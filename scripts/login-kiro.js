'use strict';

/**
 * scripts/login-kiro.js — Kiro OAuth PKCE login via the desktop auth endpoint.
 *
 * Flow (matches Kiro's official CLI / IDE):
 *   1. Generate PKCE pair (code_verifier + code_challenge).
 *   2. Open the Kiro login URL in Chromium; fill Google creds automatically,
 *      click through "Next / I understand / Continue" screens.
 *   3. Kiro redirects to `kiro://kiro.kiroAgent/authenticate-success?code=...`.
 *      We intercept that navigation to grab the authorization `code` without
 *      needing a kiro:// handler installed.
 *   4. Exchange the code at
 *      POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token
 *      to get { accessToken, refreshToken, idToken, profileArn, expiresAt }.
 *   5. Persist everything into a `provider_accounts` row under the Kiro provider.
 *
 * Usage:
 *   npm run login:kiro
 *   node scripts/login-kiro.js --email x@y.com --password ... --headless --manual
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { launchBrowser } = require('./lib/browser');
const { runGoogleLoginLoop, captureDiagnostic } = require('./lib/google-login');
const db = require('../src/db');
const { now } = require('../src/utils/common');
const { run: migrate } = require('../src/db/migrate');

migrate();

// ---------- config ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const EMAIL = process.env.KIRO_EMAIL || argVal('--email') || 'SanijayaTafasa@enowgntg.com';
const PASSWORD = process.env.KIRO_PASSWORD || argVal('--password') || 'qwertyui';
const HEADLESS = flag('--headless');
const MANUAL = flag('--manual');
const KEEP_OPEN_ON_ERROR = flag('--keep-open-on-error') || process.env.KIRO_KEEP_OPEN_ON_ERROR === '1';
const IDP = argVal('--idp') || 'Google';
const ACCOUNT_ID = Number(argVal('--account-id')) || null;
const ACCOUNT_EMAIL = argVal('--account-email') || EMAIL;
const INCOGNITO = flag('--incognito') || process.env.KIRO_INCOGNITO === '1';
// Wipe the profile dir before launching so every login starts with a fresh
// browser state (no leftover Google / Kiro / Cognito cookies, no cached
// tabs). Pass `--reuse-profile` to opt back in to the old cookie-hydration
// behavior — useful when you want to skip re-typing 2FA on every run.
const REUSE_PROFILE = flag('--reuse-profile');

const KIRO_AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const KIRO_LOGIN_URL = `${KIRO_AUTH_BASE}/login`;
const KIRO_TOKEN_URL = `${KIRO_AUTH_BASE}/oauth/token`;
const KIRO_REDIRECT = 'kiro://kiro.kiroAgent/authenticate-success';

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILE_SUFFIX = String(ACCOUNT_EMAIL || 'default').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
const USER_DATA_DIR = path.join(DATA_DIR, `kiro-profile-oauth-${PROFILE_SUFFIX}`);
const DUMP_PATH = path.join(DATA_DIR, `kiro-oauth-dump-${PROFILE_SUFFIX}.json`);
const TRACE_PATH = path.join(DATA_DIR, `kiro-oauth-trace-${PROFILE_SUFFIX}.zip`);

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- helpers ----------

function log(msg) {
  process.stdout.write(`[kiro-login] ${msg}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Recursively delete the persistent profile dir so login starts from a
 * fresh browser state. Uses `fs.rmSync` with retries (Windows can hold
 * file locks briefly after a previous Chromium session exits).
 */
function wipeProfileDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  const attempt = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  try {
    attempt();
    return true;
  } catch (err) {
    log(`wipeProfileDir first attempt failed: ${err.message}, retrying once...`);
    try { attempt(); return true; } catch (err2) {
      log(`wipeProfileDir failed: ${err2.message}`);
      return false;
    }
  }
}

function isIgnorableNavigationAbort(err) {
  const msg = String(err && err.message ? err.message : err);
  return msg.includes('net::ERR_ABORTED') || msg.includes('Navigation failed because page was closed');
}

