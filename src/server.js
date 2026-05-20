'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');

const { run: migrate } = require('./db/migrate');
const backup = require('./db/backup');
const sync = require('./services/sync');
const { SqliteSessionStore } = require('./services/sessionStore');

const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const proxyRoutes = require('./routes/proxy');
const syncRoutes = require('./routes/sync');
const chatRoutes = require('./routes/chat');

// Run migrations at boot
migrate();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Views
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Middleware
app.use(morgan('tiny'));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.SESSION_SECURE_COOKIE === '1',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Health check (no auth)
app.get('/healthz', (req, res) => res.json({ ok: true }));

function extractMockResponseInputText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '(no user input)';

  return input
    .map((item) => {
      if (!item) return '';
      if (typeof item.content === 'string') return item.content;
      if (Array.isArray(item.content)) {
        return item.content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n') || '(no user input)';
}

function countMockImages(parts) {
  if (!Array.isArray(parts)) return 0;
  return parts.filter((part) => (
    part &&
    (
      part.type === 'input_image' ||
      part.type === 'image_url' ||
      part.image_url
    )
  )).length;
}

function describeMockVision(parts) {
  const count = countMockImages(parts);
  if (!count) return '';
  return ` [vision:${count} image${count === 1 ? '' : 's'}]`;
}

function flattenMockChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '(no user message)';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n') || '(no user message)';
}

function buildMockResponsesPayload(body, text, createdAt) {
  const outputTokens = text.split(/\s+/).length;
  return {
    id: 'resp_' + Math.random().toString(16).slice(2, 10),
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model: body.model,
    output: [
      {
        id: 'msg_' + Math.random().toString(16).slice(2, 10),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: outputTokens,
      total_tokens: 10 + outputTokens,
    },
  };
}

// Local mock provider — useful for testing the playground without a real upstream.
// Accepts OpenAI-style POSTs at /mock/v1/chat/completions and returns an
// echo-style reply (streaming or non-streaming).
app.post('/mock/v1/chat/completions', (req, res) => {
  const body = req.body || {};
  const userMsg = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const vision = describeMockVision(Array.isArray(userMsg?.content) ? userMsg.content : []);
  const text =
    `Echo from mock (${body.model || 'unknown'}): ` +
    `${flattenMockChatContent(userMsg?.content || '(no user message)')}${vision}`.slice(0, 300);
  const id = 'chatcmpl-' + Math.random().toString(16).slice(2, 10);
  const now = Math.floor(Date.now() / 1000);

  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    const tokens = text.split(/(\s+)/);
    let i = 0;
    const tick = () => {
      if (i >= tokens.length) {
        res.write(
          `data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created: now, model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: tokens.length, total_tokens: 10 + tokens.length },
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.write(
        `data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created: now, model: body.model,
          choices: [{ index: 0, delta: { content: tokens[i] }, finish_reason: null }],
        })}\n\n`
      );
      i++;
      setTimeout(tick, 40);
    };
    tick();
    return;
  }

  res.json({
    id,
    object: 'chat.completion',
    created: now,
    model: body.model,
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 10, completion_tokens: text.split(/\s+/).length, total_tokens: 10 + text.split(/\s+/).length },
  });
});

app.post('/mock/v1/responses', (req, res) => {
  const body = req.body || {};
  const inputText = extractMockResponseInputText(body.input);
  const visionCount = Array.isArray(body.input)
    ? body.input.reduce((total, item) => total + countMockImages(Array.isArray(item?.content) ? item.content : []), 0)
    : 0;
  const vision = visionCount ? ` [vision:${visionCount} image${visionCount === 1 ? '' : 's'}]` : '';
  const text =
    `Echo from mock responses (${body.model || 'unknown'}): ` +
    `${inputText}${vision}`.slice(0, 300);
  const now = Math.floor(Date.now() / 1000);
  const responsePayload = buildMockResponsesPayload(body, text, now);

  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    const tokens = text.split(/(\s+)/);
    let i = 0;

    const tick = () => {
      if (i === 0) {
        res.write('event: response.created\n');
        res.write(`data: ${JSON.stringify({ type: 'response.created', response: responsePayload })}\n\n`);
      }

      if (i >= tokens.length) {
        res.write('event: response.completed\n');
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: responsePayload })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      res.write('event: response.output_text.delta\n');
      res.write(
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: tokens[i],
          response_id: responsePayload.id,
          item_id: responsePayload.output[0].id,
        })}\n\n`
      );
      i++;
      setTimeout(tick, 40);
    };

    tick();
    return;
  }

  res.json(responsePayload);
});

// OpenAI-compatible proxy
app.use('/v1', proxyRoutes);

// Admin JSON API
app.use('/api/admin', adminRoutes);

// Multi-instance sync API (shared-token auth, see src/routes/sync.js)
app.use('/api/sync', syncRoutes);

// Chat UI routes
app.use('/chat', chatRoutes);

// Dashboard (HTML) + login
app.use('/', dashboardRoutes);

// 404
app.use((req, res) => {
  if (req.accepts('html')) {
    return res.status(404).send('Not found');
  }
  res.status(404).json({ error: 'not_found' });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  const isProd = process.env.NODE_ENV === 'production';
  if (req.accepts('html') && !req.path.startsWith('/api') && !req.path.startsWith('/v1')) {
    if (isProd) return res.status(500).send('Internal error');
    const stack = String((err && err.stack) || err || 'Unknown error');
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return res.status(500).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>500 · Akira Proxy</title>` +
      `<style>body{background:#0b0f14;color:#e5e7eb;font:13px/1.5 ui-monospace,Consolas,Menlo,monospace;margin:0;padding:24px}h1{color:#f87171;font:600 15px system-ui;margin:0 0 6px}.meta{color:#94a3b8;margin-bottom:16px}pre{white-space:pre-wrap;word-break:break-word;background:#111827;border:1px solid #1f2937;border-radius:8px;padding:16px;overflow:auto}</style>` +
      `<h1>Internal Server Error</h1>` +
      `<div class="meta">${esc(req.method)} ${esc(req.originalUrl)}</div>` +
      `<pre>${esc(stack)}</pre>`
    );
  }
  res.status(500).json({ error: err.message || 'internal_error', stack: isProd ? undefined : (err && err.stack) });
});

const server = app.listen(PORT, () => {
  console.log(`Akira Proxy listening on http://localhost:${PORT}`);
  // Start the MySQL/MariaDB auto-backup (no-op if BACKUP_ENABLED=0).
  try {
    backup.start();
  } catch (err) {
    console.error('[backup] failed to start:', err.message);
  }
  // Start cross-instance sync (no-op if SYNC_MODE=disabled).
  try {
    sync.start();
  } catch (err) {
    console.error('[sync] failed to start:', err.message);
  }
  // Initialize proxy service.
  try {
    const proxyService = require('./services/proxyService');
    proxyService.init();
  } catch (err) {
    console.error('[proxy] failed to init:', err.message);
  }
});

server.on('error', (err) => {
  console.error('[server] failed to listen:', err && err.stack ? err.stack : err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err && err.stack ? err.stack : err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[process] SIGTERM received, shutting down cleanly');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[process] SIGINT received, shutting down cleanly');
  server.close(() => process.exit(0));
});
