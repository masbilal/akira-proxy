'use strict';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestamp(unixSeconds) {
  if (!unixSeconds) return '-';
  return new Date(unixSeconds * 1000).toLocaleString();
}

function rowStatusClass(row) {
  return Number(row.status_code || 0) >= 400 ? 'text-rose-600' : 'text-emerald-600';
}

function encodeRow(row) {
  return escapeHtml(JSON.stringify(row));
}

function renderLogRow(row) {
  return `
    <tr class="border-t border-slate-100 cursor-pointer log-row" data-log="${encodeRow(row)}">
      <td class="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">${escapeHtml(formatTimestamp(row.created_at))}</td>
      <td class="px-3 py-2 text-xs">${escapeHtml(row.provider_name || '-')}</td>
      <td class="px-3 py-2 text-xs font-mono">${escapeHtml(row.model_name || '-')}</td>
      <td class="px-3 py-2 text-xs ${rowStatusClass(row)}">${escapeHtml(row.status_code || '-')}</td>
      <td class="px-3 py-2 text-xs text-slate-500">${escapeHtml(row.prompt_tokens || 0)}</td>
      <td class="px-3 py-2 text-xs text-slate-500">${escapeHtml(row.completion_tokens || 0)}</td>
      <td class="px-3 py-2 text-xs text-slate-500">${escapeHtml(row.total_tokens || 0)}</td>
      <td class="px-3 py-2 text-xs text-slate-500">${escapeHtml(`${row.duration_ms || 0}ms`)}</td>
      <td class="px-3 py-2 text-xs text-rose-500 max-w-xs truncate">${escapeHtml(row.error || '')}</td>
    </tr>
  `;
}

function renderEmptyState() {
  return '<tr><td colspan="9" class="px-4 py-10 text-center text-sm text-slate-400">No requests logged.</td></tr>';
}

function renderPager(page, pages) {
  const parts = [];
  if (page > 1) {
    parts.push(`<a id="logsPrevLink" class="border border-slate-300 rounded-md px-3 py-2" href="/logs?page=${page - 1}">Previous</a>`);
  }
  if (page < pages) {
    parts.push(`<a id="logsNextLink" class="border border-slate-300 rounded-md px-3 py-2" href="/logs?page=${page + 1}">Next</a>`);
  }
  return parts.join('');
}

function openLogModal(row) {
  document.getElementById('logModalSubtitle').textContent = `${row.endpoint || '-'} · ${row.model_name || '-'}`;
  document.getElementById('detailTokenIn').textContent = row.prompt_tokens || 0;
  document.getElementById('detailTokenOut').textContent = row.completion_tokens || 0;
  document.getElementById('detailTokenTotal').textContent = row.total_tokens || 0;

  const fields = [
    ['ID', row.id],
    ['Time', row.created_at ? new Date(row.created_at * 1000).toLocaleString() : '-'],
    ['API Key', row.api_key_name || '-'],
    ['Provider', row.provider_name || '-'],
    ['Account', row.account_label || row.account_email || '-'],
    ['Model', row.model_name || '-'],
    ['Endpoint', row.endpoint || '-'],
    ['Status', row.status_code || '-'],
    ['Stream', row.stream ? 'yes' : 'no'],
    ['Duration', `${row.duration_ms || 0}ms`],
    ['Error', row.error || '-'],
  ];
  document.getElementById('logDetailGrid').innerHTML = fields.map(([label, value]) => `
    <div class="mini-account-row">
      <div class="text-xs text-slate-500">${label}</div>
      <div class="font-mono text-xs break-all">${escapeHtml(String(value))}</div>
    </div>
  `).join('');
  document.getElementById('logDetailJson').textContent = JSON.stringify(row, null, 2);
  document.getElementById('logModal').classList.remove('hidden');
  document.getElementById('logModal').classList.add('flex');
}

function closeLogModal() {
  document.getElementById('logModal').classList.add('hidden');
  document.getElementById('logModal').classList.remove('flex');
}

async function fetchLogsPage(state) {
  const params = new URLSearchParams({
    page: String(state.page),
    perPage: String(state.perPage),
  });
  const res = await fetch(`/api/admin/logs?${params.toString()}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText || 'Failed to fetch logs');
  }
  return res.json();
}

function applyLogsPayload(payload, state) {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const stats = payload.stats || {};
  const pageStats = payload.pageStats || {};
  const page = Number(payload.page || state.page) || 1;
  const pages = Number(payload.pages || 1) || 1;
  const total = Number(payload.total || 0) || 0;

  state.page = page;
  state.pages = pages;
  state.latestId = Number(payload.latestId || 0) || 0;

  document.getElementById('logsPageBadge').textContent = `Page ${page} of ${pages}`;
  document.getElementById('logsPaginationLabel').textContent = `Page ${page} of ${pages}`;
  document.getElementById('logsStatsRequests').textContent = stats.requests || 0;
  document.getElementById('logsStatsIn').textContent = stats.prompt_tokens || 0;
  document.getElementById('logsStatsOut').textContent = stats.completion_tokens || 0;
  document.getElementById('logsStatsTotal').textContent = stats.total_tokens || 0;
  document.getElementById('logsStatsErrors').textContent = stats.errors || 0;
  document.getElementById('logsStatsLatency').textContent = `${Math.round(stats.avg_duration_ms || 0)}ms`;
  document.getElementById('logsShowingSummary').textContent = `Showing ${rows.length} of ${total} requests`;
  document.getElementById('logsPageTokens').textContent = `Page tokens: ${pageStats.prompt_tokens || 0} in / ${pageStats.completion_tokens || 0} out / ${pageStats.total_tokens || 0} total`;
  document.getElementById('logsTableBody').innerHTML = rows.length ? rows.map(renderLogRow).join('') : renderEmptyState();
  document.getElementById('logsPagerLinks').innerHTML = renderPager(page, pages);
}

document.addEventListener('DOMContentLoaded', () => {
  const pageEl = document.getElementById('logsPage');
  if (!pageEl) return;

  const state = {
    page: Number(pageEl.dataset.page || 1) || 1,
    pages: Number(pageEl.dataset.pages || 1) || 1,
    perPage: Number(pageEl.dataset.perPage || 25) || 25,
    latestId: Number(pageEl.dataset.latestId || 0) || 0,
    polling: false,
  };

  document.getElementById('logsTableBody').addEventListener('click', (event) => {
    const row = event.target.closest('.log-row');
    if (!row) return;
    try {
      openLogModal(JSON.parse(row.dataset.log));
    } catch (err) {
      alert('Failed to open log detail: ' + err.message);
    }
  });

  const liveStatus = document.getElementById('logsLiveStatus');
  const poll = async () => {
    if (state.polling) return;
    state.polling = true;
    try {
      const payload = await fetchLogsPage(state);
      applyLogsPayload(payload, state);
      liveStatus.textContent = `Live refresh on · ${new Date().toLocaleTimeString()}`;
      liveStatus.className = 'block text-xs text-emerald-600 mt-1';
    } catch (err) {
      liveStatus.textContent = `Live refresh paused · ${err.message}`;
      liveStatus.className = 'block text-xs text-amber-600 mt-1';
    } finally {
      state.polling = false;
    }
  };

  poll();
  window.setInterval(poll, 5000);
  window.closeLogModal = closeLogModal;
});
