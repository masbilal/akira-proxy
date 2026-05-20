'use strict';

/**
 * scripts/login-codex.js — ChatGPT (Codex) OAuth PKCE login.
 *
 * Flow (matches the official `codex` CLI from OpenAI):
 *   1. Generate PKCE pair (code_verifier + code_challenge).
 *   2. Spin up a tiny HTTP server on http://localhost:1455 that listens for
 *      the OAuth redirect at /auth/callback. OpenAI validates the redirect
 *      URI character-for-character, so the port MUST be free.
 *   3. Open the browser at
 *      https://auth.openai.com/oauth/authorize?...
 *      with scope="openid profile email offline_access" (space encoded as %20,
 *      NOT "+"), plus the codex-specific flags that signal "CLI simplified
 *      flow".
 *   4. User signs in. Browser redirects back to /auth/callback?code=...&state=..
 *      We capture the authorization code and shut the server down.
 *   5. Exchange the code at https://auth.openai.com/oauth/token
 *      (application/x-www-form-urlencoded) to receive access_token,
 *      refresh_token, id_token, expires_in.
 *   6. Decode id_token (JWT payload only — signature not verified here) to
 *      extract `chatgpt_account_id`, `chatgpt_plan_type`, and `email`.
 *   7. Upsert into provider_accounts under the 'codex' provider slug.
 *
 * Usage:
 *   npm run login:codex
 *   node scripts/login-codex.js --label "personal" --port 1455
 *
 * Notes:
 *   - Access token lives ~5 days; refresh token rotates on use.
 *   - Tier mapping is taken from chatgpt_plan_type: free | plus | pro | team |
 *     business | enterprise.
 */

require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { now } = require('../src/utils/common');
const { run: migrate } = require('../src/db/migrate');

migrate();

// ---------- CLI args ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const LABEL = argVal('--label') || process.env.CODEX_LABEL || null;
const PORT = Number(argVal('--port') || process.env.CODEX_LOGIN_PORT || 1455) || 1455;
const FORCE = flag('--force');
const TIMEOUT_MS = Math.max(60_000, Number(argVal('--timeout-ms') || 600_000) || 600_000);

// ---------- constants ----------

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'codex_cli_rs';

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- helpers ----------

function log(msg) {
  process.stdout.write(`[codex-login] ${msg}\n`);
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthUrl({ challenge, state }) {
  // Build query string manually so `space` encodes as %20 (OpenAI rejects "+").
  const params = [
    ['response_type', 'code'],
    ['client_id', CLIENT_ID],
    ['redirect_uri', REDIRECT_URI],
    ['scope', SCOPE],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    ['id_token_add_organizations', 'true'],
    ['codex_cli_simplified_flow', 'true'],
    ['originator', ORIGINATOR],
    ['state', state],
  ];
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${AUTHORIZE_URL}?${qs}`;
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    // `start "" "<url>"` — empty title arg prevents cmd from consuming the URL.
    exec(`start "" "${url}"`);
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function waitForCallback({ port, expectedState }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { server.close(); } catch { /* noop */ }
      reject(new Error(`Timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for callback`));
    }, TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      if (!req.url) return res.end();
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const err = url.searchParams.get('error');
      const errDesc = url.searchParams.get('error_description');

      if (err) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(renderHtml('Login failed', `${err}${errDesc ? `: ${errDesc}` : ''}`));
        clearTimeout(timer);
        setTimeout(() => server.close(), 100);
        reject(new Error(`OAuth error: ${err}${errDesc ? ` (${errDesc})` : ''}`));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.end('Missing code');
        return;
      }

      if (expectedState && state !== expectedState) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(renderHtml('State mismatch', 'The returned state did not match the one we sent. Aborting.'));
        clearTimeout(timer);
        setTimeout(() => server.close(), 100);
        reject(new Error('state parameter mismatch'));
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(renderHtml(
        'Codex login complete',
        'You can close this tab and return to the terminal.'
      ));

      clearTimeout(timer);
      // Give the browser a moment to receive the body before killing the socket.
      setTimeout(() => server.close(), 250);
      if (!timedOut) resolve({ code, state });
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use. OpenAI validates the redirect URI ` +
          `character-for-character, so another free port cannot be substituted. ` +
          `Close whatever is listening on ${port} and retry.`
        ));
        return;
      }
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      log(`Listening on ${REDIRECT_URI}`);
    });
  });
}

