'use strict';

/**
 * src/db/backup.js — Auto-backup from SQLite (the live DB) to MySQL/MariaDB.
 *
 * Design goals:
 *   - SQLite is the source of truth for the running app. MySQL is a mirror
 *     kept as a fallback in case the SQLite file is ever lost/corrupted.
 *   - A full snapshot of every data table is taken on a schedule (default
 *     every 30 minutes) and replicated to MySQL via TRUNCATE + bulk INSERT.
 *   - Schema is created on MySQL side automatically the first time we
 *     connect. We keep the MySQL schema loose (mostly TEXT / BIGINT) so
 *     future SQLite migrations don't require a MySQL-side migration.
 *   - If MySQL is down, we log the failure and keep the app running — the
 *     backup is best-effort.
 *
 * Environment:
 *   BACKUP_ENABLED         – "0" to disable completely (default: enabled)
 *   BACKUP_INTERVAL_MS     – backup cadence in ms (default 30 min)
 *   BACKUP_MYSQL_HOST      – MySQL host (default 127.0.0.1)
 *   BACKUP_MYSQL_PORT      – MySQL port (default 3306)
 *   BACKUP_MYSQL_USER      – MySQL user (default root)
 *   BACKUP_MYSQL_PASSWORD  – MySQL password (default "")
 *   BACKUP_MYSQL_DATABASE  – MySQL database name (default dapuranmu)
 *
 * Public API:
 *   start()            — begin periodic backups (also runs one initial pass
 *                         shortly after boot).
 *   runBackupNow()     — perform a one-shot backup (awaitable).
 *   getBackupStatus()  — read current status for dashboards.
 */

const mysql = require('mysql2/promise');
const db = require('./index');

// ---------- configuration ----------

const ENABLED = process.env.BACKUP_ENABLED !== '0';
const INTERVAL_MS = Math.max(60_000, Number(process.env.BACKUP_INTERVAL_MS) || 30 * 60_000);
const MYSQL_CONFIG = {
  host: process.env.BACKUP_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.BACKUP_MYSQL_PORT) || 3306,
  user: process.env.BACKUP_MYSQL_USER || 'root',
  password: process.env.BACKUP_MYSQL_PASSWORD || '',
  database: process.env.BACKUP_MYSQL_DATABASE || 'dapuranmu',
  multipleStatements: true,
  charset: 'utf8mb4',
};

