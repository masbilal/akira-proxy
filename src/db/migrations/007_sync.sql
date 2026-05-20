-- 007_sync.sql
-- Multi-instance synchronization support.
--
-- Idea:
--   Each row in synced tables gets a globally-unique `uuid`, an origin
--   `node_id` (which instance last wrote it) and a soft-delete flag
--   `deleted_at`. SQLite triggers fan-out every local change to the
--   `sync_outbox` table. The sync engine pulls/pushes outbox entries
--   between peers with last-write-wins conflict resolution.
--
-- Tables synced: providers, provider_accounts, models, api_keys.
-- Tables NOT synced: request_logs (volume), admin_sessions (per-instance),
--                    schema_migrations, sync_* (sync infrastructure).

-- ========== 1. Add sync metadata columns ==========

ALTER TABLE providers          ADD COLUMN uuid       TEXT;
ALTER TABLE providers          ADD COLUMN node_id    TEXT;
ALTER TABLE providers          ADD COLUMN deleted_at INTEGER;

ALTER TABLE provider_accounts  ADD COLUMN uuid       TEXT;
ALTER TABLE provider_accounts  ADD COLUMN node_id    TEXT;
ALTER TABLE provider_accounts  ADD COLUMN deleted_at INTEGER;

ALTER TABLE models             ADD COLUMN uuid       TEXT;
ALTER TABLE models             ADD COLUMN node_id    TEXT;
ALTER TABLE models             ADD COLUMN deleted_at INTEGER;

ALTER TABLE api_keys           ADD COLUMN uuid       TEXT;
ALTER TABLE api_keys           ADD COLUMN node_id    TEXT;
ALTER TABLE api_keys           ADD COLUMN deleted_at INTEGER;

-- ========== 2. Backfill uuid for existing rows ==========
-- SQLite has no native uuid; use 16 random bytes encoded as hex.

