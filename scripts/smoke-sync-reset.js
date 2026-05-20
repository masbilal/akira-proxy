'use strict';

// Reset peer-only-model on hub for a clean soft-delete trigger test.
const db = require('../src/db');
const ts = Math.floor(Date.now() / 1000);
const info = db.prepare(
  "UPDATE models SET deleted_at = NULL, node_id = 'peer-test', updated_at = ? WHERE name = 'peer-only-model'"
).run(ts);
console.log('reset rows =', info.changes);
const outbox = db.prepare('SELECT id, table_name, row_uuid, op, ts, node_id FROM sync_outbox ORDER BY id DESC LIMIT 3').all();
console.log('latest outbox =', outbox);
