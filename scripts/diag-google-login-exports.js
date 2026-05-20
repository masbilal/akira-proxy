'use strict';

// scripts/diag-google-login-exports.js — verifies all expected exports are
// present and callable. Does NOT touch the network.

const m = require('./lib/google-login');
const expected = [
  'isEmailStep',
  'isPasswordStep',
  'fillGoogleEmailStep',
  'fillGooglePasswordStep',
  'handleGoogleGaplustos',
  'handleGoogleConsentContinue',
  'handleGoogleOAuthConsentIfPresent',
  'handleSpeedbumpIfPresent',
  'handleGoogleAccountChooser',
  'shouldProbeGoogleAccountChooser',
  'clickContinueButton',
  'detectCaptcha',
  'runGoogleLoginLoop',
  'clearKiroAuthCookies',
  'clearGoogleCookies',
  'captureDiagnostic',
];
let missing = 0;
for (const name of expected) {
  const v = m[name];
  const type = typeof v;
  const ok = type === 'function';
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(38)} (${type})`);
  if (!ok) missing += 1;
}
if (missing > 0) {
  console.error(`\n[diag] ${missing} export(s) missing`);
  process.exit(1);
}
console.log('\n[diag] all exports OK');
