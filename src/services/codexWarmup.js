'use strict';

/**
 * Codex subscription warmup — parallel of kiroWarmup for Codex accounts.
 *
 * Calls `fetchUsageInfo()` on the Codex adapter (which hits the
 * `/backend-api/accounts/{id}/usage` endpoint), normalizes the response via
 * `CodexProvider.classifySubscription`, and persists it to
 * `provider_accounts.config_json.subscription`. Marks the account as
 * exhausted when either the 5-hour or the weekly rate bucket is at/over 100%.
 */

const db = require('../db');
const { safeJsonParse, now } = require('../utils/common');

function bucketPercent(bucket) {
  if (!bucket) return null;
  const raw = bucket.used_percent ?? bucket.usedPercent ?? bucket.used;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isExhaustedCodexSubscription(subscription) {
  if (!subscription) return false;
  const primary = bucketPercent(subscription.primary);
  const secondary = bucketPercent(subscription.secondary);
  if (primary !== null && primary >= 100) return true;
  if (secondary !== null && secondary >= 100) return true;
  return false;
}

function hasRemainingCodexCredits(subscription) {
  if (!subscription) return false;
  const primary = bucketPercent(subscription.primary);
  const secondary = bucketPercent(subscription.secondary);
  // Usable when at least one bucket is known and below 100%.
  if (primary === null && secondary === null) return false;
  const primaryOk = primary === null || primary < 100;
  const secondaryOk = secondary === null || secondary < 100;
  return primaryOk && secondaryOk;
}

async function probeCodexAccountSubscription(providerRow, accountRow) {
  if (!providerRow || providerRow.type !== 'codex' || !accountRow) {
    throw new Error('Codex warmup only supports Codex provider accounts');
  }
  const CodexProvider = require('../providers/codex');
  const adapter = new CodexProvider({ ...providerRow, account: accountRow });
  const info = await adapter.fetchUsageInfo();
  if (info.status !== 200) {
    const err = new Error(summarizeUpstreamError(info.status, info.body));
    err.status = info.status;
    throw err;
  }
  if (!info.body || typeof info.body !== 'object') {
    // 200 with non-JSON body means an edge/proxy returned an HTML page.
    const err = new Error(summarizeUpstreamError(info.status, info.body));
    err.status = info.status;
    throw err;
  }
  const subscription = CodexProvider.classifySubscription(info.body);
  return {
    subscription,
    hasRemainingCredits: hasRemainingCodexCredits(subscription),
    isExhausted: isExhaustedCodexSubscription(subscription),
  };
}

/**
 * Turn whatever the upstream returned into a short, readable error string.
 * Codex sometimes answers with an HTML interstitial (Cloudflare challenge,
 * auth redirect, 5xx page) instead of JSON — echoing a 4 KB HTML blob into
 * the UI is useless, so we collapse it to one line with a hint.
 */
function summarizeUpstreamError(status, body) {
  const statusLabel = status ? `HTTP ${status}` : 'upstream error';
  if (body && typeof body === 'object') {
    const msg = (body.error && (body.error.message || body.error.code)) || body.message || body.detail;
    if (msg) return `${statusLabel}: ${String(msg).slice(0, 240)}`;
    try { return `${statusLabel}: ${JSON.stringify(body).slice(0, 240)}`; } catch {
      return statusLabel;
    }
  }
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return statusLabel;
    // Detect HTML responses and give an actionable hint.
    if (/^<!doctype html|^<html/i.test(trimmed)) {
      if (status === 401 || status === 403) {
        return `${statusLabel}: session expired — re-login (access_token rejected)`;
      }
      if (status === 429) {
        return `${statusLabel}: rate limited by ChatGPT edge (Cloudflare)`;
      }
      if (status >= 500) {
        return `${statusLabel}: ChatGPT upstream returned an HTML error page`;
      }
      return `${statusLabel}: ChatGPT returned an HTML page instead of JSON — likely auth/redirect`;
    }
    return `${statusLabel}: ${trimmed.slice(0, 240)}`;
  }
  return statusLabel;
}

function persistWarmupResult(accountId, subscription, opts = {}) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return null;

  const cfg = safeJsonParse(account.config_json, {});
  cfg.subscription = subscription;
  // Keep plan type visible to UI even when subscription is reset later.
  if (subscription && subscription.planType) cfg.chatgptPlanType = subscription.planType;

  if (opts.clearError) {
    for (const key of ['error', 'tokenRefreshQueuedAt', 'tokenRefreshReason', 'tokenRefreshRequested', 'warmupRecommendedAt']) {
      delete cfg[key];
    }
  }

  const exhaustedAt = opts.exhaustedAt === undefined ? account.exhausted_at : opts.exhaustedAt;
  db.prepare(`
    UPDATE provider_accounts
    SET config_json = ?, exhausted_at = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(cfg), exhaustedAt ?? null, now(), accountId);

  return db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
}

async function warmupCodexAccount(providerRow, accountRow, opts = {}) {
  const probe = await probeCodexAccountSubscription(providerRow, accountRow);
  const clearError = Boolean(opts.clearErrorOnAvailable && probe.hasRemainingCredits);
  const exhaustedAt = probe.isExhausted ? now() : null;
  const refreshedAccount = persistWarmupResult(accountRow.id, probe.subscription, {
    clearError,
    exhaustedAt,
  });
  return {
    ...probe,
    account: refreshedAccount,
    clearedError: clearError,
    exhaustedAt,
  };
}

module.exports = {
  bucketPercent,
  hasRemainingCodexCredits,
  isExhaustedCodexSubscription,
  probeCodexAccountSubscription,
  persistWarmupResult,
  warmupCodexAccount,
};
