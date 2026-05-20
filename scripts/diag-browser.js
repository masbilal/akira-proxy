'use strict';

// Quick smoke test for scripts/lib/browser.js. Opens a tab, reports the picked
// driver, user-agent, and the critical `navigator.webdriver` flag.
// Usage:
//   node scripts/diag-browser.js
//   node scripts/diag-browser.js --browser=patchright
//   node scripts/diag-browser.js --browser=camoufox

const os = require('os');
const path = require('path');
const { launchBrowser } = require('./lib/browser');

(async () => {
  const argv = process.argv.slice(2);
  const tmp = path.join(os.tmpdir(), 'dapuranmu-browser-smoke-' + Date.now());
  const { context, browserType } = await launchBrowser({
    userDataDir: tmp,
    headless: true,
    argv,
  });
  console.log('[diag] driver picked:', browserType);

  const page = await context.newPage();
  try {
    await page.goto('https://www.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
  } catch (err) {
    console.log('[diag] google nav error:', err.message);
  }

  const fp = await page.evaluate(() => ({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    vendor: navigator.vendor,
    languages: navigator.languages,
    automationChannel: typeof window.chrome === 'object' ? 'chrome-object-present' : 'no-chrome-object',
  }));
  console.log('[diag] fingerprint:', fp);

  await context.close();
})().catch((e) => { console.error('[diag] ERR', e); process.exit(1); });
