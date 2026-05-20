'use strict';

/**
 * scripts/lib/google-login.js — Google/Kiro OAuth login helpers.
 *
 * Exports:
 *   - isEmailStep(page)
 *   - isPasswordStep(page)
 *   - fillGoogleEmailStep(page, email)
 *   - fillGooglePasswordStep(page, password)
 *   - handleGoogleGaplustos(page)
 *   - handleGoogleConsentContinue(page)
 *   - handleGoogleOAuthConsentIfPresent(page, log)  ← NEW (scope consent for fresh GSuite)
 *   - handleSpeedbumpIfPresent(page, log)           ← NEW ("It was me" interstitial)
 *   - clickContinueButton(page)
 *   - detectCaptcha(page)                           ← now also classifies /challenge/* paths
 *   - runGoogleLoginLoop(ctx) — main state-machine that drives a login flow
 *     until either a "done" signal is reached or the deadline expires.
 *
 * This module is shared between scripts/login-kiro.js (which waits for a
 * kiro:// callback) and scripts/upgrade-kiro.js (which waits for the Kiro
 * dashboard URL after login). The new handlers are inspired by the approach
 * in HikiNarou/Kiro-Auto-Pro — kept JS-plain, no external stealth deps.
 */

const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- constants ----------

/**
 * Google OAuth "Kiro wants to access your Google Account" scope-consent
 * screen. Fresh GSuite accounts that have never authorised Kiro before land
 * here. Without a click, the OAuth flow stalls and Kiro's callback never
 * fires, surfacing as "something went wrong" or a callback timeout.
 */
const GOOGLE_OAUTH_CONSENT_URL_RE =
  /accounts\.google\.com\/(?:signin\/oauth\/(?:id|consent|warning|oauthchooseaccount)|o\/oauth2\/auth)/i;

/** Selectors for the primary CTA on the OAuth scope-consent screen. */
const GOOGLE_OAUTH_CONSENT_SELECTORS = [
  'button[jsname="LgbsSe"][data-primary-action-label]',
  'button[jsname="LgbsSe"]:has-text("Continue")',
  'button[jsname="LgbsSe"]:has-text("Allow")',
  'button[jsname="LgbsSe"]:has-text("Accept")',
  'button[jsname="LgbsSe"]:has-text("Izinkan")',
  'button[jsname="LgbsSe"]:has-text("Lanjutkan")',
  'button[jsname="LgbsSe"]',
  '#submit_approve_access',
  'button:has-text("Continue")',
  'button:has-text("Allow")',
  'button:has-text("Izinkan")',
];

/**
 * Speedbump ("Was this you? / It was me") interstitials. Soft confirmation
 * that auto-resolves with one click — must never be classified as a blocker.
 */
const SPEEDBUMP_URL_RE = /\/speedbump/i;
const SPEEDBUMP_CONFIRM_SELECTORS = [
  'button[jsname="LgbsSe"]',
  '#gaplustosNext button',
  'button:has-text("Continue")',
  'button:has-text("Confirm")',
  'button:has-text("It was me")',
  'button:has-text("Yes")',
  'button:has-text("Not now")',
  'button:has-text("Lanjutkan")',
  'button:has-text("Konfirmasi")',
  '#confirm',
  'input[name="confirm"]',
];

/**
 * SetSID is an internal Google bounce page that normally hands control off
 * to the next sign-in step within a couple of seconds. On a fresh/clean
 * Chromium profile it occasionally hangs as a blank white page and the OAuth
 * flow never progresses. Treat more than ~8s on any `/SetSID` URL with an
 * empty body as stuck, log out of Google, and restart the login from the
 * original auth URL.
 */
const SETSID_URL_RE = /\/accounts\/SetSID(?:\?|$|\/)/i;
const SETSID_STUCK_THRESHOLD_MS = 4 * 1000;

/**
 * Google account chooser URL fragments. When the browser profile is signed
 * into any Google account (even accidentally — e.g. from a previous run or
 * a Chromium sync hop), the OAuth flow bounces through a chooser before it
 * even reaches the password prompt. We need to pick the right row rather
 * than waiting for a password input that will never render.
 */
const GOOGLE_ACCOUNT_CHOOSER_URL_FRAGMENTS = [
  'accountchooser',
  'oauthchooseaccount',
  'selectaccount',
  '/chooser',
];

/**
 * Google account challenges. `/challenge/pwd` is the NORMAL password step and
 * is excluded — it's not a blocker. Everything else here requires user
 * interaction we can't automate (tap-yes on phone, TOTP, SMS, security key,
 * etc.) and should surface as a specific reason so the operator knows what
 * to do.
 */
const CHALLENGE_PATH_REGEXES = [
  { re: /\/challenge\/dp\b/i, kind: 'device_prompt' },            // tap-yes on phone
  { re: /\/challenge\/recaptcha\b/i, kind: 'recaptcha' },
  { re: /\/challenge\/ipp\b/i, kind: 'phone_verify' },            // SMS / call
  { re: /\/challenge\/ipe\b/i, kind: 'phone_email' },
  { re: /\/challenge\/ootp\b/i, kind: 'one_time_password' },
  { re: /\/challenge\/totp\b/i, kind: 'totp' },                   // authenticator app
  { re: /\/challenge\/sk\b/i, kind: 'security_key' },
  { re: /\/challenge\/kpe\b/i, kind: 'knowledge_based' },
  { re: /\/challenge\/az\b/i, kind: 'account_recovery' },
  { re: /\/challenge\/kpp\b/i, kind: 'knowledge_password' },
  { re: /\/challenge\/selection\b/i, kind: 'method_selection' },
  { re: /\/challenge\/iap\b/i, kind: 'identity_proofing' },
  { re: /\/signin\/selectchallenge\b/i, kind: 'method_selection' },
  { re: /\/signin\/rejected\b/i, kind: 'rejected' },
];

