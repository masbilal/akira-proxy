CREATE TABLE IF NOT EXISTS admin_sessions (
  sid        TEXT PRIMARY KEY,
  sess_json  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
  ON admin_sessions(expires_at);
