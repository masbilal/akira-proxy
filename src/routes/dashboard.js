'use strict';

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { formatDate, safeJsonParse } = require('../utils/common');
const { listTypes } = require('../providers');
const { accountHasActiveError, accountStatusLabel } = require('../services/accounts');
const { DEFAULT_LOGS_PER_PAGE, getLogPage } = require('../services/logs');

const router = express.Router();

/* -------- Login / logout (public) -------- */

router.get('/login', (req, res) => {
  if (req.session && req.session.admin) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.ADMIN_USERNAME || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD || 'changeme';
  if (username === expectedUser && password === expectedPass) {
    req.session.admin = { username };
    return req.session.save((err) => {
      if (err) {
        console.error('[session] failed to save admin session:', err.message);
        return res.status(500).render('login', { error: 'Failed to create session' });
      }
      return res.redirect('/');
    });
  }
  res.status(401).render('login', { error: 'Invalid credentials' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

/* ------------- Dashboard pages (protected) ------------- */

router.use(requireAdmin);

router.get('/', (req, res) => {
  const providerCount = db.prepare('SELECT COUNT(*) AS c FROM providers WHERE deleted_at IS NULL').get().c;
  const accountCount = db.prepare('SELECT COUNT(*) AS c FROM provider_accounts WHERE deleted_at IS NULL').get().c;
  const models = db.prepare('SELECT COUNT(*) AS c FROM models WHERE deleted_at IS NULL').get().c;
  const apiKeys = db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL AND deleted_at IS NULL').get().c;
  const reqs24 = db.prepare(`
    SELECT COUNT(*) AS c FROM request_logs
    WHERE created_at > strftime('%s','now') - 86400
  `).get().c;
  const providers = db.prepare('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY name ASC').all();
  const accounts = db.prepare('SELECT * FROM provider_accounts WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
  const providerSummaries = providers.map((provider) => {
    const rows = accounts.filter((account) => account.provider_id === provider.id);
    return buildProviderAccountSummary(provider, rows);
  });
  const accountStats = providerSummaries.reduce((acc, item) => {
    for (const key of ['active', 'disabled', 'exhausted', 'error', 'free', 'pro', 'power', 'enterprise', 'unknown', 'creditsCurrent', 'creditsLimit']) {
      acc[key] += Number(item.stats[key] || 0);
    }
    return acc;
  }, {
    active: 0,
    disabled: 0,
    exhausted: 0,
    error: 0,
    free: 0,
    pro: 0,
    power: 0,
    enterprise: 0,
    unknown: 0,
    creditsCurrent: 0,
    creditsLimit: 0,
  });
  accountStats.creditPct = accountStats.creditsLimit > 0
    ? Math.min(100, Math.round((accountStats.creditsCurrent / accountStats.creditsLimit) * 100))
    : 0;
  const tokenHistory = buildTokenHistory();

  res.render('dashboard', {
    active: 'overview',
    stats: { providers: providerCount, accounts: accountCount, models, apiKeys, reqs24 },
    providerSummaries,
    accountStats,
    tokenHistory,
    formatDate,
  });
});

router.get('/accounts', (req, res) => {
  const providers = db.prepare('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY name ASC').all();
  const accounts = db.prepare(`
    SELECT a.*, p.name AS provider_name, p.type AS provider_type
    FROM provider_accounts a
    JOIN providers p ON p.id = a.provider_id
    WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY p.name ASC, a.created_at DESC
  `).all();
  const summaries = providers.map((provider) => {
    const rows = accounts.filter((account) => account.provider_id === provider.id);
    return buildProviderAccountSummary(provider, rows);
  });
  res.render('accounts', {
    active: 'accounts',
    summaries,
    providers,
    formatDate,
    safeJsonParse,
  });
});

router.get('/accounts/:providerId', (req, res) => {
  const providerId = Number(req.params.providerId);
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return res.status(404).send('Provider not found');

  // Filters
  const allowedStatus = new Set(['all', 'active', 'disabled', 'exhausted', 'error']);
  const allowedTier = new Set(['all', 'free', 'pro', 'power', 'enterprise', 'unknown']);
  const status = allowedStatus.has(String(req.query.status)) ? String(req.query.status) : 'all';
  const tier = allowedTier.has(String(req.query.tier)) ? String(req.query.tier) : 'all';
  const q = (req.query.q || '').toString().trim();

  const allRowsRaw = db.prepare(`
    SELECT a.*, p.name AS provider_name, p.type AS provider_type
    FROM provider_accounts a
    JOIN providers p ON p.id = a.provider_id
    WHERE a.provider_id = ? AND a.deleted_at IS NULL
    ORDER BY
      CASE WHEN a.exhausted_at IS NOT NULL THEN 3 WHEN a.enabled = 0 THEN 2 ELSE 1 END,
      a.updated_at DESC
  `).all(providerId);

  const nowSec = Math.floor(Date.now() / 1000);
  const decorated = allRowsRaw.map((row) => {
    const cfg = safeJsonParse(row.config_json, {}) || {};
    const sub = cfg.subscription || null;
    const errorState = cfg.error && (!cfg.error.until || Number(cfg.error.until) > nowSec) ? cfg.error : null;
    const rowStatus = row.exhausted_at
      ? 'exhausted'
      : errorState
        ? 'error'
        : row.enabled
          ? 'active'
          : 'disabled';
    const rowTier = sub && sub.tier ? String(sub.tier).toLowerCase() : 'unknown';
    return { row, cfg, sub, errorState, rowStatus, rowTier };
  });

  const needle = q.toLowerCase();
  const filtered = decorated.filter(({ row, rowStatus, rowTier }) => {
    if (status !== 'all' && rowStatus !== status) return false;
    if (tier !== 'all' && rowTier !== tier) return false;
    if (needle) {
      const hay = [row.label, row.email].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 24;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * perPage;
  const pageRows = filtered.slice(offset, offset + perPage).map((d) => d.row);

  const allRows = allRowsRaw;
  const providers = db.prepare('SELECT id, name, type FROM providers WHERE enabled = 1 AND deleted_at IS NULL ORDER BY name').all();

  const filterCounts = {
    status: { all: decorated.length, active: 0, disabled: 0, exhausted: 0, error: 0 },
    tier: {
      all: decorated.length,
      free: 0, pro: 0, power: 0, enterprise: 0, unknown: 0,
      // Codex (ChatGPT) tiers.
      plus: 0, team: 0, business: 0, edu: 0,
    },
  };
  for (const d of decorated) {
    filterCounts.status[d.rowStatus] = (filterCounts.status[d.rowStatus] || 0) + 1;
    filterCounts.tier[d.rowTier] = (filterCounts.tier[d.rowTier] || 0) + 1;
  }

  res.render('provider-accounts', {
    active: 'accounts',
    provider,
    rows: pageRows,
    summary: buildProviderAccountSummary(provider, allRows),
    providers,
    page: safePage,
    pages,
    perPage,
    total,
    filters: { status, tier, q },
    filterCounts,
    formatDate,
    safeJsonParse,
  });
});

router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY created_at DESC').all();
  const accounts = db.prepare('SELECT * FROM provider_accounts WHERE deleted_at IS NULL').all();
  const models = db.prepare('SELECT * FROM models WHERE deleted_at IS NULL').all();
  const providerCards = rows.map((provider) => {
    const providerAccounts = accounts.filter((account) => account.provider_id === provider.id);
    const providerModels = models.filter((model) => model.provider_id === provider.id);
    return {
      ...provider,
      accountSummary: buildProviderAccountSummary(provider, providerAccounts),
      model_count: providerModels.length,
      enabled_model_count: providerModels.filter((model) => model.enabled).length,
    };
  });
  res.render('providers', {
    active: 'providers',
    rows: providerCards,
    types: listTypes(),
    formatDate,
    safeJsonParse,
  });
});

router.get('/models', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, p.name AS provider_name, p.type AS provider_type
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY p.name ASC, m.name ASC
  `).all();
  const providers = db.prepare('SELECT id, name, type FROM providers WHERE enabled = 1 AND deleted_at IS NULL ORDER BY name').all();
  const accounts = db.prepare('SELECT * FROM provider_accounts WHERE deleted_at IS NULL').all();
  const grouped = providers.map((provider) => {
    const models = rows.filter((model) => model.provider_id === provider.id);
    const summary = buildProviderAccountSummary(
      provider,
      accounts.filter((account) => account.provider_id === provider.id)
    );
    const tierCounts = models.reduce((acc, model) => {
      const tier = model.account_tier || 'any';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {});
    return { provider, models, summary, tierCounts };
  }).filter((group) => group.models.length || group.summary.stats.total);
  res.render('models', { active: 'models', rows, grouped, providers, formatDate });
});

router.get('/api-keys', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, key_prefix, enabled, last_used_at, created_at, revoked_at
    FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at DESC
  `).all();
  res.render('api-keys', { active: 'api-keys', rows, formatDate });
});

router.get('/logs', (req, res) => {
  const { rows, stats, pageStats, page, pages, perPage, total, latestId } = getLogPage({
    page: req.query.page,
    perPage: DEFAULT_LOGS_PER_PAGE,
  });
  res.render('logs', {
    active: 'logs',
    rows,
    stats,
    pageStats,
    page,
    pages,
    perPage,
    total,
    latestId,
    formatDate,
  });
});

router.get('/workers', (req, res) => {
  res.render('workers', { active: 'workers' });
});

router.get('/playground', (req, res) => {
  const models = db.prepare(`
    SELECT m.name, p.name AS provider_name
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = 1 AND p.enabled = 1
      AND m.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY m.name
  `).all();
  const apiKeys = db.prepare(`
    SELECT id, name, key_prefix FROM api_keys
    WHERE enabled = 1 AND revoked_at IS NULL AND deleted_at IS NULL
    ORDER BY created_at DESC
  `).all();
  res.render('playground', { active: 'playground', models, apiKeys });
});

router.get('/proxies', (req, res) => {
  res.render('proxies', { active: 'proxies' });
});

router.get('/kiro-session', (req, res) => {
  const token = req.query.token || '';
  const email = req.query.email || '';
  res.render('kiro-session', { accessToken: token, email });
});

module.exports = router;

function buildProviderAccountSummary(provider, rows) {
  const currentTs = Math.floor(Date.now() / 1000);
  const stats = {
    total: rows.length,
    active: 0,
    disabled: 0,
    exhausted: 0,
    error: 0,
    unknown: 0,
    // Kiro tiers
    free: 0,
    pro: 0,
    power: 0,
    enterprise: 0,
    // Codex (ChatGPT) tiers — free/pro/enterprise shared with above
    plus: 0,
    team: 0,
    business: 0,
    edu: 0,
    creditsCurrent: 0,
    creditsLimit: 0,
    // Codex-only accumulators.
    codexPrimaryPctSum: 0,
    codexPrimaryCount: 0,
    codexSecondaryPctSum: 0,
    codexSecondaryCount: 0,
    codexNextPrimaryReset: null,
    codexNextSecondaryReset: null,
  };

  const recent = rows
    .slice()
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, 4)
    .map((account) => {
      const cfg = safeJsonParse(account.config_json, {});
      const sub = cfg.subscription || null;
      return {
        id: account.id,
        label: account.label || account.email || `Account #${account.id}`,
        email: account.email || '',
        status: accountStatusLabel(account, currentTs),
        tier: sub && sub.tier ? sub.tier : 'unknown',
      };
    });

  for (const account of rows) {
    const cfg = safeJsonParse(account.config_json, {});
    const sub = cfg.subscription || null;
    const tier = sub && sub.tier ? String(sub.tier).toLowerCase() : 'unknown';
    if (account.exhausted_at) stats.exhausted++;
    else if (!account.enabled) stats.disabled++;
    else stats.active++;
    if (tier in stats) stats[tier]++;
    else stats.unknown++;
    if (accountHasActiveError(account, currentTs)) stats.error++;
    const usage = sub && sub.usage;
    if (usage) {
      stats.creditsCurrent += Number(usage.current || 0);
      stats.creditsLimit += Number(usage.limit || 0);
    }

    // Codex: aggregate per-account percentages + earliest upcoming reset.
    if (provider.type === 'codex' && sub) {
      const primary = sub.primary || null;
      const secondary = sub.secondary || null;
      if (primary) {
        const p = Number(primary.used_percent ?? primary.usedPercent ?? 0);
        if (Number.isFinite(p)) {
          stats.codexPrimaryPctSum += Math.max(0, Math.min(100, p));
          stats.codexPrimaryCount += 1;
        }
        const r = Number(primary.resets_at || primary.resetsAt || 0);
        if (r > currentTs && (stats.codexNextPrimaryReset === null || r < stats.codexNextPrimaryReset)) {
          stats.codexNextPrimaryReset = r;
        }
      }
      if (secondary) {
        const p = Number(secondary.used_percent ?? secondary.usedPercent ?? 0);
        if (Number.isFinite(p)) {
          stats.codexSecondaryPctSum += Math.max(0, Math.min(100, p));
          stats.codexSecondaryCount += 1;
        }
        const r = Number(secondary.resets_at || secondary.resetsAt || 0);
        if (r > currentTs && (stats.codexNextSecondaryReset === null || r < stats.codexNextSecondaryReset)) {
          stats.codexNextSecondaryReset = r;
        }
      }
    }
  }

  const creditPct = stats.creditsLimit > 0
    ? Math.min(100, Math.round((stats.creditsCurrent / stats.creditsLimit) * 100))
    : 0;

  const codexAvgPrimary = stats.codexPrimaryCount > 0
    ? Math.round(stats.codexPrimaryPctSum / stats.codexPrimaryCount)
    : null;
  const codexAvgSecondary = stats.codexSecondaryCount > 0
    ? Math.round(stats.codexSecondaryPctSum / stats.codexSecondaryCount)
    : null;

  return {
    provider,
    stats,
    recent,
    creditPct,
    codexAvgPrimary,
    codexAvgSecondary,
    codexNextPrimaryReset: stats.codexNextPrimaryReset,
    codexNextSecondaryReset: stats.codexNextSecondaryReset,
    lastUpdated: rows.reduce((max, row) => Math.max(max, row.updated_at || 0), provider.updated_at || 0),
  };
}

function buildTokenHistory() {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`
    SELECT created_at, model_name, prompt_tokens, completion_tokens, total_tokens
    FROM request_logs
    WHERE created_at >= ?
    ORDER BY created_at ASC
  `).all(nowSec - 30 * 86400);

  const ranges = {
    '1d': { seconds: 86400, buckets: 24, label: '1 day', unit: 'hour' },
    '7d': { seconds: 7 * 86400, buckets: 7, label: '7 days', unit: 'day' },
    '14d': { seconds: 14 * 86400, buckets: 14, label: '14 days', unit: 'day' },
    '30d': { seconds: 30 * 86400, buckets: 30, label: '30 days', unit: 'day' },
  };

  // Fixed palette for consistent model coloring across ranges.
  const palette = [
    '#67e8f9', // cyan
    '#fbbf24', // amber
    '#34d399', // emerald
    '#c4b5fd', // violet
    '#f472b6', // pink
    '#60a5fa', // blue
    '#f87171', // red
    '#a3e635', // lime
    '#fb923c', // orange
    '#2dd4bf', // teal
    '#e879f9', // fuchsia
    '#facc15', // yellow
  ];
  const MAX_MODELS = 10;

  const out = {};
  for (const [key, cfg] of Object.entries(ranges)) {
    const start = nowSec - cfg.seconds;
    const bucketSize = cfg.seconds / cfg.buckets;
    const labels = Array.from({ length: cfg.buckets }, (_, i) => {
      const ts = Math.floor(start + i * bucketSize);
      return {
        ts,
        label: cfg.unit === 'hour'
          ? new Date(ts * 1000).getHours().toString().padStart(2, '0') + ':00'
          : new Date(ts * 1000).toISOString().slice(5, 10),
      };
    });

    // Aggregate totals per model in this range.
    const perModelTotals = new Map();
    for (const row of rows) {
      if (row.created_at < start) continue;
      const name = row.model_name || '(unknown)';
      const agg = perModelTotals.get(name) || { prompt: 0, completion: 0, total: 0 };
      agg.prompt += Number(row.prompt_tokens || 0);
      agg.completion += Number(row.completion_tokens || 0);
      agg.total += Number(row.total_tokens || 0);
      perModelTotals.set(name, agg);
    }

    // Pick the top N models by total tokens, group the rest as "other".
    const sorted = [...perModelTotals.entries()].sort((a, b) => b[1].total - a[1].total);
    const topNames = sorted.slice(0, MAX_MODELS).map(([name]) => name);
    const otherNames = new Set(sorted.slice(MAX_MODELS).map(([name]) => name));
    const hasOther = otherNames.size > 0;

    // Init per-series buckets.
    const emptyBuckets = () => labels.map((l) => ({ ...l, prompt: 0, completion: 0, total: 0 }));
    const models = topNames.map((name, i) => ({
      name,
      color: palette[i % palette.length],
      buckets: emptyBuckets(),
      totals: perModelTotals.get(name),
    }));
    if (hasOther) {
      const otherTotal = sorted.slice(MAX_MODELS).reduce((acc, [, v]) => ({
        prompt: acc.prompt + v.prompt,
        completion: acc.completion + v.completion,
        total: acc.total + v.total,
      }), { prompt: 0, completion: 0, total: 0 });
      models.push({
        name: `other (${otherNames.size})`,
        color: '#94a3b8',
        buckets: emptyBuckets(),
        totals: otherTotal,
        isOther: true,
      });
    }
    const byName = new Map(models.map((m, i) => [m.isOther ? '__other__' : m.name, i]));

    // Aggregate "all" bucket alongside per-model buckets.
    const aggregate = emptyBuckets();
    for (const row of rows) {
      if (row.created_at < start) continue;
      const idx = Math.min(cfg.buckets - 1, Math.max(0, Math.floor((row.created_at - start) / bucketSize)));
      const prompt = Number(row.prompt_tokens || 0);
      const completion = Number(row.completion_tokens || 0);
      const total = Number(row.total_tokens || 0);
      aggregate[idx].prompt += prompt;
      aggregate[idx].completion += completion;
      aggregate[idx].total += total;
      const key2 = otherNames.has(row.model_name || '(unknown)')
        ? '__other__'
        : (row.model_name || '(unknown)');
      const mi = byName.get(key2);
      if (mi != null) {
        models[mi].buckets[idx].prompt += prompt;
        models[mi].buckets[idx].completion += completion;
        models[mi].buckets[idx].total += total;
      }
    }

    out[key] = { ...cfg, buckets: aggregate, models };
  }
  return out;
}
