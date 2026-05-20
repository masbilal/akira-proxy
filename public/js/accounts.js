'use strict';

/*
 * accounts.js — provider-aware modal controller for the /accounts page.
 *
 * The legacy single-form modal was replaced by one modal per provider type:
 *   #openaiModal       — API key per account (plain save via /api/admin/accounts).
 *   #kiroModal         — two tabs: refresh-token exchange, batch-login worker.
 *   #codexModal        — two tabs: spawn login-codex.js worker, or paste manual token.
 *   #editAccountModal  — provider-aware edit form, reused across all three types.
 *   #filterModal       — Kiro-only helper that diffs a paste list against existing rows.
 *
 * Entry points exposed on the window (called from EJS templates):
 *   openAccountModal(providerId)   — dispatches to the correct Add modal.
 *   editAccount(row)               — opens the shared edit modal pre-filled.
 *   openBatchModal()               — opens Kiro modal on the Batch tab.
 *   openKiroFilterModal() / openFilterModal() — filter-existing modal.
 *   deleteAccount, refreshAccount, resetAccount, copyRefreshToken, upgradeAccountToPro —
 *     row-level actions used by the provider-accounts.ejs table.
 */

// ---------- providers cache (filled on DOM ready) ----------

const providersById = new Map();
const providersByType = new Map();

function cacheProviderOptions() {
  const all = [];
  // Preferred source: EJS emits window.__PROVIDERS__ with every provider row,
  // so we know the type of every id regardless of how many OpenAI/Kiro/Codex
  // providers exist on the page.
  if (Array.isArray(window.__PROVIDERS__)) {
    for (const p of window.__PROVIDERS__) {
      if (!p || !p.id || !p.type) continue;
      all.push({ id: Number(p.id), type: String(p.type), name: p.name || String(p.type) });
    }
  }

  // Legacy fallbacks in case the template script tag is missing.
  const openaiSelect = document.querySelector('#openaiForm select[name="provider_id"]');
  if (openaiSelect) {
    for (const opt of openaiSelect.options) {
      if (!opt.value) continue;
      all.push({ id: Number(opt.value), type: 'openai', name: opt.dataset.providerName || opt.textContent });
    }
  }
  const kiroInput = document.querySelector('#kiroRefreshForm input[name="provider_id"]');
  if (kiroInput && kiroInput.value) {
    all.push({ id: Number(kiroInput.value), type: 'kiro', name: 'Kiro' });
  }
  const codexInput = document.querySelector('#codexLoginForm input[name="provider_id"]');
  if (codexInput && codexInput.value) {
    all.push({ id: Number(codexInput.value), type: 'codex', name: 'Codex' });
  }

  for (const p of all) {
    if (!providersById.has(p.id)) providersById.set(p.id, p);
    if (!providersByType.has(p.type)) providersByType.set(p.type, p);
  }
}

function providerTypeFor(providerId) {
  const hit = providersById.get(Number(providerId));
  return hit ? hit.type : null;
}

// ---------- shared helpers ----------

function show(el) { if (el) { el.classList.remove('hidden'); el.classList.add('flex'); } }
function hide(el) { if (el) { el.classList.add('hidden'); el.classList.remove('flex'); } }
function setError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}
function setInfo(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function writeToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

// ---------- OpenAI modal ----------

function openOpenAiModal(providerId) {
  const form = document.getElementById('openaiForm');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  if (providerId) form.elements.provider_id.value = String(providerId);
  setError('openaiFormError', '');
  show(document.getElementById('openaiModal'));
}

function closeOpenAiModal() {
  hide(document.getElementById('openaiModal'));
}

async function submitOpenAi(e) {
  e.preventDefault();
  const form = document.getElementById('openaiForm');
  const fd = new FormData(form);
  const configRaw = fd.get('config_json') || '{}';
  try { JSON.parse(configRaw); } catch (err) {
    setError('openaiFormError', 'Config JSON is invalid: ' + err.message);
    return;
  }
  const payload = {
    provider_id: Number(fd.get('provider_id')),
    label: fd.get('label') || null,
    email: fd.get('email') || null,
    api_key: fd.get('api_key') || null,
    config_json: configRaw,
    enabled: fd.get('enabled') === 'on',
  };
  const res = await fetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setError('openaiFormError', err.error || res.statusText);
    return;
  }
  location.reload();
}

