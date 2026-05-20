let selectedJobId = new URLSearchParams(window.location.search).get('job') || null;
let jobsCache = [];

function statusClass(status) {
  return `status-pill status-${status || 'idle'}`;
}

function resultClass(status) {
  return `result-tile result-${status || 'queued'}`;
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toLocaleString();
}

async function loadJobs() {
  const res = await fetch('/api/admin/workers');
  const data = await res.json().catch(() => ({ data: [] }));
  jobsCache = data.data || [];
  if (!selectedJobId && jobsCache.length) selectedJobId = jobsCache[0].id;
  renderJobs();
  if (selectedJobId) await loadJob(selectedJobId);
  document.getElementById('refreshState').textContent = `updated ${new Date().toLocaleTimeString()}`;
}

function renderJobs() {
  const list = document.getElementById('jobList');
  if (!jobsCache.length) {
    list.innerHTML = '<div class="px-5 py-8 text-center text-sm text-slate-400">No worker jobs yet.</div>';
    return;
  }
  list.innerHTML = jobsCache.map((job) => {
    const selected = job.id === selectedJobId ? 'bg-brand-50' : 'hover:bg-slate-50';
    const pct = job.total ? Math.round((Number(job.completed || 0) / Number(job.total)) * 100) : 0;
    return `
      <button class="w-full text-left px-5 py-4 ${selected}" data-job-id="${job.id}">
        <div class="flex items-center justify-between gap-3">
          <div class="font-medium text-sm truncate">${job.type || 'worker'} - ${job.id}</div>
          <span class="text-[11px] px-2 py-0.5 rounded-full ${statusClass(job.status)}">${job.status}</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">${job.completed || 0}/${job.total || 0} done - ${pct}%</div>
        <div class="text-xs text-slate-400 mt-1 truncate">${job.current ? `current: ${job.current}` : fmtTime(job.updated_at)}</div>
      </button>
    `;
  }).join('');
  list.querySelectorAll('[data-job-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedJobId = btn.dataset.jobId;
      const url = new URL(window.location.href);
      url.searchParams.set('job', selectedJobId);
      window.history.replaceState(null, '', url);
      renderJobs();
      loadJob(selectedJobId);
    });
  });
}

async function loadJob(id) {
  const res = await fetch(`/api/admin/workers/${encodeURIComponent(id)}?max=80000`);
  if (!res.ok) return;
  const data = await res.json();
  const job = data.job || {};
  const total = Number(job.total || 0);
  const completed = Number(job.completed || 0);
  const failed = Number(job.failed || 0);
  const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  document.getElementById('jobTitle').textContent = `${job.type || 'worker'} - ${job.id}`;
  document.getElementById('jobMeta').textContent =
    `started ${fmtTime(job.started_at)} - updated ${fmtTime(job.updated_at)} - failed ${failed} - headless ${job.headless === false ? 'off' : 'on'}`;
  const status = document.getElementById('jobStatus');
  status.textContent = job.status || 'unknown';
  status.className = `text-xs px-2 py-1 rounded-full ${statusClass(job.status)}`;
  const cancelBtn = document.getElementById('cancelJobBtn');
  const cancellable = ['queued', 'running'].includes(job.status);
  cancelBtn.classList.toggle('hidden', !cancellable);
  cancelBtn.onclick = cancellable ? () => cancelJob(job.id) : null;
  document.getElementById('progressText').textContent = `${completed} / ${total}`;
  document.getElementById('currentText').textContent = job.current ? `current: ${job.current}` : (job.finished_at ? `finished ${fmtTime(job.finished_at)}` : '-');
  document.getElementById('progressBar').style.width = `${pct}%`;
  renderResults(job.results || []);

  const log = document.getElementById('jobLog');
  const shouldStick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
  log.textContent = data.log || 'Waiting for log...';
  if (shouldStick) log.scrollTop = log.scrollHeight;
}

async function cancelJob(id) {
  if (!id) return;
  if (!confirm('Stop this worker job?')) return;
  const res = await fetch(`/api/admin/workers/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to stop worker');
    return;
  }
  await loadJobs();
}

function renderResults(results) {
  const list = document.getElementById('resultList');
  if (!results.length) {
    list.innerHTML = '<div class="text-slate-400">No account-level result yet.</div>';
    return;
  }
  list.innerHTML = results.map((item) => `
    <div class="border rounded-md px-3 py-2 ${resultClass(item.status)}">
      <div class="font-medium truncate">${item.email || '-'}</div>
      <div class="mt-1 flex items-center justify-between gap-2">
        <span>${item.status || 'queued'}</span>
        <span>${item.exit_code === null || typeof item.exit_code === 'undefined' ? '' : `exit ${item.exit_code}`}</span>
      </div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  loadJobs().catch(() => {});
  setInterval(() => loadJobs().catch(() => {}), 2000);
  loadBackupStatus().catch(() => {});
  setInterval(() => loadBackupStatus().catch(() => {}), 15000);
  loadSyncStatus().catch(() => {});
  setInterval(() => loadSyncStatus().catch(() => {}), 15000);
  const btn = document.getElementById('runBackupBtn');
  if (btn) btn.addEventListener('click', runBackupManually);
  const runSync = document.getElementById('runSyncBtn');
  if (runSync) runSync.addEventListener('click', runSyncManually);
  const recSync = document.getElementById('reconcileSyncBtn');
  if (recSync) recSync.addEventListener('click', reconcileSyncManually);
});

