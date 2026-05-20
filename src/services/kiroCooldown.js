'use strict';

/**
 * Post-request cool-down / warmup for Kiro accounts.
 *
 * Symptom: an account that just served a successful chat request is often
 * rate-limited on the very next call (even when it still has remaining
 * credits). Amazon Q / Kiro seems to rotate a throttling bucket tied to the
 * short-lived access token. Forcing a token refresh + usage probe after each
 * request "resets" that bucket and gives us a fresh token for the next pick.
 *
 * This module:
 *   - Is called fire-and-forget from the model proxy after a Kiro response.
 *   - Throttles per-account so we don't hammer Kiro's auth endpoint.
 *   - Swallows all errors; the upstream response has already been sent.
 */

const db = require('../db');
const { now } = require('../utils/common');

const ENABLED = String(process.env.KIRO_POST_REQUEST_REFRESH || '1') !== '0';
const MIN_GAP_SEC = Math.max(
  0,
  Number(process.env.KIRO_POST_REQUEST_REFRESH_GAP_SEC || 30) || 30
);
const DEBOUNCE_MS = Math.max(
  0,
  Number(process.env.KIRO_POST_REQUEST_REFRESH_DEBOUNCE_MS || 1500) || 1500
);
const DEBUG = String(process.env.KIRO_POST_REQUEST_REFRESH_DEBUG || '0') === '1';

// accountId -> { lastRunAt: epochSec, timer: Timeout|null, inFlight: boolean }
const state = new Map();

function log(msg, extra) {
  if (!DEBUG) return;
  if (extra !== undefined) {
    console.log(`[kiro-cooldown] ${msg}`, extra);
  } else {
    console.log(`[kiro-cooldown] ${msg}`);
  }
}

function isEnabled() {
  return ENABLED;
}

function getAccountState(accountId) {
  let entry = state.get(accountId);
  if (!entry) {
    entry = { lastRunAt: 0, timer: null, inFlight: false };
    state.set(accountId, entry);
  }
  return entry;
}

async function runCooldown(providerId, accountId) {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!provider || !account) return;
  if (provider.type !== 'kiro') return;

  const KiroProvider = require('../providers/kiro');
  const adapter = new KiroProvider({ ...provider, account });

  // 1. Force-refresh access token if we have a refresh_token. This rotates
  //    the short-lived bearer that Kiro uses for per-token rate limiting.
  if (account.refresh_token) {
    try {
      await adapter._refreshIfNeeded(true);
      log(`refreshed token for account=${accountId}`);
    } catch (err) {
      log(`token refresh failed account=${accountId}: ${err.message}`);
    }
  }

  // 2. Probe /getUsageLimits to keep subscription + usage counters fresh
  //    for the admin UI, and to catch accounts that actually ran out of
  //    credits so routing skips them next time. This also double-confirms
  //    that the rotated token is accepted upstream.
  try {
    const { warmupKiroAccount } = require('./kiroWarmup');
    // Re-read the account — the token refresh above may have updated columns.
    const refreshedAccount = db
      .prepare('SELECT * FROM provider_accounts WHERE id = ?')
      .get(accountId);
    if (refreshedAccount) {
      await warmupKiroAccount(provider, refreshedAccount, {
        clearErrorOnAvailable: false,
      });
      log(`probed usage for account=${accountId}`);
    }
  } catch (err) {
    log(`usage probe failed account=${accountId}: ${err.message}`);
  }
}

/**
 * Schedule a post-request cool-down. Safe to call many times per second;
 * subsequent calls inside the debounce window are coalesced.
 *
 * Never throws. Never awaits the actual refresh.
 */
function scheduleAfterRequest(providerRow, accountId) {
  if (!isEnabled()) return;
  if (!providerRow || providerRow.type !== 'kiro') return;
  if (!accountId) return;

  const providerId = providerRow.id;
  const entry = getAccountState(accountId);

  // Per-account throttle: only one refresh per MIN_GAP_SEC seconds, unless
  // it's the very first call.
  const elapsed = now() - entry.lastRunAt;
  if (entry.lastRunAt && elapsed < MIN_GAP_SEC) {
    log(`throttled account=${accountId} (gap=${elapsed}s < ${MIN_GAP_SEC}s)`);
    return;
  }

  // Coalesce rapid successive calls for the same account.
  if (entry.timer) {
    log(`coalesced account=${accountId}`);
    return;
  }

  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.inFlight) return;
    entry.inFlight = true;
    entry.lastRunAt = now();

    runCooldown(providerId, accountId)
      .catch((err) => log(`cooldown error account=${accountId}: ${err.message}`))
      .finally(() => {
        entry.inFlight = false;
      });
  }, DEBOUNCE_MS);

  // In Node, `unref()` lets the process exit cleanly if this is the only
  // pending timer (e.g. during test teardown).
  if (entry.timer && typeof entry.timer.unref === 'function') {
    entry.timer.unref();
  }
}

/**
 * Reset internal throttling state. Exposed primarily for tests.
 */
function resetState() {
  for (const entry of state.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  state.clear();
}

module.exports = {
  isEnabled,
  scheduleAfterRequest,
  resetState,
  // exposed for tests / manual triggering
  runCooldown,
};