const BOT_DETECTION_TEXTS = [
  'this browser or app may not be secure',
  "couldn't sign you in",
  'try using a different browser',
  'please try again later',
  'unusual activity',
  'we detected unusual activity',
  "verify it's you",
  'verify it’s you',
];

const DISABLED_TEXTS = [
  'account has been disabled',
  'account disabled',
  'account has been deleted',
  'account is disabled',
];

// ---------- step detection ----------

async function isEmailStep(target) {
  try {
    return await target.evaluate(() => {
      const sels = ['input[type="email"]', 'input[name="identifier"]', '#identifierId'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null) return true;
        }
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function isPasswordStep(target) {
  try {
    return await target.evaluate(() => {
      const sels = ['input[type="password"]', 'input[name="Passwd"]'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null) return true;
        }
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function clickGoogleNext(target) {
  try {
    return await target.evaluate(() => {
      const primary = document.querySelector('#identifierNext button, #passwordNext button');
      if (primary && primary.offsetParent !== null) {
        primary.click();
        return true;
      }
      const candidates = document.querySelectorAll('button, div[role="button"]');
      for (const el of candidates) {
        const parent = el.closest('button, div[role="button"]') || el;
        if (parent && parent.offsetParent !== null) {
          parent.click();
          return true;
        }
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function waitForEmailTransition(target) {
  try {
    await target.waitForFunction(() => {
      const host = window.location.host || '';
      const p = window.location.pathname || '';
      const visible = (sels) => sels.some((sel) =>
        Array.from(document.querySelectorAll(sel)).some((el) => el.offsetParent !== null)
      );
      const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
      const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
      if (!host.includes('accounts.google.com')) return true;
      if (hasPassword) return true;
      if (p.includes('/signin/challenge/pwd')) return true;
      return !hasEmail && !p.includes('/signin/identifier');
    }, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForPasswordTransition(target) {
  try {
    await target.waitForFunction(() => {
      const host = window.location.host || '';
      const p = window.location.pathname || '';
      const hasPassword = Array.from(
        document.querySelectorAll('input[name="Passwd"], input[type="password"]')
      ).some((el) => el.offsetParent !== null);
      if (!host.includes('accounts.google.com')) return true;
      if (!p.includes('/challenge/pwd')) return true;
      return !hasPassword;
    }, { timeout: 12000 });
    return true;
  } catch {
    return false;
  }
}

async function fillGoogleEmailStep(page, email) {
  const selectors = ['#identifierId', 'input[name="identifier"]', 'input[type="email"]'];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 3000 }).catch(() => {});
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible({ timeout: 300 }).catch(() => false))) continue;

      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true }).catch(() => {});
      await sleep(200);
      await loc.press('Control+a').catch(() => {});
      await loc.press('Backspace').catch(() => {});
      await loc.pressSequentially(email, { delay: 60 }).catch(() => {});
      await sleep(500);

      const value = (await loc.inputValue().catch(() => '')) || '';
      if (String(value).trim().toLowerCase() !== email.toLowerCase()) continue;

      const clicked = await clickGoogleNext(page);
      if (!clicked) await loc.press('Enter').catch(() => {});
      await waitForEmailTransition(page);
      return true;
    } catch { /* try next selector */ }
  }
  return false;
}

async function fillGooglePasswordStep(page, password) {
  const selectors = ['input[name="Passwd"]', 'input[type="password"]'];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 3000 }).catch(() => {});
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible({ timeout: 300 }).catch(() => false))) continue;

      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true }).catch(() => {});
      await sleep(200);
      await loc.press('Control+a').catch(() => {});
      await loc.press('Backspace').catch(() => {});
      await loc.pressSequentially(password, { delay: 70 }).catch(() => {});
      await sleep(500);

      const value = (await loc.inputValue().catch(() => '')) || '';
      if (String(value).length < password.length) continue;

      const clicked = await clickGoogleNext(page);
      if (!clicked) await loc.press('Enter').catch(() => {});
      await waitForPasswordTransition(page);
      return true;
    } catch { /* try next selector */ }
  }
  return false;
}

async function handleGoogleGaplustos(page) {
  let currentUrl = '';
  try { currentUrl = page.url(); } catch { return false; }
  if (!currentUrl.includes('/speedbump/gaplustos')) return false;

  try {
    await page.waitForSelector('#confirm, input[name="confirm"], input[type="submit"]', { state: 'visible', timeout: 5000 }).catch(() => {});
    const selectors = ['#gaplustosNext button', '#confirm', 'input[name="confirm"]', 'input[type="submit"]'];
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible({ timeout: 300 }).catch(() => false))) continue;
        await loc.click({ force: true });
        return true;
      } catch { /* next */ }
    }
    return await page.evaluate(() => {
      const el = document.querySelector('#gaplustosNext button');
      if (el && el.offsetParent !== null) { el.click(); return true; }
      for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
        if (!btn.offsetParent) continue;
        btn.click();
        return true;
      }
      return false;
    }).catch(() => false);
  } catch {
    return false;
  }
}