// Tables to mirror, in dependency-safe order (FKs referenced first).
// Each entry lists the column names that exist in SQLite AND MySQL. We use
// TEXT/BIGINT on MySQL-side so the mapping is forgiving across migrations.
const TABLES = [
  {
    name: 'schema_migrations',
    columns: ['name', 'applied_at'],
    create: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'providers',
    columns: [
      'id', 'name', 'slug', 'type', 'base_url', 'api_key', 'auth_type',
      'access_token', 'refresh_token', 'token_expires_at',
      'config_json', 'enabled', 'created_at', 'updated_at',
      'current_account_id',
      'uuid', 'node_id', 'deleted_at',
    ],
    create: `
      CREATE TABLE IF NOT EXISTS providers (
        id BIGINT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        type VARCHAR(64) NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        auth_type VARCHAR(32) NOT NULL DEFAULT 'bearer',
        access_token MEDIUMTEXT,
        refresh_token MEDIUMTEXT,
        token_expires_at BIGINT,
        config_json MEDIUMTEXT,
        enabled TINYINT NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        current_account_id BIGINT,
        uuid CHAR(32),
        node_id VARCHAR(64),
        deleted_at BIGINT,
        UNIQUE KEY uq_providers_slug (slug),
        KEY idx_providers_uuid (uuid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'api_keys',
    columns: [
      'id', 'name', 'key_prefix', 'key_hash', 'enabled',
      'last_used_at', 'created_at', 'revoked_at',
      'uuid', 'node_id', 'deleted_at',
    ],
    create: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id BIGINT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        key_prefix VARCHAR(64) NOT NULL,
        key_hash VARCHAR(255) NOT NULL,
        enabled TINYINT NOT NULL DEFAULT 1,
        last_used_at BIGINT,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT,
        uuid CHAR(32),
        node_id VARCHAR(64),
        deleted_at BIGINT,
        UNIQUE KEY uq_api_keys_hash (key_hash),
        KEY idx_api_keys_uuid (uuid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'models',
    columns: [
      'id', 'name', 'display_name', 'provider_id', 'upstream_model',
      'enabled', 'created_at', 'updated_at', 'account_tier',
      'uuid', 'node_id', 'deleted_at',
    ],
    create: `
      CREATE TABLE IF NOT EXISTS models (
        id BIGINT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        provider_id BIGINT NOT NULL,
        upstream_model VARCHAR(255) NOT NULL,
        enabled TINYINT NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        account_tier VARCHAR(32) NOT NULL DEFAULT 'any',
        uuid CHAR(32),
        node_id VARCHAR(64),
        deleted_at BIGINT,
        UNIQUE KEY uq_models_name (name),
        KEY idx_models_provider (provider_id),
        KEY idx_models_uuid (uuid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'provider_accounts',
    columns: [
      'id', 'provider_id', 'label', 'email', 'api_key',
      'access_token', 'refresh_token', 'token_expires_at',
      'config_json', 'enabled', 'exhausted_at', 'last_used_at',
      'created_at', 'updated_at',
      'uuid', 'node_id', 'deleted_at',
    ],
    create: `
      CREATE TABLE IF NOT EXISTS provider_accounts (
        id BIGINT PRIMARY KEY,
        provider_id BIGINT NOT NULL,
        label VARCHAR(255),
        email VARCHAR(255),
        api_key MEDIUMTEXT,
        access_token MEDIUMTEXT,
        refresh_token MEDIUMTEXT,
        token_expires_at BIGINT,
        config_json MEDIUMTEXT,
        enabled TINYINT NOT NULL DEFAULT 1,
        exhausted_at BIGINT,
        last_used_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        uuid CHAR(32),
        node_id VARCHAR(64),
        deleted_at BIGINT,
        KEY idx_provider_accounts_provider (provider_id),
        KEY idx_provider_accounts_enabled (provider_id, enabled, exhausted_at),
        KEY idx_provider_accounts_uuid (uuid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
  {
    name: 'request_logs',
    columns: [
      'id', 'api_key_id', 'provider_id', 'model_name', 'endpoint',
      'status_code', 'duration_ms', 'prompt_tokens', 'completion_tokens',
      'total_tokens', 'stream', 'error', 'created_at', 'provider_account_id',
    ],
    create: `
      CREATE TABLE IF NOT EXISTS request_logs (
        id BIGINT PRIMARY KEY,
        api_key_id BIGINT,
        provider_id BIGINT,
        model_name VARCHAR(255),
        endpoint VARCHAR(128) NOT NULL,
        status_code INT,
        duration_ms INT,
        prompt_tokens INT DEFAULT 0,
        completion_tokens INT DEFAULT 0,
        total_tokens INT DEFAULT 0,
        stream TINYINT NOT NULL DEFAULT 0,
        error MEDIUMTEXT,
        created_at BIGINT NOT NULL,
        provider_account_id BIGINT,
        KEY idx_logs_created_at (created_at),
        KEY idx_logs_api_key_id (api_key_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
  },
];

// ---------- runtime state ----------

const state = {
  running: false,
  lastRunAt: null,          // unix seconds
  lastStatus: null,         // 'ok' | 'error' | 'disabled'
  lastError: null,
  lastDurationMs: null,
  lastRows: null,           // { table: rowCount }
  nextRunAt: null,
  timer: null,
  initialized: false,
};

function log(msg) {
  process.stderr.write(`[backup] ${msg}\n`);
}

function getBackupStatus() {
  return {
    enabled: ENABLED,
    intervalMs: INTERVAL_MS,
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    lastDurationMs: state.lastDurationMs,
    lastRows: state.lastRows,
    nextRunAt: state.nextRunAt,
    mysql: {
      host: MYSQL_CONFIG.host,
      port: MYSQL_CONFIG.port,
      user: MYSQL_CONFIG.user,
      database: MYSQL_CONFIG.database,
    },
  };
}

// ---------- helpers ----------

/**
 * Detect which of a table's desired columns actually exist in the live
 * SQLite schema. Lets us avoid SELECT failures when a column has not been
 * added yet (e.g. running against an older DB that hasn't had `account_tier`
 * applied yet).
 */
function existingColumns(tableName, desired) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const have = new Set(rows.map((r) => r.name));
  return desired.filter((col) => have.has(col));
}

function tableExists(tableName) {
  const row = db.prepare(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?'
  ).get('table', tableName);
  return !!row;
}

async function ensureDatabase(conn) {
  // Connection is already scoped to the database (mysql2 will throw if the
  // db doesn't exist — caller creates it via getConnection with no DB first).
  for (const t of TABLES) {
    await conn.query(t.create);
    await ensureTableColumns(conn, t);
  }
}

/**
 * MySQL CREATE TABLE IF NOT EXISTS does NOT add new columns to an existing
 * table. When we add columns to TABLES (e.g. uuid/node_id/deleted_at when
 * sync was introduced), we still need to migrate existing MySQL backups
 * forward. Read the live schema, parse the CREATE statement we ship for
 * each missing column, and run ALTER TABLE ADD COLUMN.
 */
async function ensureTableColumns(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [MYSQL_CONFIG.database, table.name]
  );
  const existing = new Set(rows.map((r) => String(r.COLUMN_NAME)));
  const missing = table.columns.filter((c) => !existing.has(c));
  if (!missing.length) return;

  // Pull the column definition out of the CREATE statement we know works
  // for this table. Looks for `column_name <type...>` lines.
  const createSql = String(table.create);
  for (const col of missing) {
    // Match: column_name TYPE or column_name TYPE(options)
    // Stop at comma, newline, or closing paren of the table
    const re = new RegExp(`\\b${col}\\s+(\\w+(?:\\([^)]*\\))?)(?:\\s+(?:NOT NULL|NULL|DEFAULT\\s+[^,\\n]+|AUTO_INCREMENT|PRIMARY KEY|UNIQUE)[^,\\n]*)?(?=\\s*(?:,|\\n|\\)))`, 'i');
    const match = createSql.match(re);
    const def = match ? match[1].trim() : 'TEXT';
    const sql = `ALTER TABLE \`${table.name}\` ADD COLUMN \`${col}\` ${def}`;
    try {
      await conn.query(sql);
      log(`migrated MySQL column ${table.name}.${col}`);
    } catch (err) {
      // If the column already exists in a slightly different form, ignore.
      log(`failed to add column ${table.name}.${col}: ${err.message}`);
    }
  }
}

async function getConnection() {
  // First, connect without a DB to CREATE DATABASE if needed.
  const { database, ...rest } = MYSQL_CONFIG;
  const admin = await mysql.createConnection({ ...rest, multipleStatements: false });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, '``')}\` ` +
      `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await admin.end().catch(() => {});
  }
  const conn = await mysql.createConnection(MYSQL_CONFIG);
  return conn;
}

/**
 * Copy all rows from one SQLite table to MySQL. Clears the MySQL table
 * first for a consistent snapshot; uses batched multi-row INSERT for speed.
 */
async function replicateTable(conn, table) {
  if (!tableExists(table.name)) {
    return { table: table.name, rows: 0, skipped: 'missing-in-sqlite' };
  }
  const cols = existingColumns(table.name, table.columns);
  if (!cols.length) {
    return { table: table.name, rows: 0, skipped: 'no-common-columns' };
  }

  const sqliteQuery = `SELECT ${cols.join(', ')} FROM ${table.name}`;
  const rows = db.prepare(sqliteQuery).all();

  // We TRUNCATE + batch-insert inside a transaction for atomicity.
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  await conn.query('START TRANSACTION');
  try {
    await conn.query(`TRUNCATE TABLE \`${table.name}\``);
    if (rows.length) {
      const placeholders = '(' + cols.map(() => '?').join(', ') + ')';
      const insertSql =
        `INSERT INTO \`${table.name}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES `;
      // Batch ~500 rows per INSERT to keep packet size reasonable.
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const values = [];
        const sqlPieces = [];
        for (const row of chunk) {
          sqlPieces.push(placeholders);
          for (const col of cols) {
            const v = row[col];
            values.push(v === undefined ? null : v);
          }
        }
        await conn.query(insertSql + sqlPieces.join(', '), values);
      }
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
  }

  return { table: table.name, rows: rows.length };
}

