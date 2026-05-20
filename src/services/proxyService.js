'use strict';

/**
 * src/services/proxyService.js — Proxy management service.
 *
 * Features:
 *   - Parse proxy URLs: http://user:pass@host:port
 *   - Health checking with configurable intervals
 *   - Automatic rotation based on health
 *   - Integration with fetch requests
 */

const db = require('../db');
const { now, safeJsonParse } = require('../utils/common');

// Proxy test endpoints
const TEST_ENDPOINTS = [
  'https://api.ipify.org?format=json',
  'https://icanhazip.com',
  'https://ifconfig.me/ip',
];

// In-memory state
const state = {
  testTimer: null,
  testing: false,
};

/**
 * Parse proxy URL string.
 * Formats:
 *   - http://host:port
 *   - http://username:password@host:port
 *   - https://host:port
 *   - socks5://host:port
 * @param {string} proxyUrl
 * @returns {{ok: boolean, host?: string, port?: number, username?: string, password?: string, protocol?: string, error?: string}}
 */
function parseProxyUrl(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') {
    return { ok: false, error: 'Proxy URL is required' };
  }

  try {
    const url = new URL(proxyUrl);
    const protocol = url.protocol.replace(':', '').toLowerCase();
    
    if (!['http', 'https', 'socks5'].includes(protocol)) {
      return { ok: false, error: 'Unsupported protocol. Use http, https, or socks5' };
    }

    const port = parseInt(url.port, 10);
    if (!port || port < 1 || port > 65535) {
      return { ok: false, error: 'Invalid port number' };
    }

    return {
      ok: true,
      host: url.hostname,
      port,
      username: url.username || null,
      password: url.password || null,
      protocol,
    };
  } catch (err) {
    return { ok: false, error: `Invalid proxy URL: ${err.message}` };
  }
}

/**
 * Create proxy from URL.
 * @param {object} options
 * @param {string} options.name - Friendly name
 * @param {string} options.url - Proxy URL
 * @param {string} [options.notes]
 * @returns {Promise<{ok: boolean, proxy?: object, error?: string}>}
 */
