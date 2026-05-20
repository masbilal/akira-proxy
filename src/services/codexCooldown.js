'use strict';

/**
 * Post-request cool-down / warmup for Codex (ChatGPT) accounts.
 *
 * Mirrors `kiroCooldown.js`. After a successful /codex/responses request we:
 *   1. Optionally force-refresh the access_token if it is close to expiry or
 *      the upstream rejected us recently. Codex tokens live ~5 days so we do
 *      NOT rotate on every hit; only when needed.
 *   2. Re-probe /wham/usage to keep `primary_window` / `secondary_window`
 *      percentages fresh in the admin UI and to flag the account as
 *      exhausted when the weekly bucket is spent.
 *
 * Fire-and-forget: never awaited from the request path, never throws.
 */

const db = require('../db');
const { now } = require('../utils/common');

const ENABLED = String(process.env.CODEX_POST_REQUEST_REFRESH || '1') !== '0';
const MIN_GAP_SEC = Math.max(
  0,
  Number(process.env.CODEX_POST_REQUEST_REFRESH_GAP_SEC || 60) || 60
);
const DEBOUNCE_MS = Math.max(
  0,
  Number(process.env.CODEX_POST_REQUEST_REFRESH_DEBOUNCE_MS || 1500) || 1500
);
const DEBUG = String(process.env.CODEX_POST_REQUEST_REFRESH_DEBUG || '0') === '1';

// accountId -> { lastRunAt: epochSec, timer: Timeout|null, inFlight: boolean }
const state = new Map();

function log(msg, extra) {
  if (!DEBUG) return;
  if (extra !== undefined) {
    console.log(`[codex-cooldown] ${msg}`, extra);
  } else {
    console.log(`[codex-cooldown] ${msg}`);
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
  if (provider.type !== 'codex') return;

  // Probe /wham/usage via the warmup service. The adapter's
  // `fetchUsageInfo()` under the hood already auto-refreshes the
  // access_token if upstream returns 401/403, so we don't need to pre-rotate
  // the bearer here.
  try {
    const { warmupCodexAccount } = require('./codexWarmup');
    await warmupCodexAccount(provider, account, {
      clearErrorOnAvailable: false,
    });
    log(`probed usage for account=${accountId}`);
  } catch (err) {
    log(`usage probe failed account=${accountId}: ${err.message}`);
  }
}

/**
 * Schedule a post-request cool-down. Safe to call many times per second;
 * subsequent calls inside the debounce window are coalesced.
 *
 * Never throws. Never awaits the actual probe.
 */
function scheduleAfterRequest(providerRow, accountId) {
  if (!isEnabled()) return;
  if (!providerRow || providerRow.type !== 'codex') return;
  if (!accountId) return;

  const providerId = providerRow.id;
  const entry = getAccountState(accountId);

  // Per-account throttle: only one probe per MIN_GAP_SEC seconds.
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
  runCooldown,
};