function fmtBytesOrCount(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const now = Math.floor(Date.now() / 1000);
  const diff = ts - now;
  const abs = Math.abs(diff);
  const pretty = new Date(ts * 1000).toLocaleString();
  if (abs < 60) return `${pretty} (${diff >= 0 ? 'in ' + abs + 's' : abs + 's ago'})`;
  if (abs < 3600) return `${pretty} (${diff >= 0 ? 'in ' : ''}${Math.round(abs / 60)}m${diff >= 0 ? '' : ' ago'})`;
  return pretty;
}

async function loadBackupStatus() {
  const res = await fetch('/api/admin/backup/status');
  const s = await res.json().catch(() => ({}));
  renderBackupStatus(s);
}

function renderBackupStatus(s) {
  if (!s) return;
  const badge = document.getElementById('backupStatusBadge');
  const statusMap = {
    ok: ['ok', 'bg-emerald-100 text-emerald-700'],
    error: ['error', 'bg-rose-100 text-rose-700'],
    disabled: ['disabled', 'bg-slate-200 text-slate-600'],
    running: ['running', 'bg-amber-100 text-amber-800'],
  };
  const state = s.running ? 'running' : (s.lastStatus || (s.enabled ? 'idle' : 'disabled'));
  const [label, cls] = statusMap[state] || [state, 'bg-slate-100 text-slate-600'];
  badge.textContent = label;
  badge.className = `text-xs px-2 py-0.5 rounded-full ${cls}`;

  const my = s.mysql || {};
  document.getElementById('backupTarget').textContent =
    `mysql://${my.user || '?'}@${my.host || '?'}:${my.port || '?'}/${my.database || '?'}`;
  document.getElementById('backupLastRun').textContent = fmtRelative(s.lastRunAt);
  document.getElementById('backupLastDur').textContent = fmtDuration(s.lastDurationMs);
  document.getElementById('backupNextRun').textContent = fmtRelative(s.nextRunAt);
  document.getElementById('backupInterval').textContent = s.intervalMs
    ? `${Math.round(s.intervalMs / 60000)} min`
    : '—';

  const rowsBox = document.getElementById('backupRowsSummary');
  if (s.lastRows && Object.keys(s.lastRows).length) {
    rowsBox.textContent = Object.entries(s.lastRows)
      .map(([k, v]) => `${k}=${fmtBytesOrCount(v)}`)
      .join('  ·  ');
  } else {
    rowsBox.textContent = '';
  }

  const errBox = document.getElementById('backupError');
  if (s.lastStatus === 'error' && s.lastError) {
    errBox.textContent = s.lastError;
    errBox.classList.remove('hidden');
  } else {
    errBox.classList.add('hidden');
    errBox.textContent = '';
  }
}

