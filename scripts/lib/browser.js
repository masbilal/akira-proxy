'use strict';

/**
 * scripts/lib/browser.js — launches a Playwright browser context, choosing
 * the stealthiest available browser driver on this machine.
 *
 * Priority (when --browser=auto or not set):
 *   1. patchright  — Playwright fork with stealth patches baked in, uses
 *      regular Chromium. Most reliable against Google/Kiro bot checks and
 *      the lightest install (pure npm, no Python).
 *   2. camoufox    — Firefox fork with C++-level anti-detection patches.
 *      Heavy install (pip + managed Firefox binary) but very stealthy.
 *   3. chromium    — plain bundled Playwright Chromium with
 *      --disable-blink-features=AutomationControlled. Fallback only.
 *
 * How preference is resolved:
 *   - `--browser=<name>` / `KIRO_BROWSER=<name>` forces a specific driver.
 *     Valid names: patchright, camoufox, firefox, chromium, auto.
 *   - `--patchright`, `--camoufox`, `--chromium` are shortcut flags.
 *   - If a specific driver is requested but not installed, we throw so the
 *     user knows to install it.
 *   - In `auto` mode we probe patchright first, then camoufox, then
 *     chromium — never throwing.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { chromium, firefox } = require('playwright');

// patchright is optional — loaded lazily to avoid hard dep.
let patchrightMod = null;
function loadPatchright() {
  if (patchrightMod !== null) return patchrightMod;
  try {
    // eslint-disable-next-line global-require
    patchrightMod = require('patchright');
  } catch (err) {
    patchrightMod = false;
  }
  return patchrightMod;
}

function log(msg) {
  process.stderr.write(`[browser] ${msg}\n`);
}

function readPreferenceFrom(argv) {
  const lookup = (name) => {
    const idx = argv.indexOf(name);
    if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
    const prefix = `${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const cli = lookup('--browser');
  if (cli) return cli.toLowerCase();
  if (argv.includes('--patchright')) return 'patchright';
  if (argv.includes('--camoufox')) return 'camoufox';
  if (argv.includes('--chromium')) return 'chromium';
  const env = (process.env.KIRO_BROWSER || '').toLowerCase();
  return env || 'auto';
}

function tryCommand(cmd, args) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
    if (res.status !== 0) return null;
    const out = (res.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}

function discoverCamoufoxPath() {
  // 1. Explicit env pointer.
  if (process.env.CAMOUFOX_PATH && fs.existsSync(process.env.CAMOUFOX_PATH)) {
    return process.env.CAMOUFOX_PATH;
  }

  // 2. `python -m camoufox path` / `python3 -m camoufox path`.
  const pythonCmds = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const py of pythonCmds) {
    const out = tryCommand(py, ['-m', 'camoufox', 'path']);
    if (out) {
      // Strip possible whitespace and quotes, take last non-empty line.
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const candidate = lines[i].replace(/^"|"$/g, '');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  // 3. `camoufox path` CLI shim (if installed globally).
  const shim = tryCommand('camoufox', ['path']);
  if (shim) {
    const candidate = shim.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Launch a browser context. By default this uses Playwright persistent
 * context for compatibility with the existing Kiro flow. Pass
 * `incognito: true` to launch a non-persistent/isolated browser context
 * instead (closer to a real incognito window: no profile dir cookies/cache).
 *
 * @param {object} opts
 * @param {string} opts.userDataDir — persistent profile directory.
 * @param {boolean} [opts.headless=false]
 * @param {boolean} [opts.incognito=false]
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {string[]} [opts.argv=process.argv] — used to pick --browser flag.
 * @returns {Promise<{context: import('playwright').BrowserContext, browserType: 'patchright'|'camoufox'|'chromium'|'firefox', executablePath: string|null, browser?: import('playwright').Browser}>}
 */
