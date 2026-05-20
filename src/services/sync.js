'use strict';

/**
 * src/services/sync.js — Multi-instance synchronization engine.
 *
 * Topology supported (set via SYNC_MODE in .env):
 *   - "disabled" (default): no sync, single-instance mode.
 *   - "hub": serves the /api/sync/* endpoints. Does not initiate outbound
 *     calls. The VPS is typically the hub.
 *   - "peer": pushes local changes to a remote hub and pulls remote
 *     changes back on a timer (SYNC_INTERVAL_MS).
 *
 * Wire protocol (JSON over HTTPS, see src/routes/sync.js):
 *   POST /api/sync/handshake       — peer announces { node_id, role }
 *   GET  /api/sync/changes?since=X — returns outbox entries with row data
 *   POST /api/sync/push            — accepts { changes: [...] } from peer
 *
 * Conflict resolution: last-write-wins by `updated_at`. Tie-break: larger
 * node_id (lexicographic) wins so both sides converge deterministically.
 *
 * Foreign keys are mapped via row uuid, not autoincrement id, so different
 * instances can have different local ids without breaking references.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const db = require('../db');
const { now } = require('../utils/common');

// ---------- configuration ----------

const SYNC_MODE = String(process.env.SYNC_MODE || 'disabled').trim().toLowerCase();
const SYNC_NODE_ID = String(process.env.SYNC_NODE_ID || '').trim();
const SYNC_HUB_URL = String(process.env.SYNC_HUB_URL || '').trim();
const SYNC_SECRET = String(process.env.SYNC_SECRET || '').trim();
const SYNC_INTERVAL_MS = Math.max(2_000, Number(process.env.SYNC_INTERVAL_MS) || 15_000);
const SYNC_PUSH_LIMIT = Math.max(10, Number(process.env.SYNC_PUSH_LIMIT) || 500);
const SYNC_PULL_LIMIT = Math.max(10, Number(process.env.SYNC_PULL_LIMIT) || 500);
const SYNC_REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.SYNC_REQUEST_TIMEOUT_MS) || 20_000);

// ---------- schema map ----------

/**
 * For each synced table, we describe:
 *   - columns: data columns to ship over the wire (excluding sync metadata
 *     and id; sync metadata is added separately).
 *   - fks: { localColumn: 'referencedTable' } — the local id column is
 *     translated to the referenced row's uuid on egress, and back to a
 *     local id on ingress.
 *   - hasUpdatedAt: whether the table has a real `updated_at` column we
 *     can use as the conflict-resolution timestamp.
 */
const SYNCED_TABLES = {
  providers: {
    columns: [
      'name', 'slug', 'type', 'base_url', 'api_key', 'auth_type',
      'access_token', 'refresh_token', 'token_expires_at', 'config_json',
      'enabled', 'created_at', 'updated_at',
    ],
    fks: { current_account_id: 'provider_accounts' },
    hasUpdatedAt: true,
    // Columns enforced UNIQUE in SQLite. When an INSERT collides on one
    // of these we resolve by last-write-wins instead of crashing.
    uniqueKeys: ['slug', 'name'],
  },
  provider_accounts: {
    columns: [
      'label', 'email', 'api_key', 'access_token', 'refresh_token',
      'token_expires_at', 'config_json', 'enabled', 'exhausted_at',
      'last_used_at', 'created_at', 'updated_at',
    ],
    fks: { provider_id: 'providers' },
    hasUpdatedAt: true,
    uniqueKeys: [],
  },
  models: {
    columns: [
      'name', 'display_name', 'upstream_model', 'enabled', 'account_tier',
      'created_at', 'updated_at',
    ],
    fks: { provider_id: 'providers' },
    hasUpdatedAt: true,
    uniqueKeys: ['name'],
  },
  api_keys: {
    // No updated_at column; we use COALESCE(revoked_at, last_used_at, created_at)
    // as the sync timestamp, which is good enough since api_keys are mostly
    // append-only / revoke-only.
    columns: [
      'name', 'key_prefix', 'key_hash', 'enabled', 'last_used_at',
      'created_at', 'revoked_at',
    ],
    fks: {},
    hasUpdatedAt: false,
    uniqueKeys: ['key_hash'],
  },
};

const SYNCED_TABLE_NAMES = Object.keys(SYNCED_TABLES);

