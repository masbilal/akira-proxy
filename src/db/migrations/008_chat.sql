-- Chat sessions for persistent conversations
CREATE TABLE IF NOT EXISTS chat_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid         TEXT    NOT NULL UNIQUE,           -- public identifier for API
  title        TEXT,                              -- auto-generated or user-set
  model        TEXT    NOT NULL,                  -- model name used
  api_key_id   INTEGER,                           -- optional API key for requests
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_created_at ON chat_sessions(created_at);

-- Chat messages within sessions
CREATE TABLE IF NOT EXISTS chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL,
  role         TEXT    NOT NULL,                  -- 'user' | 'assistant' | 'system'
  content      TEXT    NOT NULL,                  -- raw text content
  tokens       INTEGER DEFAULT 0,                 -- token count if available
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
