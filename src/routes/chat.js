'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// Generate UUID v4
function generateUuid() {
  return crypto.randomUUID();
}

// Get current timestamp
function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * GET /chat
 * Chat UI page - list sessions
 */
router.get('/', (req, res) => {
  const sessions = db.prepare(`
    SELECT cs.*, 
           (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) as message_count
    FROM chat_sessions cs
    ORDER BY cs.updated_at DESC
    LIMIT 50
  `).all();

  const models = db.prepare(`
    SELECT m.name, m.display_name, p.name AS provider_name
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = 1 AND p.enabled = 1
      AND m.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY m.name ASC
  `).all();

  const apiKeys = db.prepare(`
    SELECT id, name, key_prefix
    FROM api_keys
    WHERE enabled = 1 AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all();

  res.render('chat', { 
    sessions, 
    models, 
    apiKeys,
    active: 'chat',
    title: 'Chat · Akira Proxy'
  });
});

/**
 * GET /chat/api/sessions
 * List all chat sessions
 */
router.get('/api/sessions', (req, res) => {
  const sessions = db.prepare(`
    SELECT cs.*, 
           (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) as message_count
    FROM chat_sessions cs
    ORDER BY cs.updated_at DESC
    LIMIT 100
  `).all();

  res.json({ sessions });
});

/**
 * POST /chat/api/sessions
 * Create a new chat session
 */
router.post('/api/sessions', (req, res) => {
  const { title, model, api_key_id } = req.body;
  
  if (!model) {
    return res.status(400).json({ error: 'Model is required' });
  }

  const uuid = generateUuid();
  const timestamp = now();

  const result = db.prepare(`
    INSERT INTO chat_sessions (uuid, title, model, api_key_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid, title || 'New Chat', model, api_key_id || null, timestamp, timestamp);

  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(result.lastInsertRowid);
  res.json({ session });
});

/**
 * GET /chat/api/sessions/:uuid
 * Get a session with all messages
 */
router.get('/api/sessions/:uuid', (req, res) => {
  const session = db.prepare(`
    SELECT cs.*, 
           (SELECT COUNT(*) FROM chat_messages WHERE session_id = cs.id) as message_count
    FROM chat_sessions cs
    WHERE cs.uuid = ?
  `).get(req.params.uuid);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const messages = db.prepare(`
    SELECT * FROM chat_messages
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(session.id);

  res.json({ session, messages });
});

/**
 * DELETE /chat/api/sessions/:uuid
 * Delete a chat session
 */
router.delete('/api/sessions/:uuid', (req, res) => {
  const result = db.prepare('DELETE FROM chat_sessions WHERE uuid = ?').run(req.params.uuid);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({ success: true });
});

/**
 * POST /chat/api/sessions/:uuid/messages
 * Add a message to a session
 */
router.post('/api/sessions/:uuid/messages', (req, res) => {
  const { role, content, tokens } = req.body;

  if (!role || !content) {
    return res.status(400).json({ error: 'Role and content are required' });
  }

  const session = db.prepare('SELECT * FROM chat_sessions WHERE uuid = ?').get(req.params.uuid);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const timestamp = now();

  const result = db.prepare(`
    INSERT INTO chat_messages (session_id, role, content, tokens, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(session.id, role, content, tokens || 0, timestamp);

  // Update session updated_at
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(timestamp, session.id);

  const message = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid);
  res.json({ message });
});

/**
 * PATCH /chat/api/sessions/:uuid
 * Update session (title, model, api_key_id)
 */
router.patch('/api/sessions/:uuid', (req, res) => {
  const { title, model, api_key_id } = req.body;

  const session = db.prepare('SELECT * FROM chat_sessions WHERE uuid = ?').get(req.params.uuid);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const timestamp = now();
  const updates = [];
  const values = [];

  if (title !== undefined) {
    updates.push('title = ?');
    values.push(title);
  }
  if (model !== undefined) {
    updates.push('model = ?');
    values.push(model);
  }
  if (api_key_id !== undefined) {
    updates.push('api_key_id = ?');
    values.push(api_key_id);
  }

  if (updates.length === 0) {
    return res.json({ session });
  }

  updates.push('updated_at = ?');
  values.push(timestamp);
  values.push(req.params.uuid);

  db.prepare(`UPDATE chat_sessions SET ${updates.join(', ')} WHERE uuid = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM chat_sessions WHERE uuid = ?').get(req.params.uuid);
  res.json({ session: updated });
});

/**
 * POST /chat/api/completions
 * Chat completions endpoint with session-based auth for the chat UI.
 * Forwards to the model proxy with the session's API key.
 */
router.post('/api/completions', async (req, res) => {
  // Check for admin session
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { model, messages: chatMessages, stream = true, ...rest } = req.body;
  
  if (!model || !chatMessages) {
    return res.status(400).json({ error: 'Model and messages are required' });
  }

  // Get API key from session or use first available
  const chatSessionHeader = req.get('x-chat-session');
  let apiKey = null;
  
  if (chatSessionHeader) {
    const session = db.prepare('SELECT * FROM chat_sessions WHERE uuid = ?').get(chatSessionHeader);
    if (session?.api_key_id) {
      apiKey = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1 AND revoked_at IS NULL').get(session.api_key_id);
    }
  }
  
  if (!apiKey) {
    apiKey = db.prepare('SELECT * FROM api_keys WHERE enabled = 1 AND revoked_at IS NULL LIMIT 1').get();
  }
  
  if (!apiKey) {
    return res.status(400).json({ error: 'No API key available. Create one in the API Keys page.' });
  }

  // Import proxy service
  const { proxyModelRequest } = require('../services/modelProxy');
  
  // Build request body
  const body = { model, messages: chatMessages, stream, ...rest };
  
  // Call proxy
  await proxyModelRequest({
    body,
    res,
    apiKeyId: apiKey.id,
    adapterMethod: 'chatCompletions',
    endpoint: '/v1/chat/completions',
  });
});

module.exports = router;
