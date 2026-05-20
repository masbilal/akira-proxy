'use strict';

const db = require('../db');
const { hashApiKey } = require('../utils/apiKey');
const { now } = require('../utils/common');

/**
 * Admin session guard: used on dashboard HTML routes.
 * Redirects to /login when not authenticated.
 */
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthorized' });
}

/**
 * Admin API guard: used on admin JSON endpoints (CRUD).
 * Returns 401 instead of redirecting.
 */
function requireAdminApi(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

/**
 * Bearer-token guard for the OpenAI-compatible proxy.
 * Looks up the API key in DB and attaches `req.apiKey`.
 */
function requireApiKey(req, res, next) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) {
    return res.status(401).json({
      error: { message: 'Missing or invalid Authorization header', type: 'auth_error' },
    });
  }
  const key = m[1].trim();
  const hash = hashApiKey(key);
  const row = db
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1 AND revoked_at IS NULL AND deleted_at IS NULL')
    .get(hash);
  if (!row) {
    return res.status(401).json({
      error: { message: 'Invalid API key', type: 'auth_error' },
    });
  }
  // Touch last_used_at (best-effort, don't block)
  try {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  } catch {
    /* ignore */
  }
  req.apiKey = row;
  next();
}

/**
 * Combined auth for chat UI: supports both API key and session-based auth.
 * Used by chat routes to allow authenticated requests from the chat UI.
 */
function requireChatAuth(req, res, next) {
  // Try Bearer token first
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  
  if (m) {
    const key = m[1].trim();
    const hash = hashApiKey(key);
    const row = db
      .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1 AND revoked_at IS NULL AND deleted_at IS NULL')
      .get(hash);
    
    if (row) {
      try {
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
      } catch { /* ignore */ }
      req.apiKey = row;
      return next();
    }
  }
  
  // Check for chat session header (internal use from chat UI)
  const chatSession = req.get('x-chat-session');
  if (chatSession && req.session && req.session.admin) {
    // Authenticated admin user using chat UI
    // Use the selected API key or a default one
    const apiKeyId = req.body?.api_key_id || req.query?.api_key_id;
    
    if (apiKeyId) {
      const keyRow = db
        .prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1 AND revoked_at IS NULL AND deleted_at IS NULL')
        .get(apiKeyId);
      
      if (keyRow) {
        try {
          db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), keyRow.id);
        } catch { /* ignore */ }
        req.apiKey = keyRow;
        return next();
      }
    }
    
    // No API key selected - use first available key
    const anyKey = db
      .prepare('SELECT * FROM api_keys WHERE enabled = 1 AND revoked_at IS NULL AND deleted_at IS NULL LIMIT 1')
      .get();
    
    if (anyKey) {
      try {
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), anyKey.id);
      } catch { /* ignore */ }
      req.apiKey = anyKey;
      return next();
    }
    
    // No API keys available
    return res.status(400).json({
      error: { message: 'No API key available. Create one in the API Keys page.', type: 'config_error' },
    });
  }
  
  // No valid auth
  return res.status(401).json({
    error: { message: 'Missing or invalid Authorization', type: 'auth_error' },
  });
}

module.exports = { requireAdmin, requireAdminApi, requireApiKey, requireChatAuth };
