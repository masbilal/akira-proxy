'use strict';

const session = require('express-session');
const db = require('../db');
const { now } = require('../utils/common');

const DEFAULT_TTL_SEC = Math.max(
  60,
  Number(process.env.SESSION_TTL_SEC || 7 * 24 * 60 * 60) || (7 * 24 * 60 * 60)
);
const PRUNE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.SESSION_PRUNE_INTERVAL_MS || 60 * 60 * 1000) || (60 * 60 * 1000)
);

function computeExpiry(sessionData) {
  const cookieExpiresAt = sessionData && sessionData.cookie && sessionData.cookie.expires
    ? Math.floor(new Date(sessionData.cookie.expires).getTime() / 1000)
    : 0;
  return cookieExpiresAt > 0 ? cookieExpiresAt : (now() + DEFAULT_TTL_SEC);
}

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this._pruneTimer = setInterval(() => {
      this.pruneExpired((err) => {
        if (err) {
          console.error('[session] prune failed:', err.message);
        }
      });
    }, PRUNE_INTERVAL_MS);
    this._pruneTimer.unref?.();
  }

  get(sid, callback = () => {}) {
    try {
      const row = db.prepare(`
        SELECT sess_json, expires_at
        FROM admin_sessions
        WHERE sid = ?
      `).get(sid);

      if (!row) {
        callback(null, null);
        return;
      }

      if (Number(row.expires_at || 0) <= now()) {
        db.prepare('DELETE FROM admin_sessions WHERE sid = ?').run(sid);
        callback(null, null);
        return;
      }

      callback(null, JSON.parse(row.sess_json));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      const ts = now();
      const expiresAt = computeExpiry(sessionData);
      db.prepare(`
        INSERT INTO admin_sessions (sid, sess_json, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET
          sess_json = excluded.sess_json,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run(sid, JSON.stringify(sessionData), expiresAt, ts, ts);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      db.prepare('DELETE FROM admin_sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = computeExpiry(sessionData);
      db.prepare(`
        UPDATE admin_sessions
        SET expires_at = ?, updated_at = ?
        WHERE sid = ?
      `).run(expiresAt, now(), sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  pruneExpired(callback = () => {}) {
    try {
      const info = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now());
      callback(null, info.changes);
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = {
  SqliteSessionStore,
};
