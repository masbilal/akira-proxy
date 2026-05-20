/**
 * Proxy management page JavaScript
 */

let proxies = [];
let settings = {};

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadProxies(), loadProxySettings(), loadFeatureFlags()]);
});

// ---------- Loading ----------

async function loadProxies() {
  try {
    const res = await fetch('/api/admin/proxies');
    const data = await res.json();
    proxies = data.data || [];
    renderProxies();
    renderStats();
  } catch (err) {
    console.error('Failed to load proxies:', err);
    showToast('Failed to load proxies', 'error');
  }
}

async function loadProxySettings() {
  try {
    const res = await fetch('/api/admin/proxy-settings');
    const data = await res.json();
    settings = data.data || {};
    document.getElementById('setting-auto_test_enabled').value = settings.auto_test_enabled || '0';
    document.getElementById('setting-auto_test_interval_min').value = settings.auto_test_interval_min || 30;
    document.getElementById('setting-health_threshold_ms').value = settings.health_threshold_ms || 5000;
    document.getElementById('setting-max_fail_count').value = settings.max_fail_count || 3;
  } catch (err) {
    console.error('Failed to load proxy settings:', err);
  }
}

// ---------- Rendering ----------

function renderStats() {
  const total = proxies.length;
  const healthy = proxies.filter(p => p.status === 'healthy').length;
  const unhealthy = proxies.filter(p => p.status === 'unhealthy').length;
  const disabled = proxies.filter(p => !p.enabled).length;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statHealthy').textContent = healthy;
  document.getElementById('statUnhealthy').textContent = unhealthy;
  document.getElementById('statDisabled').textContent = disabled;
}

