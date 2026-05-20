-- 009_proxies.sql
-- Proxy management for provider accounts.
--
-- Features:
--   - Store proxy configurations (HTTP/HTTPS)
--   - Health monitoring and automatic rotation
--   - Provider-level and account-level proxy assignment
--   - Auto-test scheduling

-- ========== 1. Proxy table ==========
CREATE TABLE IF NOT EXISTS proxies (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT,
  password      TEXT,
  protocol      TEXT NOT NULL DEFAULT 'http',  -- http, https, socks5
  enabled       INTEGER NOT NULL DEFAULT 1,
  
  -- Health monitoring
  status        TEXT NOT NULL DEFAULT 'unknown',  -- unknown, healthy, unhealthy, testing
  last_test_at  INTEGER,
  last_latency_ms INTEGER,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  
  -- Metadata
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  
  -- Sync support
  uuid          TEXT,
  node_id       TEXT,
  deleted_at    INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proxies_uuid ON proxies(uuid);
CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);
CREATE INDEX IF NOT EXISTS idx_proxies_enabled ON proxies(enabled);

-- ========== 2. Add proxy columns to providers ==========
ALTER TABLE providers ADD COLUMN proxy_id INTEGER;
ALTER TABLE providers ADD COLUMN proxy_enabled INTEGER DEFAULT 0;
ALTER TABLE providers ADD COLUMN proxy_mode TEXT DEFAULT 'manual';  -- manual, auto_rotate, health_based

-- ========== 3. Add proxy columns to provider_accounts ==========
ALTER TABLE provider_accounts ADD COLUMN proxy_id INTEGER;
ALTER TABLE provider_accounts ADD COLUMN proxy_enabled INTEGER DEFAULT 0;

-- ========== 4. Proxy usage log (for health tracking) ==========
CREATE TABLE IF NOT EXISTS proxy_usage_logs (
  id            INTEGER PRIMARY KEY,
  proxy_id      INTEGER NOT NULL,
  provider_id   INTEGER,
  account_id    INTEGER,
  endpoint      TEXT,
  success       INTEGER NOT NULL,
  latency_ms    INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxy_usage_logs_proxy_id ON proxy_usage_logs(proxy_id);
CREATE INDEX IF NOT EXISTS idx_proxy_usage_logs_created_at ON proxy_usage_logs(created_at);

-- ========== 5. Backfill uuid for proxies ==========
-- Note: This will be done in JS after table creation

-- ========== 6. Settings for proxy auto-test ==========
INSERT OR IGNORE INTO sync_config (key, value, updated_at) VALUES
  ('proxy_auto_test_enabled', '0', strftime('%s','now')),
  ('proxy_auto_test_interval_min', '30', strftime('%s','now')),
  ('proxy_health_threshold_ms', '5000', strftime('%s','now')),
  ('proxy_max_fail_count', '3', strftime('%s','now'));