function createProxyFromUrl({ name, url, notes }) {
  const parsed = parseProxyUrl(url);
  if (!parsed.ok) return parsed;

  const ts = now();
  const uuid = require('crypto').randomBytes(16).toString('hex');

  try {
    const info = db.prepare(`
      INSERT INTO proxies (name, host, port, username, password, protocol, notes, enabled, status, created_at, updated_at, uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'unknown', ?, ?, ?)
    `).run(name, parsed.host, parsed.port, parsed.username, parsed.password, parsed.protocol, notes, ts, ts, uuid);

    const proxy = db.prepare('SELECT * FROM proxies WHERE id = ?').get(info.lastInsertRowid);
    return { ok: true, proxy };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get all proxies.
 * @param {object} options
 * @param {boolean} [options.enabledOnly]
 * @returns {object[]}
 */
function listProxies({ enabledOnly } = {}) {
  let sql = 'SELECT * FROM proxies WHERE deleted_at IS NULL';
  if (enabledOnly) sql += ' AND enabled = 1';
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all();
}

/**
 * Get proxy by ID.
 * @param {number} id
 * @returns {object|null}
 */
function getProxy(id) {
  return db.prepare('SELECT * FROM proxies WHERE id = ? AND deleted_at IS NULL').get(id);
}

/**
 * Update proxy.
 * @param {number} id
 * @param {object} data
 * @returns {{ok: boolean, proxy?: object, error?: string}}
 */
function updateProxy(id, data) {
  const existing = getProxy(id);
  if (!existing) return { ok: false, error: 'Proxy not found' };

  const fields = ['name', 'host', 'port', 'username', 'password', 'protocol', 'enabled', 'notes', 'status'];
  const set = ['updated_at = ?'];
  const params = [now()];

  for (const f of fields) {
    if (f in data) {
      set.push(`${f} = ?`);
      params.push(data[f]);
    }
  }

  params.push(id);
  db.prepare(`UPDATE proxies SET ${set.join(', ')} WHERE id = ?`).run(...params);

  return { ok: true, proxy: getProxy(id) };
}

/**
 * Delete proxy (soft delete).
 * @param {number} id
 * @returns {{ok: boolean, error?: string}}
 */
function deleteProxy(id) {
  const existing = getProxy(id);
  if (!existing) return { ok: false, error: 'Proxy not found' };

  // Remove from providers and accounts
  db.prepare('UPDATE providers SET proxy_id = NULL WHERE proxy_id = ?').run(id);
  db.prepare('UPDATE provider_accounts SET proxy_id = NULL WHERE proxy_id = ?').run(id);

  // Soft delete
  db.prepare('UPDATE proxies SET deleted_at = ?, enabled = 0 WHERE id = ?').run(now(), id);

  return { ok: true };
}

/**
 * Test a single proxy by making a request through it.
 * @param {object} proxy
 * @param {string} [testUrl]
 * @returns {Promise<{ok: boolean, latencyMs?: number, ip?: string, error?: string}>}
 */
async function testProxy(proxy, testUrl) {
  const url = testUrl || TEST_ENDPOINTS[Math.floor(Math.random() * TEST_ENDPOINTS.length)];
  
  // Build proxy agent URL
  let proxyUrl;
  if (proxy.username && proxy.password) {
    proxyUrl = `${proxy.protocol}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
  } else {
    proxyUrl = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
  }

  const start = Date.now();
  
  try {
    // Use undici or native fetch with proxy
    // Node.js fetch doesn't support proxy directly, we need to use a workaround
    const { HttpProxyAgent } = await import('undici').catch(() => ({ HttpProxyAgent: null }));
    
    if (!HttpProxyAgent) {
      // Fallback: use simple socket test
      return testProxySocket(proxy);
    }

    const agent = new HttpProxyAgent(proxyUrl);
    const res = await fetch(url, {
      agent,
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    const text = await res.text();
    let ip = text.trim();
    
    // Try to parse JSON response (like ipify)
    try {
      const json = JSON.parse(text);
      ip = json.ip || ip;
    } catch {}

    return { ok: true, latencyMs, ip };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { ok: false, latencyMs, error: err.message };
  }
}

/**
 * Fallback socket-based proxy test.
 */
async function testProxySocket(proxy) {
  const net = require('net');
  const start = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timeout' });
    }, 10000);

    socket.connect(proxy.port, proxy.host, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({ ok: true, latencyMs: Date.now() - start, ip: null });
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
    });
  });
}

/**
 * Update proxy health status.
 * @param {number} proxyId
 * @param {{ok: boolean, latencyMs?: number, error?: string}} result
 */
function updateProxyHealth(proxyId, result) {
  const ts = now();
  
  if (result.ok) {
    db.prepare(`
      UPDATE proxies SET 
        status = 'healthy',
        last_test_at = ?,
        last_latency_ms = ?,
        fail_count = 0,
        success_count = success_count + 1,
        updated_at = ?
      WHERE id = ?
    `).run(ts, result.latencyMs, ts, proxyId);
  } else {
    db.prepare(`
      UPDATE proxies SET 
        status = 'unhealthy',
        last_test_at = ?,
        last_latency_ms = ?,
        fail_count = fail_count + 1,
        updated_at = ?
      WHERE id = ?
    `).run(ts, result.latencyMs || null, ts, proxyId);
  }
}

/**
 * Test all enabled proxies.
 */
async function testAllProxies() {
  if (state.testing) return;
  state.testing = true;

  const proxies = listProxies({ enabledOnly: true });
  
  for (const proxy of proxies) {
    // Mark as testing
    db.prepare("UPDATE proxies SET status = 'testing' WHERE id = ?").run(proxy.id);
    
    const result = await testProxy(proxy);
    updateProxyHealth(proxy.id, result);
    
    // Log usage
    logProxyUsage(proxy.id, null, null, 'health_check', result.ok, result.latencyMs, result.error);
  }

  state.testing = false;
}

/**
 * Log proxy usage.
 */
function logProxyUsage(proxyId, providerId, accountId, endpoint, success, latencyMs, error) {
  db.prepare(`
    INSERT INTO proxy_usage_logs (proxy_id, provider_id, account_id, endpoint, success, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(proxyId, providerId, accountId, endpoint, success ? 1 : 0, latencyMs, error, now());
}

/**
 * Get best proxy for a provider (auto-rotation).
 * @param {number} providerId
 * @returns {object|null}
 */
function getBestProxyForProvider(providerId) {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return null;

  // If provider has manual proxy mode, use assigned proxy
  if (provider.proxy_mode === 'manual' && provider.proxy_id) {
    return getProxy(provider.proxy_id);
  }

  // For auto_rotate or health_based, get healthy proxies
  const healthyProxies = db.prepare(`
    SELECT * FROM proxies 
    WHERE deleted_at IS NULL AND enabled = 1 AND status = 'healthy'
    ORDER BY last_latency_ms ASC, fail_count ASC, success_count DESC
  `).all();

  if (!healthyProxies.length) return null;

  if (provider.proxy_mode === 'health_based') {
    // Pick the healthiest
    return healthyProxies[0];
  }

  // auto_rotate: round-robin based on last usage
  // For simplicity, pick randomly from top 3
  const topProxies = healthyProxies.slice(0, 3);
  return topProxies[Math.floor(Math.random() * topProxies.length)];
}

/**
 * Get proxy for an account.
 * @param {number} accountId
 * @returns {object|null}
 */
function getProxyForAccount(accountId) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return null;

  // Account-level proxy takes priority
  if (account.proxy_enabled && account.proxy_id) {
    return getProxy(account.proxy_id);
  }

  // Fall back to provider proxy
  if (account.provider_id) {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(account.provider_id);
    if (provider && provider.proxy_enabled && provider.proxy_id) {
      return getProxy(provider.proxy_id);
    }
  }

  return null;
}

/* ==================== FEATURE FLAGS ==================== */

// Known proxy features
const PROXY_FEATURES = [
  'refresh_token',        // OAuth refresh token requests
  'token_import',         // Token import flow (Kiro home/usage HTML scraping)
  'api_request',          // Actual API/model requests routed through provider
  'warmup',               // Warmup requests
  'subscription_check',   // Usage / subscription tier checks
  'health_check',         // Proxy's own health check (always recommended on)
];

/**
 * Check if a proxy feature is enabled globally.
 * @param {string} feature
 * @returns {boolean}
 */
function isFeatureEnabledGlobally(feature) {
  const row = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(`proxy_feature_${feature}`);
  return row && String(row.value) === '1';
}

/**
 * Check if a proxy feature is enabled for a provider.
 * Per-provider override > global setting.
 * @param {number|null} providerId
 * @param {string} feature
 * @returns {boolean}
 */
function isFeatureEnabledForProvider(providerId, feature) {
  if (providerId) {
    const override = db.prepare(
      'SELECT enabled FROM provider_proxy_features WHERE provider_id = ? AND feature = ?'
    ).get(providerId, feature);
    if (override) return Number(override.enabled) === 1;
  }
  return isFeatureEnabledGlobally(feature);
}

/**
 * Resolve which proxy (if any) to use for a given feature + provider + account.
 * Returns null if proxy should not be used.
 *
 * Priority:
 *   1. Per-provider+feature pinned proxy (if set)
 *   2. Account-level proxy (if account has one)
 *   3. Provider-level proxy
 *   4. Best healthy proxy (auto-rotation)
 *
 * @param {object} options
 * @param {string} options.feature - One of PROXY_FEATURES
 * @param {number} [options.providerId]
 * @param {number} [options.accountId]
 * @returns {object|null} proxy row or null
 */
function resolveProxy({ feature, providerId, accountId }) {
  if (!feature) return null;

  // Resolve providerId from accountId if not provided
  if (!providerId && accountId) {
    const acc = db.prepare('SELECT provider_id FROM provider_accounts WHERE id = ?').get(accountId);
    if (acc) providerId = acc.provider_id;
  }

  // Check feature flag
  if (!isFeatureEnabledForProvider(providerId, feature)) {
    return null;
  }

  // 1. Check pinned proxy for provider+feature
  if (providerId) {
    const pinned = db.prepare(
      'SELECT proxy_id FROM provider_proxy_features WHERE provider_id = ? AND feature = ? AND proxy_id IS NOT NULL'
    ).get(providerId, feature);
    if (pinned && pinned.proxy_id) {
      const proxy = getProxy(pinned.proxy_id);
      if (proxy && proxy.enabled) return proxy;
    }
  }

  // 2. Account-level proxy
  if (accountId) {
    const accProxy = getProxyForAccount(accountId);
    if (accProxy && accProxy.enabled) return accProxy;
  }

  // 3. Provider-level proxy
  if (providerId) {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (provider && provider.proxy_enabled && provider.proxy_id) {
      const proxy = getProxy(provider.proxy_id);
      if (proxy && proxy.enabled) return proxy;
    }

    // 4. Auto-rotation if provider mode allows
    if (provider && provider.proxy_enabled && (provider.proxy_mode === 'auto_rotate' || provider.proxy_mode === 'health_based')) {
      return getBestProxyForProvider(providerId);
    }
  }

  // 5. Feature-flag fallback: when the operator turned the feature ON but
  //    didn't bind a specific proxy, use the best healthy enabled proxy
  //    rather than silently going direct. Without this, the WAF block on
  //    the egress IP keeps surfacing as a 403 even though a working proxy
  //    is configured. Disable per-feature with `proxy_feature_<name>=0`
  //    or set `proxy_feature_<name>_strict=1` to opt out of fallback only.
  const strictKey = `proxy_feature_${feature}_strict`;
  const strictRow = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(strictKey);
  if (!strictRow || String(strictRow.value) !== '1') {
    const candidate = db.prepare(`
      SELECT * FROM proxies
      WHERE deleted_at IS NULL AND enabled = 1
      ORDER BY
        CASE WHEN status = 'healthy' THEN 0 ELSE 1 END,
        last_latency_ms ASC,
        fail_count ASC,
        success_count DESC
      LIMIT 1
    `).get();
    if (candidate) return candidate;
  }

  return null;
}

/**
 * List feature flag settings for all features.
 * @returns {Array<{feature: string, enabled: boolean}>}
 */
function listFeatureFlags() {
  return PROXY_FEATURES.map(feature => ({
    feature,
    enabled: isFeatureEnabledGlobally(feature),
  }));
}

/**
 * Update a global feature flag.
 * @param {string} feature
 * @param {boolean|number|string} enabled
 */
function setFeatureFlag(feature, enabled) {
  if (!PROXY_FEATURES.includes(feature)) {
    throw new Error(`Unknown feature: ${feature}`);
  }
  const value = (enabled === true || enabled === '1' || enabled === 1) ? '1' : '0';
  db.prepare('INSERT OR REPLACE INTO sync_config (key, value, updated_at) VALUES (?, ?, ?)')
    .run(`proxy_feature_${feature}`, value, now());
}

/**
 * Get all per-provider feature overrides.
 * @param {number} providerId
 * @returns {Array<{feature: string, enabled: boolean, proxy_id: number|null}>}
 */
function listProviderFeatureOverrides(providerId) {
  return db.prepare(`
    SELECT feature, enabled, proxy_id 
    FROM provider_proxy_features 
    WHERE provider_id = ?
  `).all(providerId).map(r => ({
    feature: r.feature,
    enabled: Number(r.enabled) === 1,
    proxy_id: r.proxy_id,
  }));
}

/**
 * Set a per-provider feature override.
 * @param {object} options
 * @param {number} options.providerId
 * @param {string} options.feature
 * @param {boolean|number|null} options.enabled - null/undefined to remove override
 * @param {number} [options.proxyId] - Optional pinned proxy
 */
function setProviderFeatureOverride({ providerId, feature, enabled, proxyId }) {
  if (!PROXY_FEATURES.includes(feature)) {
    throw new Error(`Unknown feature: ${feature}`);
  }

  // null/undefined removes override (revert to global)
  if (enabled === null || enabled === undefined) {
    db.prepare('DELETE FROM provider_proxy_features WHERE provider_id = ? AND feature = ?')
      .run(providerId, feature);
    return;
  }

  const value = (enabled === true || enabled === '1' || enabled === 1) ? 1 : 0;
  db.prepare(`
    INSERT OR REPLACE INTO provider_proxy_features (provider_id, feature, enabled, proxy_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(providerId, feature, value, proxyId || null, now());
}

/**
 * Remove a provider feature override (revert to global).
 */
function removeProviderFeatureOverride(providerId, feature) {
  db.prepare('DELETE FROM provider_proxy_features WHERE provider_id = ? AND feature = ?')
    .run(providerId, feature);
}

/**
 * Build an undici Dispatcher for the given proxy row, suitable for
 * `fetch(url, { dispatcher })`. Supports http(s) and socks5/socks5h/socks4.
 *
 * Note: Node's global `fetch` ignores the `agent` option entirely. We must
 * use the `dispatcher` option (undici-style) to actually route traffic.
 *
 * @param {object} proxy - row from `proxies` table
 * @returns {Promise<import('undici').Dispatcher|null>}
 */
async function buildProxyAgent(proxy) {
  if (!proxy || !proxy.host || !proxy.port) return null;

  const protocol = String(proxy.protocol || 'http').toLowerCase();
  const auth = (proxy.username && proxy.password)
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  const proxyUrl = `${protocol}://${auth}${proxy.host}:${proxy.port}`;

  try {
    const undici = require('undici');

    if (protocol === 'socks' || protocol === 'socks4' || protocol === 'socks4a'
        || protocol === 'socks5' || protocol === 'socks5h') {
      const { SocksClient } = require('socks');
      const tls = require('node:tls');

      const socksType = (protocol === 'socks4' || protocol === 'socks4a') ? 4 : 5;
      const proxyConfig = {
        host: proxy.host,
        port: Number(proxy.port),
        type: socksType,
      };
      if (proxy.username) proxyConfig.userId = proxy.username;
      if (proxy.password) proxyConfig.password = proxy.password;

      // Custom undici Pool/Agent.connect that opens a SOCKS tunnel for each
      // origin, then optionally wraps the resulting TCP socket in TLS.
      return new undici.Agent({
        connect: async (options, callback) => {
          try {
            const target = {
              host: options.hostname || options.host,
              port: Number(options.port) || (options.protocol === 'http:' ? 80 : 443),
            };

            const { socket } = await SocksClient.createConnection({
              proxy: proxyConfig,
              command: 'connect',
              destination: target,
              timeout: 15000,
            });

            // For HTTPS targets undici expects a TLS socket. Upgrade now.
            if (options.protocol !== 'http:') {
              const tlsSocket = tls.connect({
                socket,
                servername: target.host,
                ALPNProtocols: options.allowH2 ? ['h2', 'http/1.1'] : ['http/1.1'],
                rejectUnauthorized: options.rejectUnauthorized !== false,
              });
              tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
              tlsSocket.once('error', (err) => callback(err));
              return;
            }

            callback(null, socket);
          } catch (err) {
            callback(err);
          }
        },
      });
    }

    // http / https proxies: undici's built-in ProxyAgent does CONNECT correctly.
    return new undici.ProxyAgent({ uri: proxyUrl });
  } catch (err) {
    // Surface the real reason — silently returning null hid this bug for months.
    // Caller treats null as "no proxy", so log loudly and keep going.
    // eslint-disable-next-line no-console
    console.error(`[proxy] failed to build dispatcher for proxy id=${proxy.id} (${protocol}://${proxy.host}:${proxy.port}): ${err.message}`);
    return null;
  }
}

/**
 * Get proxy settings.
 */
function getProxySettings() {
  const rows = db.prepare("SELECT key, value FROM sync_config WHERE key LIKE 'proxy_%'").all();
  const settings = {};
  for (const row of rows) {
    const key = row.key.replace('proxy_', '');
    settings[key] = row.value;
  }
  return settings;
}

/**
 * Update proxy settings.
 */
function updateProxySettings(settings) {
  const stmt = db.prepare('INSERT OR REPLACE INTO sync_config (key, value, updated_at) VALUES (?, ?, ?)');
  const ts = now();
  for (const [key, value] of Object.entries(settings)) {
    stmt.run(`proxy_${key}`, String(value), ts);
  }
}

/**
 * Start auto-test scheduler.
 */
function startAutoTest() {
  if (state.testTimer) {
    clearInterval(state.testTimer);
  }

  const settings = getProxySettings();
  if (settings.auto_test_enabled !== '1') return;

  const intervalMs = Math.max(60000, (Number(settings.auto_test_interval_min) || 30) * 60000);
  
  state.testTimer = setInterval(() => {
    testAllProxies().catch(err => {
      console.error('[proxy] auto-test error:', err.message);
    });
  }, intervalMs);

  console.log(`[proxy] auto-test started, interval: ${intervalMs / 60000} minutes`);
}

/**
 * Stop auto-test scheduler.
 */
function stopAutoTest() {
  if (state.testTimer) {
    clearInterval(state.testTimer);
    state.testTimer = null;
  }
  console.log('[proxy] auto-test stopped');
}

/**
 * Initialize proxy service.
 */
function init() {
  // Backfill uuids for existing proxies
  db.prepare(`
    UPDATE proxies SET uuid = lower(hex(randomblob(16))) 
    WHERE uuid IS NULL OR uuid = ''
  `).run();

  // Start auto-test if enabled
  startAutoTest();
}

module.exports = {
  PROXY_FEATURES,
  parseProxyUrl,
  createProxyFromUrl,
  listProxies,
  getProxy,
  updateProxy,
  deleteProxy,
  testProxy,
  testAllProxies,
  updateProxyHealth,
  getBestProxyForProvider,
  getProxyForAccount,
  resolveProxy,
  buildProxyAgent,
  logProxyUsage,
  getProxySettings,
  updateProxySettings,
  isFeatureEnabledGlobally,
  isFeatureEnabledForProvider,
  listFeatureFlags,
  setFeatureFlag,
  listProviderFeatureOverrides,
  setProviderFeatureOverride,
  removeProviderFeatureOverride,
  startAutoTest,
  stopAutoTest,
  init,
};