function fetchFailureDetails(err) {
  const cause = err && err.cause;
  const parts = [err && err.message ? err.message : String(err)];
  if (cause) {
    if (cause.code) parts.push(`cause.code=${cause.code}`);
    if (cause.message) parts.push(`cause.message=${cause.message}`);
  }
  return parts.join(' ');
}

function isTlsChainError(err) {
  const code = err && err.cause && err.cause.code;
  return [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ].includes(code);
}

function postJsonInsecure(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        port: u.port || 443,
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            text: async () => text,
          });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function generatePkce() {
  // PKCE code verifier: 43-128 chars of [A-Za-z0-9-._~]
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return { verifier, challenge };
}

function extractCodeFromKiroUrl(url) {
  // kiro://kiro.kiroAgent/authenticate-success?code=XYZ&state=ABC
  if (!url || !url.startsWith('kiro://')) return null;
  const q = url.split('?')[1];
  if (!q) return null;
  const params = new URLSearchParams(q);
  return params.get('code');
}

async function exchangeCodeForTokens(code, verifier) {
  const requestBody = JSON.stringify({
    code,
    code_verifier: verifier,
    redirect_uri: KIRO_REDIRECT,
  });
  let res;
  try {
    res = await fetch(KIRO_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    });
  } catch (err) {
    if (!isTlsChainError(err)) {
      throw new Error(`token exchange fetch failed: ${fetchFailureDetails(err)}`);
    }
    log(`Token exchange TLS verification failed (${err.cause.code}); retrying with certificate verification disabled for this request...`);
    res = await postJsonInsecure(KIRO_TOKEN_URL, requestBody);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (res.status !== 200) {
    throw new Error(`token exchange failed: status=${res.status} body=${String(text).slice(0, 300)}`);
  }
  return body;
}

