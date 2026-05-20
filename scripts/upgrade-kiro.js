'use strict';

/**
 * scripts/upgrade-kiro.js — Upgrade a Kiro free account to Pro, returning the
 * Stripe Checkout URL so the user can finish payment manually.
 *
 * Approach (hybrid):
 *   1. Launch Chromium with the account's persistent OAuth profile.
 *   2. Navigate to https://app.kiro.dev/account/usage and drive the Google
 *      login flow if the web session has lapsed.
 *   3. Once the SPA starts hitting /service/KiroWebPortalService/*, intercept
 *      the first request to capture the Bearer token + CSRF + kiro-user-id
 *      headers and the HttpOnly session cookies (AccessToken/RefreshToken).
 *   4. Call `GenerateSubscriptionManagementUrl` directly over HTTP (CBOR body)
 *      and read `encodedVerificationUrl` — a full Stripe checkout URL with
 *      its required `#fid=...` fragment already attached.
 *   5. Emit the URL on stdout as a JSON line prefixed with `UPGRADE_RESULT `.
 *
 * This replaces the old "click DOM button and wait for Stripe tab" flow,
 * which was flaky about the URL fragment.
 *
 * Usage:
 *   node scripts/upgrade-kiro.js --email x@y.com --password ... [--headless]
 *   node scripts/upgrade-kiro.js --account-id 5
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encode, decode } = require('cbor-x');
const { launchBrowser } = require('./lib/browser');
const {
  runGoogleLoginLoop,
  clearKiroAuthCookies,
  captureDiagnostic,
} = require('./lib/google-login');
const db = require('../src/db');
const { run: migrate } = require('../src/db/migrate');

migrate();

// ---------- config ----------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const ACCOUNT_ID = Number(argVal('--account-id')) || null;
const CLI_EMAIL = argVal('--email') || process.env.KIRO_EMAIL || null;
const CLI_PASSWORD = argVal('--password') || process.env.KIRO_PASSWORD || null;
const HEADLESS = flag('--headless');
const MANUAL = flag('--manual');
// By default the upgrade script wipes its own profile dir before launching
// so every run starts from a clean browser state. Pass `--reuse-profile` to
// opt in to cookie-hydration behavior (faster if the session is still live).
const REUSE_PROFILE = flag('--reuse-profile');

const KIRO_USAGE_URL = 'https://app.kiro.dev/account/usage';
const KIRO_WEB_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const AWS_UA = 'aws-sdk-js/1.0.0 ua/2.1 os/Windows lang/js md/browser#Chromium_147 m/N,M,E';

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- helpers ----------

function log(msg) {
  process.stderr.write(`[kiro-upgrade] ${msg}\n`);
}

function emit(result) {
  process.stdout.write(`UPGRADE_RESULT ${JSON.stringify(result)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveAccount() {
  if (ACCOUNT_ID) {
    const row = db.prepare(`
      SELECT a.*, p.type AS provider_type, p.slug AS provider_slug
      FROM provider_accounts a
      JOIN providers p ON p.id = a.provider_id
      WHERE a.id = ?
    `).get(ACCOUNT_ID);
    if (!row) throw new Error(`account #${ACCOUNT_ID} not found`);
    if (row.provider_type !== 'kiro') throw new Error(`account #${ACCOUNT_ID} is not a kiro account`);
    return row;
  }
  if (!CLI_EMAIL) throw new Error('--account-id or --email is required');
  const row = db.prepare(`
    SELECT a.*, p.type AS provider_type, p.slug AS provider_slug
    FROM provider_accounts a
    JOIN providers p ON p.id = a.provider_id
    WHERE p.type = 'kiro' AND a.email = ?
    ORDER BY a.id DESC LIMIT 1
  `).get(CLI_EMAIL);
  return row || null;
}

function accountConfig(account) {
  try { return JSON.parse(account.config_json || '{}'); } catch { return {}; }
}

function profileDirFor(email) {
  const suffix = String(email || 'default').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
  // Separate profile from `login-kiro.js` (`kiro-profile-oauth-*`) — the
  // upgrade flow wipes its profile per-run by default, which would blow
  // away the login script's persistent OAuth session.
  return path.join(DATA_DIR, `kiro-profile-upgrade-${suffix}`);
}

/**
 * Recursively delete the persistent profile directory so each upgrade run
 * starts with a fresh browser state. No cookies, no IndexedDB, no cached
 * /account/usage page — guarantees the SPA renders /signin and hands off
 * to Google cleanly.
 *
 * Uses `fs.rmSync` (Node 14+); retries once on Windows EBUSY.
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

// Click "Continue with Google" / "Sign in with Google" on the Kiro signin page.
// Harmless no-op if the session is already live and we're on /account/usage.
async function clickKiroSignin(page) {
  return page.evaluate(() => {
    const keywords = ['google', 'sign in', 'signin', 'continue with', 'login'];
    const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    for (const b of btns) {
      const txt = (b.textContent || '').toLowerCase().trim();
      if (!txt) continue;
      if (keywords.some((k) => txt.includes(k))) {
        (b.closest('button, a, [role="button"]') || b).click();
        return txt.slice(0, 60);
      }
    }
    return '';
  }).catch(() => '');
}

// Find the first http(s) URL in a nested object/array.
function findUrl(val, depth = 0) {
  if (!val || depth > 6) return null;
  if (typeof val === 'string' && /^https?:\/\//.test(val)) return val;
  if (Array.isArray(val)) {
    for (const v of val) { const r = findUrl(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof val === 'object') {
    for (const v of Object.values(val)) { const r = findUrl(v, depth + 1); if (r) return r; }
  }
  return null;
}

async function callKiroWebPortal(op, payload, ctx) {
  const headers = {
    'authorization': `Bearer ${ctx.bearer}`,
    'accept': 'application/cbor',
    'content-type': 'application/cbor',
    'smithy-protocol': 'rpc-v2-cbor',
    'amz-sdk-invocation-id': crypto.randomUUID(),
    'amz-sdk-request': 'attempt=1; max=1',
    'x-amz-user-agent': AWS_UA,
    'origin': 'https://app.kiro.dev',
    'referer': 'https://app.kiro.dev/account/usage',
    'user-agent': UA,
  };
  if (ctx.csrf) headers['x-csrf-token'] = ctx.csrf;
  if (ctx.kiroUserId) headers['x-kiro-userid'] = ctx.kiroUserId;
  if (ctx.kiroVisitorId) headers['x-kiro-visitorid'] = ctx.kiroVisitorId;
  if (ctx.cookieHeader) headers['cookie'] = ctx.cookieHeader;

  const res = await fetch(`${KIRO_WEB_BASE}/${op}`, {
    method: 'POST',
    headers,
    body: encode(payload),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  try { body = decode(buf); } catch {
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8').slice(0, 400); }
  }
  return { status: res.status, body };
}

// ---------- main ----------

async function main() {
  const account = resolveAccount();
  if (!account) throw new Error('target account not found');

  const cfg = accountConfig(account);
  const sub = cfg.subscription || null;
  if (sub && sub.tier && !['free', 'unknown'].includes(String(sub.tier).toLowerCase())) {
    log(`Warning: account tier is "${sub.tier}" — upgrade may not apply, continuing anyway.`);
  }

  const email = CLI_EMAIL || account.email;
  const password = CLI_PASSWORD;
  const profileDir = profileDirFor(email);
  log(`Using profile dir: ${profileDir}`);
  log(`Target account: #${account.id} ${email || account.label}`);

  // Start from a clean profile unless the caller explicitly opts in to
  // reusing cookies. This is the #1 fix for "session nyangkut" — stale
  // Kiro/Cognito cookies short-circuit /signin back to /account/usage and
  // the Google button never renders.
  if (!REUSE_PROFILE) {
    const wiped = wipeProfileDir(profileDir);
    log(wiped ? 'Wiped profile dir for a fresh run' : 'Profile dir starts empty');
  } else {
    log('Reusing existing profile dir (--reuse-profile)');
  }

  fs.mkdirSync(profileDir, { recursive: true });
  const { context, browserType } = await launchBrowser({
    userDataDir: profileDir,
    headless: HEADLESS,
    viewport: { width: 1280, height: 820 },
    argv: process.argv,
  });
  log(`Launched browser: ${browserType}`);

  let bearer = null;
  let csrf = null;
  let kiroUserId = null;
  let kiroVisitorId = null;

  context.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/service/KiroWebPortalService/')) return;
    const h = req.headers();
    if (h['authorization'] && !bearer) bearer = h['authorization'].replace(/^Bearer\s+/i, '');
    if (h['x-csrf-token'] && !csrf) csrf = h['x-csrf-token'];
    if (h['x-kiro-userid'] && !kiroUserId) kiroUserId = h['x-kiro-userid'];
    if (h['x-kiro-visitorid'] && !kiroVisitorId) kiroVisitorId = h['x-kiro-visitorid'];
  });

  const page = context.pages()[0] || await context.newPage();
  page.on('pageerror', () => {});

  try {
    log(`Navigating to ${KIRO_USAGE_URL}...`);
    await page.goto(KIRO_USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      .catch((err) => log(`initial nav warning: ${err.message}`));

    // ---- Stage 1: hydrate from persistent profile cookies ------------------
    // If the persistent profile still has a live Kiro web session, the SPA
    // auth-redirects straight to /account/usage and fires its first portal
    // request immediately. Skip entirely when we just wiped the profile —
    // there are no cookies to hydrate from so it's pure wasted waiting.
    const HYDRATE_WINDOW_MS = REUSE_PROFILE ? 12_000 : 0;
    const hydrateUntil = Date.now() + HYDRATE_WINDOW_MS;
    let hydrateLandedOnSignin = false;
    while (Date.now() < hydrateUntil) {
      const u = page.url();
      if (/\/signin(\?|$|\/)/.test(u) || /amazoncognito\.com/.test(u) || /accounts\.google\.com/.test(u)) {
        hydrateLandedOnSignin = true;
        break;
      }
      if (bearer) {
        log('Hydrate succeeded — session alive, Bearer captured.');
        break;
      }
      await sleep(400);
    }

    // ---- Stage 2: fresh Google login (only if hydrate failed) -------------
    const needLogin = !bearer && (hydrateLandedOnSignin || Date.now() >= hydrateUntil);
    if (needLogin) {
      if (hydrateLandedOnSignin) {
        log('Hydrate landed on signin/OAuth — running fresh Google login.');
      } else {
        log('Hydrate window elapsed without Bearer — running fresh Google login.');
        // Clear any stale Kiro+Cognito cookies so /signin actually renders
        // the Google button instead of short-circuiting back to /account/usage.
        await clearKiroAuthCookies(context, log);
        await page.goto(KIRO_USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
          .catch((err) => log(`re-nav warning: ${err.message}`));
      }

      // Kick off the Kiro signin → Google OAuth handoff.
      for (let i = 0; i < 5; i += 1) {
        const u = page.url();
        if (!u.includes('/signin')) break;
        const clicked = await clickKiroSignin(page);
        if (clicked) log(`Clicked "${clicked}" on signin page`);
        await sleep(2500);
      }

      // Drive the Google email/password flow, auto-handle OAuth consent,
      // speedbump, and captcha. Exits as soon as we're back on a kiro.dev
      // page that isn't /signin.
      await runGoogleLoginLoop({
        context,
        page,
        email,
        password: password || '',
        manual: MANUAL,
        headless: HEADLESS,
        log,
        screenshotDir: DATA_DIR,
        screenshotTag: `upgrade-${account.id}`,
        defaultDeadlineMs: 90 * 1000,
        // When Google's /accounts/SetSID bounce page hangs as a blank
        // screen (observed on fresh profiles), re-enter the Kiro flow from
        // the top (/account/usage) so the state machine can try again.
        restartUrl: KIRO_USAGE_URL,
        isDone: async (p) => {
          const u = p.url();
          let host = '';
          try { host = new URL(u).hostname; } catch { return false; }
          if (!host.endsWith('kiro.dev')) return false;
          if (/\/signin(\?|$|\/)/.test(u)) return false;
          return true;
        },
      }).catch((err) => log(`Login loop ended: ${err.message}`));
    }

    // Wait for the SPA to fire its first authenticated portal request so we
    // can capture the Bearer + CSRF headers. If hydrate succeeded this is
    // immediate; if we went through Stage 2, give the SPA up to 20s.
    const headerDeadline = Date.now() + 20_000;
    while (Date.now() < headerDeadline && !bearer) await sleep(300);
    if (!bearer) {
      throw new Error('did not capture web portal Bearer token — login may have failed');
    }
    log(`Captured Bearer token (len=${bearer.length}), csrf=${csrf ? 'yes' : 'no'}, userId=${kiroUserId ? 'yes' : 'no'}`);

    // Grab the HttpOnly session cookies (AccessToken, RefreshToken, Idp, UserId)
    // — the web portal authenticates requests primarily via these.
    const allCookies = await context.cookies('https://app.kiro.dev');
    const kiroCookies = allCookies.filter(
      (c) => c.domain === 'app.kiro.dev' || c.domain === '.app.kiro.dev'
    );
    const cookieHeader = kiroCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    log(`Cookies: ${kiroCookies.map((c) => c.name).join(',')}`);

    const profileArn = cfg.profileArn || null;
    if (!profileArn) {
      throw new Error('account has no profileArn in config_json; re-run login to refresh it');
    }

    log('Calling GenerateSubscriptionManagementUrl...');
    const resCall = await callKiroWebPortal(
      'GenerateSubscriptionManagementUrl',
      { subscriptionType: 'Q_DEVELOPER_STANDALONE_PRO', profileArn },
      { bearer, csrf, kiroUserId, kiroVisitorId, cookieHeader }
    );
    if (resCall.status !== 200) {
      const type = resCall.body && resCall.body.__type;
      const msg = resCall.body && resCall.body.message;
      throw new Error(`GenerateSubscriptionManagementUrl failed: status=${resCall.status} ${type || ''} ${msg || ''}`.trim());
    }

    const checkoutUrl = findUrl(resCall.body);
    if (!checkoutUrl) {
      throw new Error('response had no URL: ' + JSON.stringify(resCall.body).slice(0, 200));
    }
    log(`Captured checkout URL (${checkoutUrl.includes('#') ? 'with' : 'WITHOUT'} fragment): ${checkoutUrl}`);

    emit({ ok: true, checkoutUrl, accountId: account.id });
    log('DONE');
  } catch (err) {
    log(`ERROR: ${err.stack || err.message}`);
    try {
      const diag = await captureDiagnostic(
        page,
        path.join(DATA_DIR, 'diag'),
        `kiro-upgrade-${account.id}`
      );
      const written = Object.values(diag).filter(Boolean);
      if (written.length) log(`Diagnostic: ${written.join(', ')}`);
    } catch { /* ignore */ }
    emit({ ok: false, error: err.message, accountId: account.id });
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  emit({ ok: false, error: err.message });
  process.exit(1);
});
