'use strict';

const db = require('../db');

const DEFAULT_LOGS_PER_PAGE = 25;
const MAX_LOGS_PER_PAGE = 25;

function normalizeLogPageOptions(opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const requestedPerPage = Number(opts.perPage) || DEFAULT_LOGS_PER_PAGE;
  const perPage = Math.min(Math.max(requestedPerPage, 1), MAX_LOGS_PER_PAGE);
  return { page, perPage };
}

function getLogPage(opts = {}) {
  const { page, perPage } = normalizeLogPageOptions(opts);
  const total = db.prepare('SELECT COUNT(*) AS c FROM request_logs').get().c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pages);
  const offset = (safePage - 1) * perPage;

  const rows = db.prepare(`
    SELECT l.*, k.name AS api_key_name, p.name AS provider_name, a.label AS account_label, a.email AS account_email
    FROM request_logs l
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    LEFT JOIN providers p ON p.id = l.provider_id
    LEFT JOIN provider_accounts a ON a.id = l.provider_account_id
    ORDER BY l.id DESC LIMIT ? OFFSET ?
  `).all(perPage, offset);

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS streams
    FROM request_logs
  `).get();

  const pageStats = rows.reduce((acc, row) => {
    acc.prompt_tokens += Number(row.prompt_tokens || 0);
    acc.completion_tokens += Number(row.completion_tokens || 0);
    acc.total_tokens += Number(row.total_tokens || 0);
    acc.errors += Number(row.status_code || 0) >= 400 ? 1 : 0;
    return acc;
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, errors: 0 });

  return {
    rows,
    stats,
    pageStats,
    page: safePage,
    pages,
    perPage,
    total,
    latestId: rows.length ? rows[0].id : 0,
  };
}

module.exports = {
  DEFAULT_LOGS_PER_PAGE,
  MAX_LOGS_PER_PAGE,
  getLogPage,
  normalizeLogPageOptions,
};