function renderProxies() {
  const tbody = document.getElementById('proxyList');

  if (!proxies.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="px-4 py-12 text-center">
          <div class="text-slate-400 mb-2">No proxies configured</div>
          <button onclick="openProxyModal()" class="text-brand-600 hover:underline text-sm">Add your first proxy</button>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = proxies.map(p => `
    <tr class="hover:bg-slate-50">
      <td class="px-4 py-3">
        <div class="font-medium">${escapeHtml(p.name)}</div>
        ${p.notes ? `<div class="text-xs text-slate-500 mt-0.5">${escapeHtml(p.notes)}</div>` : ''}
      </td>
      <td class="px-4 py-3 font-mono text-xs text-slate-600">
        ${escapeHtml(p.host)}:${p.port}
        ${p.username ? `<div class="text-slate-400 mt-0.5">${escapeHtml(p.username)}:****</div>` : ''}
      </td>
      <td class="px-4 py-3">
        <span class="inline-block px-2 py-0.5 text-xs rounded-md bg-slate-100 text-slate-700 uppercase">${escapeHtml(p.protocol)}</span>
      </td>
      <td class="px-4 py-3">${renderStatus(p.status, p.enabled)}</td>
      <td class="px-4 py-3 text-slate-600">${p.last_latency_ms ? p.last_latency_ms + 'ms' : '—'}</td>
      <td class="px-4 py-3 text-xs">
        <span class="text-emerald-600">${p.success_count || 0}</span>
        <span class="text-slate-400">/</span>
        <span class="text-rose-600">${p.fail_count || 0}</span>
      </td>
      <td class="px-4 py-3 text-xs text-slate-500">${p.last_test_at ? formatDate(p.last_test_at) : 'Never'}</td>
      <td class="px-4 py-3 text-right">
        <div class="inline-flex items-center gap-1">
          <button onclick="testProxy(${p.id}, this)" title="Test" class="px-2 py-1 text-xs rounded-md border border-slate-300 hover:bg-slate-100 text-slate-700">Test</button>
          <button onclick='editProxy(${JSON.stringify(p.id)})' title="Edit" class="px-2 py-1 text-xs rounded-md border border-slate-300 hover:bg-slate-100 text-brand-600">Edit</button>
          <button onclick="toggleProxy(${p.id}, ${p.enabled ? 1 : 0})" title="${p.enabled ? 'Disable' : 'Enable'}" class="px-2 py-1 text-xs rounded-md border border-slate-300 hover:bg-slate-100 ${p.enabled ? 'text-amber-600' : 'text-emerald-600'}">${p.enabled ? 'Disable' : 'Enable'}</button>
          <button onclick="deleteProxy(${p.id})" title="Delete" class="px-2 py-1 text-xs rounded-md border border-rose-300 text-rose-600 hover:bg-rose-50">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderStatus(status, enabled) {
  if (!enabled) {
    return '<span class="inline-block px-2 py-0.5 text-xs rounded-md bg-slate-100 text-slate-500">Disabled</span>';
  }
  const map = {
    healthy: '<span class="inline-block px-2 py-0.5 text-xs rounded-md bg-emerald-100 text-emerald-700">Healthy</span>',
    unhealthy: '<span class="inline-block px-2 py-0.5 text-xs rounded-md bg-rose-100 text-rose-700">Unhealthy</span>',
    testing: '<span class="inline-block px-2 py-0.5 text-xs rounded-md bg-amber-100 text-amber-700">Testing…</span>',
    unknown: '<span class="inline-block px-2 py-0.5 text-xs rounded-md bg-slate-100 text-slate-600">Unknown</span>',
  };
  return map[status] || map.unknown;
}

// ---------- Modal: Add/Edit ----------

function openProxyModal() {
  document.getElementById('proxyModalTitle').textContent = 'Add Proxy';
  document.getElementById('proxyId').value = '';
  document.getElementById('proxyName').value = '';
  document.getElementById('proxyUrl').value = '';
  document.getElementById('proxyNotes').value = '';
  document.getElementById('proxyUrlGroup').classList.remove('hidden');
  document.getElementById('proxyEditFields').classList.add('hidden');
  document.getElementById('proxyUrl').required = true;
  showModal();
}

function editProxy(id) {
  const p = proxies.find(x => x.id === id);
  if (!p) return;
  document.getElementById('proxyModalTitle').textContent = 'Edit Proxy';
  document.getElementById('proxyId').value = p.id;
  document.getElementById('proxyName').value = p.name || '';
  document.getElementById('proxyHost').value = p.host || '';
  document.getElementById('proxyPort').value = p.port || '';
  document.getElementById('proxyUsername').value = p.username || '';
  document.getElementById('proxyPassword').value = '';
  document.getElementById('proxyProtocol').value = p.protocol || 'http';
  document.getElementById('proxyEnabled').checked = !!p.enabled;
  document.getElementById('proxyNotes').value = p.notes || '';
  document.getElementById('proxyUrlGroup').classList.add('hidden');
  document.getElementById('proxyEditFields').classList.remove('hidden');
  document.getElementById('proxyUrl').required = false;
  showModal();
}

function showModal() {
  const modal = document.getElementById('proxyModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeProxyModal() {
  const modal = document.getElementById('proxyModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function submitProxy() {
  const id = document.getElementById('proxyId').value;
  const name = document.getElementById('proxyName').value.trim();
  const notes = document.getElementById('proxyNotes').value.trim();

  if (!name) {
    showToast('Name is required', 'error');
    return;
  }

  if (id) {
    // Edit mode
    const data = {
      name,
      host: document.getElementById('proxyHost').value.trim(),
      port: parseInt(document.getElementById('proxyPort').value, 10),
      username: document.getElementById('proxyUsername').value.trim() || null,
      protocol: document.getElementById('proxyProtocol').value,
      enabled: document.getElementById('proxyEnabled').checked ? 1 : 0,
      notes: notes || null,
    };
    const password = document.getElementById('proxyPassword').value;
    if (password) data.password = password;

    try {
      const res = await fetch(`/api/admin/proxies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (result.ok) {
        closeProxyModal();
        await loadProxies();
        showToast('Proxy updated', 'success');
      } else {
        showToast(result.error || 'Failed to update', 'error');
      }
    } catch (err) {
      showToast('Failed to update: ' + err.message, 'error');
    }
  } else {
    // Add mode
    const url = document.getElementById('proxyUrl').value.trim();
    if (!url) {
      showToast('Proxy URL is required', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url, notes }),
      });
      const result = await res.json();
      if (result.ok) {
        closeProxyModal();
        await loadProxies();
        showToast('Proxy added', 'success');
      } else {
        showToast(result.error || 'Failed to add', 'error');
      }
    } catch (err) {
      showToast('Failed to add: ' + err.message, 'error');
    }
  }
}

// ---------- Actions ----------

async function testProxy(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '…';
  }
  try {
    const res = await fetch(`/api/admin/proxies/${id}/test`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast(`Test OK: ${data.latency_ms}ms${data.ip ? ` · IP: ${data.ip}` : ''}`, 'success');
    } else {
      showToast(`Test failed: ${data.error}`, 'error');
    }
    await loadProxies();
  } catch (err) {
    showToast('Test failed: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test';
    }
  }
}

