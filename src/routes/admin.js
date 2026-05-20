'use strict';

const express = require('express');
const db = require('../db');
const { requireAdminApi } = require('../middleware/auth');
const { now, slugify, safeJsonParse } = require('../utils/common');
const { generateApiKey, hashApiKey, shortPrefix } = require('../utils/apiKey');
const { listTypes } = require('../providers');
const { proxyModelRequest } = require('../services/modelProxy');
const {
  accountConfig,
  accountHasActiveError,
  clearAccountError,
  clearProviderCurrentAccount,
} = require('../services/accounts');
const { DEFAULT_LOGS_PER_PAGE, getLogPage } = require('../services/logs');
const { warmupKiroAccount } = require('../services/kiroWarmup');
const { warmupCodexAccount } = require('../services/codexWarmup');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const router = express.Router();
router.use(requireAdminApi);

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const WORKER_JOBS_PATH = path.join(DATA_DIR, 'worker-jobs.json');
const runningWorkers = new Map();

/* ---------------------------- PROVIDERS ----------------------------- */

router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  res.json({ data: rows.map(sanitizeProvider) });
});

router.post('/providers', (req, res) => {
  const { name, type, base_url, api_key, auth_type, config_json, enabled } = req.body || {};
  if (!name || !type || !base_url) {
    return res.status(400).json({ error: 'name, type, base_url required' });
  }
  if (!listTypes().includes(type)) {
    return res.status(400).json({ error: `unknown type. allowed: ${listTypes().join(', ')}` });
  }
  const ts = now();
  let slug = slugify(name);
  // ensure unique slug
  let i = 1;
  const base = slug;
  while (db.prepare('SELECT 1 FROM providers WHERE slug = ?').get(slug)) {
    slug = `${base}-${++i}`;
  }
  try {
    const info = db.prepare(`
      INSERT INTO providers
        (name, slug, type, base_url, api_key, auth_type, config_json, enabled, created_at, updated_at)
      VALUES (@name, @slug, @type, @base_url, @api_key, @auth_type, @config_json, @enabled, @ts, @ts)
    `).run({
      name,
      slug,
      type,
      base_url,
      api_key: api_key || null,
      auth_type: auth_type || 'bearer',
      config_json: typeof config_json === 'string' ? config_json : JSON.stringify(config_json || {}),
      enabled: enabled ? 1 : 0,
      ts,
    });
    const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(sanitizeProvider(row));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/providers/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const fields = ['name', 'type', 'base_url', 'api_key', 'auth_type', 'config_json', 'enabled',
    'access_token', 'refresh_token', 'token_expires_at'];
  const set = [];
  const params = { id, updated_at: now() };
  for (const f of fields) {
    if (f in req.body) {
      let v = req.body[f];
      if (f === 'enabled') v = v ? 1 : 0;
      if (f === 'config_json' && typeof v !== 'string') v = JSON.stringify(v || {});
      set.push(`${f} = @${f}`);
      params[f] = v;
    }
  }
  if (!set.length) return res.json(sanitizeProvider(row));
  db.prepare(`UPDATE providers SET ${set.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  const updated = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  res.json(sanitizeProvider(updated));
});

router.delete('/providers/:id', (req, res) => {
  const id = Number(req.params.id);
  // Soft-delete so the change replicates to peers; SQLite triggers will
  // emit a 'delete' outbox entry. Hard-delete is unsafe under sync because
  // peers would resurrect the row from their next push.
  // node_id is rewritten to the local instance so the AFTER UPDATE trigger
  // (which filters on NEW.node_id = local_node_id) emits an outbox entry.
  const ts = now();
  const localNode = "COALESCE((SELECT value FROM sync_config WHERE key = 'local_node_id'), node_id)";
  const info = db.prepare(`UPDATE providers SET deleted_at = ?, updated_at = ?, node_id = ${localNode} WHERE id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  // Cascade soft-delete to dependent rows so they don't dangle on peers.
  db.prepare(`UPDATE provider_accounts SET deleted_at = ?, updated_at = ?, node_id = ${localNode} WHERE provider_id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  db.prepare(`UPDATE models SET deleted_at = ?, updated_at = ?, node_id = ${localNode} WHERE provider_id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  res.json({ ok: true });
});

/**
 * Refresh Kiro subscription info on-demand. Calls /getUsageLimits via the
 * adapter, classifies it, and persists into config_json.subscription.
 */
router.post('/providers/:id/refresh-subscription', async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.type !== 'kiro') {
    return res.status(400).json({ error: 'subscription probe only available for kiro providers' });
  }
  try {
    const KiroProvider = require('../providers/kiro');
    const adapter = new KiroProvider(row);
    const info = await adapter.fetchUsageInfo();
    if (info.status !== 200) {
      return res.status(info.status).json({ error: 'upstream returned ' + info.status, body: info.body });
    }
    const classified = KiroProvider.classifySubscription(info.body);
    const cfgObj = (() => { try { return JSON.parse(row.config_json || '{}'); } catch { return {}; } })();
    cfgObj.subscription = classified;
    db.prepare('UPDATE providers SET config_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(cfgObj),
      now(),
      id
    );
    res.json({ ok: true, subscription: classified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizeProvider(row) {
  if (!row) return row;
  const copy = { ...row };
  // Mask secrets in list responses — UI will ask separately when editing
  if (copy.api_key) copy.api_key_masked = maskSecret(copy.api_key);
  if (copy.access_token) copy.access_token_masked = maskSecret(copy.access_token);
  if (copy.refresh_token) copy.refresh_token_masked = maskSecret(copy.refresh_token);
  delete copy.api_key;
  delete copy.access_token;
  delete copy.refresh_token;
  copy.config = safeJsonParse(copy.config_json, {});
  return copy;
}

function maskSecret(s) {
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

/* ---------------------------- ACCOUNTS ------------------------------ */

router.get('/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, p.name AS provider_name, p.type AS provider_type
    FROM provider_accounts a
    JOIN providers p ON p.id = a.provider_id
    WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY p.name ASC, a.created_at DESC
  `).all();
  res.json({ data: rows.map(sanitizeAccount) });
});

router.post('/accounts', (req, res) => {
  const {
    provider_id, label, email, api_key, access_token, refresh_token,
    token_expires_at, config_json, enabled,
  } = req.body || {};
  if (!provider_id) return res.status(400).json({ error: 'provider_id required' });
  const provider = db.prepare('SELECT id FROM providers WHERE id = ?').get(Number(provider_id));
  if (!provider) return res.status(400).json({ error: 'provider not found' });
  const ts = now();
  const info = db.prepare(`
    INSERT INTO provider_accounts
      (provider_id, label, email, api_key, access_token, refresh_token, token_expires_at,
       config_json, enabled, created_at, updated_at)
    VALUES
      (@provider_id, @label, @email, @api_key, @access_token, @refresh_token, @token_expires_at,
       @config_json, @enabled, @ts, @ts)
  `).run({
    provider_id: Number(provider_id),
    label: label || email || 'Account',
    email: email || null,
    api_key: api_key || null,
    access_token: access_token || null,
    refresh_token: refresh_token || null,
    token_expires_at: Number(token_expires_at) || null,
    config_json: typeof config_json === 'string' ? config_json : JSON.stringify(config_json || {}),
    enabled: enabled ? 1 : 0,
    ts,
  });
  res.status(201).json(sanitizeAccount(db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(info.lastInsertRowid)));
});

router.patch('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const fields = [
    'provider_id', 'label', 'email', 'api_key', 'access_token', 'refresh_token',
    'token_expires_at', 'config_json', 'enabled', 'exhausted_at',
  ];
  const set = [];
  const params = { id, updated_at: now() };
  for (const f of fields) {
    if (f in req.body) {
      let v = req.body[f];
      if (f === 'enabled') v = v ? 1 : 0;
      if (f === 'config_json' && typeof v !== 'string') v = JSON.stringify(v || {});
      if (f === 'exhausted_at' && !v) v = null;
      set.push(`${f} = @${f}`);
      params[f] = v;
    }
  }
  if (!set.length) return res.json(sanitizeAccount(row));
  db.prepare(`UPDATE provider_accounts SET ${set.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  if (req.body && req.body.clear_error) clearAccountError(id, { clearLastError: true });
  const updated = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);
  if (!updated.exhausted_at) clearProviderCurrentAccount(updated.provider_id, id);
  res.json(sanitizeAccount(updated));
});

router.delete('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT provider_id FROM provider_accounts WHERE id = ?').get(id);
  // Soft-delete so the change replicates to peers via the outbox triggers.
  const ts = now();
  const info = db.prepare(`UPDATE provider_accounts SET deleted_at = ?, updated_at = ?, node_id = COALESCE((SELECT value FROM sync_config WHERE key = 'local_node_id'), node_id) WHERE id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  if (row) clearProviderCurrentAccount(row.provider_id, id);
  res.json({ ok: true });
});

/**
 * Reveal the raw refresh_token for an account so the admin can copy it to the
 * clipboard. Admin-session gated via router.use(requireAdminApi) above. The
 * token is never logged; callers should treat the response as sensitive.
 */
router.get('/accounts/:id/refresh-token', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT refresh_token FROM provider_accounts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!row.refresh_token) return res.status(404).json({ error: 'no refresh_token on this account' });
  res.json({ ok: true, refresh_token: row.refresh_token });
});

/**
 * Generate a session URL for opening Kiro in a browser.
 * Uses the stored access_token to create a URL that can be opened in browser
 * with cookie-based authentication to app.kiro.dev.
 */
router.post('/accounts/:id/open-kiro-session', async (req, res) => {
  const id = Number(req.params.id);
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(account.provider_id);
  if (!provider || provider.type !== 'kiro') {
    return res.status(400).json({ error: 'open-session only available for kiro accounts' });
  }

  // Check if we have tokens
  if (!account.access_token && !account.refresh_token) {
    return res.status(400).json({ error: 'account has no tokens' });
  }

  const KiroProvider = require('../providers/kiro');
  const { refreshAccessToken } = require('../services/kiroTokenImport');

  let accessToken = account.access_token;
  let refreshToken = account.refresh_token;

  // If access token might be expired, refresh it first
  const nowTs = now();
  const expiresAt = account.token_expires_at ? Number(account.token_expires_at) : 0;
  const needsRefresh = !accessToken || (expiresAt > 0 && expiresAt < nowTs + 300);

  if (needsRefresh && refreshToken) {
    try {
      const result = await refreshAccessToken(refreshToken, {
        providerId: provider.id,
        accountId: account.id
      });
      if (result.ok) {
        accessToken = result.accessToken;
        // Update stored tokens
        db.prepare(`
          UPDATE provider_accounts
          SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
          WHERE id = ?
        `).run(accessToken, result.refreshToken, result.expiresAt, nowTs, id);
      } else {
        return res.status(401).json({
          error: result.edgeBlocked
            ? 'Cannot reach Kiro (IP blocked by CloudFront). Try using a proxy.'
            : `Token refresh failed: ${result.error}`,
          edge_blocked: result.edgeBlocked || false
        });
      }
    } catch (err) {
      return res.status(502).json({ error: `Failed to refresh token: ${err.message}` });
    }
  }

  if (!accessToken) {
    return res.status(401).json({ error: 'No valid access token available' });
  }

  // Return the session URL and access token for the frontend to open
  // The frontend will set cookies and open the page
  res.json({
    ok: true,
    session_url: 'https://app.kiro.dev/account/usage',
    access_token: accessToken,
    email: account.email || null
  });
});

router.post('/accounts/:id/refresh-subscription', async (req, res) => {
  const id = Number(req.params.id);
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(account.provider_id);
  if (!provider) return res.status(404).json({ error: 'provider not found' });
  if (provider.type !== 'kiro' && provider.type !== 'codex') {
    return res.status(400).json({ error: 'subscription probe only available for kiro and codex accounts' });
  }
  try {
    const warmed = provider.type === 'kiro'
      ? await warmupKiroAccount(provider, account, { clearErrorOnAvailable: true })
      : await warmupCodexAccount(provider, account, { clearErrorOnAvailable: true });
    if (warmed.exhaustedAt) clearProviderCurrentAccount(provider.id, id);
    res.json({
      ok: true,
      subscription: warmed.subscription,
      exhausted_at: warmed.exhaustedAt,
      rate_limited: warmed.hasRemainingCredits,
      cleared_error: warmed.clearedError,
    });
  } catch (err) {
    res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500).json({
      error: err.message,
      upstream_status: err.status || null,
    });
  }
});

/**
 * Trigger the Playwright worker that opens https://app.kiro.dev/account/usage,
 * clicks "Upgrade to Pro" and captures the resulting Stripe Checkout URL.
 *
 * Long-running (spawns a browser). We cap the runtime at 3 minutes; the worker
 * emits a `UPGRADE_RESULT {...}` JSON line on stdout when done. Frontend opens
 * the returned URL in a new tab so the user can finish payment manually.
 */
router.post('/accounts/:id/upgrade-to-pro', async (req, res) => {
  const id = Number(req.params.id);
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);
  if (!account) return res.status(404).json({ error: 'not found' });
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(account.provider_id);
  if (!provider || provider.type !== 'kiro') {
    return res.status(400).json({ error: 'upgrade only available for kiro accounts' });
  }

  const cfg = safeJsonParse(account.config_json, {}) || {};
  const sub = cfg.subscription || null;
  const tier = sub && sub.tier ? String(sub.tier).toLowerCase() : 'unknown';
  if (tier && !['free', 'unknown'].includes(tier)) {
    return res.status(400).json({ error: `account tier is "${tier}"; upgrade only applies to free accounts` });
  }
  if (!account.email) {
    return res.status(400).json({ error: 'account has no email on file; cannot drive login' });
  }

  // --- Fast path: HTTP-only Stripe URL generation (no browser, no password) ---
  // Replicates the kiro_login_upgrade.py::generate_stripe_url flow. Works as
  // long as the stored access_token is still valid — falls back to the
  // browser worker otherwise.
  const forceBrowser = Boolean(req.body && req.body.forceBrowser === true);
  if (!forceBrowser && account.access_token) {
    try {
      const KiroProvider = require('../providers/kiro');
      const adapter = new KiroProvider({ ...provider, account });
      const result = await adapter.generateStripeUrl();
      if (result && result.ok && result.checkoutUrl) {
        return res.json({
          ok: true,
          checkoutUrl: result.checkoutUrl,
          accountId: id,
          method: 'http',
        });
      }
      // Non-fatal: record the failure reason and continue to the browser
      // fallback. Tokens might be expired, profile ARN might be stale, etc.
      console.warn(
        '[upgrade-to-pro] HTTP fast path failed, falling back to browser worker:',
        result && (result.error || result.code)
      );
    } catch (err) {
      console.warn('[upgrade-to-pro] HTTP fast path threw, falling back:', err.message);
    }
  }

  // --- Slow path: spawn the Playwright worker (requires password for fresh login) ---
  const password = (req.body && typeof req.body.password === 'string' && req.body.password) || null;
  const headless = !(req.body && req.body.headless === false);

  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'upgrade-kiro.js');
  const args = [scriptPath, '--account-id', String(id), '--email', account.email];
  if (password) args.push('--password', password);
  if (headless) args.push('--headless');

  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: headless,
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  const settle = (payload, statusCode = 200) => {
    if (settled) return;
    settled = true;
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    res.status(statusCode).json(payload);
  };

  const timeout = setTimeout(() => {
    settle({ ok: false, error: 'upgrade worker timed out after 3 minutes', stderr: stderr.slice(-1500) }, 504);
  }, 3 * 60 * 1000);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const match = stdout.match(/UPGRADE_RESULT (\{.*\})/);
    if (match) {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.ok && parsed.checkoutUrl) {
          settle({ ok: true, checkoutUrl: parsed.checkoutUrl, accountId: id, method: 'browser' });
        } else {
          settle({ ok: false, error: parsed.error || 'unknown worker error', stderr: stderr.slice(-1500) }, 500);
        }
      } catch (err) {
        settle({ ok: false, error: 'failed to parse worker result: ' + err.message, raw: match[1] }, 500);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  child.on('close', (code) => {
    clearTimeout(timeout);
    if (settled) return;
    settle({
      ok: false,
      error: `upgrade worker exited with code ${code} before emitting result`,
      stderr: stderr.slice(-1500),
    }, 500);
  });
  child.on('error', (err) => {
    clearTimeout(timeout);
    settle({ ok: false, error: `failed to spawn worker: ${err.message}` }, 500);
  });
});

router.post('/providers/:id/warmup-accounts', async (req, res) => {
  const id = Number(req.params.id);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  if (!provider) return res.status(404).json({ error: 'not found' });
  if (provider.type !== 'kiro') {
    return res.status(400).json({ error: 'warmup currently available for kiro providers' });
  }

  const currentTs = now();
  const accounts = db.prepare('SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY id ASC').all(id);
  const targetAccounts = accounts.filter((account) => {
    const cfg = accountConfig(account);
    return Boolean(
      account.exhausted_at ||
      accountHasActiveError(account, currentTs) ||
      cfg.warmupRecommendedAt
    );
  });
  const results = [];

  for (const account of targetAccounts) {
    const label = account.email || account.label || `Account #${account.id}`;
    try {
      const warmed = await warmupKiroAccount(provider, account, { clearErrorOnAvailable: true });
      if (warmed.exhaustedAt) clearProviderCurrentAccount(provider.id, account.id);
      results.push({
        id: account.id,
        label,
        ok: true,
        subscription: warmed.subscription,
        exhausted_at: warmed.exhaustedAt,
        rate_limited: warmed.hasRemainingCredits,
        cleared_error: warmed.clearedError,
      });
    } catch (err) {
      const cfgObj = (() => { try { return JSON.parse(account.config_json || '{}'); } catch { return {}; } })();
      cfgObj.lastError = err.message;
      db.prepare('UPDATE provider_accounts SET config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(cfgObj), now(), account.id);
      results.push({ id: account.id, label, ok: false, error: err.message });
    }
  }

  res.json({
    ok: true,
    targeted: targetAccounts.length,
    total: results.length,
    success: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  });
});

/**
 * Parse a batch-login style textarea into { valid, invalid } pairs.
 * Accepts "email:password" per line, trims whitespace and skips blanks.
 */
function parseBatchLoginLines(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0 || i === line.length - 1) {
      invalid.push(line);
      continue;
    }
    const email = line.slice(0, i).trim();
    const password = line.slice(i + 1);
    // Require a proper email (something before and after @, no whitespace).
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      invalid.push(line);
      continue;
    }
    valid.push({ email, password, raw: line });
  }
  return { valid, invalid };
}

/**
 * POST /api/admin/accounts/kiro/by-refresh-token
 *
 * Body: { provider_id, refresh_token, label?, email?, probe_usage? }
 *
 * Exchanges a Kiro refresh token for a fresh access token by calling
 * `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`. On success,
 * upserts a provider_accounts row (matched by provider+email when email is
 * given, otherwise creates a new one), runs the subscription probe when
 * `probe_usage` is true, and returns the new account id.
 *
 * Note: Kiro's /refreshToken endpoint only returns tokens, not profileArn.
 * We rely on /getUsageLimits (via fetchUsageInfo, which doesn't require
 * profileArn for the initial probe) to pull subscription + profileArn info.
 */
router.post('/accounts/kiro/by-refresh-token', async (req, res) => {
  const providerId = Number(req.body && req.body.provider_id);
  const refreshToken = String((req.body && req.body.refresh_token) || '').trim();
  const label = req.body && req.body.label ? String(req.body.label) : null;
  const email = req.body && req.body.email ? String(req.body.email).trim() : null;
  const probeUsage = !(req.body && req.body.probe_usage === false);

  if (!providerId) return res.status(400).json({ error: 'provider_id required' });
  if (!refreshToken) return res.status(400).json({ error: 'refresh_token required' });

  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'provider not found' });
  if (provider.type !== 'kiro') {
    return res.status(400).json({ error: 'provider is not of type "kiro"' });
  }

  // Tolerate local CA chain issues the same way src/providers/kiro.js does.
  const prevTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (process.env.KIRO_STRICT_TLS !== '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let tokens;
  try {
    // Delegate to the shared service so the request goes through the proxy
    // configured for the `refresh_token` feature flag (CloudFront blocks
    // direct egress from many ASNs).
    const { refreshAccessToken } = require('../services/kiroTokenImport');
    const result = await refreshAccessToken(refreshToken, { providerId: provider.id });
    if (!result.ok) {
      // edgeBlocked = WAF block, not a token problem
      const status = result.edgeBlocked ? 502 : 401;
      return res.status(status).json({
        error: result.error,
        edge_blocked: !!result.edgeBlocked,
      });
    }
    tokens = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
    };
  } catch (err) {
    return res.status(502).json({ error: `failed to reach Kiro /refreshToken: ${err.message}` });
  } finally {
    if (prevTlsRejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsRejectUnauthorized;
  }

  const access = tokens.accessToken || tokens.access_token;
  const newRefresh = tokens.refreshToken || tokens.refresh_token || refreshToken;
  const idToken = tokens.idToken || tokens.id_token || null;
  if (!access) {
    return res.status(502).json({ error: 'upstream /refreshToken response missing accessToken', body: tokens });
  }

  // Resolve expiresAt into a unix-seconds value (same logic as login-kiro.js).
  let exp = 0;
  if (tokens.expiresAt) {
    const parsed = Number(tokens.expiresAt);
    if (Number.isFinite(parsed)) exp = parsed > 1e10 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    else {
      const ms = Date.parse(String(tokens.expiresAt));
      if (!Number.isNaN(ms)) exp = Math.floor(ms / 1000);
    }
  }
  if (!exp && tokens.expiresIn) exp = now() + Number(tokens.expiresIn);
  if (!exp) exp = now() + 3600;

  // Match by email within this provider so re-importing the same account
  // updates it in place instead of duplicating.
  const existing = email
    ? db.prepare('SELECT * FROM provider_accounts WHERE provider_id = ? AND email = ?').get(provider.id, email)
    : null;
  const existingCfg = (() => {
    try { return JSON.parse((existing && existing.config_json) || provider.config_json || '{}'); } catch { return {}; }
  })();

  const cfg = {
    ...existingCfg,
    auth: 'oauth-pkce',
    idp: existingCfg.idp || 'Google',
    region: 'us-east-1',
    profileArn: existingCfg.profileArn || null,
    idToken: idToken || existingCfg.idToken || null,
    addedVia: 'refresh-token-exchange',
  };
  delete cfg.error; // clear stale error from previous failures

  const ts = now();
  let accountId;
  if (existing) {
    db.prepare(`
      UPDATE provider_accounts
      SET label = @label,
          email = @email,
          access_token = @access,
          refresh_token = @refresh,
          token_expires_at = @exp,
          config_json = @cfg,
          enabled = 1,
          exhausted_at = NULL,
          updated_at = @ts
      WHERE id = @id
    `).run({
      id: existing.id,
      label: label || existing.label || email || 'Kiro account',
      email: email || existing.email || null,
      access,
      refresh: newRefresh,
      exp,
      cfg: JSON.stringify(cfg),
      ts,
    });
    accountId = existing.id;
  } else {
    const info = db.prepare(`
      INSERT INTO provider_accounts
        (provider_id, label, email, access_token, refresh_token, token_expires_at,
         config_json, enabled, created_at, updated_at)
      VALUES
        (@provider_id, @label, @email, @access, @refresh, @exp,
         @cfg, 1, @ts, @ts)
    `).run({
      provider_id: provider.id,
      label: label || email || 'Kiro account',
      email: email || null,
      access,
      refresh: newRefresh,
      exp,
      cfg: JSON.stringify(cfg),
      ts,
    });
    accountId = info.lastInsertRowid;
  }

  db.prepare('UPDATE providers SET enabled = 1, auth_type = \'oauth\', updated_at = ? WHERE id = ?')
    .run(ts, provider.id);

  // Subscription probe reuses the same adapter-level logic as login-kiro.js.
  let subscription = null;
  let probeError = null;
  if (probeUsage) {
    try {
      const KiroProvider = require('../providers/kiro');
      const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
      const adapter = new KiroProvider({ ...provider, account });
      const info = await adapter.fetchUsageInfo();
      if (info.status === 200) {
        subscription = KiroProvider.classifySubscription(info.body);
        const cfgObj = (() => { try { return JSON.parse(account.config_json || '{}'); } catch { return {}; } })();
        cfgObj.subscription = subscription;
        // The usageLimits response includes a profileArn when the account has
        // one provisioned; persist it so adapter calls that require it work.
        const upstreamProfileArn = info.body && (info.body.profileArn || (info.body.profile && info.body.profile.arn));
        if (!cfgObj.profileArn && typeof upstreamProfileArn === 'string') {
          cfgObj.profileArn = upstreamProfileArn;
        }
        db.prepare('UPDATE provider_accounts SET config_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(cfgObj), now(), accountId);
      } else {
        probeError = `usage probe returned status ${info.status}`;
      }
    } catch (err) {
      probeError = err.message;
    }
  }

  const saved = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  res.status(existing ? 200 : 201).json({
    ok: true,
    account_id: accountId,
    account: sanitizeAccount(saved),
    subscription,
    probe_error: probeError,
    updated: !!existing,
  });
});

/**
 * POST /api/admin/accounts/kiro/batch-refresh-tokens
 *
 * Body: { provider_id, tokens: string, probe_usage? }
 *
 * `tokens` is a multiline string, each line is either:
 *   - "email:refreshToken" (email explicitly provided)
 *   - "refreshToken" (email auto-detected from Kiro profile)
 *
 * Imports multiple Kiro accounts in batch, returns summary.
 */
router.post('/accounts/kiro/batch-refresh-tokens', async (req, res) => {
  const providerId = Number(req.body && req.body.provider_id);
  const tokensRaw = String((req.body && req.body.tokens) || '').trim();
  const probeUsage = !(req.body && req.body.probe_usage === false);

  if (!providerId) return res.status(400).json({ error: 'provider_id required' });
  if (!tokensRaw) return res.status(400).json({ error: 'tokens required' });

  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'provider not found' });
  if (provider.type !== 'kiro') {
    return res.status(400).json({ error: 'provider is not of type "kiro"' });
  }

  // Parse input
  const { valid, invalid } = parseRefreshTokenInput(tokensRaw);
  if (!valid.length) {
    return res.status(400).json({ error: 'No valid tokens found', invalid });
  }

  // Process each token
  const results = [];
  const summary = {
    total: valid.length,
    success: 0,
    failed: 0,
    pro: 0,
    power: 0,
    enterprise: 0,
    free: 0,
    unknown: 0,
  };

  // Tolerate local CA chain issues
  const prevTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (process.env.KIRO_STRICT_TLS !== '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  try {
    for (const item of valid) {
      try {
        // Call the single-token endpoint logic internally
        const resp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/admin/accounts/kiro/by-refresh-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': req.headers.cookie || '',
          },
          body: JSON.stringify({
            provider_id: providerId,
            refresh_token: item.refreshToken,
            email: item.email,
            probe_usage: probeUsage,
          }),
        });

        const data = await resp.json();

        if (data.ok) {
          results.push({
            email: item.email || data.account?.email,
            ok: true,
            account_id: data.account_id,
            tier: data.subscription?.tier || 'unknown',
            updated: data.updated,
          });
          summary.success++;
          const tier = data.subscription?.tier || 'unknown';
          if (tier === 'pro') summary.pro++;
          else if (tier === 'power') summary.power++;
          else if (tier === 'enterprise') summary.enterprise++;
          else if (tier === 'free') summary.free++;
          else summary.unknown++;
        } else {
          results.push({
            email: item.email,
            ok: false,
            error: data.error || 'Unknown error',
          });
          summary.failed++;
        }
      } catch (err) {
        results.push({
          email: item.email,
          ok: false,
          error: err.message,
        });
        summary.failed++;
      }
    }
  } finally {
    if (prevTlsRejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsRejectUnauthorized;
  }

  res.json({
    ok: true,
    summary,
    results,
    invalid_lines: invalid,
  });
});

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

    // Just a token (length check)
    if (line.length >= 50) {
      valid.push({ email: null, refreshToken: line });
    } else {
      invalid.push(line);
    }
  }

  return { valid, invalid };
}