async function handleGoogleConsentContinue(page) {
  let currentUrl = '';
  try { currentUrl = page.url(); } catch { return false; }
  if (!currentUrl.includes('accounts.google.com')) return false;

  try {
    return await page.evaluate(() => {
      const el = document.querySelector('#submit_approve_access button, #submit_approve_access');
      if (el && el.offsetParent !== null) { el.click(); return true; }
      const keywords = [
        'continue', 'allow', 'lanjut', 'weiter', 'erlauben',
        'continuer', 'autoriser', 'continuar', 'permitir',
      ];
      for (const btn of document.querySelectorAll('button, div[role="button"]')) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (!txt || btn.offsetParent === null) continue;
        if (keywords.some((k) => txt.includes(k))) { btn.click(); return true; }
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function clickContinueButton(page) {
  try {
    await page.evaluate(() => {
      const idSelectors = ['#gaplustosNext button', '#identifierNext button', '#passwordNext button', '#submit', '#confirm'];
      for (const sel of idSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return; }
      }
      const keywords = [
        'next', 'continue', 'accept', 'understand', 'agree', 'ok', 'got it',
        'login', 'sign in',
        'mengerti', 'lanjutkan', 'setuju', 'masuk', 'lewati', 'berikutnya',
        'weiter', 'akzeptieren', 'verstanden', 'anmelden',
        'suivant', 'continuer', 'accepter', 'compris',
        'siguiente', 'continuar', 'aceptar', 'entendido',
      ];
      for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
        if (!btn.offsetParent) continue;
        const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
        if (!txt) continue;
        if (keywords.some((k) => txt.includes(k))) { btn.click(); return; }
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * Click the first matching selector that is actually visible on the page.
 * Returns true iff a click fired.
 */
async function clickFirstVisible(page, selectors, timeoutPerSel = 1500) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: timeoutPerSel }).catch(() => false);
      if (!visible) continue;
      await loc.click({ timeout: 4000, force: false }).catch(() => {});
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * Auto-resolve the Google OAuth scope-consent screen (`accounts.google.com/
 * signin/oauth/{id,consent,warning,...}` or `/o/oauth2/auth`).
 *
 * Fresh GSuite accounts that have never authorized Kiro before land here.
 * The page has a single primary CTA ("Continue" / "Allow" / "Izinkan")
 * instantiated by JS after a brief delay. Without a click, the OAuth flow
 * stalls and Kiro's callback never fires — surfacing as "something went
 * wrong" or a generic callback timeout.
 *
 * Returns true if a click was dispatched.
 */
async function handleGoogleOAuthConsentIfPresent(page, log) {
  let url = '';
  try { url = page.url(); } catch { return false; }
  if (!GOOGLE_OAUTH_CONSENT_URL_RE.test(url)) return false;

  let bodyText = '';
  try {
    bodyText = ((await page.textContent('body', { timeout: 1500 })) || '').toLowerCase();
  } catch { /* ignore */ }

  const looksLikeConsent =
    bodyText.includes('wants access') ||
    bodyText.includes('permissions') ||
    bodyText.includes('permission') ||
    bodyText.includes('izinkan') ||
    bodyText.includes('lanjutkan') ||
    bodyText.includes('allow kiro') ||
    bodyText.includes('access your google account');

  if (!looksLikeConsent) return false;

  if (log) log('[google-login] OAuth scope-consent screen detected — auto-confirming');

  // Render delay — primary CTA is JS-instantiated on these pages.
  await sleep(1100);
  const clicked = await clickFirstVisible(page, GOOGLE_OAUTH_CONSENT_SELECTORS, 5000);
  if (!clicked) {
    if (log) log('[google-login] OAuth consent CTA not found after wait');
    return false;
  }
  // Allow the post-consent redirect chain (back through Cognito) to settle.
  await sleep(1800);
  return true;
}

/**
 * Auto-resolve Google "speedbump" soft confirmation screens ("Was this you?
 * / It was me"). Lives at `/speedbump` or `/signin/speedbump`. One click
 * continues the flow. Never a blocker.
 */
async function handleSpeedbumpIfPresent(page, log) {
  let url = '';
  try { url = page.url(); } catch { return false; }
  if (!SPEEDBUMP_URL_RE.test(url)) return false;

  if (log) log('[google-login] speedbump detected — auto-confirming');
  await sleep(700);
  const clicked = await clickFirstVisible(page, SPEEDBUMP_CONFIRM_SELECTORS, 4000);
  if (!clicked) {
    if (log) log('[google-login] speedbump confirm button not found');
    return false;
  }
  await sleep(1400);
  return true;
}

/**
 * Decide whether we should look for an account-chooser on the current page.
 * True when the URL is a known chooser path, OR the caller is still within
 * the short grace window after email submit (when Google may route us
 * through a chooser even without an obvious URL fragment).
 */
function shouldProbeGoogleAccountChooser(currentHost, currentUrl, nowMs, deadlineMs) {
  const host = String(currentHost || '').toLowerCase();
  const url = String(currentUrl || '').toLowerCase();
  if (!host.includes('accounts.google.com')) return false;
  if (GOOGLE_ACCOUNT_CHOOSER_URL_FRAGMENTS.some((frag) => url.includes(frag))) return true;
  return nowMs < deadlineMs;
}

/**
 * Auto-resolve Google's "Choose an account" screen. Picks the row matching
 * `email` (via `data-identifier`, `data-email`, or visible text). Falls back
 * to the only row if the chooser has exactly one candidate. Explicitly
 * skips "Use another account" / "Add account" entries and header chips.
 *
 * Ported from the Python adapter at enowxai/scripts/auth/app/providers/kiro.py
 * (its `_handle_google_account_chooser`). Returns true when a row was
 * clicked; the caller should yield a beat and re-check the page.
 */
async function handleGoogleAccountChooser(page, email, log) {
  let url = '';
  try { url = page.url(); } catch { return false; }
  if (!/accounts\.google\.com/i.test(url)) return false;
  if (!GOOGLE_ACCOUNT_CHOOSER_URL_FRAGMENTS.some((frag) => url.toLowerCase().includes(frag))) {
    return false;
  }

  try {
    const result = await page.evaluate((targetEmail) => {
      const normalized = String(targetEmail || '').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.width > 0 && r.height > 0;
      };
      const walkText = (el) => String((el && (el.innerText || el.textContent)) || '').trim();
      const blockedPhrases = [
        'use another account',
        'add account',
        'gunakan akun lain',
        'pakai akun lain',
        'tambahkan akun',
      ];
      const hasBlocked = (text) => {
        const t = String(text || '').toLowerCase();
        return blockedPhrases.some((p) => t.includes(p));
      };

      // Scope the search to the chooser panel so we skip the top-right
      // "account chip" that appears on every Google page.
      const chooserRoot = (() => {
        const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'));
        const match = headings.find((h) => {
          const t = walkText(h).toLowerCase();
          return t.includes('choose an account') || t.includes('pilih akun');
        });
        if (match) {
          return (
            match.closest('[role="main"], main, form, section, div[data-view-id]') ||
            match.parentElement ||
            document.body
          );
        }
        return document.querySelector('[role="main"], main, form') || document.body;
      })();

      const clickTarget = (el) => {
        if (!el) return false;
        const target =
          el.closest(
            '[data-identifier], [data-email], div.BHzsHc, li[role="link"], div[role="link"], [role="listitem"], li, a, button, [role="button"]'
          ) || el;
        if (!isVisible(target)) return false;
        try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* ignore */ }
        try { target.click(); } catch { /* ignore */ }
        try {
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch { /* ignore */ }
        return true;
      };

      const raw = Array.from(
        chooserRoot.querySelectorAll(
          [
            'div[data-identifier]',
            'div[data-email]',
            'li[data-identifier]',
            'li[data-email]',
            'div.BHzsHc',
            'li[role="link"]',
            'div[role="link"]',
            '[role="listitem"]',
          ].join(', ')
        )
      );

      const candidates = [];
      for (const el of raw) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        // Skip the top-right chip that leaks past scoping
        const isHeaderChip =
          rect.top < 120 &&
          rect.right > window.innerWidth * 0.55 &&
          !el.closest('[role="main"], main, form');
        if (isHeaderChip) continue;
        if (el.closest('header')) continue;

        const text = walkText(el);
        if (hasBlocked(text)) continue;
        if (!chooserRoot.contains(el)) continue;

        const identifier =
          String(el.getAttribute('data-identifier') || '') ||
          String(el.getAttribute('data-email') || '') ||
          (() => {
            const inner = el.querySelector('[data-identifier], [data-email]');
            if (!inner) return '';
            return String(
              inner.getAttribute('data-identifier') ||
                inner.getAttribute('data-email') ||
                ''
            );
          })();

        const normalizedId = identifier.trim().toLowerCase();
        const emailLike = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
        const textHasTarget = normalized && text.toLowerCase().includes(normalized);
        const matches =
          normalized &&
          (normalizedId === normalized ||
            emailLike.some((v) => String(v).trim().toLowerCase() === normalized) ||
            textHasTarget);

        if (normalizedId || emailLike.length || textHasTarget) {
          candidates.push({ el, matches, top: rect.top || 0, text });
        }
      }

      candidates.sort((a, b) => a.top - b.top);
      const matched = candidates.find((c) => c.matches);
      if (matched) return clickTarget(matched.el) ? 'matched' : '';
      if (candidates.length === 1) return clickTarget(candidates[0].el) ? 'single' : '';
      return '';
    }, email || '');

    if (result) {
      if (log) log(`[google-login] account chooser clicked (${result})`);
      return true;
    }
  } catch (err) {
    if (log) log(`[google-login] account chooser handler error: ${err && err.message}`);
  }
  return false;
}

/**
 * Detect captcha / human-verification screens. Must NOT trigger on Google's
 * normal password page (/signin/challenge/pwd, heading "Verify it's you"),
 * nor on the OAuth scope-consent screen (which is auto-resolved upstream).
 *
 * Also classifies the specific challenge type when we hit one (device
 * prompt, TOTP, SMS, etc.) so callers can render an actionable message.
 */
async function detectCaptcha(page) {
  let currentUrl = '';
  try { currentUrl = page.url(); } catch { return { detected: false, reason: '' }; }
  const lower = currentUrl.toLowerCase();

  // OAuth scope-consent has its own auto-handler; never treat it as captcha.
  if (GOOGLE_OAUTH_CONSENT_URL_RE.test(currentUrl)) {
    return { detected: false, reason: '' };
  }

  // Speedbump is a soft confirm; auto-handled upstream.
  if (SPEEDBUMP_URL_RE.test(currentUrl)) {
    return { detected: false, reason: '' };
  }

  // Normal password step is not a blocker.
  if (lower.includes('/signin/challenge/pwd') || lower.includes('/signin/v2/challenge/pwd')) {
    return { detected: false, reason: '' };
  }

  try {
    const hasPasswordInput = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('input[type="password"], input[name="Passwd"]')
      ).some((el) => el.offsetParent !== null);
    });
    if (hasPasswordInput) return { detected: false, reason: '' };
  } catch { /* ignore */ }

  // Classify specific challenge types first so callers can surface actionable
  // messages (e.g. "check your phone for tap-yes prompt").
  for (const { re, kind } of CHALLENGE_PATH_REGEXES) {
    if (re.test(currentUrl)) {
      return { detected: true, reason: `challenge:${kind}` };
    }
  }

  const urlHints = [
    '/signin/recaptcha',
    '/signin/v2/challenge/recaptcha',
    '/signin/v2/challenge/ipp',
    '/signin/v2/challenge/az',
    '/signin/v2/challenge/kpp',
    '/signin/v2/challenge/selectchallenge',
    '/b/0/bannedaccount',
    '/deniedsigninrejected',
  ];
  for (const hint of urlHints) {
    if (lower.includes(hint)) return { detected: true, reason: `url:${hint}` };
  }

  try {
    const reason = await page.evaluate((botTexts) => {
      for (const frame of document.querySelectorAll('iframe')) {
        const src = (frame.getAttribute('src') || '').toLowerCase();
        if (!src) continue;
        if (src.includes('/recaptcha/api2/bframe') || src.includes('/recaptcha/enterprise')) {
          // bframe may preload at 0x0 before the challenge drops. Require a
          // real bounding box before counting as blocking.
          const rect = frame.getBoundingClientRect();
          if (rect && rect.width > 50 && rect.height > 50) return 'iframe:recaptcha';
        }
        if (src.includes('hcaptcha.com')) return 'iframe:hcaptcha';
        if (src.includes('challenges.cloudflare.com')) return 'iframe:turnstile';
      }
      for (const sel of ['#recaptcha', '.g-recaptcha', '[data-sitekey]']) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetParent !== null) return `widget:${sel}`;
        }
      }
      const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
      const phrases = [
        'unusual activity',
        'unusual sign-in',
        "i'm not a robot",
        'im not a robot',
        'aktivitas tidak biasa',
        'saya bukan robot',
        'ungewöhnliche aktivität',
        'bestätigen sie, dass sie kein roboter sind',
        'activité inhabituelle',
        'actividad inusual',
      ];
      for (const p of phrases) {
        if (bodyText.includes(p)) return `text:${p.slice(0, 24)}`;
      }
      for (const t of botTexts) {
        if (bodyText.includes(t)) return `bot:${t.slice(0, 28)}`;
      }
      return '';
    }, BOT_DETECTION_TEXTS);
    if (reason) return { detected: true, reason };
  } catch { /* ignore */ }

  // Final check: account-disabled hard block.
  try {
    const disabled = await page.evaluate((texts) => {
      const body = (document.body ? document.body.innerText : '').toLowerCase();
      for (const t of texts) if (body.includes(t)) return t;
      return '';
    }, DISABLED_TEXTS);
    if (disabled) return { detected: true, reason: `disabled:${disabled.slice(0, 28)}` };
  } catch { /* ignore */ }

  return { detected: false, reason: '' };
}