async function launchBrowser(opts) {
  const { userDataDir } = opts;
  const headless = Boolean(opts.headless);
  const incognito = Boolean(opts.incognito);
  const viewport = opts.viewport || { width: 1280, height: 820 };
  const argv = opts.argv || process.argv;
  const pref = readPreferenceFrom(argv);

  // In incognito mode, userDataDir is not required since we use isolated context
  if (!incognito && !userDataDir) {
    throw new Error('launchBrowser: userDataDir is required for persistent context');
  }
  
  // Only create profile dir for persistent context
  if (!incognito && userDataDir) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // ---- Resolve which driver to use ---------------------------------------
  let execPath = null;
  let browserType = null; // decided below

  // Explicit requests take precedence (and must succeed or throw).
  if (pref === 'patchright') {
    const pr = loadPatchright();
    if (!pr) {
      throw new Error(
        'patchright requested but not installed. Run `npm install patchright` ' +
        'and then `npx patchright install chromium`.'
      );
    }
    browserType = 'patchright';
  } else if (pref === 'camoufox') {
    execPath = discoverCamoufoxPath();
    if (!execPath) {
      throw new Error(
        'Camoufox requested but its executable was not found. ' +
        'Install it with `pip install -U camoufox[geoip]` then `python -m camoufox fetch`, ' +
        'or set CAMOUFOX_PATH to the Firefox binary.'
      );
    }
    browserType = 'camoufox';
  } else if (pref === 'firefox') {
    browserType = 'firefox';
  } else if (pref === 'chromium') {
    browserType = 'chromium';
  } else {
    // auto: patchright → camoufox → chromium
    if (loadPatchright()) {
      browserType = 'patchright';
    } else {
      execPath = discoverCamoufoxPath();
      if (execPath) {
        browserType = 'camoufox';
      } else {
        browserType = 'chromium';
      }
    }
  }

  // ---- Launch the chosen driver ------------------------------------------

  // Chromium launch flags that prevent Google's SetSID "sync account into
  // browser" step. That sync is what makes /accounts/SetSID hang on blank
  // pages during headless OAuth flows. The flags below:
  //   - Disable the signin manager so Google can't push the account into
  //     Chrome's identity layer (MirrorAccountConsistency, AccountConsistencyMirror).
  //   - Disable browser sign-in / sync-disabled error UI.
  //   - Suppress the external-protocol dialog so the `kiro://` return URL
  //     doesn't surface a blocking modal.
  const CHROMIUM_NO_ACCOUNT_SYNC_FLAGS = [
    '--disable-features=' + [
      // Prevent Google from writing the signed-in account into the browser
      'AccountConsistency',
      'AccountConsistencyMirror',
      'DiceWebSigninInterception',
      'MirrorNoNewUsers',
      'MirrorAccountConsistency',
      // Suppress secondary sync UI that sometimes wedges the OAuth page
      'SigninInterception',
      'SigninNotificationChannelsPlatform',
      'SyncTrustedVaultKeysFromWeb',
      // Block the external-protocol chooser for `kiro://` (we capture the
      // redirect via a request listener; the modal would only waste time).
      'ExternalProtocolDialog',
      // Low-priority features that can trigger background work mid-OAuth
      'OptimizationHints',
    ].join(','),
    '--disable-sync',
    '--disable-signin-promo',
    '--disable-signin-scoped-device-id',
  ];

  if (browserType === 'patchright') {
    const pr = loadPatchright();
    log('Using Patchright (stealth Chromium).');
    if (incognito) {
      const browser = await pr.chromium.launch({
        headless,
        args: CHROMIUM_NO_ACCOUNT_SYNC_FLAGS,
      });
      // True incognito: no cookies, no storage, completely isolated context
      const context = await browser.newContext({
        viewport,
        // Ignore HTTPS errors for OAuth flows
        ignoreHTTPSErrors: true,
      });
      log('Created isolated incognito context (no cookie persistence)');
      return { context, browser, browserType, executablePath: null };
    }
    const context = await pr.chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport,
      args: CHROMIUM_NO_ACCOUNT_SYNC_FLAGS,
      // Patchright recommends the default channel; not setting `channel`
      // lets it pick the managed Chromium that `npx patchright install` put
      // in place. No `--disable-blink-features=AutomationControlled` here
      // because patchright strips the automation flag at the browser level.
    });
    return { context, browserType, executablePath: null };
  }

  if (browserType === 'camoufox') {
    log(`Using Camoufox at ${execPath}`);
    if (incognito) {
      const browser = await firefox.launch({
        headless,
        executablePath: execPath,
      });
      const context = await browser.newContext({ viewport });
      return { context, browser, browserType, executablePath: execPath };
    }
    const context = await firefox.launchPersistentContext(userDataDir, {
      headless,
      viewport,
      executablePath: execPath,
      // Camoufox already ships with anti-detection patches. Don't override the
      // user-agent; let the binary report its spoofed navigator.
    });
    return { context, browserType, executablePath: execPath };
  }

  if (browserType === 'firefox') {
    log('Using Playwright Firefox (no stealth patches).');
    if (incognito) {
      const browser = await firefox.launch({ headless });
      const context = await browser.newContext({ viewport });
      return { context, browser, browserType, executablePath: null };
    }
    const context = await firefox.launchPersistentContext(userDataDir, { headless, viewport });
    return { context, browserType, executablePath: null };
  }

  log('Using bundled Chromium (no stealth patches).');
  if (incognito) {
    const browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled', ...CHROMIUM_NO_ACCOUNT_SYNC_FLAGS],
    });
    const context = await browser.newContext({ viewport });
    return { context, browser, browserType, executablePath: null };
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport,
    args: ['--disable-blink-features=AutomationControlled', ...CHROMIUM_NO_ACCOUNT_SYNC_FLAGS],
  });
  return { context, browserType, executablePath: null };
}

module.exports = {
  launchBrowser,
  discoverCamoufoxPath,
  loadPatchright,
};

// Quiet the unused import warning when only launchBrowser is needed.
void execSync;
