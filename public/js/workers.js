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
  const btn = document.getElementById('runBackupBtn');
  if (btn) btn.addEventListener('click', runBackupManually);
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
      alert('Backup failed: ' + (data.error || res.statusText));
    }
    if (data.status) renderBackupStatus(data.status);
    else await loadBackupStatus();
  } catch (err) {
    alert('Backup failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}