// ---------- state-machine loop ----------

/**
 * @param {object} ctx
 * @param {import('playwright').BrowserContext} ctx.context
 * @param {import('playwright').Page} ctx.page
 * @param {string} ctx.email
 * @param {string} ctx.password
 * @param {(p: import('playwright').Page) => Promise<boolean>} ctx.isDone
 *     — returns true when the overall flow should exit the loop successfully.
 * @param {boolean} [ctx.manual=false]
 * @param {boolean} [ctx.headless=false]
 * @param {(msg: string) => void} [ctx.log]
 * @param {string} [ctx.screenshotDir] — where to save captcha screenshots.
 * @param {string} [ctx.screenshotTag] — filename tag (usually the email).
 * @param {string} [ctx.restartUrl] — when provided, a stuck/blank
 *     `/accounts/SetSID` page (observed occasionally on fresh profiles) is
 *     recovered by re-navigating the page to this URL, which bounces Google
 *     back into the sign-in flow. If omitted, SetSID is just skipped over
 *     without any recovery.
 * @param {(page: import('playwright').Page) => Promise<void>} [ctx.onRestart]
 *     — optional hook invoked after a restart navigation, before the loop
 *     resumes. Useful when the caller needs to re-arm a request listener.
 * @param {number} [ctx.defaultDeadlineMs=60000]
 * @param {number} [ctx.captchaExtensionMs=180000]
 * @param {number} [ctx.hardCapMs=600000]
 * @returns {Promise<boolean>} — true if isDone() resolved within the deadline.
 */