/**
 * POST /api/admin/accounts/codex/login
 *
 * Body: { provider_id, port?, force? }
 *
 * Spawns `scripts/login-codex.js` as a worker-tracked background job so the
 * frontend can redirect to /workers and watch logs in real time. The script
 * opens a browser, listens for the OAuth callback on `http://localhost:<port>`,
 * exchanges the authorization code, and persists the resulting account into
 * provider_accounts under the Codex provider. The account label is set by the
 * script from the ChatGPT email after login, so we don't accept one here.
 *
 * We register the job with the same worker-job tracker used for Kiro batch
 * logins so the existing /workers UI works without changes.
 */
router.post('/accounts/codex/login', (req, res) => {
  const providerId = Number(req.body && req.body.provider_id);
  if (!providerId) return res.status(400).json({ error: 'provider_id required' });
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'provider not found' });
  if (provider.type !== 'codex') {
    return res.status(400).json({ error: 'provider is not of type "codex"' });
  }

  const rawPort = Number(req.body && req.body.port);
  const port = rawPort > 0 && rawPort < 65536 ? Math.floor(rawPort) : 1455;
  const force = !!(req.body && req.body.force);

  const jobId = Date.now().toString(36);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFile = path.join(DATA_DIR, `codex-login-${jobId}.log`);
  const displayName = 'codex-login';

  upsertWorkerJob({
    id: jobId,
    type: 'codex-login',
    status: 'queued',
    total: 1,
    completed: 0,
    failed: 0,
    headless: false,
    current: displayName,
    logFile,
    accounts: [displayName],
    results: [{
      email: displayName,
      status: 'queued',
      started_at: null,
      finished_at: null,
      exit_code: null,
    }],
    started_at: now(),
    updated_at: now(),
    finished_at: null,
  });
  appendWorkerLog(
    logFile,
    `queued codex login (port=${port}, force=${force})\n` +
    `Open http://localhost:${port}/auth/callback will be opened automatically.\n` +
    `Account label will be set from the ChatGPT email after login.\n`
  );

  // Kick the actual subprocess off the request lifecycle; the HTTP response
  // returns immediately with the job id so the UI can redirect to /workers.
  runCodexLogin({ providerId: provider.id, port, force, jobId, logFile, displayName })
    .catch((err) => {
      console.error('[codex-login]', err);
      appendWorkerLog(logFile, `worker failed: ${err.message}\n`);
      setWorkerResult(jobId, displayName, {
        status: 'failed',
        finished_at: now(),
        exit_code: null,
      });
      updateWorkerJob(jobId, { status: 'failed', error: err.message, finished_at: now() });
    });

  res.json({ ok: true, jobId, logFile });
});