function persistTokens(tokens) {
  const prov = db.prepare("SELECT id, name, config_json FROM providers WHERE slug = 'kiro'").get();
  if (!prov) {
    throw new Error('No provider with slug "kiro" found. Run `npm run seed` first.');
  }

  const existingAccount = ACCOUNT_ID
    ? db.prepare('SELECT * FROM provider_accounts WHERE id = ? AND provider_id = ?').get(ACCOUNT_ID, prov.id)
    : db.prepare('SELECT * FROM provider_accounts WHERE provider_id = ? AND email = ?').get(prov.id, ACCOUNT_EMAIL);
  const existingCfg = (() => {
    try {
      return JSON.parse((existingAccount && existingAccount.config_json) || prov.config_json || '{}');
    } catch {
      return {};
    }
  })();

  const cfg = {
    ...existingCfg,
    auth: 'oauth-pkce',
    idp: IDP,
    profileArn: tokens.profileArn || existingCfg.profileArn || null,
    idToken: tokens.idToken || existingCfg.idToken || null,
    region: 'us-east-1',
  };

  // token_expires_at: prefer expiresAt (unix seconds) over expiresIn
  let exp = 0;
  if (tokens.expiresAt) {
    const parsed = Number(tokens.expiresAt);
    exp = Number.isFinite(parsed) && parsed > 1e10 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    // If it came as ISO string
    if (!Number.isFinite(parsed)) {
      const ms = Date.parse(String(tokens.expiresAt));
      if (!Number.isNaN(ms)) exp = Math.floor(ms / 1000);
    }
  }
  if (!exp && tokens.expiresIn) {
    exp = now() + Number(tokens.expiresIn);
  }
  if (!exp) exp = now() + 3600;

  db.prepare(`
    UPDATE providers
    SET enabled = 1,
        auth_type = 'oauth',
        base_url = 'https://q.us-east-1.amazonaws.com',
        updated_at = @now
    WHERE id = @id
  `).run({ id: prov.id, now: now() });

  let accountId;
  if (existingAccount) {
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
          updated_at = @now
      WHERE id = @id
    `).run({
      id: existingAccount.id,
      label: existingAccount.label || ACCOUNT_EMAIL || 'Kiro account',
      email: ACCOUNT_EMAIL || existingAccount.email || null,
      access: tokens.accessToken,
      refresh: tokens.refreshToken || null,
      exp,
      cfg: JSON.stringify(cfg),
      now: now(),
    });
    accountId = existingAccount.id;
  } else {
    const info = db.prepare(`
      INSERT INTO provider_accounts
        (provider_id, label, email, access_token, refresh_token, token_expires_at,
         config_json, enabled, created_at, updated_at)
      VALUES
        (@provider_id, @label, @email, @access, @refresh, @exp,
         @cfg, 1, @now, @now)
    `).run({
      provider_id: prov.id,
      label: ACCOUNT_EMAIL || 'Kiro account',
      email: ACCOUNT_EMAIL || null,
      access: tokens.accessToken,
      refresh: tokens.refreshToken || null,
      exp,
      cfg: JSON.stringify(cfg),
      now: now(),
    });
    accountId = info.lastInsertRowid;
  }

  return { prov, account: db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId), cfg, exp };
}

// ---------- main ----------

async function main() {
  log(`Starting OAuth PKCE flow (headless=${HEADLESS}, manual=${MANUAL}, incognito=${INCOGNITO}, idp=${IDP}, email=${EMAIL})`);
  log(`Profile dir: ${USER_DATA_DIR}`);

  const { verifier, challenge } = generatePkce();
  const state = crypto.randomUUID();
  const authUrl =
    KIRO_LOGIN_URL +
    '?' +
    new URLSearchParams({
      idp: IDP,
      redirect_uri: KIRO_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();

  // Start from a clean profile unless the caller opts in to reusing cookies.
  // Fresh-per-run is the safest default: no stale Google consent, no stale
  // Kiro session, no cached tabs that could short-circuit the flow.
  if (INCOGNITO) {
    log('Using incognito browser context (no persistent profile cookies/cache)');
    // In incognito mode, we don't need a profile dir at all
  } else if (!REUSE_PROFILE) {
    const wiped = wipeProfileDir(USER_DATA_DIR);
    log(wiped ? 'Wiped profile dir for a fresh run' : 'Profile dir starts empty');
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  } else {
    log('Reusing existing profile dir (--reuse-profile)');
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  // In incognito mode, pass empty string for userDataDir since we don't need persistence
  const { context, browser, browserType } = await launchBrowser({
    userDataDir: INCOGNITO ? '' : USER_DATA_DIR,
    headless: HEADLESS,
    incognito: INCOGNITO,
    viewport: { width: 1280, height: 820 },
    argv: process.argv,
  });
  log(`Launched browser: ${browserType}`);

  // Intercept the kiro:// callback at request time so we don't need a protocol handler.
  let capturedCode = null;
  context.on('request', (req) => {
    if (capturedCode) return;
    const url = req.url();
    const code = extractCodeFromKiroUrl(url);
    if (code) {
      log(`Captured authorization code from request: ${url.slice(0, 80)}...`);
      capturedCode = code;
    }
  });
  // Belt-and-suspenders: also watch frame navigations + response "location" headers.
  context.on('response', async (resp) => {
    if (capturedCode) return;
    try {
      const loc = resp.headers()['location'];
      const code = extractCodeFromKiroUrl(loc);
      if (code) {
        log(`Captured authorization code from redirect: ${String(loc).slice(0, 80)}...`);
        capturedCode = code;
      }
    } catch {
      /* ignore */
    }
  });

  // Firefox (including Camoufox) doesn't support context.tracing like Chromium
  // does in all cases; guard the call.
  let tracingActive = false;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    tracingActive = true;
  } catch (err) {
    log(`Tracing unavailable (${err.message}); continuing without trace.`);
  }
  const page = context.pages()[0] || (await context.newPage());
  // Avoid navigation errors when the browser tries to follow the kiro:// URL.
  page.on('pageerror', () => {});

  try {
    // ========== NEW FLOW: Login Google first, then Kiro ==========
    // This prevents SetSID loop by establishing Google session BEFORE Kiro OAuth
    
    // Step 1: Clear any existing Google session (ensure fresh state)
    log('Step 1: Clearing any existing Google cookies...');
    const { clearGoogleCookies } = require('./lib/google-login');
    await clearGoogleCookies(context, log);
    await sleep(500);

    // Step 2: Login to Google first to establish session
    log('Step 2: Logging into Google first to establish session...');
    const GOOGLE_LOGIN_URL = 'https://accounts.google.com/signin';
    
    try {
      await page.goto(GOOGLE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      if (!isIgnorableNavigationAbort(err)) throw err;
    }
    
    // Run Google login flow (email + password)
    await runGoogleLoginLoop({
      context,
      page,
      email: EMAIL,
      password: PASSWORD,
      manual: MANUAL,
      headless: HEADLESS,
      log,
      screenshotDir: path.dirname(DUMP_PATH),
      screenshotTag: ACCOUNT_EMAIL || EMAIL || 'unknown',
      // No restart URL for Google login - we want to stay on Google
      restartUrl: null,
      isDone: async (p) => {
        const url = p.url();
        // Done when we're on myaccount.google.com or google.com homepage (logged in)
        if (url.includes('myaccount.google.com') || url.includes('google.com/') && !url.includes('signin')) {
          // Check if we're actually logged in by looking for account elements
          try {
            const hasAccountBtn = await p.locator('[data-identifier], [aria-label*="Account"], button[aria-label*="Google"]').count();
            return hasAccountBtn > 0;
          } catch {
            return false;
          }
        }
        return false;
      },
    });
    
    log('Google session established successfully!');
    await sleep(1000);

    // Step 3: Navigate to Kiro signin page (not direct OAuth URL)
    // This is cleaner and avoids SetSID issues
    const KIRO_SIGNIN_URL = 'https://app.kiro.dev/signin';
    let kiroNavAttempts = 0;
    const maxKiroNavAttempts = 5;
    
    while (kiroNavAttempts < maxKiroNavAttempts) {
      kiroNavAttempts++;
      log(`Step 3: Navigating to Kiro signin page (attempt ${kiroNavAttempts}/${maxKiroNavAttempts})...`);
      
      try {
        await page.goto(KIRO_SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (err) {
        if (!isIgnorableNavigationAbort(err)) {
          log(`Navigation error: ${err.message}`);
          if (kiroNavAttempts < maxKiroNavAttempts) {
            await sleep(2000);
            continue;
          }
          throw err;
        }
      }

      await sleep(1500);
      const currentUrl = page.url();
      log(`Current URL: ${currentUrl}`);
      
      // Check if we're on Kiro signin page
      if (currentUrl.includes('kiro.dev') && currentUrl.includes('signin')) {
        log('Reached Kiro signin page, looking for Google login button...');
        
        // Try to find and click Google login button
        const googleBtnSelectors = [
          'button:has-text("Google")',
          'button:has-text("Sign in with Google")',
          'a:has-text("Google")',
          '[aria-label*="Google" i]',
          'button[data-provider="google"]',
          '.google-login-btn',
          '#google-login',
        ];
        
        let clicked = false;
        for (const sel of googleBtnSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              log(`Found Google button with selector: ${sel}`);
              await btn.click({ timeout: 5000 }).catch(() => {});
              clicked = true;
              await sleep(2000);
              break;
            }
          } catch (e) {
            // Try next selector
          }
        }
        
        if (clicked) {
          log('Clicked Google login button!');
          break;
        } else {
          log('Google login button not found, retrying...');
          if (kiroNavAttempts < maxKiroNavAttempts) {
            await sleep(2000);
            continue;
          }
        }
      }
      
      // If we got the callback code already
      if (capturedCode || extractCodeFromKiroUrl(currentUrl)) {
        log('Got authorization code!');
        break;
      }
      
      // If we're on Google accounts page (OAuth consent)
      if (currentUrl.includes('accounts.google.com')) {
        log('On Google OAuth page, will handle in login loop...');
        break;
      }
      
      // Small delay before retry
      if (kiroNavAttempts < maxKiroNavAttempts) {
        await sleep(1500);
      }
    }

    // Drive the Google/Kiro consent flow via the shared state-machine. It
    // handles email/password fills, gaplustos & approve_access consent, and
    // pauses when a captcha / verification challenge is detected. The loop
    // exits as soon as any open page navigates to kiro://...?code=...
    log('Waiting for kiro:// callback (up to 1 minute; auto-extended on captcha)...');
    await runGoogleLoginLoop({
      context,
      page,
      email: EMAIL,
      password: PASSWORD,
      manual: MANUAL,
      headless: HEADLESS,
      log,
      screenshotDir: path.dirname(DUMP_PATH),
      screenshotTag: ACCOUNT_EMAIL || EMAIL || 'unknown',
      // When Google's /accounts/SetSID bounce page hangs as a blank screen
      // (observed on fresh profiles), re-enter the OAuth PKCE flow from the
      // top so the state machine can try again.
      restartUrl: authUrl,
      isDone: async (p) => {
        if (capturedCode) return true;
        const url = p.url();
        
        // Check for kiro:// callback
        const code = extractCodeFromKiroUrl(url);
        if (code) { capturedCode = code; return true; }
        
        // NEW: Also consider done when we reach Kiro usage page
        // This means login succeeded via web flow (not kiro:// callback)
        if (url.includes('kiro.dev') && (url.includes('/account/usage') || url.includes('/home'))) {
          log('Reached Kiro usage page - login successful via web flow!');
          return true;
        }
        
        return false;
      },
    });

    // Check if we need to capture tokens from web session (not kiro:// callback)
    const finalUrl = page.url();
    if (!capturedCode && finalUrl.includes('kiro.dev') && (finalUrl.includes('/account/usage') || finalUrl.includes('/home'))) {
      log('Login successful via web flow, extracting tokens from session...');
      
      // Get tokens from browser cookies
      const kiroCookies = await context.cookies('https://app.kiro.dev');
      const accessToken = kiroCookies.find(c => c.name === 'AccessToken')?.value;
      const refreshToken = kiroCookies.find(c => c.name === 'RefreshToken')?.value;
      const idp = kiroCookies.find(c => c.name === 'Idp')?.value;
      
      if (accessToken) {
        log('Found AccessToken in cookies!');
        
        // We need to get the profileArn from the page or make an API call
        let profileArn = null;
        try {
          // Try to get from page content
          const pageContent = await page.content();
          const profileMatch = pageContent.match(/profileArn["\s:]+([^"'\s,}]+)/i);
          if (profileMatch) profileArn = profileMatch[1];
        } catch (e) {
          // Ignore
        }
        
        const normalized = {
          accessToken,
          refreshToken: refreshToken || '',
          idToken: '',
          profileArn,
          expiresAt: null,
          expiresIn: null,
        };
        
        // Save tokens
        const saved = persistTokens(normalized);
        
        log('');
        log('=== LOGIN COMPLETE (Web Flow) ===');
        log(`Provider:    #${saved.prov.id} ${saved.prov.name}`);
        log(`Account:     #${saved.account.id} ${saved.account.email || saved.account.label || ''}`);
        log(`Tokens saved from web session cookies.`);
        
        return;
      } else {
        log('No AccessToken found in cookies, falling back to OAuth flow...');
      }
    }

    if (!capturedCode) {
      throw new Error('Timed out waiting for authorization code');
    }
    log(`Authorization code received (${capturedCode.length} chars). Exchanging for tokens...`);

    const tokens = await exchangeCodeForTokens(capturedCode, verifier);
    const access = tokens.accessToken || tokens.access_token;
    const refresh = tokens.refreshToken || tokens.refresh_token;
    const profileArn = tokens.profileArn || tokens.profile_arn;
    if (!access) throw new Error('Token response did not include accessToken: ' + JSON.stringify(tokens).slice(0, 200));
    const normalized = {
      accessToken: access,
      refreshToken: refresh,
      idToken: tokens.idToken || tokens.id_token,
      profileArn,
      expiresAt: tokens.expiresAt || tokens.expires_at,
      expiresIn: tokens.expiresIn || tokens.expires_in,
    };

    // Persist raw token response to dump file for debugging (mask the actual values)
    fs.writeFileSync(
      DUMP_PATH,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          profileArn: normalized.profileArn,
          expiresAt: normalized.expiresAt,
          expiresIn: normalized.expiresIn,
          accessTokenPrefix: (access || '').slice(0, 20) + '...',
          refreshTokenPrefix: (refresh || '').slice(0, 20) + '...',
          idTokenPrefix: (normalized.idToken || '').slice(0, 20) + '...',
        },
        null,
        2
      )
    );

    const saved = persistTokens(normalized);

    // Detect subscription tier by calling /getUsageLimits through the adapter.
    // We reload the provider row (persistTokens just updated it) and instantiate
    // the adapter to reuse its fetchUsageInfo() + classifier.
    let subscription = null;
    try {
      const KiroProvider = require('../src/providers/kiro');
      const { classifySubscription } = KiroProvider;
      const fresh = db.prepare('SELECT * FROM providers WHERE id = ?').get(saved.prov.id);
      const adapter = new KiroProvider({ ...fresh, account: saved.account });
      const info = await adapter.fetchUsageInfo();
      if (info.status === 200) {
        subscription = classifySubscription(info.body);
        // Persist the classification into config_json so the dashboard can display
        // it without calling upstream on every page load.
        const cfgRow = db.prepare('SELECT config_json FROM provider_accounts WHERE id = ?').get(saved.account.id);
        const cfgObj = (() => { try { return JSON.parse(cfgRow.config_json || '{}'); } catch { return {}; } })();
        cfgObj.subscription = subscription;
        db.prepare('UPDATE provider_accounts SET config_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(cfgObj), Math.floor(Date.now() / 1000), saved.account.id);
      } else {
        log(`Subscription probe returned ${info.status}; skipping tier detection.`);
      }
    } catch (err) {
      log(`Subscription detection failed: ${err.message}`);
    }

    log('');
    log('=== LOGIN COMPLETE ===');
    log(`Provider:    #${saved.prov.id} ${saved.prov.name}`);
    log(`Account:     #${saved.account.id} ${saved.account.email || saved.account.label || ''}`);
    log(`profileArn:  ${saved.cfg.profileArn || '(none)'}`);
    log(`Expires:     ${new Date(saved.exp * 1000).toISOString()}`);
    log(`Tokens saved. Access token length: ${access.length}, refresh: ${refresh?.length || 0}`);
    if (subscription) {
      log('');
      log(`Subscription:  ${subscription.title || '(unknown)'}  [tier=${subscription.tier}]`);
      log(`  type:        ${subscription.type || '-'}`);
      if (subscription.usage) {
        log(`  usage:       ${subscription.usage.current} / ${subscription.usage.limit} ${subscription.usage.unit}`);
      }
      if (subscription.nextResetAt) {
        log(`  next reset:  ${new Date(subscription.nextResetAt * 1000).toISOString()}`);
      }
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    log(`Trace will be saved to: ${TRACE_PATH}`);
    try {
      const diag = await captureDiagnostic(
        page,
        path.join(DATA_DIR, 'diag'),
        `kiro-login-${PROFILE_SUFFIX}`
      );
      const written = Object.values(diag).filter(Boolean);
      if (written.length) log(`Diagnostic: ${written.join(', ')}`);
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    if (tracingActive) {
      try {
        await context.tracing.stop({ path: TRACE_PATH });
        log(`Trace: ${TRACE_PATH}  (view: npx playwright show-trace ${TRACE_PATH})`);
      } catch {
        /* ignore */
      }
    }
    if (!HEADLESS && (KEEP_OPEN_ON_ERROR || process.exitCode)) {
      log('Keeping browser open for 10 seconds so the last screen can be inspected...');
      await sleep(10000);
    } else {
      await sleep(1000);
    }
    await context.close();
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