async function runGoogleLoginLoop(ctx) {
  const {
    context,
    page,
    email,
    password,
    isDone,
    manual = false,
    headless = false,
    screenshotDir = null,
    screenshotTag = 'unknown',
    restartUrl = null,
    onRestart = null,
  } = ctx;
  const log = ctx.log || ((msg) => process.stderr.write(`[login-loop] ${msg}\n`));
  const DEFAULT_DEADLINE_MS = ctx.defaultDeadlineMs || 60 * 1000;
  const CAPTCHA_EXTENSION_MS = ctx.captchaExtensionMs || 3 * 60 * 1000;
  const HARD_CAP_MS = ctx.hardCapMs || 10 * 60 * 1000;

  // Pre-click warmup: small mouse move + dwell so sites that profile mouse
  // timing before the first click see human-looking input. Cheap and helps
  // against "something went wrong" on fresh Google sessions.
  try {
    const vp = page.viewportSize();
    if (vp) {
      await page.mouse.move(Math.floor(vp.width / 3), Math.floor(vp.height / 2), { steps: 4 });
      await sleep(180 + Math.floor(Math.random() * 160));
      await page.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2) + 40, { steps: 6 });
      await sleep(140 + Math.floor(Math.random() * 160));
    }
  } catch { /* ignore */ }

  const startedAt = Date.now();
  let deadline = startedAt + DEFAULT_DEADLINE_MS;
  let emailTransitionDeadline = 0;
  let passwordTransitionDeadline = 0;
  let emailStepStartedAt = 0;
  let accountChooserDeadline = 0;
  let captchaActive = false;
  let captchaLoggedReason = '';
  let captchaScreenshotSaved = false;
  let lastCaptchaReason = '';
  let setsidFirstSeenAt = 0;
  let setsidRestartCount = 0;

  while (Date.now() < deadline) {
    if (await isDone(page).catch(() => false)) return true;

    let currentUrl = '';
    try { currentUrl = page.url(); } catch { currentUrl = ''; }
    const parsed = currentUrl.startsWith('http') ? new URL(currentUrl) : null;
    const currentHost = parsed ? parsed.hostname : '';
    const nowMs = Date.now();

    // Captcha detection & handoff.
    const captchaCheck = await detectCaptcha(page);
    if (captchaCheck.detected) {
      lastCaptchaReason = captchaCheck.reason;
      if (!captchaActive) {
        captchaActive = true;
        captchaLoggedReason = captchaCheck.reason;
        log(`⚠️  CAPTCHA / verification detected (${captchaCheck.reason}).`);
        if (headless) {
          log('⚠️  Browser is headless — cannot solve. Rerun without --headless.');
        } else {
          log('⚠️  Solve the challenge in the browser. Auto-fill is paused; will resume automatically.');
        }
        if (!captchaScreenshotSaved && screenshotDir) {
          try {
            const safeTag = String(screenshotTag).replace(/[^a-z0-9._-]+/gi, '_');
            const shotPath = path.join(screenshotDir, `captcha-${safeTag}-${Date.now()}.png`);
            await page.screenshot({ path: shotPath, fullPage: true });
            log(`📷  Captcha screenshot saved: ${shotPath}`);
            captchaScreenshotSaved = true;
          } catch { /* ignore */ }
        }
      }
      const extended = nowMs + CAPTCHA_EXTENSION_MS;
      const hardDeadline = startedAt + HARD_CAP_MS;
      deadline = Math.min(Math.max(deadline, extended), hardDeadline);
      emailStepStartedAt = 0;
      emailTransitionDeadline = nowMs + 2000;
      passwordTransitionDeadline = nowMs + 2000;
      await sleep(1500);
      continue;
    } else if (captchaActive) {
      log(`✅  Captcha cleared (was: ${captchaLoggedReason}). Resuming auto-fill.`);
      captchaActive = false;
      captchaLoggedReason = '';
      emailTransitionDeadline = nowMs + 4000;
      passwordTransitionDeadline = nowMs + 4000;
      await sleep(2000);
      continue;
    }

    if (SETSID_URL_RE.test(currentUrl) || currentUrl.toLowerCase().includes('/accounts/set')) {
      // SetSID is Google writing the authenticated account into the browser
      // (Chrome identity / Mirror account consistency). In headless /
      // persistent-context automation it frequently hangs as a blank page
      // because Chrome's identity layer isn't mounted.
      //
      // Fast skip: SetSID URLs always carry the next destination in their
      // `continue=` query param. Navigate straight there and we bypass the
      // sync-into-browser step entirely — no blank page, no 8s wait.
      let skipped = false;
      try {
        const parsed = new URL(currentUrl);
        const cont = parsed.searchParams.get('continue');
        if (cont && /^https?:\/\//i.test(cont)) {
          log(`⏩  SetSID detected; skipping directly to continue=${cont.slice(0, 80)}${cont.length > 80 ? '…' : ''}`);
          await page.goto(cont, { waitUntil: 'domcontentloaded', timeout: 30000 });
          skipped = true;
          setsidFirstSeenAt = 0;
          emailTransitionDeadline = Date.now() + 3000;
          passwordTransitionDeadline = Date.now() + 3000;
          await sleep(600);
        }
      } catch (err) {
        log(`SetSID skip failed: ${err && err.message}`);
      }
      if (skipped) continue;

      // Fallback: if there's no `continue=` param (rare), fall back to the
      // old timeout-based recovery — wait N seconds, then clear ALL cookies
      // (nuclear option for endless SetSID loop) and re-enter the sign-in flow.
      if (!setsidFirstSeenAt) setsidFirstSeenAt = nowMs;
      const stuckFor = nowMs - setsidFirstSeenAt;
      if (stuckFor >= SETSID_STUCK_THRESHOLD_MS && setsidRestartCount < 5) {
        setsidRestartCount += 1;
        log(
          `⚠️  SetSID appears stuck (blank page, ${Math.round(stuckFor / 1000)}s). ` +
          `Nuclear clear ALL cookies and restarting (attempt ${setsidRestartCount}/5)…`
        );
        // NUCLEAR OPTION: Clear ALL cookies to break SetSID loop
        // SetSID loop happens when Google detects existing session and tries to sync
        await clearAllContextCookies(context, log);
        
        // Navigate to app.kiro.dev first, then click login button
        // This is cleaner than direct OAuth URL which can trigger SetSID immediately
        const kiroAppUrl = 'https://app.kiro.dev/signin';
        const targetUrl = restartUrl || kiroAppUrl;
        
        try {
          log(`Navigating to ${targetUrl} for fresh login...`);
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(1500);
          
          // If on signin page, look for Google login button
          const currentUrl = page.url();
          if (currentUrl.includes('kiro.dev') && currentUrl.includes('signin')) {
            const googleBtn = page.locator('button:has-text("Google"), [aria-label*="Google"], a:has-text("Google")').first();
            if (await googleBtn.count() > 0 && await googleBtn.isVisible().catch(() => false)) {
              log('Clicking Google login button on Kiro signin page...');
              await googleBtn.click().catch(() => {});
              await sleep(2000);
            }
          }
        } catch (err) {
          const msg = String(err && err.message || err);
          if (msg.includes('ERR_ABORTED') || msg.includes('Navigation failed')) {
            log(`restart navigation aborted (expected during OAuth)`);
          } else {
            log(`restart navigation failed: ${msg}`);
          }
        }
        if (typeof onRestart === 'function') {
          try { await onRestart(page); } catch (err) { log(`onRestart hook error: ${err && err.message}`); }
        }
        setsidFirstSeenAt = 0;
        emailStepStartedAt = 0;
        emailTransitionDeadline = Date.now() + 3000;
        passwordTransitionDeadline = Date.now() + 3000;
        accountChooserDeadline = Date.now() + 10_000;
        // Give ourselves a fresh budget so the restart isn't immediately
        // blown by a deadline that was almost exhausted.
        deadline = Math.max(deadline, Date.now() + DEFAULT_DEADLINE_MS);
        await sleep(1200);
        continue;
      }
      await sleep(500);
      continue;
    }
    // Any non-SetSID URL clears the stuck timer.
    if (setsidFirstSeenAt) setsidFirstSeenAt = 0;

    // Auto-confirm the Google OAuth scope-consent screen (fresh GSuite
    // accounts authorising Kiro for the first time). This must run before
    // the generic consent / continue button scanners so it doesn't get
    // mistakenly attributed as a "captcha detected" or a timeout.
    if (await handleGoogleOAuthConsentIfPresent(page, log)) {
      emailTransitionDeadline = Date.now() + 3000;
      await sleep(600);
      continue;
    }

    // Auto-confirm speedbump interstitials ("Was this you? / It was me").
    if (await handleSpeedbumpIfPresent(page, log)) {
      emailTransitionDeadline = Date.now() + 3000;
      await sleep(600);
      continue;
    }

    if (await handleGoogleGaplustos(page)) {
      log('Clicked gaplustos consent button.');
      await sleep(800);
      continue;
    }

    if (await handleGoogleConsentContinue(page)) {
      log('Clicked Google OAuth approve/continue.');
      await sleep(800);
      continue;
    }

    const onGoogleAuth = currentHost.includes('accounts.google.com');
    if (onGoogleAuth && !manual) {
      // Probe the Google account-chooser before anything else. When the
      // persistent profile is signed into a Google account (on purpose or
      // accidentally), Google may route us through a chooser instead of
      // the password prompt. Picking the matching row fast-paths us
      // through without waiting for a password input that will never
      // render.
      if (shouldProbeGoogleAccountChooser(currentHost, currentUrl, nowMs, accountChooserDeadline)) {
        if (await handleGoogleAccountChooser(page, email, log)) {
          accountChooserDeadline = 0;
          emailTransitionDeadline = Date.now() + 3000;
          await sleep(1000);
          continue;
        }
      }

      const atPasswordStep = await isPasswordStep(page);
      const atEmailStep = await isEmailStep(page);

      if (atEmailStep && !atPasswordStep) {
        if (!email) {
          log('Email step visible but no --email configured; pausing auto-fill.');
          await sleep(1500);
          continue;
        }
        if (!emailStepStartedAt) emailStepStartedAt = nowMs;
        else if (nowMs - emailStepStartedAt > 60 * 1000) {
          throw new Error('email step stuck > 60s (captcha suspected)');
        }
        if (nowMs < emailTransitionDeadline) {
          await sleep(400);
          continue;
        }
        log(`Filling Google email: ${email}`);
        if (await fillGoogleEmailStep(page, email)) {
          emailTransitionDeadline = Date.now() + 6000;
          accountChooserDeadline = Date.now() + 10_000;
          await sleep(1000);
          continue;
        }
      }

      if (atPasswordStep) {
        emailStepStartedAt = 0;
        if (!password) {
          log('Password step visible but no --password configured; pausing.');
          await sleep(1500);
          continue;
        }
        if (nowMs < passwordTransitionDeadline) {
          await sleep(400);
          continue;
        }
        log('Filling Google password...');
        if (await fillGooglePasswordStep(page, password)) {
          passwordTransitionDeadline = Date.now() + 8000;
          accountChooserDeadline = Date.now() + 10_000;
          await sleep(1000);
          continue;
        }
      }

      if (atEmailStep || atPasswordStep) {
        await sleep(600);
        continue;
      }
    } else {
      emailStepStartedAt = 0;
    }

    if (!manual) {
      await clickContinueButton(page).catch(() => {});
    }
    await sleep(1000);

    // Scan other tabs for isDone / consent buttons.
    for (const p of context.pages()) {
      if (p === page) continue;
      if (await isDone(p).catch(() => false)) return true;
      await handleGoogleOAuthConsentIfPresent(p, log).catch(() => {});
      await handleSpeedbumpIfPresent(p, log).catch(() => {});
      await handleGoogleConsentContinue(p).catch(() => {});
      await handleGoogleGaplustos(p).catch(() => {});
    }
  }

  // Timed out. Best-effort dump the final page state so the operator can
  // figure out where we got stuck without re-running blindly.
  try {
    const safeTag = String(screenshotTag).replace(/[^a-z0-9._-]+/gi, '_');
    const finalUrl = (() => { try { return page.url(); } catch { return ''; } })();
    const title = await page.title().catch(() => '');
    const bodyPreview = await page
      .evaluate(() => ((document.body ? document.body.innerText : '') || '').slice(0, 1200))
      .catch(() => '');
    const summary = {
      email: screenshotTag,
      tookMs: Date.now() - startedAt,
      finalUrl,
      title,
      captchaReason: lastCaptchaReason || null,
      bodyPreview,
    };
    log('────── login timeout diagnostic ──────');
    log(`  finalUrl: ${finalUrl}`);
    log(`  title: ${title}`);
    if (lastCaptchaReason) log(`  lastCaptchaReason: ${lastCaptchaReason}`);
    if (bodyPreview) log(`  bodyPreview: ${bodyPreview.replace(/\s+/g, ' ').slice(0, 240)}...`);
    if (screenshotDir) {
      const base = path.join(screenshotDir, `timeout-${safeTag}-${Date.now()}`);
      try {
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        log(`  screenshot: ${base}.png`);
      } catch { /* ignore */ }
      try {
        const html = await page.content();
        const fs = require('fs');
        fs.writeFileSync(`${base}.html`, html);
        fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
        log(`  html+json: ${base}.{html,json}`);
      } catch { /* ignore */ }
    }
    log('───────────────────────────────────────');
  } catch { /* ignore */ }

  return false;
}