function runCodexLogin({ port, force, jobId, logFile, displayName }) {
  return new Promise((resolve) => {
    setWorkerResult(jobId, displayName, { status: 'running', started_at: now() });
    updateWorkerJob(jobId, {
      status: 'running',
      current: displayName,
      current_index: 1,
      updated_at: now(),
    });
    appendWorkerLog(logFile, `\n[1/1 ${displayName}] starting\n`);

    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'login-codex.js');
    const args = [scriptPath, '--port', String(port)];
    if (force) args.push('--force');

    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    runningWorkers.set(jobId, { child, cancelled: false, email: displayName });
    const prefix = `[1/1 ${displayName}] `;
    const append = (chunk) => appendWorkerLog(logFile, prefix + chunk.toString());
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      const running = runningWorkers.get(jobId);
      const wasCancelled = (running && running.cancelled) || isWorkerCancelled(jobId);
      runningWorkers.delete(jobId);
      appendWorkerLog(logFile, `${prefix}exit=${code}\n`);
      setWorkerResult(jobId, displayName, {
        status: wasCancelled ? 'cancelled' : (code === 0 ? 'success' : 'failed'),
        finished_at: now(),
        exit_code: code,
      });
      if (wasCancelled) {
        markWorkerCancelled(jobId, 'cancelled while account was running');
        appendWorkerLog(logFile, '\nworker cancelled\n');
        return resolve();
      }
      updateWorkerJob(jobId, {
        completed: 1,
        failed: code === 0 ? 0 : 1,
        current: null,
        status: code === 0 ? 'completed' : 'completed_with_errors',
        finished_at: now(),
        updated_at: now(),
      });
      appendWorkerLog(logFile, '\nworker finished\n');
      resolve();
    });
    child.on('error', (err) => {
      appendWorkerLog(logFile, `${prefix}spawn error: ${err.message}\n`);
      setWorkerResult(jobId, displayName, {
        status: 'failed',
        finished_at: now(),
        exit_code: null,
      });
      updateWorkerJob(jobId, {
        status: 'failed',
        error: err.message,
        finished_at: now(),
        updated_at: now(),
      });
      resolve();
    });
  });
}

