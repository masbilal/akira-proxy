/**
 * Codex account diagnostic.
 *
 * Usage:
 *   node scripts/diag-codex.js <account_id|email>
 *
 * Prints a sanitized view of the stored tokens and pings /usage once to
 * surface the real upstream response (status, content-type, body preview)
 * without echoing huge HTML bodies.
 */
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db', 'index'));

function safeJson(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

function mask(token) {
  if (!token) return null;
  if (token.length <= 12) return `${token[0]}…${token.slice(-2)}`;
  return `${token.slice(0, 8)}…${token.slice(-6)} (len=${token.length})`;
}

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const pad = parts[1] + '='.repeat((4 - parts[1].length % 4) % 4);
    const b = Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(b);
  } catch {
    return null;
  }
}

async function main() {
  const idArg = process.argv[2];
  if (!idArg) {
    console.error('Usage: node scripts/diag-codex.js <account_id|email>');
    process.exit(1);
  }
  const byId = /^\d+$/.test(idArg)
    ? db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(Number(idArg))
    : null;
  const row = byId || db.prepare('SELECT * FROM provider_accounts WHERE email = ?').get(idArg);
  if (!row) {
    console.error('Account not found for', idArg);
    process.exit(2);
  }
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(row.provider_id);
  const cfg = safeJson(row.config_json, {});
  const idPayload = decodeJwtPayload(row.access_token);

  console.log('== Codex account ==');
  console.log('id                  :', row.id);
  console.log('provider            :', provider && provider.name, `(${provider && provider.type})`);
  console.log('email               :', row.email);
  console.log('label               :', row.label);
  console.log('enabled             :', !!row.enabled);
  console.log('access_token        :', mask(row.access_token));
  console.log('refresh_token       :', mask(row.refresh_token));
  console.log('token_expires_at    :', row.token_expires_at,
    row.token_expires_at ? `(${new Date(row.token_expires_at * 1000).toISOString()})` : '');
  const now = Math.floor(Date.now() / 1000);
  console.log('time_to_expiry      :', row.token_expires_at ? `${row.token_expires_at - now}s` : 'n/a');
  console.log('cfg.chatgptAccountId:', cfg.chatgptAccountId || null);
  console.log('cfg.planType        :', cfg.planType || null);
  console.log('cfg.tier            :', cfg.tier || null);
  if (idPayload) {
    console.log('-- access_token JWT payload (for reference) --');
    console.log('  sub         :', idPayload.sub);
    console.log('  iss         :', idPayload.iss);
    console.log('  aud         :', idPayload.aud);
    console.log('  exp         :', idPayload.exp, idPayload.exp ? `(${new Date(idPayload.exp * 1000).toISOString()})` : '');
    const auth = idPayload['https://api.openai.com/auth'] || {};
    console.log('  auth.chatgpt_account_id:', auth.chatgpt_account_id);
    console.log('  auth.chatgpt_plan_type :', auth.chatgpt_plan_type);
    console.log('  auth.user_id           :', auth.user_id);
  } else {
    console.log('(access_token is not a parseable JWT — may be opaque)');
  }

  // Ping /usage with whatever is in the DB right now.
  const CodexProvider = require(path.join(__dirname, '..', 'src', 'providers', 'codex'));
  const adapter = new CodexProvider({ ...provider, account: row });
  console.log('\n== /usage probe ==');
  try {
    const info = await adapter.fetchUsageInfo();
    console.log('status     :', info.status);
    if (info.body && typeof info.body === 'object') {
      console.log('body (json):', JSON.stringify(info.body).slice(0, 600));
    } else if (typeof info.body === 'string') {
      console.log('body (text):', info.body.slice(0, 400).replace(/\s+/g, ' '));
    } else {
      console.log('body       :', info.body);
    }
  } catch (err) {
    console.log('threw      :', err.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
