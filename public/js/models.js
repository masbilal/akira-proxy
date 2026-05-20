const modal = () => document.getElementById('modelModal');
const form = () => document.getElementById('modelForm');
const errBox = () => document.getElementById('modelFormError');

function openModelModal() {
  form().reset();
  form().elements.id.value = '';
  document.getElementById('modelModalTitle').textContent = 'Add model';
  errBox().classList.add('hidden');
  modal().classList.remove('hidden');
  modal().classList.add('flex');
}

function closeModelModal() {
  modal().classList.add('hidden');
  modal().classList.remove('flex');
}

function editModel(row) {
  form().reset();
  form().elements.id.value = row.id;
  form().elements.name.value = row.name;
  form().elements.display_name.value = row.display_name || '';
  form().elements.provider_id.value = row.provider_id;
  form().elements.upstream_model.value = row.upstream_model;
  form().elements.account_tier.value = row.account_tier || 'any';
  form().elements.enabled.checked = !!row.enabled;
  document.getElementById('modelModalTitle').textContent = 'Edit model';
  errBox().classList.add('hidden');
  modal().classList.remove('hidden');
  modal().classList.add('flex');
}

async function deleteModel(id, name) {
  if (!confirm(`Delete model mapping "${name}"?`)) return;
  const res = await fetch(`/api/admin/models/${id}`, { method: 'DELETE' });
  if (res.ok) location.reload();
  else alert('Failed to delete');
}

function tryInPlayground(modelId) {
  const url = `/playground?model=${encodeURIComponent(modelId)}`;
  window.location.href = url;
}

async function copyModelId(modelId, btn) {
  try {
    await navigator.clipboard.writeText(modelId);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = modelId;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  if (!btn) return;
  const prev = btn.innerHTML;
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  btn.style.color = '#34d399';
  setTimeout(() => {
    btn.innerHTML = prev;
    btn.style.color = '';
  }, 1200);
}

function setupModelTabs() {
  const tabs = document.querySelectorAll('.model-tab');
  if (!tabs.length) return;
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.provider;
      tabs.forEach((t) => t.classList.remove('model-tab-active'));
      tab.classList.add('model-tab-active');
      document.querySelectorAll('.model-panel').forEach((panel) => {
        if (panel.id === target) panel.classList.remove('hidden');
        else panel.classList.add('hidden');
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupModelTabs();
  form().addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form());
    const id = fd.get('id');
    const payload = {
      name: fd.get('name'),
      display_name: fd.get('display_name') || null,
      provider_id: Number(fd.get('provider_id')),
      upstream_model: fd.get('upstream_model'),
      account_tier: fd.get('account_tier') || 'any',
      enabled: fd.get('enabled') === 'on',
    };
    const url = id ? `/api/admin/models/${id}` : '/api/admin/models';
    const method = id ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      errBox().textContent = err.error || res.statusText;
      errBox().classList.remove('hidden');
      return;
    }
    location.reload();
  });
});