// ---------- Kiro modal (tabs: refresh / batch-refresh / batch) ----------

function selectKiroTab(tab) {
  document.querySelectorAll('#kiroModal [data-kiro-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.kiroTab === tab);
  });
  document.querySelectorAll('#kiroModal [data-kiro-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.kiroPanel !== tab);
  });
}

function openKiroModal(providerId, tab = 'refresh') {
  const refreshForm = document.getElementById('kiroRefreshForm');
  const batchRefreshForm = document.getElementById('kiroBatchRefreshForm');
  const batchForm = document.getElementById('batchForm');
  if (refreshForm) {
    refreshForm.reset();
    refreshForm.elements.id.value = '';
    if (providerId) refreshForm.elements.provider_id.value = String(providerId);
    refreshForm.elements.probe_usage.checked = true;
  }
  if (batchRefreshForm) {
    batchRefreshForm.reset();
    if (providerId) batchRefreshForm.elements.provider_id.value = String(providerId);
    batchRefreshForm.elements.probe_usage.checked = true;
  }
  if (batchForm) {
    batchForm.reset();
    batchForm.elements.headless.checked = true;
    if (batchForm.elements.incognito) batchForm.elements.incognito.checked = true;
  }
  setError('kiroRefreshFormError', '');
  setInfo('kiroRefreshFormInfo', '');
  setError('kiroBatchRefreshFormError', '');
  setInfo('kiroBatchRefreshFormInfo', '');
  setError('batchFormError', '');
  selectKiroTab(tab);
  show(document.getElementById('kiroModal'));
}

function closeKiroModal() {
  hide(document.getElementById('kiroModal'));
}

// "Open the batch-login tab" — kept as a separate entry point because the
// Filter modal uses it to land on the right tab after handing off a paste.
function openBatchModal() {
  openKiroModal(null, 'batch');
}

// "Open the batch-refresh-tokens tab"
function openBatchRefreshModal() {
  openKiroModal(null, 'batch-refresh');
}

async function submitKiroRefresh(e) {
  e.preventDefault();
  const form = document.getElementById('kiroRefreshForm');
  const fd = new FormData(form);
  const providerId = Number(fd.get('provider_id') || 0);
  const refreshToken = String(fd.get('refresh_token') || '').trim();
  if (!providerId) {
    setError('kiroRefreshFormError', 'Tidak ada provider Kiro terdeteksi — buat dulu di halaman Providers.');
    return;
  }
  if (!refreshToken) {
    setError('kiroRefreshFormError', 'Refresh token wajib diisi.');
    return;
  }
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Exchanging...'; }
  setError('kiroRefreshFormError', '');
  setInfo('kiroRefreshFormInfo', '');
  try {
    const res = await fetch('/api/admin/accounts/kiro/by-refresh-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        refresh_token: refreshToken,
        label: fd.get('label') || null,
        email: fd.get('email') || null,
        probe_usage: fd.get('probe_usage') === 'on',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setError('kiroRefreshFormError', data.error || res.statusText);
      return;
    }
    setInfo('kiroRefreshFormInfo', `Saved account #${data.account_id}. Reloading…`);
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    setError('kiroRefreshFormError', err.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
  }
}

async function submitKiroBatch(e) {
  e.preventDefault();
  const form = document.getElementById('batchForm');
  const fd = new FormData(form);
  const res = await fetch('/api/admin/accounts/kiro/batch-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accounts: fd.get('accounts'),
      headless: fd.get('headless') === 'on',
      incognito: fd.get('incognito') === 'on',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setError('batchFormError', data.error || res.statusText);
    return;
  }
  window.location.href = `/workers?job=${encodeURIComponent(data.jobId)}`;
}

async function submitKiroBatchRefresh(e) {
  e.preventDefault();
  const form = document.getElementById('kiroBatchRefreshForm');
  const fd = new FormData(form);
  const providerId = Number(fd.get('provider_id') || 0);
  const tokens = String(fd.get('tokens') || '').trim();
  
  if (!providerId) {
    setError('kiroBatchRefreshFormError', 'Tidak ada provider Kiro terdeteksi — buat dulu di halaman Providers.');
    return;
  }
  if (!tokens) {
    setError('kiroBatchRefreshFormError', 'Tokens wajib diisi.');
    return;
  }
  
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Importing...'; }
  setError('kiroBatchRefreshFormError', '');
  setInfo('kiroBatchRefreshFormInfo', '');
  
  try {
    const res = await fetch('/api/admin/accounts/kiro/batch-refresh-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        tokens,
        probe_usage: fd.get('probe_usage') === 'on',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setError('kiroBatchRefreshFormError', data.error || res.statusText);
      return;
    }
    
    // Show summary
    const summary = data.summary || {};
    const summaryText = `Import selesai: ${summary.success}/${summary.total} berhasil` +
      (summary.failed ? `, ${summary.failed} gagal` : '') +
      (summary.pro ? `, ${summary.pro} Pro` : '') +
      (summary.power ? `, ${summary.power} Power` : '') +
      (summary.enterprise ? `, ${summary.enterprise} Enterprise` : '');
    setInfo('kiroBatchRefreshFormInfo', summaryText);
    
    // Show details if there are failures
    if (summary.failed > 0 && data.results) {
      const failedItems = data.results.filter(r => !r.ok);
      console.log('Failed imports:', failedItems);
    }
    
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    setError('kiroBatchRefreshFormError', err.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
  }
}

// ---------- Codex modal (tabs: browser / manual) ----------

function selectCodexTab(tab) {
  document.querySelectorAll('#codexModal [data-codex-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.codexTab === tab);
  });
  document.querySelectorAll('#codexModal [data-codex-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.codexPanel !== tab);
  });
}