// ---------- public API ----------

async function runBackupNow() {
  if (!ENABLED) {
    state.lastStatus = 'disabled';
    return { ok: false, error: 'backup disabled via BACKUP_ENABLED=0' };
  }
  if (state.running) {
    return { ok: false, error: 'backup already in progress' };
  }
  state.running = true;
  const startedAt = Date.now();
  let conn = null;
  const rowCounts = {};
  try {
    conn = await getConnection();
    await ensureDatabase(conn);
    for (const t of TABLES) {
      const res = await replicateTable(conn, t);
      rowCounts[t.name] = res.rows;
      if (res.skipped) rowCounts[t.name] = `skipped:${res.skipped}`;
    }
    state.lastStatus = 'ok';
    state.lastError = null;
    state.lastRows = rowCounts;
    state.lastRunAt = Math.floor(Date.now() / 1000);
    state.lastDurationMs = Date.now() - startedAt;
    log(
      `backup complete in ${state.lastDurationMs}ms to mysql://` +
      `${MYSQL_CONFIG.user}@${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}/${MYSQL_CONFIG.database} ` +
      `(${Object.entries(rowCounts).map(([k, v]) => `${k}=${v}`).join(', ')})`
    );
    return { ok: true, durationMs: state.lastDurationMs, rows: rowCounts };
  } catch (err) {
    state.lastStatus = 'error';
    state.lastError = err.message;
    state.lastRunAt = Math.floor(Date.now() / 1000);
    state.lastDurationMs = Date.now() - startedAt;
    log(`backup FAILED after ${state.lastDurationMs}ms: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    state.running = false;
    if (conn) await conn.end().catch(() => {});
  }
}

function scheduleNext() {
  state.nextRunAt = Math.floor((Date.now() + INTERVAL_MS) / 1000);
}

function start() {
  if (!ENABLED) {
    log('backups disabled (BACKUP_ENABLED=0).');
    state.lastStatus = 'disabled';
    return;
  }
  if (state.initialized) return;
  state.initialized = true;

  log(
    `backups enabled; target mysql://${MYSQL_CONFIG.user}@${MYSQL_CONFIG.host}:` +
    `${MYSQL_CONFIG.port}/${MYSQL_CONFIG.database}; cadence=${Math.round(INTERVAL_MS / 60000)}min`
  );

  // Run an initial backup shortly after boot so we have something in MySQL
  // even if the process is restarted less than an interval later.
  setTimeout(() => {
    runBackupNow().finally(scheduleNext);
  }, 15_000).unref?.();

  state.timer = setInterval(() => {
    runBackupNow().finally(scheduleNext);
  }, INTERVAL_MS);
  state.timer.unref?.();
  scheduleNext();
}

module.exports = {
  start,
  runBackupNow,
  getBackupStatus,
  TABLES,
};
