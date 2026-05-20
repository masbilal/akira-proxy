'use strict';

/**
 * src/routes/sync.js — HTTP endpoints exposed by a hub (or peer that
 * happens to be reachable) so other instances can replicate.
 *
 * All endpoints require a shared bearer token via `Authorization: Bearer
 * <SYNC_SECRET>`. If SYNC_SECRET is empty, the routes are wired but every
 * request is rejected with 503, so the dashboard / curl tests show why.
 *
 * Endpoints:
 *   POST /api/sync/handshake  — peer announces { node_id, role }; we record
 *                               it in sync_peers and return our own info.
 *   GET  /api/sync/changes    — return outbox entries with id > since,
 *                               serialized for the wire.
 *   POST /api/sync/push       — accept { from, changes } and apply them
 *                               locally with last-write-wins.
 */

const express = require('express');
const sync = require('../services/sync');
const db = require('../db');
const { now } = require('../utils/common');

const router = express.Router();

// ---------- shared-token guard ----------

router.use((req, res, next) => {
  if (!sync.SYNC_SECRET) {
    return res.status(503).json({
      error: 'sync_secret_not_configured',
      message: 'Set SYNC_SECRET in .env to enable cross-instance sync.',
    });
  }
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m || m[1].trim() !== sync.SYNC_SECRET) {
    return res.status(401).json({ error: 'invalid_sync_secret' });
  }
  next();
});

// ---------- handshake ----------

router.post('/handshake', (req, res) => {
  const remoteNodeId = String((req.body && req.body.node_id) || '').trim();
  if (!remoteNodeId) return res.status(400).json({ error: 'node_id required' });
  const role = String((req.body && req.body.role) || 'peer').trim();

  sync.upsertPeer(remoteNodeId, {
    role,
    last_seen_at: now(),
    last_error: null,
  });

  const status = sync.getStatus();
  res.json({
    ok: true,
    node_id: status.nodeId,
    role: status.mode === 'hub' ? 'hub' : 'peer',
    accept_role: role,
    server_time: now(),
  });
});

// ---------- changes feed ----------

router.get('/changes', (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
  const { changes, cursor } = sync.readOutboxChanges(since, limit);

  // Track what this peer has pulled (not strictly required for the protocol,
  // but useful for the dashboard view of "who saw what").
  const remoteNodeId = String(req.get('x-sync-node-id') || '').trim();
  if (remoteNodeId) {
    try {
      sync.upsertPeer(remoteNodeId, {
        last_seen_at: now(),
        last_pull_ts: now(),
      });
    } catch { /* best-effort */ }
  }

  res.json({
    ok: true,
    cursor,
    count: changes.length,
    changes,
  });
});

// ---------- accept pushed changes ----------

router.post('/push', (req, res) => {
  const remoteNodeId = String((req.body && req.body.from) || '').trim();
  const changes = Array.isArray(req.body && req.body.changes) ? req.body.changes : [];
  if (!remoteNodeId) return res.status(400).json({ error: 'from required' });

  const status = sync.getStatus();
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  let maxOutboxId = 0;
  for (const change of changes) {
    if (!change || !change.table || !change.uuid || !change.op) {
      skipped += 1;
      continue;
    }
    // Don't accept echoed copies of our own changes.
    if (change.node_id === status.nodeId) {
      skipped += 1;
      if (change.outbox_id) maxOutboxId = Math.max(maxOutboxId, Number(change.outbox_id) || 0);
      continue;
    }
    const result = sync.applyIncomingChange(change);
    if (result === 'applied') applied += 1;
    else if (result === 'conflict') conflicts += 1;
    else skipped += 1;
    if (change.outbox_id) maxOutboxId = Math.max(maxOutboxId, Number(change.outbox_id) || 0);
  }

  // Track the peer's high-water mark on our side so the dashboard reflects
  // what's been delivered.
  try {
    sync.upsertPeer(remoteNodeId, {
      last_seen_at: now(),
      last_pull_outbox_id: maxOutboxId || undefined,
    });
  } catch { /* best-effort */ }

  res.json({
    ok: true,
    received: changes.length,
    applied,
    skipped,
    conflicts,
    cursor: maxOutboxId,
  });
});

// ---------- status (admin-only also exposes via /api/admin/sync/status) ----------

router.get('/status', (req, res) => {
  res.json(sync.getStatus());
});

module.exports = router;

// Best-effort suppression of "db unused" lint when the import is kept for
// future expansion but not directly referenced above.
void db;
