'use strict';

// Smoke-test: soft-delete a model on the hub via the same SQL the admin
// route now uses (sets node_id = local so the AFTER UPDATE trigger fires
// on rows that originated from a peer).

const db = require('../src/db');
const ts = Math.floor(Date.now() / 1000);
const info = db.prepare(
  "UPDATE models SET deleted_at = ?, updated_at = ?, " +
  "node_id = COALESCE((SELECT value FROM sync_config WHERE key = 'local_node_id'), node_id) " +
  "WHERE name = 'peer-only-model' AND deleted_at IS NULL"
).run(ts, ts);
console.log('soft-deleted rows =', info.changes);
const outbox = db.prepare('SELECT id, table_name, row_uuid, op, ts, node_id FROM sync_outbox ORDER BY id DESC LIMIT 3').all();
console.log('latest outbox =', outbox);