function openCodexModal(providerId, tab = 'browser') {
  const login = document.getElementById('codexLoginForm');
  const manual = document.getElementById('codexManualForm');
  if (login) {
    login.reset();
    if (providerId) login.elements.provider_id.value = String(providerId);
    login.elements.port.value = '1455';
    login.elements.force.checked = false;
  }
  if (manual) {
    manual.reset();
    manual.elements.id.value = '';
    if (providerId) manual.elements.provider_id.value = String(providerId);
    manual.elements.enabled.checked = true;
  }
  setError('codexLoginFormError', '');
  setInfo('codexLoginFormInfo', '');
  setError('codexManualFormError', '');
  selectCodexTab(tab);
  show(document.getElementById('codexModal'));
}

function closeCodexModal() {
  hide(document.getElementById('codexModal'));
}

async function submitCodexLogin(e) {
  e.preventDefault();
  const form = document.getElementById('codexLoginForm');
  const fd = new FormData(form);
  const providerId = Number(fd.get('provider_id') || 0);
  if (!providerId) {
    setError('codexLoginFormError', 'Tidak ada provider Codex terdeteksi — buat dulu di halaman Providers.');
    return;
  }
  const port = Number(fd.get('port') || 1455);
  if (!(port > 0 && port < 65536)) {
    setError('codexLoginFormError', 'Port harus antara 1 dan 65535.');
    return;
  }
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Starting...'; }
  setError('codexLoginFormError', '');
  setInfo('codexLoginFormInfo', '');
  try {
    const res = await fetch('/api/admin/accounts/codex/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider_id: providerId,
        port,
        force: fd.get('force') === 'on',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setError('codexLoginFormError', data.error || res.statusText);
      return;
    }
    setInfo('codexLoginFormInfo', 'Worker started. Redirecting to Workers…');
    setTimeout(() => { window.location.href = `/workers?job=${encodeURIComponent(data.jobId)}`; }, 500);
  } catch (err) {
    setError('codexLoginFormError', err.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
  }
}

async function submitCodexManual(e) {
  e.preventDefault();
  const form = document.getElementById('codexManualForm');
  const fd = new FormData(form);
  const providerId = Number(fd.get('provider_id') || 0);
  const email = String(fd.get('email') || '').trim();
  const accessToken = String(fd.get('access_token') || '').trim();
  if (!providerId) {
    setError('codexManualFormError', 'Tidak ada provider Codex terdeteksi.');
    return;
  }
  if (!email) {
    setError('codexManualFormError', 'Email wajib diisi.');
    return;
  }
  if (!accessToken) {
    setError('codexManualFormError', 'Access token wajib diisi.');
    return;
  }
  const payload = {
    provider_id: providerId,
    label: email,
    email,
    access_token: accessToken,
    refresh_token: fd.get('refresh_token') || null,
    config_json: '{}',
    enabled: fd.get('enabled') === 'on',
  };
  const res = await fetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setError('codexManualFormError', err.error || res.statusText);
    return;
  }
  location.reload();
}

// ---------- Edit account (shared across providers) ----------

