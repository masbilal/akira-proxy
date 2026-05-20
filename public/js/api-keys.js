const SAVED_KEYS_STORAGE = 'akiraProxyRecentKeys';

async function createKey() {
  const name = prompt('Name for this API key?');
  if (!name) return;
  const res = await fetch('/api/admin/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Error: ' + (err.error || res.statusText));
    return;
  }
  const data = await res.json();
  rememberKey(data);
  showNewKey(data.key);
  applySavedKeyButtons();
}

function showNewKey(key) {
  const wrap = document.getElementById('newKeyAlert');
  document.getElementById('newKeyVal').textContent = key;
  wrap.classList.remove('hidden');
  navigator.clipboard.writeText(key).catch(() => {});
}

function copyKey() {
  const val = document.getElementById('newKeyVal').textContent;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.getElementById('copyNewKeyBtn');
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}

function readSavedKeys() {
  try {
    const raw = localStorage.getItem(SAVED_KEYS_STORAGE);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedKeys(items) {
  localStorage.setItem(SAVED_KEYS_STORAGE, JSON.stringify(items.slice(0, 20)));
}

function rememberKey(data) {
  const items = readSavedKeys().filter((item) => item.prefix !== data.key_prefix);
  items.unshift({
    name: data.name,
    key: data.key,
    prefix: data.key_prefix,
    createdAt: Date.now(),
  });
  writeSavedKeys(items);
}

function findSavedKey(prefix) {
  return readSavedKeys().find((item) => item.prefix === prefix) || null;
}

function copySavedKey(prefix, btn) {
  const saved = findSavedKey(prefix);
  if (!saved) return;
  navigator.clipboard.writeText(saved.key).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}

function applySavedKeyButtons() {
  document.querySelectorAll('.copy-saved-key-btn').forEach((btn) => {
    const prefix = btn.dataset.keyPrefix;
    const saved = findSavedKey(prefix);
    btn.classList.toggle('hidden', !saved);
    btn.onclick = saved ? () => copySavedKey(prefix, btn) : null;
    btn.title = saved ? `Copy browser-local key for ${prefix}` : '';
  });
}

async function revokeKey(id, name) {
  if (!confirm(`Revoke key "${name}"? Requests using this key will start failing immediately.`)) return;
  const res = await fetch(`/api/admin/api-keys/${id}/revoke`, { method: 'POST' });
  if (res.ok) location.reload();
  else alert('Failed to revoke');
}

async function deleteKey(id, name) {
  if (!confirm(`Delete key "${name}" permanently?`)) return;
  const res = await fetch(`/api/admin/api-keys/${id}`, { method: 'DELETE' });
  if (res.ok) location.reload();
  else alert('Failed to delete');
}

document.addEventListener('DOMContentLoaded', () => {
  applySavedKeyButtons();
});
