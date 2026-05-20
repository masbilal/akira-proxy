'use strict';

const db = require('../db');
const { now } = require('../utils/common');

function insertLog(row) {
  try {
    db.prepare(`
      INSERT INTO request_logs
        (api_key_id, provider_id, provider_account_id, model_name, endpoint, status_code, duration_ms,
         prompt_tokens, completion_tokens, total_tokens, stream, error, created_at)
      VALUES
        (@api_key_id, @provider_id, @provider_account_id, @model_name, @endpoint, @status_code, @duration_ms,
         @prompt_tokens, @completion_tokens, @total_tokens, @stream, @error, @created_at)
    `).run({
      api_key_id: row.api_key_id ?? null,
      provider_id: row.provider_id ?? null,
      provider_account_id: row.provider_account_id ?? null,
      model_name: row.model_name ?? null,
      endpoint: row.endpoint,
      status_code: row.status_code ?? null,
      duration_ms: row.duration_ms ?? null,
      prompt_tokens: row.prompt_tokens ?? 0,
      completion_tokens: row.completion_tokens ?? 0,
      total_tokens: row.total_tokens ?? 0,
      stream: row.stream ? 1 : 0,
      error: row.error ?? null,
      created_at: now(),
    });
  } catch (e) {
    console.error('[logger] failed to write log:', e.message);
  }
}

module.exports = { insertLog };
