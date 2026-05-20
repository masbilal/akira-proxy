'use strict';

// Smoke-test helper: insert a model row referencing provider id=2 (the
// E2E Provider that arrived from the hub), so we can verify the peer's
// outbox -> hub push path.

const db = require('../src/db');
const ts = Math.floor(Date.now() / 1000);
const info = db.prepare(
  "INSERT INTO models (name, display_name, provider_id, upstream_model, account_tier, enabled, created_at, updated_at) " +
  "VALUES ('peer-only-model', 'Peer Only Model', 2, 'gpt-test', 'any', 1, ?, ?)"
).run(ts, ts);
console.log('peer inserted model id =', info.lastInsertRowid);
const row = db.prepare('SELECT id, name, uuid, node_id, provider_id FROM models WHERE id = ?').get(info.lastInsertRowid);
console.log('row =', row);
const outbox = db.prepare('SELECT id, table_name, row_uuid, op, ts, node_id FROM sync_outbox ORDER BY id DESC LIMIT 3').all();
console.log('latest outbox =', outbox);