/**
 * Clear Google/YouTube cookies programmatically so the next navigation to
 * accounts.google.com renders a fresh sign-in page instead of bouncing
 * through a half-mounted SSO session (which is what causes the blank
 * /accounts/SetSID hang in the first place).
 *
 * Preferred over `page.goto('https://accounts.google.com/Logout')` because
 * Google's logout flow triggers cross-domain iframes to accounts.youtube.com
 * etc. that fail noisily with "Unsafe attempt to load URL ... from frame
 * with URL chrome-error://chromewebdata" when anything in the chain errors.
 * Cookie clearing is instant, silent, and equivalent for our purposes.
 *
 * Preserves Kiro + Cognito cookies so the caller stays authenticated there.
 */
async function clearGoogleCookies(context, log) {
  try {
    const all = await context.cookies();
    const GOOGLE_DOMAIN_RE = /(?:^|\.)(?:google\.com|googleusercontent\.com|googleapis\.com|youtube\.com|gstatic\.com)$/i;
    const survivors = all.filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
      return !GOOGLE_DOMAIN_RE.test(d);
    });
    const removed = all.length - survivors.length;
    await context.clearCookies();
    if (survivors.length > 0) {
      await context.addCookies(
        survivors.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires === -1 ? undefined : c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }))
      );
    }
    if (log) log(`[google-login] cleared ${removed} Google cookies, kept ${survivors.length}`);
    return { removed, kept: survivors.length };
  } catch (err) {
    if (log) log(`[google-login] clearGoogleCookies failed: ${err && err.message}`);
    return { removed: 0, kept: 0 };
  }
}

