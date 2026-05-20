'use strict';

const db = require('../db');
const { now, safeJsonParse } = require('../utils/common');
const { resolveProxy, buildProxyAgent, logProxyUsage } = require('./proxyService');

const REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const KIRO_HOME_URL = 'https://app.kiro.dev/home';
const KIRO_USAGE_URL = 'https://app.kiro.dev/account/usage';
const Q_USAGE_URL = 'https://q.us-east-1.amazonaws.com/getUsageLimits';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';

/**
 * Exchange refresh token for new access token.
 * @param {string} refreshToken
 * @param {object} [options]
 * @param {number} [options.accountId] - Account ID for proxy lookup
 * @returns {Promise<{ok: boolean, accessToken?: string, refreshToken?: string, expiresAt?: number, error?: string}>}
 */
async function refreshAccessToken(refreshToken, options = {}) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    return { ok: false, error: 'refresh_token is required' };
  }

  // Resolve proxy via feature flag system
  const proxy = resolveProxy({
    feature: 'refresh_token',
    providerId: options.providerId || null,
    accountId: options.accountId || null,
  });
  const agent = proxy ? await buildProxyAgent(proxy) : null;

  const fetchStart = Date.now();
  try {
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ refreshToken }),
    };

    if (agent) {
      fetchOptions.dispatcher = agent;
    }

    const res = await fetch(REFRESH_URL, fetchOptions);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (proxy) {
        logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
          'refresh_token', false, Date.now() - fetchStart, `HTTP ${res.status}`);
      }
      const isCloudFrontBlock = res.status === 403
        && /cloudfront/i.test(res.headers.get('server') || '')
        && /text\/html/i.test(res.headers.get('content-type') || '');
      const detail = isCloudFrontBlock
        ? `egress IP blocked by CloudFront (POP=${res.headers.get('x-amz-cf-pop') || '?'}); enable a proxy for the refresh_token feature`
        : text.slice(0, 200);
      return { ok: false, error: `refresh failed: ${res.status} ${detail}`, edgeBlocked: isCloudFrontBlock };
    }

    const data = await res.json();

    // Response structure: { accessToken, refreshToken?, expiresIn? }
    const accessToken = data.accessToken || data.access_token;
    const newRefreshToken = data.refreshToken || data.refresh_token || refreshToken;
    const expiresIn = Number(data.expiresIn || data.expires_in || 3600);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

    if (!accessToken) {
      if (proxy) {
        logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
          'refresh_token', false, Date.now() - fetchStart, 'no accessToken');
      }
      return { ok: false, error: 'no accessToken in refresh response' };
    }

    if (proxy) {
      logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
        'refresh_token', true, Date.now() - fetchStart, null);
    }

    return {
      ok: true,
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    };
  } catch (err) {
    if (proxy) {
      logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
        'refresh_token', false, Date.now() - fetchStart, err.message);
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Find email in HTML using multiple patterns.
 */
function findEmailInHtml(html) {
  if (!html || typeof html !== 'string') return null;
  // 1) preload state JSON patterns
  const jsonMatches = [
    /"email"\s*:\s*"([^"@]+@[^"]+)"/i,
    /"userEmail"\s*:\s*"([^"@]+@[^"]+)"/i,
    /"emailAddress"\s*:\s*"([^"@]+@[^"]+)"/i,
    /"signInName"\s*:\s*"([^"@]+@[^"]+)"/i,
  ];
  for (const re of jsonMatches) {
    const m = html.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  // 2) fallback first email-like string in HTML
  const generic = html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return generic ? generic[0].toLowerCase() : null;
}

/**
 * Find email by searching near userId in HTML.
 */
function findEmailByUserId(html, userId) {
  if (!html || !userId) return null;
  const escaped = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`${escaped}.{0,600}?([a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,})`, 'i'),
    new RegExp(`([a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}).{0,600}?${escaped}`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Find userId in HTML meta tag.
 */
function findUserIdInHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/<meta\s+name="user-id"\s+content="([^"]+)"/i);
  return m ? m[1] : null;
}

/**
 * Fetch user profile from Kiro pages (using cookie-based auth).
 * Email and userId are embedded in the HTML.
 * @param {string} accessToken
 * @param {object} [options]
 * @param {number} [options.accountId] - Account ID for proxy lookup
 * @returns {Promise<{ok: boolean, email?: string, userId?: string, error?: string}>}
 */