UPDATE providers          SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = '';
UPDATE provider_accounts  SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = '';
UPDATE models             SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = '';
UPDATE api_keys           SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL OR uuid = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_uuid          ON providers(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_uuid  ON provider_accounts(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_uuid             ON models(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_uuid           ON api_keys(uuid);

-- ========== 3. Sync infrastructure tables ==========

-- Key/value store for runtime sync configuration (e.g. local_node_id).
CREATE TABLE IF NOT EXISTS sync_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outbox: every local change appended here by triggers. Consumed by the
-- sync worker to push to remote peers, and served by /api/sync/changes.
CREATE TABLE IF NOT EXISTS sync_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT    NOT NULL,
  row_uuid    TEXT    NOT NULL,
  op          TEXT    NOT NULL,         -- 'upsert' | 'delete'
  ts          INTEGER NOT NULL,         -- updated_at of the row
  node_id     TEXT    NOT NULL,         -- origin (always local node)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_table_uuid ON sync_outbox(table_name, row_uuid);

-- Peer registry: tracks what each remote node has seen.
CREATE TABLE IF NOT EXISTS sync_peers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id              TEXT NOT NULL UNIQUE,
  endpoint             TEXT,
  role                 TEXT NOT NULL DEFAULT 'peer',  -- 'hub' | 'peer'
  last_pull_ts         INTEGER NOT NULL DEFAULT 0,    -- max(ts) we received from this peer
  last_pull_outbox_id  INTEGER NOT NULL DEFAULT 0,    -- max(id) we received from this peer
  last_push_outbox_id  INTEGER NOT NULL DEFAULT 0,    -- max(id) we shipped to this peer
  last_seen_at         INTEGER,
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Seed a placeholder local_node_id; real value is set at boot from env.
INSERT OR IGNORE INTO sync_config (key, value, updated_at)
VALUES ('local_node_id', 'unset', strftime('%s','now'));

-- ========== 4. Backfill node_id for existing rows ==========
-- Mark legacy rows so triggers don't accidentally re-emit them. Boot code
-- rewrites this column for rows where node_id = 'legacy' once it knows
-- the real local_node_id.

UPDATE providers          SET node_id = 'legacy' WHERE node_id IS NULL OR node_id = '';
UPDATE provider_accounts  SET node_id = 'legacy' WHERE node_id IS NULL OR node_id = '';
UPDATE models             SET node_id = 'legacy' WHERE node_id IS NULL OR node_id = '';
UPDATE api_keys           SET node_id = 'legacy' WHERE node_id IS NULL OR node_id = '';

-- ========== 5. Triggers per synced table ==========
-- Pattern (repeated for each table):
--   - AFTER INSERT  : back-fill uuid + node_id if blank, then emit outbox
--                     entry only when origin is the local node.
--   - AFTER UPDATE  : emit outbox on real changes (updated_at advanced or
--                     soft-delete flipped). Only when origin is local —
--                     remote-applied rows carry the foreign node_id and
--                     are skipped to avoid replication loops.
--
-- The cascading UPDATE inside AFTER INSERT does NOT bump updated_at, so
-- it does not re-trigger AFTER UPDATE (guarded by ts comparison).

------------------------------ providers -------------------------------

CREATE TRIGGER IF NOT EXISTS providers_after_insert
AFTER INSERT ON providers
BEGIN
  UPDATE providers
     SET node_id = COALESCE(NULLIF(node_id, ''), (SELECT value FROM sync_config WHERE key = 'local_node_id')),
         uuid    = COALESCE(NULLIF(uuid,    ''), lower(hex(randomblob(16))))
   WHERE id = NEW.id;

  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'providers', p.uuid, 'upsert', p.updated_at, p.node_id, strftime('%s','now')
    FROM providers p
   WHERE p.id = NEW.id
     AND p.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

CREATE TRIGGER IF NOT EXISTS providers_after_update
AFTER UPDATE ON providers
WHEN NEW.updated_at > OLD.updated_at
  OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
BEGIN
  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'providers',
         NEW.uuid,
         CASE WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'delete' ELSE 'upsert' END,
         NEW.updated_at,
         NEW.node_id,
         strftime('%s','now')
   WHERE NEW.uuid IS NOT NULL
     AND NEW.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

-------------------------- provider_accounts ---------------------------

CREATE TRIGGER IF NOT EXISTS provider_accounts_after_insert
AFTER INSERT ON provider_accounts
BEGIN
  UPDATE provider_accounts
     SET node_id = COALESCE(NULLIF(node_id, ''), (SELECT value FROM sync_config WHERE key = 'local_node_id')),
         uuid    = COALESCE(NULLIF(uuid,    ''), lower(hex(randomblob(16))))
   WHERE id = NEW.id;

  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'provider_accounts', a.uuid, 'upsert', a.updated_at, a.node_id, strftime('%s','now')
    FROM provider_accounts a
   WHERE a.id = NEW.id
     AND a.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

CREATE TRIGGER IF NOT EXISTS provider_accounts_after_update
AFTER UPDATE ON provider_accounts
WHEN NEW.updated_at > OLD.updated_at
  OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
BEGIN
  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'provider_accounts',
         NEW.uuid,
         CASE WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'delete' ELSE 'upsert' END,
         NEW.updated_at,
         NEW.node_id,
         strftime('%s','now')
   WHERE NEW.uuid IS NOT NULL
     AND NEW.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

-------------------------------- models --------------------------------

CREATE TRIGGER IF NOT EXISTS models_after_insert
AFTER INSERT ON models
BEGIN
  UPDATE models
     SET node_id = COALESCE(NULLIF(node_id, ''), (SELECT value FROM sync_config WHERE key = 'local_node_id')),
         uuid    = COALESCE(NULLIF(uuid,    ''), lower(hex(randomblob(16))))
   WHERE id = NEW.id;

  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'models', m.uuid, 'upsert', m.updated_at, m.node_id, strftime('%s','now')
    FROM models m
   WHERE m.id = NEW.id
     AND m.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

CREATE TRIGGER IF NOT EXISTS models_after_update
AFTER UPDATE ON models
WHEN NEW.updated_at > OLD.updated_at
  OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
BEGIN
  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'models',
         NEW.uuid,
         CASE WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'delete' ELSE 'upsert' END,
         NEW.updated_at,
         NEW.node_id,
         strftime('%s','now')
   WHERE NEW.uuid IS NOT NULL
     AND NEW.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

------------------------------- api_keys -------------------------------

CREATE TRIGGER IF NOT EXISTS api_keys_after_insert
AFTER INSERT ON api_keys
BEGIN
  UPDATE api_keys
     SET node_id = COALESCE(NULLIF(node_id, ''), (SELECT value FROM sync_config WHERE key = 'local_node_id')),
         uuid    = COALESCE(NULLIF(uuid,    ''), lower(hex(randomblob(16))))
   WHERE id = NEW.id;

  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'api_keys', k.uuid, 'upsert', COALESCE(k.created_at, strftime('%s','now')), k.node_id, strftime('%s','now')
    FROM api_keys k
   WHERE k.id = NEW.id
     AND k.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;

-- api_keys table has no `updated_at` column, so we only watch deletions
-- and last_used_at bumps via revoke for the UPDATE trigger.
CREATE TRIGGER IF NOT EXISTS api_keys_after_update
AFTER UPDATE ON api_keys
WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
  OR (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL)
  OR (NEW.enabled IS NOT OLD.enabled)
BEGIN
  INSERT INTO sync_outbox (table_name, row_uuid, op, ts, node_id, created_at)
  SELECT 'api_keys',
         NEW.uuid,
         CASE WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN 'delete' ELSE 'upsert' END,
         COALESCE(NEW.revoked_at, NEW.last_used_at, NEW.created_at, strftime('%s','now')),
         NEW.node_id,
         strftime('%s','now')
   WHERE NEW.uuid IS NOT NULL
     AND NEW.node_id = (SELECT value FROM sync_config WHERE key = 'local_node_id');
END;