/**
 * POST /api/admin/accounts/kiro/filter-existing
 *
 * Body: { accounts: "email:password\nemail2:password2..." }
 * Returns which emails already exist in provider_accounts (for the Kiro
 * provider) and which are missing. Invalid input lines are reported too so
 * the caller can fix them before running the batch login.
 */
router.post('/accounts/kiro/filter-existing', (req, res) => {
  const { valid, invalid } = parseBatchLoginLines(req.body && req.body.accounts);
  if (!valid.length && !invalid.length) {
    return res.status(400).json({ error: 'no accounts submitted' });
  }

  const existingRows = db.prepare(`
    SELECT a.id, a.email, a.label, a.enabled, a.exhausted_at, a.config_json
    FROM provider_accounts a
    JOIN providers p ON p.id = a.provider_id
    WHERE p.type = 'kiro' AND a.email IS NOT NULL
  `).all();
  const byEmailLower = new Map();
  for (const row of existingRows) {
    byEmailLower.set(String(row.email).trim().toLowerCase(), row);
  }

  const existing = [];
  const missing = [];
  const seen = new Set();
  const duplicates = [];
  for (const item of valid) {
    const key = item.email.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(item);
      continue;
    }
    seen.add(key);
    const hit = byEmailLower.get(key);
    if (hit) {
      existing.push({
        email: item.email,
        password: item.password,
        raw: item.raw,
        account_id: hit.id,
        label: hit.label,
        enabled: !!hit.enabled,
        exhausted_at: hit.exhausted_at,
        has_error: accountHasActiveError(hit),
      });
    } else {
      missing.push({ email: item.email, password: item.password, raw: item.raw });
    }
  }

  res.json({
    ok: true,
    total: valid.length + invalid.length,
    existing_count: existing.length,
    missing_count: missing.length,
    duplicate_count: duplicates.length,
    invalid_count: invalid.length,
    existing,
    missing,
    duplicates,
    invalid,
    // Convenience: text ready to paste into the Batch Kiro login modal.
    missing_text: missing.map((m) => m.raw).join('\n'),
    existing_text: existing.map((e) => e.raw).join('\n'),
  });
});