async function fetchKiroHomeMeta(accessToken, options = {}) {
  if (!accessToken) return { ok: false, error: 'missing access_token' };

  // Resolve proxy once per call (using token_import feature flag)
  const proxy = resolveProxy({
    feature: 'token_import',
    providerId: options.providerId || null,
    accountId: options.accountId || null,
  });
  const agent = proxy ? await buildProxyAgent(proxy) : null;

  const fetchPage = async (url, userId) => {
    const cookie = [`AccessToken=${accessToken}`, 'Idp=Google'];
    if (userId) cookie.push(`UserId=${userId}`);

    const fetchOptions = {
      headers: {
        'user-agent': UA,
        'cookie': cookie.join('; '),
      },
      redirect: 'follow',
    };

    if (agent) {
      fetchOptions.dispatcher = agent;
    }

    const start = Date.now();
    try {
      const res = await fetch(url, fetchOptions);
      const html = await res.text();
      if (proxy) {
        logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
          'token_import', res.ok, Date.now() - start, res.ok ? null : `HTTP ${res.status}`);
      }
      return { res, html };
    } catch (err) {
      if (proxy) {
        logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
          'token_import', false, Date.now() - start, err.message);
      }
      throw err;
    }
  };

  // Priority: /account/usage because email is clearly visible in top-right UI and profile card.
  let html1 = '';
  let finalUrl = '';
  let userId = null;
  let email = null;

  try {
    const first = await fetchPage(KIRO_USAGE_URL, null);
    html1 = first.html;
    finalUrl = (first.res.url || '').toString();
    if (!finalUrl.includes('/signin')) {
      userId = findUserIdInHtml(html1);
      email = findEmailInHtml(html1) || findEmailByUserId(html1, userId);
    }
  } catch (_) {
    // fallback to /home below
  }

  if (!email || !userId) {
    try {
      const home = await fetchPage(KIRO_HOME_URL, null);
      const homeUrl = (home.res.url || '').toString();
      if (!homeUrl.includes('/signin')) {
        userId = userId || findUserIdInHtml(home.html);
        email = email || findEmailInHtml(home.html) || findEmailByUserId(home.html, userId);
        finalUrl = finalUrl || homeUrl;
      }
    } catch (err) {
      if (!finalUrl) {
        return { ok: false, error: `fetch Kiro pages failed: ${err.message}` };
      }
    }
  }

  if ((finalUrl || '').includes('/signin')) {
    return { ok: false, error: 'access_token rejected (redirect /signin)' };
  }

  // Re-hit usage page with UserId cookie to get complete state if needed
  if (userId && !email) {
    try {
      const second = await fetchPage(KIRO_USAGE_URL, userId);
      email = findEmailInHtml(second.html) || findEmailByUserId(second.html, userId) || email;
    } catch (_) { /* ignore */ }
  }

  return { ok: true, userId, email, accessToken };
}

/**
 * Fetch usage limits from Q API to get subscription tier.
 * @param {string} accessToken
 * @param {string} [profileArn]
 * @param {object} [options]
 * @param {number} [options.accountId] - Account ID for proxy lookup
 * @returns {Promise<{ok: boolean, subscription?: object, profileArn?: string, error?: string}>}
 */