const EDIT_PRESETS = {
  openai: {
    heading: 'Edit OpenAI account',
    lead: 'Update API key, label, atau config JSON. Biarkan kosong untuk token yang tidak berubah.',
    badge: 'OPENAI',
  },
  kiro: {
    heading: 'Edit Kiro account',
    lead: 'Perbarui token OAuth atau config JSON. Biarkan kosong kalau tidak berubah.',
    badge: 'KIRO',
  },
  codex: {
    heading: 'Edit Codex account',
    lead: 'Perbarui token ChatGPT atau config JSON. Biarkan kosong kalau tidak berubah.',
    badge: 'CODEX',
  },
};

function editAccount(row) {
  const form = document.getElementById('editAccountForm');
  if (!form) return;
  form.reset();
  const type = row.provider_type || providerTypeFor(row.provider_id) || 'openai';
  const preset = EDIT_PRESETS[type] || EDIT_PRESETS.openai;
  document.getElementById('editAccountHeading').textContent = preset.heading;
  document.getElementById('editAccountLead').textContent = preset.lead;
  document.getElementById('editAccountTypePill').textContent = preset.badge;
  const shell = document.querySelector('#editAccountModal .account-provider-modal');
  if (shell) shell.dataset.providerType = type;

  // Show/hide token vs api_key sections based on provider type.
  document.querySelectorAll('#editAccountModal [data-edit-section]').forEach((section) => {
    const supported = String(section.dataset.editSection || '').split(/\s+/).filter(Boolean);
    const active = supported.includes(type);
    section.classList.toggle('hidden', !active);
    section.querySelectorAll('input, textarea').forEach((field) => {
      if (!active) field.value = '';
    });
  });

  form.elements.id.value = row.id;
  form.elements.provider_id.value = row.provider_id;
  form.elements.provider_type.value = type;
  form.elements.label.value = row.label || '';
  form.elements.email.value = row.email || '';
  form.elements.config_json.value = row.config_json || '{}';
  form.elements.enabled.checked = !!row.enabled;
  setError('editAccountFormError', '');
  show(document.getElementById('editAccountModal'));
}

function closeEditAccountModal() {
  hide(document.getElementById('editAccountModal'));
}

async function submitEditAccount(e) {
  e.preventDefault();
  const form = document.getElementById('editAccountForm');
  const fd = new FormData(form);
  const id = fd.get('id');
  const type = fd.get('provider_type') || 'openai';
  const configRaw = fd.get('config_json') || '{}';
  try { JSON.parse(configRaw); } catch (err) {
    setError('editAccountFormError', 'Config JSON is invalid: ' + err.message);
    return;
  }
  const payload = {
    provider_id: Number(fd.get('provider_id')),
    label: fd.get('label') || null,
    email: fd.get('email') || null,
    config_json: configRaw,
    enabled: fd.get('enabled') === 'on',
  };
  if (type === 'openai') {
    const v = fd.get('api_key');
    if (v) payload.api_key = v;
  } else {
    const at = fd.get('access_token');
    const rt = fd.get('refresh_token');
    if (at) payload.access_token = at;
    if (rt) payload.refresh_token = rt;
  }
  const res = await fetch(`/api/admin/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setError('editAccountFormError', err.error || res.statusText);
    return;
  }
  location.reload();
}

// ---------- Dispatcher used by the EJS templates ----------

function openAccountModal(providerId) {
  const type = providerTypeFor(providerId);
  if (type === 'kiro') return openKiroModal(providerId, 'refresh');
  if (type === 'codex') return openCodexModal(providerId, 'browser');
  return openOpenAiModal(providerId);
}

// Row-level actions (unchanged from the legacy implementation) --------

async function deleteAccount(id) {
  if (!confirm('Delete this account?')) return;
  const res = await fetch(`/api/admin/accounts/${id}`, { method: 'DELETE' });
  if (res.ok) location.reload();
  else alert('Failed to delete');
}

async function refreshAccount(id) {
  const res = await fetch(`/api/admin/accounts/${id}/refresh-subscription`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert('Failed: ' + (data.error || res.statusText));
  location.reload();
}

async function copyRefreshToken(id, btn) {
  const originalLabel = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/accounts/${id}/refresh-token`, {
      headers: { accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.refresh_token) {
      alert('Failed to fetch refresh token: ' + (data.error || res.statusText));
      return;
    }
    await writeToClipboard(data.refresh_token);
    if (btn) {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = originalLabel; btn.disabled = false; }, 1200);
    }
  } catch (err) {
    alert('Failed to copy refresh token: ' + err.message);
    if (btn) btn.disabled = false;
  } finally {
    if (btn) {
      const menu = btn.closest('.account-menu');
      if (menu) menu.classList.remove('open');
    }
  }
}

