'use strict';

const db = require('../db');
const { safeJsonParse, now } = require('../utils/common');

function hasRemainingCredits(subscription) {
  const usage = subscription && subscription.usage;
  if (!usage) return false;
  const limit = Number(usage.limit || 0);
  const current = Number(usage.current || 0);
  return limit > 0 && current < limit;
}

function isExhaustedSubscription(subscription) {
  const usage = subscription && subscription.usage;
  if (!usage) return false;
  const limit = Number(usage.limit || 0);
  const current = Number(usage.current || 0);
  return limit > 0 && current >= limit;
}

async function probeKiroAccountSubscription(providerRow, accountRow) {
  if (!providerRow || providerRow.type !== 'kiro' || !accountRow) {
    throw new Error('Kiro warmup only supports Kiro provider accounts');
  }

  const KiroProvider = require('../providers/kiro');
  const adapter = new KiroProvider({ ...providerRow, account: accountRow });
  const info = await adapter.fetchUsageInfo();
  if (info.status !== 200) {
    throw new Error(`upstream returned ${info.status}`);
  }

  const subscription = KiroProvider.classifySubscription(info.body);
  return {
    subscription,
    hasRemainingCredits: hasRemainingCredits(subscription),
    isExhausted: isExhaustedSubscription(subscription),
  };
}

function persistWarmupResult(accountId, subscription, opts = {}) {
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return null;

  const cfg = safeJsonParse(account.config_json, {});
  cfg.subscription = subscription;

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

async function warmupKiroAccount(providerRow, accountRow, opts = {}) {
  const probe = await probeKiroAccountSubscription(providerRow, accountRow);
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
  hasRemainingCredits,
  isExhaustedSubscription,
  persistWarmupResult,
  probeKiroAccountSubscription,
  warmupKiroAccount,
};