async function fetchSubscriptionInfo(accessToken, profileArn, options = {}) {
  // Resolve proxy via feature flag
  const proxy = resolveProxy({
    feature: 'subscription_check',
    providerId: options.providerId || null,
    accountId: options.accountId || null,
  });
  const agent = proxy ? await buildProxyAgent(proxy) : null;

  const start = Date.now();
  try {
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': UA,
      'Content-Type': 'application/json',
    };

    // Add x-amz-profile-arn header if available
    if (profileArn) {
      headers['x-amz-profile-arn'] = profileArn;
    }

    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    };

    if (agent) {
      fetchOptions.dispatcher = agent;
    }

    const res = await fetch(Q_USAGE_URL, fetchOptions);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (proxy) {
        logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
          'subscription_check', false, Date.now() - start, `HTTP ${res.status}`);
      }
      return { ok: false, error: `usage fetch failed: ${res.status} ${text}` };
    }

    const body = await res.json();
    const subscription = classifySubscription(body);

    // Extract profileArn from response if not provided
    const detectedArn = body.profileArn || (body.profile && body.profile.arn) || profileArn;

    if (proxy) {
      logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
        'subscription_check', true, Date.now() - start, null);
    }

    return {
      ok: true,
      subscription,
      profileArn: detectedArn,
      raw: body,
    };
  } catch (err) {
    if (proxy) {
      logProxyUsage(proxy.id, options.providerId || null, options.accountId || null,
        'subscription_check', false, Date.now() - start, err.message);
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Classify subscription from getUsageLimits response.
 * @param {object} body
 * @returns {object}
 */
function classifySubscription(body) {
  if (!body || typeof body !== 'object') return { tier: 'unknown' };
  
  const info = body.subscriptionInfo || {};
  const type = String(info.type || '').toUpperCase();
  const title = String(info.subscriptionTitle || '').toUpperCase();
  const upgradeCap = String(info.upgradeCapability || '').toUpperCase();

  let tier = 'unknown';
  if (/FREE/.test(type) || /FREE/.test(title)) tier = 'free';
  else if (/PRO(?!FESSIONAL)?/.test(type) || /PRO/.test(title)) tier = 'pro';
  else if (/POWER/.test(type) || /POWER/.test(title)) tier = 'power';
  else if (/ENTERPRISE/.test(type) || /ENTERPRISE/.test(title)) tier = 'enterprise';
  else if (upgradeCap === 'UPGRADE_CAPABLE') tier = 'free';

  // Pull usage numbers
  const breakdown = Array.isArray(body.usageBreakdownList) ? body.usageBreakdownList[0] : null;
  const usage = breakdown
    ? {
        limit: Number(breakdown.usageLimit ?? 0),
        current: Number(breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0),
        unit: breakdown.displayName || 'Credits',
      }
    : null;

  return {
    tier,
    type: info.type || null,
    title: info.subscriptionTitle || null,
    upgradeCapability: info.upgradeCapability || null,
    daysUntilReset: body.daysUntilReset || 0,
    usage,
    capturedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Parse refresh token input - supports "email:token" or just token.
 * @param {string} raw
 * @returns {{valid: Array, invalid: Array}}
 */
function parseRefreshTokenInput(raw) {
  const valid = [];
  const invalid = [];
  const lines = String(raw || '').split(/\r?\n/);

  for (const original of lines) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;

    // Format: "email:refreshToken"
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && line.indexOf('@') > -1 && line.indexOf('@') < colonIdx) {
      const email = line.slice(0, colonIdx).trim();
      const token = line.slice(colonIdx + 1).trim();
      if (email && token) {
        valid.push({ email, refreshToken: token });
        continue;
      }
    }

    // Just a token (length check for basic validation)
    if (line.length >= 50) {
      valid.push({ email: null, refreshToken: line });
    } else {
      invalid.push(line);
    }
  }

  return { valid, invalid };
}

/**
 * Import a Kiro account using refresh token.
 * @param {object} options
 * @param {number} options.providerId - Kiro provider ID to associate account with
 * @param {string} options.refreshToken - Refresh token
 * @param {string} [options.email] - Optional email (auto-detected if not provided)
 * @param {string} [options.label] - Optional label
 * @returns {Promise<{ok: boolean, accountId?: number, email?: string, tier?: string, error?: string}>}
 */
async function importByRefreshToken({ providerId, refreshToken, email, label }) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    return { ok: false, error: 'refresh_token is required' };
  }

  if (!providerId) {
    return { ok: false, error: 'provider_id is required' };
  }

  // Verify provider exists and is Kiro type
  const provider = db.prepare('SELECT * FROM providers WHERE id = ? AND deleted_at IS NULL').get(providerId);
  if (!provider) {
    return { ok: false, error: 'Provider not found' };
  }
  if (provider.type !== 'kiro') {
    return { ok: false, error: 'Provider must be of type "kiro"' };
  }

  // Get existing account ID for proxy lookup (if updating)
  const existing = db.prepare(`
    SELECT * FROM provider_accounts 
    WHERE provider_id = ? AND email = ? AND deleted_at IS NULL
  `).get(providerId, email || '');

  const accountIdForProxy = existing ? existing.id : null;

  // Step 1: Exchange refresh token for access token
  const refreshed = await refreshAccessToken(refreshToken, { providerId, accountId: accountIdForProxy });
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error };
  }

  // Step 2: Fetch profile info (email, userId)
  const homeMeta = await fetchKiroHomeMeta(refreshed.accessToken, { providerId, accountId: accountIdForProxy });
  const detectedEmail = homeMeta.email;
  const userId = homeMeta.userId;
  const detectedArn = homeMeta.profileArn;

  const finalEmail = (email && email.trim()) || detectedEmail;
  if (!finalEmail) {
    return {
      ok: false,
      error: 'Email tidak terdeteksi dari Kiro. Berikan email secara manual.',
      userId,
    };
  }

  // Step 3: Fetch subscription info
  const subInfo = await fetchSubscriptionInfo(refreshed.accessToken, detectedArn, { providerId, accountId: accountIdForProxy });
  if (!subInfo.ok) {
    return { ok: false, error: subInfo.error };
  }

  const subscription = subInfo.subscription;
  const profileArn = subInfo.profileArn || detectedArn;

  // Step 4: Upsert into provider_accounts
  const configJson = {
    subscription,
    profileArn,
    userId,
    importedAt: now(),
    importSource: 'refresh_token',
  };

  const tokenExpiresAt = refreshed.expiresAt;
  const ts = now();

  // Check if account with this email already exists for this provider
  // (re-query because the detected email may differ from the input)
  const existingForEmail = db.prepare(`
    SELECT * FROM provider_accounts 
    WHERE provider_id = ? AND email = ? AND deleted_at IS NULL
  `).get(providerId, finalEmail);

  let accountId;

  if (existingForEmail) {
    // Update existing account
    const existingConfig = safeJsonParse(existingForEmail.config_json, {});
    const mergedConfig = { ...existingConfig, ...configJson };

    db.prepare(`
      UPDATE provider_accounts 
      SET access_token = ?, 
          refresh_token = COALESCE(?, refresh_token),
          token_expires_at = ?,
          config_json = ?,
          label = ?,
          last_used_at = NULL,
          exhausted_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(
      refreshed.accessToken,
      refreshed.refreshToken,
      tokenExpiresAt,
      JSON.stringify(mergedConfig),
      label || existingForEmail.label || finalEmail,
      ts,
      existingForEmail.id
    );
    accountId = existingForEmail.id;
  } else {
    // Create new account
    const result = db.prepare(`
      INSERT INTO provider_accounts 
        (provider_id, label, email, access_token, refresh_token, token_expires_at, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      providerId,
      label || finalEmail,
      finalEmail,
      refreshed.accessToken,
      refreshed.refreshToken,
      tokenExpiresAt,
      JSON.stringify(configJson),
      ts,
      ts
    );
    accountId = result.lastInsertRowid;
  }

  return {
    ok: true,
    accountId,
    email: finalEmail,
    tier: subscription.tier,
    subscription,
    profileArn,
    userId,
    isNew: !existingForEmail,
  };
}