// ---------- runtime state ----------

const state = {
  mode: SYNC_MODE,
  nodeId: SYNC_NODE_ID,
  hubUrl: SYNC_HUB_URL,
  intervalMs: SYNC_INTERVAL_MS,
  initialized: false,
  running: false,
  timer: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastPullCount: 0,
  lastPushCount: 0,
  lastDurationMs: null,
};

function log(msg) {
  process.stderr.write(`[sync] ${msg}\n`);
}

// ---------- node id helpers ----------

function deriveNodeId(envValue) {
  const trimmed = String(envValue || '').trim();
  if (trimmed) return trimmed;
  // Stable fallback: persist a random id once, reuse forever.
  const existing = db.prepare(
    "SELECT value FROM sync_config WHERE key = 'derived_node_id'"
  ).get();
  if (existing && existing.value) return existing.value;
  const generated = 'node-' + crypto.randomBytes(6).toString('hex');
  const ts = now();
  db.prepare(`
    INSERT INTO sync_config (key, value, updated_at) VALUES ('derived_node_id', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(generated, ts);
  return generated;
}

function persistLocalNodeId(nodeId) {
  const ts = now();
  db.prepare(`
    INSERT INTO sync_config (key, value, updated_at) VALUES ('local_node_id', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(nodeId, ts);
}

function readLocalNodeId() {
  const row = db.prepare("SELECT value FROM sync_config WHERE key = 'local_node_id'").get();
  return row && row.value ? row.value : null;
}

/**
 * Replace the legacy placeholder node_id on rows that existed before sync
 * was introduced. Without this, those rows would never get pushed because
 * the trigger filters on `node_id = local_node_id`.
 */
function adoptLegacyRows(localNodeId) {
  for (const table of SYNCED_TABLE_NAMES) {
    const def = SYNCED_TABLES[table];
    // We deliberately don't bump updated_at here so we don't flood the
    // outbox at boot. The triggers won't fire because the UPDATE either
    // doesn't change updated_at (when the table has one) or doesn't flip
    // deleted_at — it just fixes node_id so future edits sync.
    const sql = def.hasUpdatedAt
      ? `UPDATE ${table} SET node_id = ?, updated_at = updated_at WHERE node_id = 'legacy'`
      : `UPDATE ${table} SET node_id = ? WHERE node_id = 'legacy'`;
    try {
      db.prepare(sql).run(localNodeId);
    } catch (err) {
      log(`adoptLegacyRows ${table} failed: ${err.message}`);
    }
  }
}

// ---------- uuid <-> id translation ----------

function uuidToId(table, uuid) {
  if (!uuid) return null;
  const row = db.prepare(`SELECT id FROM ${table} WHERE uuid = ?`).get(uuid);
  return row ? row.id : null;
}

function idToUuid(table, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id);
  return row ? row.uuid : null;
}

// ---------- outbox & cursors ----------

function maxOutboxId() {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sync_outbox').get();
  return row ? Number(row.m) : 0;
}

function getPeerCursor(nodeId) {
  return db.prepare(`
    SELECT * FROM sync_peers WHERE node_id = ?
  `).get(nodeId);
}

function upsertPeer(nodeId, patch = {}) {
  const ts = now();
  const existing = getPeerCursor(nodeId);
  if (existing) {
    const fields = [];
    const params = { id: existing.id, updated_at: ts };
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (!fields.length) return existing;
    db.prepare(`UPDATE sync_peers SET ${fields.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
    return getPeerCursor(nodeId);
  }
  db.prepare(`
    INSERT INTO sync_peers (node_id, endpoint, role, last_pull_ts, last_pull_outbox_id,
                            last_push_outbox_id, last_seen_at, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nodeId,
    patch.endpoint || null,
    patch.role || 'peer',
    Number(patch.last_pull_ts || 0),
    Number(patch.last_pull_outbox_id || 0),
    Number(patch.last_push_outbox_id || 0),
    patch.last_seen_at || null,
    patch.last_error || null,
    ts,
    ts,
  );
  return getPeerCursor(nodeId);
}

// ---------- (de)serialize a row to/from the wire ----------

/**
 * Read a synced row by uuid and serialize it for transport. Returns null
 * if the row doesn't exist locally anymore (e.g. hard-deleted by an old
 * code path before sync was enabled).
 */
function readRowForWire(table, uuid) {
  const def = SYNCED_TABLES[table];
  if (!def) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid);
  if (!row) return null;

  const data = {};
  for (const col of def.columns) data[col] = row[col];
  // Sync metadata (ts is the conflict-resolution timestamp).
  data.deleted_at = row.deleted_at || null;
  // FK translations: send the referenced row's uuid, not its local id.
  for (const [fkCol, fkTable] of Object.entries(def.fks)) {
    data[`__fk_${fkCol}_uuid`] = idToUuid(fkTable, row[fkCol]);
  }
  return data;
}

function rowTimestamp(table, row) {
  const def = SYNCED_TABLES[table];
  if (!def) return now();
  if (def.hasUpdatedAt) return Number(row.updated_at) || now();
  return Number(row.revoked_at || row.last_used_at || row.created_at) || now();
}

/**
 * Apply a remote change locally, with last-write-wins. Returns one of:
 *   'applied'  — change was written
 *   'skipped'  — local row is newer (LWW)
 *   'conflict' — unique-key collision with a different uuid
 *   'noop'     — nothing to do
 */
function applyIncomingChange(change) {
  const def = SYNCED_TABLES[change.table];
  if (!def) return 'noop';
  if (!change.uuid) return 'noop';

  const existing = db.prepare(`SELECT * FROM ${change.table} WHERE uuid = ?`).get(change.uuid);

  // ---- DELETE -----------------------------------------------------------
  if (change.op === 'delete') {
    if (!existing) return 'noop';
    if (existing.deleted_at) return 'skipped';
    const ts = Number(change.ts) || now();
    if (def.hasUpdatedAt) {
      db.prepare(`
        UPDATE ${change.table}
           SET deleted_at = ?, updated_at = ?, node_id = ?
         WHERE uuid = ?
      `).run(ts, ts, change.node_id || existing.node_id, change.uuid);
    } else {
      db.prepare(`
        UPDATE ${change.table}
           SET deleted_at = ?, node_id = ?
         WHERE uuid = ?
      `).run(ts, change.node_id || existing.node_id, change.uuid);
    }
    return 'applied';
  }

  // ---- UPSERT -----------------------------------------------------------
  const incomingTs = Number(change.ts) || now();
  const data = change.data || {};

  // Translate FK uuids to local ids; missing referenced rows mean the
  // referenced row hasn't arrived yet — apply with NULL and let the next
  // pull cycle reconcile (the foreign row will arrive eventually since
  // we ship in outbox-id order on the producer side).
  const fkValues = {};
  for (const [fkCol, fkTable] of Object.entries(def.fks)) {
    const fkUuid = data[`__fk_${fkCol}_uuid`];
    fkValues[fkCol] = fkUuid ? uuidToId(fkTable, fkUuid) : null;
  }

  if (existing) {
    // Last-write-wins by ts, tie-break by node_id (lexicographic max wins).
    const localTs = rowTimestamp(change.table, existing);
    if (incomingTs < localTs) return 'skipped';
    if (incomingTs === localTs && String(existing.node_id || '') >= String(change.node_id || '')) {
      return 'skipped';
    }

    const set = [];
    const params = { uuid: change.uuid };
    for (const col of def.columns) {
      if (col in data) {
        set.push(`${col} = @${col}`);
        params[col] = data[col];
      }
    }
    for (const fkCol of Object.keys(def.fks)) {
      set.push(`${fkCol} = @${fkCol}`);
      params[fkCol] = fkValues[fkCol];
    }
    set.push('node_id = @node_id');
    params.node_id = change.node_id || state.nodeId;
    set.push('deleted_at = @deleted_at');
    params.deleted_at = data.deleted_at || null;

    db.prepare(`UPDATE ${change.table} SET ${set.join(', ')} WHERE uuid = @uuid`).run(params);
    return 'applied';
  }

  // No row with this uuid exists yet — INSERT.
  const cols = ['uuid', 'node_id'];
  const vals = ['@uuid', '@node_id'];
  const params = {
    uuid: change.uuid,
    node_id: change.node_id || state.nodeId,
  };
  for (const col of def.columns) {
    if (col in data) {
      cols.push(col);
      vals.push(`@${col}`);
      params[col] = data[col];
    }
  }
  for (const fkCol of Object.keys(def.fks)) {
    cols.push(fkCol);
    vals.push(`@${fkCol}`);
    params[fkCol] = fkValues[fkCol];
  }
  if (data.deleted_at) {
    cols.push('deleted_at');
    vals.push('@deleted_at');
    params.deleted_at = data.deleted_at;
  }

  try {
    const sql = `INSERT INTO ${change.table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
    db.prepare(sql).run(params);
    return 'applied';
  } catch (err) {
    // UNIQUE constraint collision: a different uuid already owns one of
    // the natural keys (slug/name/key_hash/...). Reconcile via LWW
    // instead of crashing — adopt whichever side is newer.
    if (isUniqueConstraint(err)) {
      const reconciled = reconcileUniqueConflict(change, params, def, incomingTs);
      if (reconciled) return reconciled;
    }
    log(`apply ${change.table} ${change.uuid} conflict: ${err.message}`);
    return 'conflict';
  }
}

// ---------- unique-key reconciliation -----------------------------------

function isUniqueConstraint(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return /UNIQUE constraint failed/i.test(msg) || err.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * When INSERT fails because a natural-key column (slug/name/key_hash/...)
 * is already used by a row with a different uuid, decide who wins:
 *
 *   - If the local row is newer (or same ts but lexicographically larger
 *     node_id), keep local. Return 'skipped'.
 *   - Otherwise the incoming row wins. We promote the local row's uuid to
 *     the incoming uuid and overwrite all data columns. This converges
 *     both nodes onto a single uuid so future updates apply cleanly.
 *
 * Returns 'applied', 'skipped', or null if reconciliation didn't apply.
 */
function reconcileUniqueConflict(change, insertParams, def, incomingTs) {
  const uniqueKeys = Array.isArray(def.uniqueKeys) ? def.uniqueKeys : [];
  if (!uniqueKeys.length) return null;

  // Find the local row that owns the conflicting natural key.
  let localRow = null;
  for (const col of uniqueKeys) {
    const value = insertParams[col];
    if (value == null) continue;
    const candidate = db.prepare(
      `SELECT * FROM ${change.table} WHERE ${col} = ? LIMIT 1`
    ).get(value);
    if (candidate && candidate.uuid !== change.uuid) {
      localRow = candidate;
      break;
    }
  }
  if (!localRow) return null;

  const localTs = rowTimestamp(change.table, localRow);
  const incomingNode = String(change.node_id || '');
  const localNode = String(localRow.node_id || '');

  // Local wins on LWW: keep local row, drop the incoming insert.
  if (incomingTs < localTs) {
    log(`reconcile ${change.table} ${change.uuid}: local newer, keeping local uuid=${localRow.uuid}`);
    return 'skipped';
  }
  if (incomingTs === localTs && localNode >= incomingNode) {
    log(`reconcile ${change.table} ${change.uuid}: tie-break favors local uuid=${localRow.uuid}`);
    return 'skipped';
  }

  // Incoming wins: rewrite local row to adopt incoming uuid + data.
  const set = ['uuid = @uuid', 'node_id = @node_id'];
  const params = {
    id: localRow.id,
    uuid: change.uuid,
    node_id: incomingNode || state.nodeId,
  };
  for (const col of def.columns) {
    if (col in insertParams) {
      set.push(`${col} = @${col}`);
      params[col] = insertParams[col];
    }
  }
  for (const fkCol of Object.keys(def.fks)) {
    set.push(`${fkCol} = @${fkCol}`);
    params[fkCol] = insertParams[fkCol] || null;
  }
  set.push('deleted_at = @deleted_at');
  params.deleted_at = insertParams.deleted_at || null;

  try {
    db.prepare(
      `UPDATE ${change.table} SET ${set.join(', ')} WHERE id = @id`
    ).run(params);
    log(`reconcile ${change.table}: adopted incoming uuid=${change.uuid} (was uuid=${localRow.uuid})`);
    return 'applied';
  } catch (err) {
    log(`reconcile ${change.table} ${change.uuid} update failed: ${err.message}`);
    return null;
  }
}

// ---------- outbox query for outbound changes ----------

/**
 * Return outbox entries with id > sinceId, joined with the latest row
 * data for each (uuid, table). Used both by /api/sync/changes (server
 * side) and by peer push (client side).
 *
 * IMPORTANT: an outbox row referring to a uuid that no longer exists
 * locally will be skipped (e.g. if hard-delete leaked through). The
 * outbox entry is still consumed so the cursor advances.
 */
function readOutboxChanges(sinceId, limit) {
  const rows = db.prepare(`
    SELECT * FROM sync_outbox
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(Number(sinceId) || 0, Math.max(1, Number(limit) || SYNC_PULL_LIMIT));

  const changes = [];
  let cursor = Number(sinceId) || 0;
  for (const entry of rows) {
    cursor = Math.max(cursor, Number(entry.id) || 0);
    const data = readRowForWire(entry.table_name, entry.row_uuid);
    if (entry.op === 'delete') {
      // For a delete, we don't need the full row data, just the uuid.
      changes.push({
        outbox_id: Number(entry.id),
        table: entry.table_name,
        uuid: entry.row_uuid,
        op: 'delete',
        ts: Number(entry.ts) || now(),
        node_id: entry.node_id,
      });
      continue;
    }
    if (!data) continue;
    changes.push({
      outbox_id: Number(entry.id),
      table: entry.table_name,
      uuid: entry.row_uuid,
      op: 'upsert',
      ts: Number(entry.ts) || now(),
      node_id: entry.node_id,
      data,
    });
  }
  return { changes, cursor };
}

// ---------- HTTP client (no extra deps) ----------

function httpRequest({ method, url, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (err) { return reject(err); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'authorization': `Bearer ${SYNC_SECRET}`,
        'content-type': 'application/json',
        'accept': 'application/json',
        'x-sync-node-id': state.nodeId,
        ...(data ? { 'content-length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
        resolve({ status: res.statusCode, body: json, raw: text });
      });
    });
    req.setTimeout(timeoutMs || SYNC_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`sync request timed out after ${timeoutMs || SYNC_REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- peer push & pull cycle ----------

async function handshakeWithHub() {
  if (!state.hubUrl) throw new Error('SYNC_HUB_URL not set');
  const url = state.hubUrl.replace(/\/$/, '') + '/api/sync/handshake';
  const resp = await httpRequest({
    method: 'POST',
    url,
    body: { node_id: state.nodeId, role: 'peer' },
  });
  if (resp.status !== 200) {
    throw new Error(`handshake returned ${resp.status}: ${resp.raw && resp.raw.slice(0, 200)}`);
  }
  const remote = resp.body || {};
  if (!remote.node_id) throw new Error('handshake response missing node_id');
  upsertPeer(remote.node_id, {
    endpoint: state.hubUrl,
    role: remote.role || 'hub',
    last_seen_at: now(),
    last_error: null,
  });
  return remote;
}

async function pushToHub(hubNodeId) {
  const peer = getPeerCursor(hubNodeId);
  const sinceId = peer ? Number(peer.last_push_outbox_id) : 0;
  const { changes, cursor } = readOutboxChanges(sinceId, SYNC_PUSH_LIMIT);
  if (!changes.length) return { pushed: 0, cursor: sinceId };

  const url = state.hubUrl.replace(/\/$/, '') + '/api/sync/push';
  const resp = await httpRequest({
    method: 'POST',
    url,
    body: { from: state.nodeId, changes },
  });
  if (resp.status !== 200) {
    throw new Error(`push returned ${resp.status}: ${resp.raw && resp.raw.slice(0, 200)}`);
  }
  upsertPeer(hubNodeId, {
    last_push_outbox_id: cursor,
    last_seen_at: now(),
    last_error: null,
  });
  return { pushed: changes.length, cursor };
}

async function pullFromHub(hubNodeId) {
  const peer = getPeerCursor(hubNodeId);
  const sinceId = peer ? Number(peer.last_pull_outbox_id) : 0;
  const url = state.hubUrl.replace(/\/$/, '') +
    `/api/sync/changes?since=${encodeURIComponent(sinceId)}&limit=${SYNC_PULL_LIMIT}`;
  const resp = await httpRequest({ method: 'GET', url });
  if (resp.status !== 200) {
    throw new Error(`pull returned ${resp.status}: ${resp.raw && resp.raw.slice(0, 200)}`);
  }
  const remoteChanges = (resp.body && Array.isArray(resp.body.changes)) ? resp.body.changes : [];
  const remoteCursor = Number(resp.body && resp.body.cursor) || sinceId;

  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const change of remoteChanges) {
    // Don't echo back changes that originated from us.
    if (change.node_id === state.nodeId) continue;
    const result = applyIncomingChange(change);
    if (result === 'applied') applied += 1;
    else if (result === 'conflict') conflicts += 1;
    else skipped += 1;
  }

  upsertPeer(hubNodeId, {
    last_pull_outbox_id: remoteCursor,
    last_pull_ts: now(),
    last_seen_at: now(),
    last_error: null,
  });
  return { pulled: remoteChanges.length, applied, skipped, conflicts, cursor: remoteCursor };
}

async function runOnce() {
  if (state.mode !== 'peer') return { skipped: 'not-peer' };
  if (!state.hubUrl || !SYNC_SECRET) {
    return { skipped: 'missing-hub-or-secret' };
  }
  if (state.running) return { skipped: 'already-running' };
  state.running = true;
  const startedAt = Date.now();

  try {
    const hub = await handshakeWithHub();
    const pushRes = await pushToHub(hub.node_id);
    const pullRes = await pullFromHub(hub.node_id);
    state.lastStatus = 'ok';
    state.lastError = null;
    state.lastPushCount = pushRes.pushed;
    state.lastPullCount = pullRes.pulled;
    state.lastRunAt = now();
    state.lastDurationMs = Date.now() - startedAt;
    return { ok: true, push: pushRes, pull: pullRes };
  } catch (err) {
    state.lastStatus = 'error';
    state.lastError = err.message;
    state.lastRunAt = now();
    state.lastDurationMs = Date.now() - startedAt;
    log(`cycle failed: ${err.message}`);
    // Also persist the error against the hub peer if we know it.
    try {
      const peer = db.prepare(
        "SELECT * FROM sync_peers WHERE role = 'hub' ORDER BY id LIMIT 1"
      ).get();
      if (peer) upsertPeer(peer.node_id, { last_error: err.message });
    } catch { /* ignore */ }
    return { ok: false, error: err.message };
  } finally {
    state.running = false;
  }
}

function start() {
  if (state.initialized) return;
  state.initialized = true;

  // Resolve a stable local node id and write it to sync_config so the
  // SQLite triggers can read it.
  const resolved = deriveNodeId(SYNC_NODE_ID);
  state.nodeId = resolved;
  persistLocalNodeId(resolved);
  adoptLegacyRows(resolved);

  if (state.mode === 'disabled') {
    log(`disabled (node_id=${resolved})`);
    return;
  }
  if (state.mode === 'hub') {
    log(`hub mode (node_id=${resolved}); listening on /api/sync/*`);
    return;
  }
  if (state.mode !== 'peer') {
    log(`unknown SYNC_MODE="${state.mode}", treating as disabled`);
    return;
  }
  if (!state.hubUrl) {
    log('peer mode but SYNC_HUB_URL is empty — sync disabled until configured');
    return;
  }
  if (!SYNC_SECRET) {
    log('peer mode but SYNC_SECRET is empty — sync disabled until configured');
    return;
  }
  log(
    `peer mode (node_id=${resolved}) -> ${state.hubUrl}; cadence=${state.intervalMs}ms`
  );

  // Initial cycle shortly after boot, then periodic.
  setTimeout(() => {
    runOnce().catch((err) => log(`initial cycle threw: ${err.message}`));
  }, 5_000).unref?.();

  state.timer = setInterval(() => {
    runOnce().catch((err) => log(`scheduled cycle threw: ${err.message}`));
  }, state.intervalMs);
  state.timer.unref?.();
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function getStatus() {
  let peers = [];
  try {
    peers = db.prepare(`
      SELECT node_id, endpoint, role, last_pull_ts, last_pull_outbox_id,
             last_push_outbox_id, last_seen_at, last_error
      FROM sync_peers ORDER BY id ASC
    `).all();
  } catch { /* ignore */ }
  let outboxSize = 0;
  try {
    outboxSize = db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get().c;
  } catch { /* ignore */ }
  return {
    mode: state.mode,
    nodeId: state.nodeId || readLocalNodeId(),
    hubUrl: state.hubUrl || null,
    intervalMs: state.intervalMs,
    initialized: state.initialized,
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    lastPullCount: state.lastPullCount,
    lastPushCount: state.lastPushCount,
    lastDurationMs: state.lastDurationMs,
    outboxSize,
    peers,
  };
}

// ---------- on-demand reconciliation -----------------------------------

/**
 * Scan every synced table for rows that share a natural-key value
 * (slug/name/key_hash/...) but carry different uuids. Such pairs would
 * otherwise stall sync forever because INSERT keeps failing on UNIQUE.
 *
 * Resolution per duplicate group: keep the row with the most recent
 * timestamp (or larger node_id on tie); merge all losers into the winner
 * by promoting the winner's uuid + data, then soft-delete the losers so
 * remote peers also drop them.
 *
 * Returns a summary { tables: { [name]: {scanned, merged, errors} }, totals }.
 */
function reconcileExistingDuplicates() {
  const summary = { tables: {}, totals: { scanned: 0, merged: 0, errors: 0 } };
  for (const table of SYNCED_TABLE_NAMES) {
    const def = SYNCED_TABLES[table];
    const uniqueKeys = Array.isArray(def.uniqueKeys) ? def.uniqueKeys : [];
    const tableStats = { scanned: 0, merged: 0, errors: 0, groups: 0 };
    for (const col of uniqueKeys) {
      let rows;
      try {
        rows = db.prepare(`SELECT * FROM ${table} WHERE ${col} IS NOT NULL`).all();
      } catch (err) {
        log(`reconcileExistingDuplicates: scan ${table}.${col} failed: ${err.message}`);
        tableStats.errors += 1;
        continue;
      }
      tableStats.scanned += rows.length;

      // Group by natural-key value, ignoring already soft-deleted rows.
      const groups = new Map();
      for (const row of rows) {
        if (row.deleted_at) continue;
        const key = row[col];
        if (key == null) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }

      for (const [, group] of groups) {
        if (group.length < 2) continue;
        tableStats.groups += 1;

        // Pick the winner: latest ts, tie-break by larger node_id, then larger id.
        const winner = group.reduce((best, candidate) => {
          if (!best) return candidate;
          const bt = rowTimestamp(table, best);
          const ct = rowTimestamp(table, candidate);
          if (ct > bt) return candidate;
          if (ct < bt) return best;
          const bn = String(best.node_id || '');
          const cn = String(candidate.node_id || '');
          if (cn > bn) return candidate;
          if (cn < bn) return best;
          return candidate.id > best.id ? candidate : best;
        }, null);

        const losers = group.filter((r) => r.id !== winner.id);
        const ts = now();
        for (const loser of losers) {
          try {
            // Soft-delete the loser so peers drop their copy too. We bump
            // updated_at (if available) so triggers emit a delete in the
            // outbox.
            if (def.hasUpdatedAt) {
              db.prepare(`
                UPDATE ${table}
                   SET deleted_at = ?, updated_at = ?, node_id = ?
                 WHERE id = ?
              `).run(ts, ts, state.nodeId || loser.node_id, loser.id);
            } else {
              db.prepare(`
                UPDATE ${table}
                   SET deleted_at = ?, node_id = ?
                 WHERE id = ?
              `).run(ts, state.nodeId || loser.node_id, loser.id);
            }
            tableStats.merged += 1;
          } catch (err) {
            log(`reconcileExistingDuplicates: ${table} loser id=${loser.id} failed: ${err.message}`);
            tableStats.errors += 1;
          }
        }
      }
    }
    summary.tables[table] = tableStats;
    summary.totals.scanned += tableStats.scanned;
    summary.totals.merged += tableStats.merged;
    summary.totals.errors += tableStats.errors;
  }
  return summary;
}

module.exports = {
  start,
  stop,
  runOnce,
  getStatus,
  applyIncomingChange,
  reconcileExistingDuplicates,
  readOutboxChanges,
  upsertPeer,
  getPeerCursor,
  // exported for routes
  SYNC_SECRET,
  SYNC_MODE,
  SYNCED_TABLE_NAMES,
  // for tests / debugging
  _internal: {
    deriveNodeId,
    persistLocalNodeId,
    adoptLegacyRows,
    readLocalNodeId,
    maxOutboxId,
    state,
  },
};
