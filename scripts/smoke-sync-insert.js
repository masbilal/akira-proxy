'use strict';

// Smoke-test helper: insert a provider into whichever DB DB_PATH points at
// and report the resulting outbox state. Used by the e2e sync test.

const db = require('../src/db');
const ts = Math.floor(Date.now() / 1000);
const info = db.prepare(
  "INSERT INTO providers (name, slug, type, base_url, auth_type, config_json, enabled, created_at, updated_at) " +
  "VALUES ('E2E Provider', 'e2e-prov', 'openai', 'https://api.e2e.test/v1', 'bearer', '{}', 1, ?, ?)"
).run(ts, ts);
console.log('inserted provider id =', info.lastInsertRowid);
const row = db.prepare('SELECT id, uuid, node_id, deleted_at, updated_at FROM providers WHERE id = ?').get(info.lastInsertRowid);
console.log('row =', row);
const outbox = db.prepare('SELECT id, table_name, row_uuid, op, ts, node_id FROM sync_outbox ORDER BY id DESC LIMIT 3').all();
console.log('latest outbox entries =', outbox);