async function runBackupManually() {
  const btn = document.getElementById('runBackupBtn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Running...';
  try {
    const res = await fetch('/api/admin/backup/run', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast('error', 'Backup failed', data.error || res.statusText);
    } else {
      const rows = data.rows || (data.status && data.status.lastRows) || {};
      const total = Object.values(rows).reduce((s, v) => s + (Number(v) || 0), 0);
      toast('success', 'Backup OK', total ? `Mirrored ${total.toLocaleString()} rows` : 'Backup completed');
    }
    if (data.status) renderBackupStatus(data.status);
    else await loadBackupStatus();
  } catch (err) {
    toast('error', 'Backup failed', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------- Multi-instance sync ----------

async function loadSyncStatus() {
  try {
    const res = await fetch('/api/admin/sync/status');
    const s = await res.json().catch(() => ({}));
    renderSyncStatus(s);
  } catch { /* ignore */ }
}

function renderSyncStatus(s) {
  if (!s) return;
  const badge = document.getElementById('syncStatusBadge');
  if (!badge) return;

  const mode = s.mode || 'disabled';
  const stateMap = {
    disabled: ['disabled', 'bg-slate-200 text-slate-600'],
    running:  ['running',  'bg-amber-100 text-amber-800'],
    ok:       ['ok',       'bg-emerald-100 text-emerald-700'],
    error:    ['error',    'bg-rose-100 text-rose-700'],
    skipped:  ['idle',     'bg-slate-100 text-slate-600'],
  };
  let key = mode === 'disabled' ? 'disabled' :
            s.running ? 'running' :
            (s.lastStatus === 'error' ? 'error' :
             s.lastStatus === 'ok' ? 'ok' :
             s.lastStatus || (s.initialized ? 'idle' : 'idle'));
  const [label, cls] = stateMap[key] || [String(key), 'bg-slate-100 text-slate-600'];
  badge.textContent = label;
  badge.className = `text-xs px-2 py-0.5 rounded-full ${cls}`;

  document.getElementById('syncMode').textContent = mode;
  document.getElementById('syncNodeId').textContent = s.nodeId || '—';
  document.getElementById('syncLastRun').textContent = fmtRelative(s.lastRunAt);
  document.getElementById('syncOutbox').textContent = (s.outboxSize ?? 0).toLocaleString();

  const target = document.getElementById('syncTarget');
  if (target) {
    target.textContent = s.hubUrl
      ? `hub: ${s.hubUrl}`
      : (mode === 'hub' ? 'serving /api/sync/* for connected peers' : 'no hub configured');
  }

  const peersBox = document.getElementById('syncPeersBox');
  if (peersBox) {
    const peers = Array.isArray(s.peers) ? s.peers : [];
    if (!peers.length) {
      peersBox.textContent = mode === 'disabled' ? '' : 'no peers seen yet';
    } else {
      peersBox.textContent = peers.map((p) =>
        `${p.node_id || '?'} pull=${p.last_pull_outbox_id || 0} push=${p.last_push_outbox_id || 0}` +
        (p.last_seen_at ? ` seen=${new Date(p.last_seen_at * 1000).toLocaleTimeString()}` : '')
      ).join('  ·  ');
    }
  }

  const errBox = document.getElementById('syncError');
  if (errBox) {
    if (s.lastStatus === 'error' && s.lastError) {
      errBox.textContent = s.lastError;
      errBox.classList.remove('hidden');
    } else {
      errBox.classList.add('hidden');
      errBox.textContent = '';
    }
  }
}

async function runSyncManually() {
  const btn = document.getElementById('runSyncBtn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Running...';
  try {
    const res = await fetch('/api/admin/sync/run', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast('error', 'Sync failed', data.error || (data.result && data.result.reason) || res.statusText);
    } else {
      const r = data.result || {};
      const parts = [];
      if (r.skipped) parts.push(r.reason || 'no-op');
      if (typeof r.pulled === 'number') parts.push(`pulled ${r.pulled}`);
      if (typeof r.pushed === 'number') parts.push(`pushed ${r.pushed}`);
      toast('success', 'Sync OK', parts.length ? parts.join(' · ') : 'Cycle completed');
    }
    if (data.status) renderSyncStatus(data.status);
    else await loadSyncStatus();
  } catch (err) {
    toast('error', 'Sync failed', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function reconcileSyncManually() {
  const btn = document.getElementById('reconcileSyncBtn');
  if (!btn || btn.disabled) return;
  if (!confirm('Scan synced tables for duplicate natural keys (slug/name/key_hash) and merge them via last-write-wins? Losers will be soft-deleted and propagated to peers.')) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Reconciling...';
  try {
    const res = await fetch('/api/admin/sync/reconcile', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast('error', 'Reconcile failed', data.error || res.statusText);
    } else {
      const t = (data.summary && data.summary.totals) || {};
      const merged = Number(t.merged) || 0;
      const errors = Number(t.errors) || 0;
      const detail = Object.entries((data.summary && data.summary.tables) || {})
        .filter(([, s]) => (s.merged || s.errors))
        .map(([name, s]) => `${name}: merged=${s.merged} errors=${s.errors}`)
        .join('  ·  ');
      if (merged === 0 && errors === 0) {
        toast('success', 'Reconcile OK', 'No duplicates found.');
      } else if (errors === 0) {
        toast('success', 'Reconcile OK', `${merged} row(s) merged.${detail ? '\n' + detail : ''}`);
      } else {
        toast('warn', 'Reconcile partial', `${merged} merged, ${errors} error(s).${detail ? '\n' + detail : ''}`);
      }
    }
    if (data.status) renderSyncStatus(data.status);
    else await loadSyncStatus();
  } catch (err) {
    toast('error', 'Reconcile failed', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------- toast helper ----------

function toast(kind, title, message) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const palette = {
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    error:   'bg-rose-50 border-rose-200 text-rose-800',
    warn:    'bg-amber-50 border-amber-200 text-amber-800',
    info:    'bg-slate-50 border-slate-200 text-slate-800',
  };
  const el = document.createElement('div');
  el.className = `rounded-md border px-3 py-2 shadow-sm text-xs flex flex-col gap-0.5 ${palette[kind] || palette.info}`;
  el.style.transition = 'opacity 0.25s';
  if (title) {
    const h = document.createElement('div');
    h.className = 'font-semibold';
    h.textContent = title;
    el.appendChild(h);
  }
  if (message) {
    const m = document.createElement('div');
    m.className = 'whitespace-pre-line break-words';
    m.textContent = message;
    el.appendChild(m);
  }
  stack.appendChild(el);
  const ttl = kind === 'error' ? 8000 : 5000;
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, ttl);
}