/**
 * Clear the Kiro+Cognito auth state before re-running a Google login on a
 * session that's gone stale.
 *
 * Why: Kiro's SPA short-circuits /signin → /account/usage when an old
 * RefreshToken cookie is present. Re-running the login after a dead hydrate
 * lands on /account/usage instead of /signin, so the Google button never
 * renders and we get stuck. Clearing the Kiro-origin + Cognito cookies
 * forces the SPA to show /signin again.
 *
 * Preserves Google cookies (accounts.google.com, google.com) so the user
 * stays signed into Google — avoids forcing re-auth on every upgrade run.
 */
async function clearKiroAuthCookies(context, log) {
  try {
    const all = await context.cookies();
    const survivors = all.filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
      if (d === 'app.kiro.dev' || d === 'kiro.dev' || d.endsWith('.kiro.dev')) return false;
      if (d.endsWith('amazoncognito.com')) return false;
      return true;
    });
    const removed = all.length - survivors.length;
    await context.clearCookies();
    if (survivors.length > 0) {
      await context.addCookies(
        survivors.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires === -1 ? undefined : c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        }))
      );
    }
    if (log) log(`[kiro] cleared ${removed} Kiro/Cognito cookies, kept ${survivors.length}`);
    return { removed, kept: survivors.length };
  } catch (err) {
    if (log) log(`[kiro] clearKiroAuthCookies failed: ${err && err.message}`);
    return { removed: 0, kept: 0 };
  }
}