router.post('/accounts/kiro/batch-login', (req, res) => {
  const headless = req.body && req.body.headless !== false;
  const incognito = !(req.body && req.body.incognito === false);
  const { valid: parsed, invalid } = parseBatchLoginLines(req.body && req.body.accounts);
  if (invalid.length) {
    return res.status(400).json({ error: `invalid line(s): ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '...' : ''}` });
  }
  if (!parsed.length) return res.status(400).json({ error: 'no accounts submitted' });

  const jobId = Date.now().toString(36);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFile = path.join(DATA_DIR, `kiro-batch-${jobId}.log`);
  upsertWorkerJob({
    id: jobId,
    type: 'kiro-batch-login',
    status: 'queued',
    total: parsed.length,
    completed: 0,
    failed: 0,
    headless,
    incognito,
    current: null,
    logFile,
    accounts: parsed.map((item) => item.email),
    results: parsed.map((item) => ({
      email: item.email,
      status: 'queued',
      started_at: null,
      finished_at: null,
      exit_code: null,
    })),
    started_at: now(),
    updated_at: now(),
    finished_at: null,
  });
  appendWorkerLog(logFile, `queued ${parsed.length} Kiro login(s), headless=${headless}, incognito=${incognito}\n`);
  runKiroBatch(parsed, logFile, jobId, { headless, incognito }).catch((err) => {
    console.error('[kiro-batch-login]', err);
    appendWorkerLog(logFile, `worker failed: ${err.message}\n`);
    updateWorkerJob(jobId, { status: 'failed', error: err.message, finished_at: now() });
  });
  res.json({ ok: true, jobId, logFile, count: parsed.length });
});

