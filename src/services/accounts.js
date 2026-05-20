'use strict';

const db = require('../db');
const { now, safeJsonParse } = require('../utils/common');
const ACCOUNT_ERROR_COOLDOWN_SEC = Math.max(30, Number(process.env.ACCOUNT_ERROR_COOLDOWN_SEC || 300) || 300);
const ACCOUNT_SELECTION_MODE = String(process.env.ACCOUNT_SELECTION_MODE || 'smart').trim().toLowerCase();
const ACCOUNT_MIN_REUSE_GAP_SEC = Math.max(0, Number(process.env.ACCOUNT_MIN_REUSE_GAP_SEC || 45) || 45);

function providerConfig(providerRow) {
  return safeJsonParse(providerRow && providerRow.config_json, {});
}

function updateProviderSelection(providerId, accountId) {
  if (!providerId || !accountId) return;
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return;

  const cfg = providerConfig(provider);
  cfg.accountRouting = {
    ...(cfg.accountRouting && typeof cfg.accountRouting === 'object' ? cfg.accountRouting : {}),
    lastAccountId: accountId,
    lastSelectedAt: now(),
  };

  db.prepare('UPDATE providers SET current_account_id = ?, config_json = ?, updated_at = ? WHERE id = ?')
    .run(accountId, JSON.stringify(cfg), now(), providerId);
}

function accountConfig(account) {
  return safeJsonParse(account && account.config_json, {});
}

function accountError(account) {
  const cfg = accountConfig(account);
  return cfg && cfg.error && typeof cfg.error === 'object' ? cfg.error : null;
}

function accountErrorLabel(account) {
  const error = accountError(account);
  if (!error) return null;
  if (error.label) return String(error.label);
  if (error.kind === 'rate_limited') return 'rate limited';
  return 'error';
}

function accountHasActiveError(account, currentTs = now()) {
  const error = accountError(account);
  if (!error) return false;
  const until = Number(error.until || 0) || 0;
  return until <= 0 || until > currentTs;
}

function accountStatusLabel(account, currentTs = now()) {
  if (!account) return 'unknown';
  if (account.exhausted_at) return 'exhausted';
  if (accountHasActiveError(account, currentTs)) return accountErrorLabel(account) || 'error';
  return account.enabled ? 'active' : 'disabled';
}

function accountIsExhausted(account) {
  if (!account) return true;
  if (account.exhausted_at) return true;
  const cfg = accountConfig(account);
  const usage = cfg.subscription && cfg.subscription.usage;
  if (!usage) return false;
  const limit = Number(usage.limit || 0);
  const current = Number(usage.current || 0);
  return limit > 0 && current >= limit;
}

function accountTier(account) {
  const cfg = accountConfig(account);
  const sub = cfg.subscription || {};
  return String(sub.tier || 'unknown').toLowerCase();
}

function accountErrorCount(account) {
  const error = accountError(account);
  return Number(error && error.count ? error.count : 0) || 0;
}

function accountMatchesTier(account, requestedTier) {
  const tier = String(requestedTier || 'any').toLowerCase();
  if (tier === 'any') return true;
  const actual = accountTier(account);
  // Rules: "free" accepts any paid tier above it; otherwise require exact match.
  // `plus`, `team`, `business`, `edu` are ChatGPT-side tiers for Codex.
  const allowed = {
    free: ['free', 'plus', 'pro', 'team', 'business', 'edu', 'power', 'enterprise'],
    plus: ['plus', 'pro', 'team', 'business', 'enterprise'],
    pro: ['pro', 'team', 'business', 'enterprise'],
    team: ['team', 'business', 'enterprise'],
    business: ['business', 'enterprise'],
    edu: ['edu'],
    power: ['power'],
    enterprise: ['enterprise'],
  };
  return (allowed[tier] || [tier]).includes(actual);
}

function listProviderAccounts(providerRow, opts = {}) {
  const requestedTier = opts.accountTier || 'any';
  const currentTs = now();
  let accounts = db.prepare(`
    SELECT * FROM provider_accounts
    WHERE provider_id = ? AND enabled = 1 AND exhausted_at IS NULL AND deleted_at IS NULL
    ORDER BY id ASC
  `).all(providerRow.id)
    .filter((account) => !accountIsExhausted(account))
    .filter((account) => !accountHasActiveError(account, currentTs))
    .filter((account) => accountMatchesTier(account, requestedTier));

  const excludeIds = new Set(
    Array.isArray(opts.excludeAccountIds)
      ? opts.excludeAccountIds.map((id) => Number(id)).filter(Boolean)
      : []
  );
  if (excludeIds.size) {
    accounts = accounts.filter((account) => !excludeIds.has(Number(account.id)));
  }

  return accounts;
}

function pickProviderAccount(providerRow, opts = {}) {
  const accounts = listProviderAccounts(providerRow, opts);

  if (!accounts.length) return null;

  const selected = selectProviderAccount(providerRow, accounts);
  updateProviderSelection(providerRow.id, selected.id);
  touchAccount(selected.id);
  return selected;
}

function selectProviderAccount(providerRow, accounts) {
  const cfg = providerConfig(providerRow);
  const routing = cfg.accountRouting && typeof cfg.accountRouting === 'object' ? cfg.accountRouting : {};
  const lastAccountId = Number(routing.lastAccountId || providerRow.current_account_id || 0) || 0;

  const ordered = [...accounts].sort((a, b) => Number(a.id) - Number(b.id));
  if (ordered.length === 1) return ordered[0];

  if (ACCOUNT_SELECTION_MODE === 'round_robin') {
    return selectNextRoundRobin(ordered, lastAccountId);
  }

  return selectSmartAccount(ordered, lastAccountId);
}

