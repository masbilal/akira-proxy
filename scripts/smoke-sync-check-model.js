'use strict';

const db = require('../src/db');
const arg = process.argv[2] || 'peer-only-model';
const row = db.prepare(
  'SELECT id, name, deleted_at, node_id FROM models WHERE name = ?'
).get(arg);
console.log('models row =', row);
const outbox = db.prepare('SELECT id, table_name, row_uuid, op, ts, node_id FROM sync_outbox ORDER BY id DESC LIMIT 3').all();
console.log('latest outbox =', outbox);