async function openKiroSession(id, btn) {
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Opening...';
  }
  try {
    const res = await fetch(`/api/admin/accounts/${id}/open-kiro-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      alert('Failed to open Kiro session: ' + (data.error || res.statusText));
      return;
    }
    
    // Open the Kiro session helper page that will set cookies and redirect
    const sessionUrl = `/kiro-session?token=${encodeURIComponent(data.access_token)}&email=${encodeURIComponent(data.email || '')}`;
    const win = window.open(sessionUrl, '_blank');
    if (!win) {
      alert('Popup blocked. Please allow popups for this site to open Kiro session.');
    } else {
      if (btn) {
        btn.textContent = 'Opened!';
        setTimeout(() => { btn.textContent = originalLabel; btn.disabled = false; }, 2000);
      }
    }
  } catch (err) {
    alert('Failed to open Kiro session: ' + err.message);
  } finally {
    if (btn) {
      btn.textContent = originalLabel;
      btn.disabled = false;
      const menu = btn.closest('.account-menu');
      if (menu) menu.classList.remove('open');
    }
  }
}

async function upgradeAccountToPro(id, btn) {
  if (!confirm('Get a Stripe checkout URL to upgrade this account to Pro?')) return;
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="account-upgrade-spinner" aria-hidden="true"></span><span class="account-upgrade-label">Opening checkout…</span>';
  }
  try {
    // Server tries the HTTP-only fast path first (reads stored access_token,
    // no browser, no password). If that fails it falls back to spawning the
    // Playwright worker — which needs a password for the fresh Google login.
    // We only prompt for the password AFTER the fast path fails.
    let res = await fetch(`/api/admin/accounts/${id}/upgrade-to-pro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headless: true }),
    });
    let data = await res.json().catch(() => ({}));
    if ((!res.ok || !data.ok || !data.checkoutUrl) && /token|refresh|signin|profile_arn/i.test(String(data.error || ''))) {
      // Fast path rejected the token — ask for the Google password and retry
      // with the browser worker explicitly so the user can re-login.
      const password = prompt(
        'The stored Kiro token is no longer valid.\n\n' +
        'Enter the Google password for this account so the browser worker can re-login.\n' +
        'Leave blank to cancel.'
      );
      if (!password) {
        alert('Upgrade cancelled. The stored token needs a browser re-login to continue.');
        return;
      }
      res = await fetch(`/api/admin/accounts/${id}/upgrade-to-pro`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, headless: true, forceBrowser: true }),
      });
      data = await res.json().catch(() => ({}));
    }
    if (!res.ok || !data.ok || !data.checkoutUrl) {
      const detail = data.error || res.statusText;
      const hint = data.stderr ? '\n\n' + data.stderr.split('\n').slice(-6).join('\n') : '';
      alert('Failed to get Stripe checkout URL: ' + detail + hint);
      return;
    }
    // Open the Stripe checkout in a single new tab. We use an anchor-click
    // instead of `window.open(..., 'noopener')` because the latter returns
    // `null` on some browsers even when the tab opens successfully, which
    // would trigger a fallback and open the checkout twice.
    const a = document.createElement('a');
    a.href = data.checkoutUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    alert('Failed: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function resetAccount(id) {
  const res = await fetch(`/api/admin/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exhausted_at: null, enabled: true, clear_error: true }),
  });
  if (res.ok) location.reload();
  else alert('Failed to reset');
}

// ---------- Filter-existing modal (Kiro) ----------

const filterModal = () => document.getElementById('filterModal');
const filterForm = () => document.getElementById('filterForm');
const filterErr = () => document.getElementById('filterFormError');
const filterResults = () => document.getElementById('filterResults');

function openFilterModal() {
  if (filterForm()) filterForm().reset();
  if (filterErr()) filterErr().classList.add('hidden');
  clearFilterResults();
  show(filterModal());
}
// Back-compat alias used by the new Kiro modal header.
function openKiroFilterModal() { openFilterModal(); }

function closeFilterModal() { hide(filterModal()); }

function clearFilterResults() {
  const box = filterResults();
  if (!box) return;
  box.classList.add('hidden');
  ['filterTotal', 'filterExistingCount', 'filterMissingCount', 'filterInvalidCount'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '0';
  });
  const missingText = document.getElementById('filterMissingText');
  if (missingText) missingText.value = '';
  const existingList = document.getElementById('filterExistingList');
  if (existingList) existingList.innerHTML = '';
  const dupBlock = document.getElementById('filterDuplicateBlock');
  if (dupBlock) dupBlock.classList.add('hidden');
  const dupList = document.getElementById('filterDuplicateList');
  if (dupList) dupList.innerHTML = '';
  const invBlock = document.getElementById('filterInvalidBlock');
  if (invBlock) invBlock.classList.add('hidden');
  const invList = document.getElementById('filterInvalidList');
  if (invList) invList.innerHTML = '';
}

async function copyFilterMissing() {
  const text = document.getElementById('filterMissingText').value || '';
  if (!text.trim()) return alert('Nothing to copy.');
  const ok = await writeToClipboard(text);
  if (!ok) alert('Copy failed; please select and copy manually.');
}

async function copyFilterExisting() {
  const rows = document.querySelectorAll('#filterExistingList [data-raw]');
  const text = Array.from(rows).map((r) => r.getAttribute('data-raw')).join('\n');
  if (!text.trim()) return alert('Nothing to copy.');
  const ok = await writeToClipboard(text);
  if (!ok) alert('Copy failed; please select and copy manually.');
}

function sendMissingToBatch() {
  const text = document.getElementById('filterMissingText').value || '';
  if (!text.trim()) return alert('No missing accounts to send.');
  closeFilterModal();
  openBatchModal();
  const ta = document.getElementById('batchForm') && document.getElementById('batchForm').elements.accounts;
  if (ta) ta.value = text;
}

function renderFilterResults(data) {
  document.getElementById('filterTotal').textContent = data.total || 0;
  document.getElementById('filterExistingCount').textContent = data.existing_count || 0;
  document.getElementById('filterMissingCount').textContent = data.missing_count || 0;
  document.getElementById('filterInvalidCount').textContent = data.invalid_count || 0;

  document.getElementById('filterMissingText').value = data.missing_text || '';

  const existList = document.getElementById('filterExistingList');
  existList.innerHTML = '';
  (data.existing || []).forEach((item) => {
    const row = document.createElement('div');
    row.setAttribute('data-raw', item.raw || `${item.email}:${item.password || ''}`);
    row.className = 'flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-slate-50';
    const statusBits = [];
    if (!item.enabled) statusBits.push('<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">disabled</span>');
    if (item.exhausted_at) statusBits.push('<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">exhausted</span>');
    if (item.has_error) statusBits.push('<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">error</span>');
    row.innerHTML = `
      <span class="truncate">${escapeHtml(item.email)}</span>
      <span class="flex items-center gap-2 flex-shrink-0">
        ${statusBits.join(' ')}
        <span class="text-[11px] text-slate-500">#${escapeHtml(String(item.account_id))}</span>
      </span>
    `;
    existList.appendChild(row);
  });

  const dupBlock = document.getElementById('filterDuplicateBlock');
  const dupList = document.getElementById('filterDuplicateList');
  if (data.duplicates && data.duplicates.length) {
    dupList.innerHTML = data.duplicates.map((d) => escapeHtml(d.email)).join('<br>');
    dupBlock.classList.remove('hidden');
  } else {
    dupBlock.classList.add('hidden');
  }

  const invBlock = document.getElementById('filterInvalidBlock');
  const invList = document.getElementById('filterInvalidList');
  if (data.invalid && data.invalid.length) {
    invList.innerHTML = data.invalid.map((line) => escapeHtml(line)).join('<br>');
    invBlock.classList.remove('hidden');
  } else {
    invBlock.classList.add('hidden');
  }

  filterResults().classList.remove('hidden');
}

// ---------- Menus & search in provider-accounts.ejs ----------

function setupAccountMenus() {
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('.account-menu-btn');
    const openMenus = document.querySelectorAll('.account-menu.open');

    if (btn) {
      const menu = btn.closest('.account-menu');
      const wasOpen = menu.classList.contains('open');
      openMenus.forEach((m) => {
        m.classList.remove('open');
        const b = m.querySelector('.account-menu-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
      return;
    }

    if (!event.target.closest('.account-menu-list')) {
      openMenus.forEach((m) => {
        m.classList.remove('open');
        const b = m.querySelector('.account-menu-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.account-menu.open').forEach((m) => {
      m.classList.remove('open');
      const b = m.querySelector('.account-menu-btn');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  });
}

function setupAccountSearch() {
  const searchForm = document.querySelector('.account-filter-search');
  if (!searchForm) return;
  const input = searchForm.querySelector('input[name="q"]');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => searchForm.submit(), 380);
  });
}

// ---------- DOM wiring ----------

document.addEventListener('DOMContentLoaded', () => {
  cacheProviderOptions();
  setupAccountMenus();
  setupAccountSearch();

  const openaiForm = document.getElementById('openaiForm');
  if (openaiForm) openaiForm.addEventListener('submit', submitOpenAi);

  const kiroRefreshForm = document.getElementById('kiroRefreshForm');
  if (kiroRefreshForm) kiroRefreshForm.addEventListener('submit', submitKiroRefresh);
  const kiroBatchRefreshForm = document.getElementById('kiroBatchRefreshForm');
  if (kiroBatchRefreshForm) kiroBatchRefreshForm.addEventListener('submit', submitKiroBatchRefresh);
  const batchForm = document.getElementById('batchForm');
  if (batchForm) batchForm.addEventListener('submit', submitKiroBatch);

  const codexLoginForm = document.getElementById('codexLoginForm');
  if (codexLoginForm) codexLoginForm.addEventListener('submit', submitCodexLogin);
  const codexManualForm = document.getElementById('codexManualForm');
  if (codexManualForm) codexManualForm.addEventListener('submit', submitCodexManual);

  const editForm = document.getElementById('editAccountForm');
  if (editForm) editForm.addEventListener('submit', submitEditAccount);

  // Tab clicks inside the Kiro/Codex modals.
  document.querySelectorAll('#kiroModal [data-kiro-tab]').forEach((btn) => {
    btn.addEventListener('click', () => selectKiroTab(btn.dataset.kiroTab));
  });
  document.querySelectorAll('#codexModal [data-codex-tab]').forEach((btn) => {
    btn.addEventListener('click', () => selectCodexTab(btn.dataset.codexTab));
  });

  if (filterForm()) {
    filterForm().addEventListener('submit', async (e) => {
      e.preventDefault();
      filterErr().classList.add('hidden');
      const fd = new FormData(filterForm());
      const accounts = String(fd.get('accounts') || '').trim();
      if (!accounts) {
        filterErr().textContent = 'Paste at least one email:password line.';
        filterErr().classList.remove('hidden');
        return;
      }
      const submitBtn = filterForm().querySelector('button[type="submit"]');
      const prev = submitBtn ? submitBtn.textContent : '';
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Checking...'; }
      try {
        const res = await fetch('/api/admin/accounts/kiro/filter-existing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accounts }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          filterErr().textContent = data.error || res.statusText;
          filterErr().classList.remove('hidden');
          return;
        }
        renderFilterResults(data);
      } catch (err) {
        filterErr().textContent = err.message;
        filterErr().classList.remove('hidden');
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prev; }
      }
    });
  }
});

// Expose the functions that EJS inline handlers call.
window.openAccountModal = openAccountModal;
window.openOpenAiModal = openOpenAiModal;
window.closeOpenAiModal = closeOpenAiModal;
window.openKiroModal = openKiroModal;
window.closeKiroModal = closeKiroModal;
window.openBatchModal = openBatchModal;
window.openCodexModal = openCodexModal;
window.closeCodexModal = closeCodexModal;
window.editAccount = editAccount;
window.closeEditAccountModal = closeEditAccountModal;
window.deleteAccount = deleteAccount;
window.refreshAccount = refreshAccount;
window.copyRefreshToken = copyRefreshToken;
window.openKiroSession = openKiroSession;
window.upgradeAccountToPro = upgradeAccountToPro;
window.resetAccount = resetAccount;
window.openFilterModal = openFilterModal;
window.openKiroFilterModal = openKiroFilterModal;
window.closeFilterModal = closeFilterModal;
window.clearFilterResults = clearFilterResults;
window.copyFilterMissing = copyFilterMissing;
window.copyFilterExisting = copyFilterExisting;
window.sendMissingToBatch = sendMissingToBatch;