/**
 * Batch import multiple refresh tokens.
 * @param {object} options
 * @param {number} options.providerId
 * @param {Array<{email?: string, refreshToken: string}>} options.tokens
 * @returns {Promise<{results: Array, summary: object}>}
 */
async function batchImportByRefreshToken({ providerId, tokens }) {
  const results = [];
  const summary = {
    total: tokens.length,
    success: 0,
    failed: 0,
    pro: 0,
    power: 0,
    enterprise: 0,
    free: 0,
  };

  for (const token of tokens) {
    const result = await importByRefreshToken({
      providerId,
      refreshToken: token.refreshToken,
      email: token.email,
    });

    results.push({
      email: token.email,
      ...result,
    });

    if (result.ok) {
      summary.success++;
      if (result.tier === 'pro') summary.pro++;
      else if (result.tier === 'power') summary.power++;
      else if (result.tier === 'enterprise') summary.enterprise++;
      else if (result.tier === 'free') summary.free++;
    } else {
      summary.failed++;
    }
  }

  return { results, summary };
}

module.exports = {
  refreshAccessToken,
  fetchKiroHomeMeta,
  fetchSubscriptionInfo,
  classifySubscription,
  parseRefreshTokenInput,
  importByRefreshToken,
  batchImportByRefreshToken,
};