router.get('/workers', (req, res) => {
  res.json({ data: readWorkerJobs().sort((a, b) => String(b.id).localeCompare(String(a.id))) });
});

router.get('/workers/:id', (req, res) => {
  const job = readWorkerJobs().find((item) => item.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const max = Math.min(Number(req.query.max) || 30000, 200000);
  let log = '';
  try {
    if (job.logFile && fs.existsSync(job.logFile)) {
      const stat = fs.statSync(job.logFile);
      const start = Math.max(0, stat.size - max);
      const fd = fs.openSync(job.logFile, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      log = buf.toString('utf8');
    }
  } catch (err) {
    log = `failed to read log: ${err.message}`;
  }
  res.json({ job, log });
});

router.post('/workers/:id/cancel', (req, res) => {
  const jobId = req.params.id;
  const job = readWorkerJobs().find((item) => item.id === jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status)) {
    return res.json({ ok: true, job });
  }

  const running = runningWorkers.get(jobId);
  if (running && running.child && !running.child.killed) {
    try {
      running.cancelled = true;
      running.child.kill('SIGTERM');
      setTimeout(() => {
        if (running.child && !running.child.killed) {
          try { running.child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 5000);
    } catch {
      /* ignore */
    }
  }

  markWorkerCancelled(jobId, 'cancel requested');
  res.json({ ok: true });
});

function runKiroBatch(accounts, logFile, jobId, options = {}) {
  return accounts.reduce((chain, item, index) => chain.then(() => new Promise((resolve) => {
    const latest = readWorkerJobs().find((item) => item.id === jobId);
    if (!latest || latest.status === 'cancelled') return resolve();
    setWorkerResult(jobId, item.email, { status: 'running', started_at: now() });
    updateWorkerJob(jobId, {
      status: 'running',
      current: item.email,
      current_index: index + 1,
      updated_at: now(),
    });
    appendWorkerLog(logFile, `\n[${index + 1}/${accounts.length} ${item.email}] starting\n`);
    const args = [
      path.join(__dirname, '..', '..', 'scripts', 'login-kiro.js'),
      '--email', item.email,
      '--password', item.password,
      '--account-email', item.email,
    ];
    if (options.headless) args.push('--headless');
    else args.push('--keep-open-on-error');
    if (options.incognito !== false) args.push('--incognito');
    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: options.headless !== false,
    });
    runningWorkers.set(jobId, { child, cancelled: false, email: item.email });
    const prefix = `[${index + 1}/${accounts.length} ${item.email}] `;
    const append = (chunk) => appendWorkerLog(logFile, prefix + chunk.toString());
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => {
      const running = runningWorkers.get(jobId);
      const wasCancelled = (running && running.cancelled) || isWorkerCancelled(jobId);
      runningWorkers.delete(jobId);
      appendWorkerLog(logFile, `${prefix}exit=${code}\n`);
      setWorkerResult(jobId, item.email, {
        status: wasCancelled ? 'cancelled' : (code === 0 ? 'success' : 'failed'),
        finished_at: now(),
        exit_code: code,
      });
      if (wasCancelled) {
        markWorkerCancelled(jobId, 'cancelled while account was running');
        return resolve();
      }
      const job = readWorkerJobs().find((item) => item.id === jobId) || {};
      updateWorkerJob(jobId, {
        completed: Number(job.completed || 0) + 1,
        failed: Number(job.failed || 0) + (code === 0 ? 0 : 1),
        current: null,
        updated_at: now(),
      });
      resolve();
    });
  })), Promise.resolve()).then(() => {
    const job = readWorkerJobs().find((item) => item.id === jobId) || {};
    if (job.status === 'cancelled') {
      appendWorkerLog(logFile, '\nworker cancelled\n');
      return;
    }
    updateWorkerJob(jobId, {
      status: Number(job.failed || 0) > 0 ? 'completed_with_errors' : 'completed',
      current: null,
      finished_at: now(),
      updated_at: now(),
    });
    appendWorkerLog(logFile, '\nworker finished\n');
  });
}

function sanitizeAccount(row) {
  if (!row) return row;
  const copy = { ...row };
  if (copy.api_key) copy.api_key_masked = maskSecret(copy.api_key);
  if (copy.access_token) copy.access_token_masked = maskSecret(copy.access_token);
  if (copy.refresh_token) copy.refresh_token_masked = maskSecret(copy.refresh_token);
  delete copy.api_key;
  delete copy.access_token;
  delete copy.refresh_token;
  copy.config = safeJsonParse(copy.config_json, {});
  return copy;
}

function readWorkerJobs() {
  try {
    if (!fs.existsSync(WORKER_JOBS_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(WORKER_JOBS_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeWorkerJobs(jobs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WORKER_JOBS_PATH, JSON.stringify(jobs.slice(-100), null, 2));
}

function upsertWorkerJob(job) {
  const jobs = readWorkerJobs();
  const idx = jobs.findIndex((item) => item.id === job.id);
  if (idx >= 0) jobs[idx] = { ...jobs[idx], ...job };
  else jobs.push(job);
  writeWorkerJobs(jobs);
}

function updateWorkerJob(id, patch) {
  const jobs = readWorkerJobs();
  const idx = jobs.findIndex((item) => item.id === id);
  if (idx < 0) return;
  jobs[idx] = { ...jobs[idx], ...patch, updated_at: patch.updated_at || now() };
  writeWorkerJobs(jobs);
}

function appendWorkerLog(logFile, text) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, text);
}

function isWorkerCancelled(jobId) {
  const job = readWorkerJobs().find((item) => item.id === jobId);
  return job && job.status === 'cancelled';
}

function markWorkerCancelled(jobId, reason) {
  const job = readWorkerJobs().find((item) => item.id === jobId);
  if (!job) return;
  const results = Array.isArray(job.results) ? job.results.map((item) => {
    if (item.status === 'queued' || item.status === 'running') {
      return {
        ...item,
        status: item.status === 'running' ? 'cancelled' : 'skipped',
        finished_at: item.finished_at || now(),
      };
    }
    return item;
  }) : [];
  updateWorkerJob(jobId, {
    status: 'cancelled',
    current: null,
    finished_at: now(),
    updated_at: now(),
    results,
  });
  if (job.logFile) appendWorkerLog(job.logFile, `\nworker cancelled: ${reason}\n`);
}

function setWorkerResult(jobId, email, patch) {
  const jobs = readWorkerJobs();
  const idx = jobs.findIndex((item) => item.id === jobId);
  if (idx < 0) return;
  const results = Array.isArray(jobs[idx].results) ? jobs[idx].results : [];
  const resultIdx = results.findIndex((item) => item.email === email);
  if (resultIdx >= 0) {
    results[resultIdx] = { ...results[resultIdx], ...patch };
  } else {
    results.push({ email, ...patch });
  }
  jobs[idx] = { ...jobs[idx], results, updated_at: now() };
  writeWorkerJobs(jobs);
}

/* ----------------------------- MODELS ------------------------------- */

router.get('/models', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, p.name AS provider_name, p.slug AS provider_slug
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY m.name ASC
  `).all();
  res.json({ data: rows });
});

router.post('/models', (req, res) => {
  const { name, display_name, provider_id, upstream_model, account_tier, enabled } = req.body || {};
  if (!name || !provider_id || !upstream_model) {
    return res.status(400).json({ error: 'name, provider_id, upstream_model required' });
  }
  const ts = now();
  try {
    const info = db.prepare(`
      INSERT INTO models (name, display_name, provider_id, upstream_model, account_tier, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, display_name || null, provider_id, upstream_model, account_tier || 'any', enabled ? 1 : 0, ts, ts);
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/models/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const fields = ['name', 'display_name', 'provider_id', 'upstream_model', 'account_tier', 'enabled'];
  const set = [];
  const params = { id, updated_at: now() };
  for (const f of fields) {
    if (f in req.body) {
      let v = req.body[f];
      if (f === 'enabled') v = v ? 1 : 0;
      set.push(`${f} = @${f}`);
      params[f] = v;
    }
  }
  if (!set.length) return res.json(row);
  db.prepare(`UPDATE models SET ${set.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  res.json(db.prepare('SELECT * FROM models WHERE id = ?').get(id));
});

router.delete('/models/:id', (req, res) => {
  const id = Number(req.params.id);
  const ts = now();
  const info = db.prepare(`UPDATE models SET deleted_at = ?, updated_at = ?, node_id = COALESCE((SELECT value FROM sync_config WHERE key = 'local_node_id'), node_id) WHERE id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

/* ---------------------------- API KEYS ------------------------------ */

router.get('/api-keys', (req, res) => {
  const rows = db.prepare('SELECT id, name, key_prefix, enabled, last_used_at, created_at, revoked_at FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  res.json({ data: rows });
});

router.post('/api-keys', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const key = generateApiKey();
  const hash = hashApiKey(key);
  const prefix = shortPrefix(key);
  const ts = now();
  db.prepare(`
    INSERT INTO api_keys (name, key_prefix, key_hash, enabled, created_at)
    VALUES (?, ?, ?, 1, ?)
  `).run(name, prefix, hash, ts);
  // Return plaintext key ONCE
  res.status(201).json({ name, key, key_prefix: prefix });
});

router.post('/api-keys/:id/revoke', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('UPDATE api_keys SET enabled = 0, revoked_at = ? WHERE id = ?').run(now(), id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.delete('/api-keys/:id', (req, res) => {
  const id = Number(req.params.id);
  const ts = now();
  const info = db.prepare(`UPDATE api_keys SET deleted_at = ?, revoked_at = COALESCE(revoked_at, ?), enabled = 0, node_id = COALESCE((SELECT value FROM sync_config WHERE key = 'local_node_id'), node_id) WHERE id = ? AND deleted_at IS NULL`).run(ts, ts, id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

/* ------------------------------ LOGS -------------------------------- */

router.get('/logs', (req, res) => {
  const pageData = getLogPage({
    page: req.query.page,
    perPage: req.query.perPage || req.query.limit || DEFAULT_LOGS_PER_PAGE,
  });
  res.json({ data: pageData.rows, ...pageData });
});

/* ------------------------- PROVIDER TYPES --------------------------- */

router.get('/provider-types', (req, res) => {
  res.json({ data: listTypes() });
});

/* --------------------------- MYSQL BACKUP --------------------------- */

const backup = require('../db/backup');

router.get('/backup/status', (req, res) => {
  res.json(backup.getBackupStatus());
});

router.post('/backup/run', async (req, res) => {
  try {
    const result = await backup.runBackupNow();
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result, status: backup.getBackupStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ------------------------ MULTI-INSTANCE SYNC ----------------------- */

const sync = require('../services/sync');

router.get('/sync/status', (req, res) => {
  res.json(sync.getStatus());
});

router.post('/sync/run', async (req, res) => {
  try {
    const result = await sync.runOnce();
    res.json({ ok: !!(result && (result.ok || result.skipped)), result, status: sync.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ----------------------- PLAYGROUND PROXY --------------------------- */

/**
 * Admin-only chat endpoint used by the dashboard Playground. Same resolution
 * + adapter logic as /v1/chat/completions but authenticated via admin session
 * rather than an API key (so no raw key needs to be shown to the browser).
 * Optionally attaches a given api_key_id to the request log for attribution.
 */
router.post('/playground/chat', async (req, res) => {
  const body = { ...(req.body || {}) };
  const apiKeyId = Number(body.__api_key_id) || null;
  delete body.__api_key_id;

  await proxyModelRequest({
    body,
    res,
    apiKeyId,
    adapterMethod: 'chatCompletions',
    endpoint: '/api/admin/playground/chat',
  });
});

router.post('/playground/responses', async (req, res) => {
  const body = { ...(req.body || {}) };
  const apiKeyId = Number(body.__api_key_id) || null;
  delete body.__api_key_id;

  await proxyModelRequest({
    body,
    res,
    apiKeyId,
    adapterMethod: 'responses',
    endpoint: '/api/admin/playground/responses',
  });
});

/* ---------------------------- PROXIES ------------------------------ */

const {
  parseProxyUrl,
  createProxyFromUrl,
  listProxies,
  getProxy,
  updateProxy,
  deleteProxy,
  testProxy,
  testAllProxies,
  getProxySettings,
  updateProxySettings,
  startAutoTest,
  stopAutoTest,
  PROXY_FEATURES,
  listFeatureFlags,
  setFeatureFlag,
  listProviderFeatureOverrides,
  setProviderFeatureOverride,
  removeProviderFeatureOverride,
} = require('../services/proxyService');

/**
 * List all proxies.
 */
router.get('/proxies', (req, res) => {
  const proxies = listProxies({});
  // Mask passwords in response
  const data = proxies.map((p) => ({
    ...p,
    password: p.password ? '****' : null,
  }));
  res.json({ data });
});

/**
 * Create a new proxy from URL format.
 * Body: { name, url, notes? }
 * URL format: http://username:password@host:port
 */
router.post('/proxies', (req, res) => {
  const { name, url, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!url) return res.status(400).json({ error: 'url required' });

  const result = createProxyFromUrl({ name, url, notes });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  res.status(201).json({ ok: true, proxy: { ...result.proxy, password: result.proxy.password ? '****' : null } });
});

/**
 * Get a single proxy.
 */
router.get('/proxies/:id', (req, res) => {
  const id = Number(req.params.id);
  const proxy = getProxy(id);
  if (!proxy) return res.status(404).json({ error: 'not found' });
  res.json({ data: { ...proxy, password: proxy.password ? '****' : null } });
});

/**
 * Update a proxy.
 */
router.patch('/proxies/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = updateProxy(id, req.body || {});
  if (!result.ok) {
    return res.status(result.error === 'Proxy not found' ? 404 : 400).json({ error: result.error });
  }
  res.json({ ok: true, proxy: { ...result.proxy, password: result.proxy.password ? '****' : null } });
});

/**
 * Delete a proxy.
 */
router.delete('/proxies/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = deleteProxy(id);
  if (!result.ok) {
    return res.status(result.error === 'Proxy not found' ? 404 : 400).json({ error: result.error });
  }
  res.json({ ok: true });
});

/**
 * Test a single proxy.
 */
router.post('/proxies/:id/test', async (req, res) => {
  const id = Number(req.params.id);
  const proxy = getProxy(id);
  if (!proxy) return res.status(404).json({ error: 'not found' });

  const result = await testProxy(proxy);
  
  // Update health status
  const { updateProxyHealth } = require('../services/proxyService');
  updateProxyHealth(id, result);

  res.json({
    ok: result.ok,
    latency_ms: result.latencyMs,
    ip: result.ip,
    error: result.error,
  });
});

/**
 * Test all enabled proxies.
 */
router.post('/proxies/test-all', async (req, res) => {
  await testAllProxies();
  res.json({ ok: true });
});

/**
 * Get proxy settings.
 */
router.get('/proxy-settings', (req, res) => {
  const settings = getProxySettings();
  res.json({ data: settings });
});

/**
 * Update proxy settings.
 */
router.patch('/proxy-settings', (req, res) => {
  const body = req.body || {};
  const allowedKeys = [
    'auto_test_enabled',
    'auto_test_interval_min',
    'health_threshold_ms',
    'max_fail_count',
  ];
  
  const updates = {};
  for (const key of allowedKeys) {
    if (key in body) {
      updates[key] = body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no valid settings provided' });
  }

  updateProxySettings(updates);

  // Restart auto-test if needed
  if ('auto_test_enabled' in updates) {
    if (updates.auto_test_enabled === '1' || updates.auto_test_enabled === 1 || updates.auto_test_enabled === true) {
      startAutoTest();
    } else {
      stopAutoTest();
    }
  }

  res.json({ ok: true, settings: getProxySettings() });
});

/**
 * Assign proxy to provider.
 */
router.patch('/providers/:id/proxy', (req, res) => {
  const id = Number(req.params.id);
  const { proxy_id, proxy_enabled, proxy_mode } = req.body || {};

  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  if (!provider) return res.status(404).json({ error: 'provider not found' });

  const updates = [];
  const params = { id, updated_at: now() };

  if (proxy_id !== undefined) {
    updates.push('proxy_id = @proxy_id');
    params.proxy_id = proxy_id || null;
  }
  if (proxy_enabled !== undefined) {
    updates.push('proxy_enabled = @proxy_enabled');
    params.proxy_enabled = proxy_enabled ? 1 : 0;
  }
  if (proxy_mode !== undefined) {
    updates.push('proxy_mode = @proxy_mode');
    params.proxy_mode = proxy_mode || 'manual';
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no proxy fields to update' });
  }

  db.prepare(`UPDATE providers SET ${updates.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  const updated = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);

  res.json({ ok: true, provider: sanitizeProvider(updated) });
});

/**
 * Assign proxy to account.
 */
router.patch('/accounts/:id/proxy', (req, res) => {
  const id = Number(req.params.id);
  const { proxy_id, proxy_enabled } = req.body || {};

  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);
  if (!account) return res.status(404).json({ error: 'account not found' });

  const updates = [];
  const params = { id, updated_at: now() };

  if (proxy_id !== undefined) {
    updates.push('proxy_id = @proxy_id');
    params.proxy_id = proxy_id || null;
  }
  if (proxy_enabled !== undefined) {
    updates.push('proxy_enabled = @proxy_enabled');
    params.proxy_enabled = proxy_enabled ? 1 : 0;
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no proxy fields to update' });
  }

  db.prepare(`UPDATE provider_accounts SET ${updates.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  const updated = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id);

  res.json({ ok: true, account: sanitizeAccount(updated) });
});

/**
 * Get proxy usage logs.
 */
router.get('/proxy-usage-logs', (req, res) => {
  const proxyId = Number(req.query.proxy_id) || null;
  const limit = Math.min(100, Number(req.query.limit) || 50);

  let sql = `
    SELECT l.*, p.name AS proxy_name, pr.name AS provider_name, a.email AS account_email
    FROM proxy_usage_logs l
    LEFT JOIN proxies p ON p.id = l.proxy_id
    LEFT JOIN providers pr ON pr.id = l.provider_id
    LEFT JOIN provider_accounts a ON a.id = l.account_id
  `;
  const params = [];

  if (proxyId) {
    sql += ' WHERE l.proxy_id = ?';
    params.push(proxyId);
  }

  sql += ' ORDER BY l.created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  res.json({ data: rows });
});

/* ----------------- PROXY FEATURE FLAGS (global) ----------------- */

/**
 * List available proxy features and their global enabled state.
 */
router.get('/proxy-features', (req, res) => {
  res.json({
    available: PROXY_FEATURES,
    flags: listFeatureFlags(),
  });
});

/**
 * Update a global feature flag.
 * Body: { feature, enabled }
 */
router.patch('/proxy-features', (req, res) => {
  const { feature, enabled } = req.body || {};
  if (!feature) return res.status(400).json({ error: 'feature is required' });
  try {
    setFeatureFlag(feature, enabled);
    res.json({ ok: true, flags: listFeatureFlags() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ----------------- PER-PROVIDER PROXY FEATURE OVERRIDES ----------------- */

/**
 * Get per-provider feature overrides.
 */
router.get('/providers/:id/proxy-features', (req, res) => {
  const providerId = Number(req.params.id);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'provider not found' });

  res.json({
    provider_id: providerId,
    available: PROXY_FEATURES,
    overrides: listProviderFeatureOverrides(providerId),
    global: listFeatureFlags(),
  });
});

/**
 * Set or remove a per-provider feature override.
 * Body: { feature, enabled (null|0|1), proxy_id? }
 *   - enabled=null removes the override (revert to global default)
 */
router.patch('/providers/:id/proxy-features', (req, res) => {
  const providerId = Number(req.params.id);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).json({ error: 'provider not found' });

  const { feature, enabled, proxy_id } = req.body || {};
  if (!feature) return res.status(400).json({ error: 'feature is required' });

  try {
    if (enabled === null || enabled === undefined) {
      removeProviderFeatureOverride(providerId, feature);
    } else {
      setProviderFeatureOverride({
        providerId,
        feature,
        enabled: enabled === true || enabled === 1 || enabled === '1',
        proxyId: proxy_id || null,
      });
    }
    res.json({ ok: true, overrides: listProviderFeatureOverrides(providerId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
