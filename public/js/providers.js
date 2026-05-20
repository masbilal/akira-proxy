const modal = () => document.getElementById('providerModal');
const form = () => document.getElementById('providerForm');
const errBox = () => document.getElementById('providerFormError');

function openProviderModal() {
  form().reset();
  form().elements.id.value = '';
  form().elements.config_json.value = '{}';
  document.getElementById('providerModalTitle').textContent = 'Add provider';
  errBox().classList.add('hidden');
  modal().classList.remove('hidden');
  modal().classList.add('flex');
}

function closeProviderModal() {
  modal().classList.add('hidden');
  modal().classList.remove('flex');
}

function editProvider(row) {
  form().reset();
  form().elements.id.value = row.id;
  form().elements.name.value = row.name;
  form().elements.type.value = row.type;
  form().elements.base_url.value = row.base_url;
  form().elements.auth_type.value = row.auth_type;
  form().elements.api_key.value = '';
  form().elements.api_key.placeholder = row.api_key_masked
    ? `current: ${row.api_key_masked} — leave blank to keep`
    : '';
  form().elements.config_json.value = row.config_json || '{}';
  form().elements.enabled.checked = !!row.enabled;
  document.getElementById('providerModalTitle').textContent = 'Edit provider';
  errBox().classList.add('hidden');
  modal().classList.remove('hidden');
  modal().classList.add('flex');
}

async function deleteProvider(id, name) {
  if (!confirm(`Delete provider "${name}"? All mapped models will also be removed.`)) return;
  const res = await fetch(`/api/admin/providers/${id}`, { method: 'DELETE' });
  if (res.ok) location.reload();
  else alert('Failed to delete');
}

async function refreshSubscription(id) {
  const res = await fetch(`/api/admin/providers/${id}/refresh-subscription`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    const sub = data.subscription || {};
    alert(
      `Plan: ${sub.title || sub.tier || 'unknown'}\n` +
        `tier: ${sub.tier}\n` +
        (sub.usage ? `usage: ${sub.usage.current} / ${sub.usage.limit} ${sub.usage.unit}` : '')
    );
    location.reload();
  } else {
    alert('Failed: ' + (data.error || res.statusText));
  }
}

async function warmupProvider(id) {
  if (!confirm('Warmup affected accounts in this provider? This will refresh plan data for accounts in error, exhausted, or rate-limited state.')) return;
  const res = await fetch(`/api/admin/providers/${id}/warmup-accounts`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert('Warmup failed: ' + (data.error || res.statusText));
    return;
  }
  alert(`Warmup complete\nTargeted: ${data.targeted ?? data.total}\nSuccess: ${data.success}/${data.total}\nFailed: ${data.failed}`);
  location.reload();
}

document.addEventListener('DOMContentLoaded', () => {
  form().addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form());
    const id = fd.get('id');
    const payload = {
      name: fd.get('name'),
      type: fd.get('type'),
      base_url: fd.get('base_url'),
      auth_type: fd.get('auth_type'),
      config_json: fd.get('config_json') || '{}',
      enabled: fd.get('enabled') === 'on',
    };
    const apiKeyVal = fd.get('api_key');
    if (apiKeyVal) payload.api_key = apiKeyVal;

    // Validate JSON
    try {
      JSON.parse(payload.config_json);
    } catch (err) {
      showErr('Config JSON is invalid: ' + err.message);
      return;
    }

    const url = id ? `/api/admin/providers/${id}` : '/api/admin/providers';
    const method = id ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showErr(err.error || res.statusText);
      return;
    }
    location.reload();
  });
});

function showErr(msg) {
  const e = errBox();
  e.textContent = msg;
  e.classList.remove('hidden');
}