async function testAllProxies() {
  showToast('Testing all proxies…', 'info');
  try {
    const res = await fetch('/api/admin/proxies/test-all', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('All proxies tested', 'success');
      await loadProxies();
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function toggleProxy(id, currentEnabled) {
  try {
    const res = await fetch(`/api/admin/proxies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: currentEnabled ? 0 : 1 }),
    });
    const data = await res.json();
    if (data.ok) {
      await loadProxies();
      showToast(`Proxy ${currentEnabled ? 'disabled' : 'enabled'}`, 'success');
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function deleteProxy(id) {
  if (!confirm('Delete this proxy? It will be removed from any provider/account using it.')) return;
  try {
    const res = await fetch(`/api/admin/proxies/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      await loadProxies();
      showToast('Proxy deleted', 'success');
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function saveProxySettings() {
  const payload = {
    auto_test_enabled: document.getElementById('setting-auto_test_enabled').value,
    auto_test_interval_min: document.getElementById('setting-auto_test_interval_min').value,
    health_threshold_ms: document.getElementById('setting-health_threshold_ms').value,
    max_fail_count: document.getElementById('setting-max_fail_count').value,
  };
  try {
    const res = await fetch('/api/admin/proxy-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Settings saved', 'success');
    } else {
      showToast(data.error || 'Failed to save', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ---------- Utils ----------

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function formatDate(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const now = Date.now() / 1000;
  const diff = now - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleString();
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const colorMap = {
    success: 'bg-emerald-500',
    error: 'bg-rose-500',
    info: 'bg-slate-700',
  };
  const toast = document.createElement('div');
  toast.className = `${colorMap[type] || colorMap.info} text-white text-sm px-4 py-2 rounded-md shadow-lg max-w-sm`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('proxyModal');
  if (e.target === modal) closeProxyModal();
  const om = document.getElementById('overridesModal');
  if (e.target === om) closeOverridesModal();
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeProxyModal();
    closeOverridesModal();
  }
});

/* ============== FEATURE FLAGS ============== */

const FEATURE_LABELS = {
  refresh_token: { label: 'Refresh Token', desc: 'OAuth refresh token requests' },
  token_import: { label: 'Token Import', desc: 'Email/profile fetch during import (Kiro home/usage scraping)' },
  api_request: { label: 'API Requests', desc: 'Actual model/API requests routed via provider' },
  warmup: { label: 'Warmup', desc: 'Background warmup pings' },
  subscription_check: { label: 'Subscription Check', desc: 'Usage / tier / billing checks' },
  health_check: { label: 'Health Check', desc: 'Proxy\'s own health check (recommended on)' },
};

let featureFlags = [];
let availableFeatures = [];

async function loadFeatureFlags() {
  try {
    const res = await fetch('/api/admin/proxy-features');
    const data = await res.json();
    featureFlags = data.flags || [];
    availableFeatures = data.available || [];
    renderFeatureFlags();
  } catch (err) {
    console.error('Failed to load feature flags:', err);
  }
}

function renderFeatureFlags() {
  const container = document.getElementById('featureFlagsList');
  if (!container) return;
  if (!featureFlags.length) {
    container.innerHTML = '<div class="text-sm text-slate-400 col-span-full">No features available.</div>';
    return;
  }
  container.innerHTML = featureFlags.map(f => {
    const meta = FEATURE_LABELS[f.feature] || { label: f.feature, desc: '' };
    return `
      <div class="flex items-start justify-between gap-3 p-3 border border-slate-200 rounded-md">
        <div class="min-w-0">
          <div class="text-sm font-medium">${escapeHtml(meta.label)}</div>
          <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(meta.desc)}</div>
          <div class="text-xs text-slate-400 mt-1 font-mono">${escapeHtml(f.feature)}</div>
        </div>
        <label class="inline-flex items-center cursor-pointer shrink-0">
          <input type="checkbox" ${f.enabled ? 'checked' : ''} onchange="toggleFeatureFlag('${f.feature}', this.checked)" class="sr-only peer" />
          <div class="relative w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
        </label>
      </div>
    `;
  }).join('');
}

async function toggleFeatureFlag(feature, enabled) {
  try {
    const res = await fetch('/api/admin/proxy-features', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, enabled: enabled ? 1 : 0 }),
    });
    const data = await res.json();
    if (data.ok) {
      featureFlags = data.flags || featureFlags;
      showToast(`${FEATURE_LABELS[feature]?.label || feature}: ${enabled ? 'enabled' : 'disabled'}`, 'success');
      renderFeatureFlags();
    } else {
      showToast(data.error || 'Failed to update', 'error');
      // Revert UI
      renderFeatureFlags();
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
    renderFeatureFlags();
  }
}

/* ============== PER-PROVIDER OVERRIDES ============== */

let providersList = [];
let currentProviderOverrides = null;

async function openProviderOverridesModal() {
  // Load providers
  try {
    const res = await fetch('/api/admin/providers');
    const data = await res.json();
    providersList = data.data || [];
  } catch (err) {
    showToast('Failed to load providers', 'error');
    return;
  }

  const select = document.getElementById('overrideProviderSelect');
  select.innerHTML = '<option value="">— Choose a provider —</option>' +
    providersList.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.type)})</option>`).join('');

  document.getElementById('overridesContent').classList.add('hidden');

  const modal = document.getElementById('overridesModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeOverridesModal() {
  const modal = document.getElementById('overridesModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function loadProviderOverrides() {
  const providerId = document.getElementById('overrideProviderSelect').value;
  const content = document.getElementById('overridesContent');
  if (!providerId) {
    content.classList.add('hidden');
    return;
  }

  try {
    const res = await fetch(`/api/admin/providers/${providerId}/proxy-features`);
    const data = await res.json();
    currentProviderOverrides = { providerId, ...data };
    renderOverridesTable();
    content.classList.remove('hidden');
  } catch (err) {
    showToast('Failed to load overrides: ' + err.message, 'error');
  }
}

function renderOverridesTable() {
  const tbody = document.getElementById('overridesTable');
  if (!tbody || !currentProviderOverrides) return;

  const { providerId, available, overrides, global } = currentProviderOverrides;
  const overrideMap = new Map(overrides.map(o => [o.feature, o]));
  const globalMap = new Map(global.map(g => [g.feature, g.enabled]));

  // Build proxy options
  const proxyOptions = '<option value="">— Auto —</option>' +
    proxies.filter(p => p.enabled).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  tbody.innerHTML = available.map(feature => {
    const meta = FEATURE_LABELS[feature] || { label: feature, desc: '' };
    const override = overrideMap.get(feature);
    const globalEnabled = globalMap.get(feature) || false;
    const overrideValue = override ? (override.enabled ? '1' : '0') : '';
    const pinnedProxy = override?.proxy_id || '';
    const effective = override ? override.enabled : globalEnabled;

    return `
      <tr>
        <td class="px-3 py-2">
          <div class="font-medium text-sm">${escapeHtml(meta.label)}</div>
          <div class="text-xs text-slate-400 font-mono">${escapeHtml(feature)}</div>
        </td>
        <td class="px-3 py-2 text-xs">
          ${globalEnabled ? '<span class="text-emerald-600">ON</span>' : '<span class="text-slate-400">OFF</span>'}
        </td>
        <td class="px-3 py-2">
          <select onchange="setProviderOverride(${providerId}, '${feature}', this.value)" class="text-xs border border-slate-300 rounded px-2 py-1">
            <option value="" ${overrideValue === '' ? 'selected' : ''}>Use Global</option>
            <option value="1" ${overrideValue === '1' ? 'selected' : ''}>Force ON</option>
            <option value="0" ${overrideValue === '0' ? 'selected' : ''}>Force OFF</option>
          </select>
        </td>
        <td class="px-3 py-2">
          <select id="pin-${feature}" onchange="setProviderOverridePin(${providerId}, '${feature}', this.value)" class="text-xs border border-slate-300 rounded px-2 py-1 max-w-[160px]" ${overrideValue === '' ? 'disabled' : ''}>
            ${proxyOptions.replace(`value="${pinnedProxy}"`, `value="${pinnedProxy}" selected`)}
          </select>
        </td>
        <td class="px-3 py-2 text-xs">
          ${effective ? '<span class="text-emerald-600 font-medium">ON</span>' : '<span class="text-slate-400 font-medium">OFF</span>'}
        </td>
      </tr>
    `;
  }).join('');
}

async function setProviderOverride(providerId, feature, value) {
  const enabled = value === '' ? null : (value === '1' ? 1 : 0);

  try {
    const res = await fetch(`/api/admin/providers/${providerId}/proxy-features`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, enabled }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Override updated', 'success');
      await loadProviderOverrides();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function setProviderOverridePin(providerId, feature, proxyId) {
  // Need to keep the existing enabled state when updating pin
  const current = currentProviderOverrides?.overrides.find(o => o.feature === feature);
  if (!current) {
    showToast('Set the override to "Force ON/OFF" first before pinning a proxy', 'info');
    return;
  }

  try {
    const res = await fetch(`/api/admin/providers/${providerId}/proxy-features`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feature,
        enabled: current.enabled ? 1 : 0,
        proxy_id: proxyId ? Number(proxyId) : null,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(proxyId ? 'Proxy pinned' : 'Pin removed', 'success');
      await loadProviderOverrides();
    } else {
      showToast(data.error || 'Failed', 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}
