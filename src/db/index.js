'use strict';

/**
 * SQLite connection using Node.js built-in `node:sqlite` (stable in Node 22.5+,
 * gated behind an ExperimentalWarning in Node 24.x).
 *
 * Exposes a small compatibility layer over better-sqlite3's API surface that
 * the rest of the codebase uses:
 *   - db.prepare(sql).run(...)
 *   - db.prepare(sql).get(...)
 *   - db.prepare(sql).all(...)
 *   - db.exec(sql)
 *   - db.transaction(fn)
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dapuranmu.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

function normalizeInfo(info) {
  return {
    lastInsertRowid:
      typeof info.lastInsertRowid === 'bigint'
        ? Number(info.lastInsertRowid)
        : info.lastInsertRowid,
    changes: info.changes,
  };
}

function prepare(sql) {
  const stmt = raw.prepare(sql);
  return {
    run: (...args) => normalizeInfo(stmt.run(...args)),
    get: (...args) => stmt.get(...args),
    all: (...args) => stmt.all(...args),
  };
}

function transaction(fn) {
  return (...args) => {
    raw.exec('BEGIN');
    try {
      const result = fn(...args);
      raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { raw.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  };
}

module.exports = {
  prepare,
  exec: (sql) => raw.exec(sql),
  transaction,
  close: () => raw.close(),
  DB_PATH,
};
module.exports.DB_PATH = DB_PATH;
