-- dapuranmu schema
-- All timestamps are unix seconds (INTEGER)

CREATE TABLE IF NOT EXISTS providers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,                -- human readable, e.g. "Kiro main"
  slug         TEXT    NOT NULL UNIQUE,                -- url-safe id, e.g. "kiro-main"
  type         TEXT    NOT NULL,                       -- adapter type: "openai" | "kiro"
  base_url     TEXT    NOT NULL,                       -- upstream base url, e.g. https://api.openai.com/v1
  api_key      TEXT,                                   -- upstream api key (bearer) if applicable
  auth_type    TEXT    NOT NULL DEFAULT 'bearer',      -- "bearer" | "oauth" | "none"
  -- For OAuth / token-based providers (Kiro Google login, etc.)
  access_token  TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,                            -- unix seconds
  -- Arbitrary provider-specific config as JSON
  config_json  TEXT    NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Models exposed by the router. Each model maps to exactly one provider.
CREATE TABLE IF NOT EXISTS models (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,           -- id shown to clients, e.g. "gpt-4o"
  display_name      TEXT,
  provider_id       INTEGER NOT NULL,
  upstream_model    TEXT    NOT NULL,                  -- actual model id sent to upstream
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

-- API keys the router issues to its clients (end-users of the proxy).
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,                       -- user-friendly label
  key_prefix   TEXT    NOT NULL,                       -- first 8 chars shown in UI
  key_hash     TEXT    NOT NULL UNIQUE,                -- sha256 of full key
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);

-- Request log (for usage analytics + debugging)
CREATE TABLE IF NOT EXISTS request_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id        INTEGER,
  provider_id       INTEGER,
  model_name        TEXT,
  endpoint          TEXT    NOT NULL,
  status_code       INTEGER,
  duration_ms       INTEGER,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  stream            INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (api_key_id)  REFERENCES api_keys(id)  ON DELETE SET NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_api_key_id ON request_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
