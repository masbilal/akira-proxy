CREATE TABLE IF NOT EXISTS provider_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id       INTEGER NOT NULL,
  label             TEXT,
  email             TEXT,
  api_key           TEXT,
  access_token      TEXT,
  refresh_token     TEXT,
  token_expires_at  INTEGER,
  config_json       TEXT NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  exhausted_at      INTEGER,
  last_used_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

ALTER TABLE providers ADD COLUMN current_account_id INTEGER;

ALTER TABLE request_logs ADD COLUMN provider_account_id INTEGER;

INSERT INTO provider_accounts
  (provider_id, label, email, api_key, access_token, refresh_token, token_expires_at,
   config_json, enabled, exhausted_at, last_used_at, created_at, updated_at)
SELECT
  id,
  name || ' account',
  NULL,
  api_key,
  access_token,
  refresh_token,
  token_expires_at,
  config_json,
  enabled,
  NULL,
  NULL,
  created_at,
  updated_at
FROM providers
WHERE api_key IS NOT NULL OR access_token IS NOT NULL OR refresh_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider ON provider_accounts(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_enabled ON provider_accounts(provider_id, enabled, exhausted_at);
