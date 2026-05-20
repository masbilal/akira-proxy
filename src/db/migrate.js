'use strict';

/**
 * Very simple file-based migration runner.
 * Runs every *.sql file in ./migrations, in sorted order.
 * Tracks applied migrations in schema_migrations.
 */

const fs = require('fs');
const path = require('path');
const db = require('./index');

function run() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Math.floor(Date.now() / 1000)
      );
    });
    tx();
  }
  console.log('[migrate] done');
}

if (require.main === module) {
  try {
    run();
    process.exit(0);
  } catch (err) {
    console.error('[migrate] failed:', err);
    process.exit(1);
  }
}

module.exports = { run };