function selectNextRoundRobin(accounts, lastAccountId) {
  if (!lastAccountId) return accounts[0];
  const currentIndex = accounts.findIndex((account) => Number(account.id) === Number(lastAccountId));
  if (currentIndex < 0) return accounts[0];
  return accounts[(currentIndex + 1) % accounts.length];
}

function selectSmartAccount(accounts, lastAccountId) {
  const currentTs = now();
  let candidates = accounts;

  if (ACCOUNT_MIN_REUSE_GAP_SEC > 0) {
    const cooledDown = accounts.filter((account) => {
      const lastUsedAt = Number(account.last_used_at || 0) || 0;
      return !lastUsedAt || (currentTs - lastUsedAt) >= ACCOUNT_MIN_REUSE_GAP_SEC;
    });
    if (cooledDown.length) {
      candidates = cooledDown;
    }
  }

  const lowestErrorCount = Math.min(...candidates.map((account) => accountErrorCount(account)));
  const safest = candidates.filter((account) => accountErrorCount(account) === lowestErrorCount);
  const roundRobinPool = safest.length ? safest : candidates;

  return selectNextRoundRobin(roundRobinPool, lastAccountId);
}

function attachAccount(providerRow, accountRow) {
  if (!accountRow) return providerRow;
  return { ...providerRow, account: accountRow };
}

function markAccountExhausted(accountId) {
  if (!accountId) return;
  db.prepare('UPDATE provider_accounts SET exhausted_at = ?, updated_at = ? WHERE id = ?')
    .run(now(), now(), accountId);
}

function markAccountError(accountId, message, opts = {}) {
  if (!accountId) return;
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return;

  const cfg = accountConfig(account);
  const ts = now();
  const cooldownSec = Math.max(30, Number(opts.cooldownSec ?? ACCOUNT_ERROR_COOLDOWN_SEC) || ACCOUNT_ERROR_COOLDOWN_SEC);
  const previousCount = Number(cfg.error && cfg.error.count ? cfg.error.count : 0) || 0;
  cfg.error = {
    message: String(message || 'Unknown account error'),
    status: opts.status ?? null,
    code: opts.code ?? null,
    kind: opts.kind || 'error',
    label: String(opts.label || (opts.kind === 'rate_limited' ? 'rate limited' : 'error')),
    at: ts,
    until: ts + cooldownSec,
    count: previousCount + 1,
    needsWarmup: Boolean(opts.needsWarmup),
  };
  cfg.lastError = {
    message: String(message || 'Unknown account error'),
    status: opts.status ?? null,
    code: opts.code ?? null,
    kind: opts.kind || 'error',
    label: String(opts.label || (opts.kind === 'rate_limited' ? 'rate limited' : 'error')),
    at: ts,
  };
  if (opts.needsWarmup) {
    cfg.warmupRecommendedAt = ts;
  }

  let tokenExpiresAt = account.token_expires_at;
  if (opts.queueTokenRefresh && account.refresh_token) {
    cfg.tokenRefreshQueuedAt = ts;
    cfg.tokenRefreshReason = String(opts.tokenRefreshReason || message || 'account_error');
    cfg.tokenRefreshRequested = true;
    tokenExpiresAt = ts - 1;
  }

  db.prepare(`
    UPDATE provider_accounts
    SET config_json = ?, token_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(cfg), tokenExpiresAt, ts, accountId);
}

function clearAccountError(accountId, opts = {}) {
  if (!accountId) return;
  const account = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(accountId);
  if (!account) return;

  const cfg = accountConfig(account);
  let changed = false;
  for (const key of ['error', 'tokenRefreshQueuedAt', 'tokenRefreshReason', 'tokenRefreshRequested', 'warmupRecommendedAt']) {
    if (key in cfg) {
      delete cfg[key];
      changed = true;
    }
  }
  if (opts.clearLastError && 'lastError' in cfg) {
    delete cfg.lastError;
    changed = true;
  }
  if (!changed) return;

  db.prepare('UPDATE provider_accounts SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(cfg), now(), accountId);
}

function clearProviderCurrentAccount(providerId, accountId) {
  db.prepare(`
    UPDATE providers
    SET current_account_id = NULL, updated_at = ?
    WHERE id = ? AND current_account_id = ?
  `).run(now(), providerId, accountId);
}

function touchAccount(accountId) {
  db.prepare('UPDATE provider_accounts SET last_used_at = ? WHERE id = ?').run(now(), accountId);
}

function shouldMarkExhausted(result) {
  const text = JSON.stringify(result && (result.body || result.error || result));
  return /quota|limit|exhaust|usage|too many|throttle|rate/i.test(text || '');
}

module.exports = {
  accountConfig,
  accountError,
  accountErrorLabel,
  accountHasActiveError,
  accountIsExhausted,
  accountMatchesTier,
  accountStatusLabel,
  accountTier,
  attachAccount,
  clearAccountError,
  clearProviderCurrentAccount,
  accountErrorCount,
  listProviderAccounts,
  markAccountError,
  markAccountExhausted,
  pickProviderAccount,
  providerConfig,
  shouldMarkExhausted,
};