function renderHtml(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#0b0f17; color:#e6edf3; margin:0; padding:0; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .card { max-width: 480px; padding: 32px; background:#111827; border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.4); text-align:center; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p  { margin: 0; color:#9ca3af; line-height:1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function exchangeCodeForTokens(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'accept': 'application/json',
    },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (res.status !== 200) {
    throw new Error(`token exchange failed: status=${res.status} body=${String(text).slice(0, 300)}`);
  }
  return parsed;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '==='.slice((payload.length + 3) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function mapPlanTier(rawPlan) {
  const plan = String(rawPlan || '').toLowerCase();
  if (!plan) return 'unknown';
  if (plan.includes('enterprise')) return 'enterprise';
  if (plan.includes('business')) return 'business';
  if (plan.includes('team')) return 'team';
  if (plan === 'pro' || plan.includes('pro')) return 'pro';
  if (plan.includes('plus')) return 'plus';
  if (plan.includes('free')) return 'free';
  return plan;
}

function persistTokens({ access, refresh, idToken, expiresIn, planType, accountId, email }) {
  const prov = db.prepare("SELECT id, name, config_json FROM providers WHERE slug = 'codex'").get();
  if (!prov) {
    throw new Error('No provider with slug "codex" found. Run `npm run migrate` first.');
  }

  const existing = email
    ? db.prepare('SELECT * FROM provider_accounts WHERE provider_id = ? AND email = ?').get(prov.id, email)
    : null;
  if (existing && !FORCE) {
    log(`Account for ${email} already exists (#${existing.id}); updating tokens in place. Use --force to rebuild config from scratch.`);
  }

  const existingCfg = (() => {
    try { return JSON.parse((existing && existing.config_json) || '{}'); } catch { return {}; }
  })();

  const tier = mapPlanTier(planType);
  const cfg = {
    ...(FORCE ? {} : existingCfg),
    auth: 'oauth-pkce',
    provider: 'codex',
    clientId: CLIENT_ID,
    chatgptAccountId: accountId || existingCfg.chatgptAccountId || null,
    chatgptPlanType: planType || existingCfg.chatgptPlanType || null,
    idToken: idToken || existingCfg.idToken || null,
    subscription: {
      tier,
      planType: planType || null,
      capturedAt: Math.floor(Date.now() / 1000),
    },
  };

  const exp = now() + Math.max(60, Number(expiresIn) || 3600);
  const ts = now();

  let accountRowId;
  if (existing) {
    db.prepare(`
      UPDATE provider_accounts
      SET label = COALESCE(@label, label),
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
      label: LABEL || existing.label || email || 'Codex account',
      email: email || existing.email || null,
      access,
      refresh,
      exp,
      cfg: JSON.stringify(cfg),
      ts,
    });
    accountRowId = existing.id;
  } else {
    const info = db.prepare(`
      INSERT INTO provider_accounts
        (provider_id, label, email, access_token, refresh_token, token_expires_at,
         config_json, enabled, created_at, updated_at)
      VALUES
        (@provider_id, @label, @email, @access, @refresh, @exp,
         @cfg, 1, @ts, @ts)
    `).run({
      provider_id: prov.id,
      label: LABEL || email || 'Codex account',
      email: email || null,
      access,
      refresh,
      exp,
      cfg: JSON.stringify(cfg),
      ts,
    });
    accountRowId = info.lastInsertRowid;
  }

  db.prepare(`
    UPDATE providers
    SET enabled = 1, auth_type = 'oauth', updated_at = ?
    WHERE id = ?
  `).run(ts, prov.id);

  return {
    prov,
    account: db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountRowId),
    tier,
    exp,
  };
}

// ---------- main ----------

async function main() {
  log(`PKCE OAuth flow against auth.openai.com (port=${PORT}, force=${FORCE})`);

  const { verifier, challenge } = generatePkce();
  const state = crypto.randomUUID();
  const authUrl = buildAuthUrl({ challenge, state });

  const callbackPromise = waitForCallback({ port: PORT, expectedState: state });

  log('Opening browser for ChatGPT login...');
  log(`If it does not open, copy this URL into your browser:\n    ${authUrl}`);
  openBrowser(authUrl);

  const { code } = await callbackPromise;
  log(`Authorization code received (${code.length} chars). Exchanging for tokens...`);

  const tokens = await exchangeCodeForTokens(code, verifier);
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  const idToken = tokens.id_token;
  const expiresIn = tokens.expires_in;
  if (!access) throw new Error('token response missing access_token: ' + JSON.stringify(tokens).slice(0, 200));

  const idPayload = decodeJwtPayload(idToken);
  const authClaim = idPayload['https://api.openai.com/auth'] || {};
  const accountId = authClaim.chatgpt_account_id || idPayload.chatgpt_account_id || null;
  const planType = authClaim.chatgpt_plan_type || idPayload.chatgpt_plan_type || null;
  const email = idPayload.email || null;

  if (!accountId) {
    log('WARNING: id_token did not include a chatgpt_account_id claim. Chat requests require this header and will fail without it.');
  }

  const saved = persistTokens({
    access, refresh, idToken, expiresIn, planType, accountId, email,
  });

  log('');
  log('=== LOGIN COMPLETE ===');
  log(`Provider:      #${saved.prov.id} ${saved.prov.name}`);
  log(`Account:       #${saved.account.id} ${saved.account.email || saved.account.label || ''}`);
  log(`Plan type:     ${planType || '(unknown)'}  → tier=${saved.tier}`);
  log(`Account id:    ${accountId || '(missing!)'}`);
  log(`Access expires:${new Date(saved.exp * 1000).toISOString()}  (~${Math.round(expiresIn / 3600)}h)`);
  log(`Refresh token: ${refresh ? 'stored' : 'NOT returned'}`);
}

main().catch((err) => {
  process.stderr.write(`[codex-login] ERROR: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