/**
 * Clear ALL cookies from browser context - nuclear option for SetSID stuck.
 * Used when SetSID loop is endless and we need completely fresh state.
 */
async function clearAllContextCookies(context, log) {
  try {
    const all = await context.cookies();
    const count = all.length;
    await context.clearCookies();
    if (log) log(`[google-login] CLEARED ALL ${count} cookies from context (nuclear option)`);
    return count;
  } catch (err) {
    if (log) log(`[google-login] clearAllContextCookies failed: ${err && err.message}`);
    return 0;
  }
}

/**
 * Save a failure diagnostic bundle (PNG + HTML + visible-button inventory +
 * JSON summary) to `dir`. All files share `basename-timestamp.*` so they're
 * easy to correlate. Never throws.
 */
async function captureDiagnostic(page, dir, basename) {
  const out = { screenshot: null, html: null, buttons: null, summary: null };
  if (!page || !dir || !basename) return out;
  let fs;
  try { fs = require('fs'); } catch { return out; }
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const safe = String(basename).replace(/[^a-z0-9._-]+/gi, '_');
  const ts = Date.now();
  const base = path.join(dir, `${safe}-${ts}`);

  let finalUrl = '';
  try { finalUrl = page.url(); } catch { /* ignore */ }

  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    out.screenshot = `${base}.png`;
  } catch { /* ignore */ }

  try {
    const html = await page.content();
    fs.writeFileSync(`${base}.html`, html);
    out.html = `${base}.html`;
  } catch { /* ignore */ }

  try {
    const inventory = await page.evaluate(() => {
      const result = [];
      for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) continue;
        const txt = (el.textContent || el.getAttribute('aria-label') || el.value || '').trim();
        if (!txt) continue;
        result.push({
          tag: el.tagName.toLowerCase(),
          text: txt.slice(0, 80),
          testid: el.getAttribute('data-testid') || null,
          href: el.getAttribute('href') || null,
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
        if (result.length >= 40) break;
      }
      return result;
    });
    fs.writeFileSync(`${base}.buttons.json`, JSON.stringify(inventory, null, 2));
    out.buttons = `${base}.buttons.json`;
  } catch { /* ignore */ }

  try {
    const title = await page.title().catch(() => '');
    const bodyPreview = await page
      .evaluate(() => ((document.body ? document.body.innerText : '') || '').slice(0, 1500))
      .catch(() => '');
    const summary = {
      capturedAt: new Date(ts).toISOString(),
      basename,
      finalUrl,
      title,
      bodyPreview,
    };
    fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
    out.summary = `${base}.json`;
  } catch { /* ignore */ }

  return out;
}

module.exports = {
  isEmailStep,
  isPasswordStep,
  fillGoogleEmailStep,
  fillGooglePasswordStep,
  handleGoogleGaplustos,
  handleGoogleConsentContinue,
  handleGoogleOAuthConsentIfPresent,
  handleSpeedbumpIfPresent,
  handleGoogleAccountChooser,
  shouldProbeGoogleAccountChooser,
  clickContinueButton,
  detectCaptcha,
  runGoogleLoginLoop,
  clearKiroAuthCookies,
  clearGoogleCookies,
  clearAllContextCookies,
  captureDiagnostic,
};
