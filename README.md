# Akira Proxy

A lightweight, self-hosted AI proxy router with OpenAI-compatible endpoints
and a management dashboard. Think of it as a tiny `9router` you can run
locally.

## Features

- OpenAI-compatible APIs at `/v1/chat/completions`, `/v1/responses`, and `/v1/models`
- Vision-ready pass-through for image inputs on compatible OpenAI-style upstreams
- Server-side streaming passthrough (SSE)
- Provider adapters: generic `openai`-compatible and `kiro`
- Dashboard for CRUD on providers, models, API keys, and request logs
- SQLite storage via Node.js built-in `node:sqlite`
- Kiro OAuth helper script in `scripts/login-kiro.js`
- Kiro CLI headless bridge for coding/tool execution when `KIRO_API_KEY` is set

## Layout

```text
src/
  server.js                Express entrypoint
  db/                      SQLite + migrations
  middleware/auth.js       admin session + API-key bearer guards
  providers/
    base.js                adapter contract
    openai.js              generic OpenAI-compatible adapter
    kiro.js                Kiro adapter
    index.js               registry
  routes/
    proxy.js               /v1/* (OpenAI-compatible)
    admin.js               /api/admin/* (JSON CRUD)
    dashboard.js           HTML pages + login
  services/logger.js       request log writer
  utils/                   apiKey + common helpers
  views/                   EJS templates
public/                    static assets
scripts/
  login-kiro.js            Kiro OAuth login helper
data/                      SQLite files
```

## Quick start

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
npm start
```

Dashboard: `http://localhost:3000`

Proxy base: `http://localhost:3000/v1`

For a stable local run without automatic restarts, use:

```bash
npm run dev
```

If you explicitly want auto-restart while editing files under `src/` or `scripts/`, use:

```bash
npm run dev:watch
```

## Using the proxy

1. Log in to the dashboard.
2. Add a provider.
3. Add a model mapping.
4. Create an API key.
5. Send requests, for example:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer akr-XXXX" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"hello"}],
    "stream": false
  }'
```

## Kiro modes

The Kiro adapter supports two execution paths:

1. Direct Kiro/Amazon Q HTTP using OAuth tokens stored by `npm run login:kiro`
2. Local `kiro-cli` headless execution when `KIRO_API_KEY` is present

For most VS Code and OpenAI-compatible clients, the direct HTTP path is the
important one. It now preserves Kiro tool calls over `/v1/chat/completions`,
bridges `/v1/responses`, and accepts image inputs for both endpoints when the
request uses direct HTTP mode.

### Browser used for login/upgrade automation

`scripts/login-kiro.js` and `scripts/upgrade-kiro.js` drive a real browser to
sign in with Google. By default they auto-detect the stealthiest available
driver and fall back gracefully:

1. **[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)** —
   a Playwright fork with stealth patches baked into Chromium. Drop-in API,
   pure npm, no Python. **Recommended default** because it is the most
   reliable against Google and Kiro bot checks and is the lightest to set up.
2. **[Camoufox](https://camoufox.com/)** — a Firefox fork with C++-level
   anti-detection patches. Heavier install (Python + managed Firefox binary)
   but very stealthy when Patchright is blocked.
3. **Bundled Chromium** — plain Playwright Chromium with the automation flag
   stripped. Used when neither stealth driver is installed.

Patchright is installed alongside the project dependencies, so a normal
`npm install` is enough. After that, download the patched Chromium once:

```powershell
npx patchright install chromium
```

Camoufox is optional. Install it only if you want to fall back to a Firefox
stealth driver:

```powershell
pip install -U "camoufox[geoip]"
python -m camoufox fetch
```

Selecting a browser:

```bash
# Auto-detect (default): Patchright > Camoufox > Chromium
node scripts/login-kiro.js

# Force Patchright
node scripts/login-kiro.js --patchright

# Force Camoufox (errors out if not installed)
node scripts/login-kiro.js --browser camoufox
node scripts/upgrade-kiro.js --browser camoufox

# Force bundled Chromium
node scripts/login-kiro.js --chromium
```

You can also set `KIRO_BROWSER=patchright|camoufox|chromium` in the
environment. If Camoufox is installed in a non-standard location, point
`CAMOUFOX_PATH` at the Firefox binary directly.

To quickly verify which driver is selected and whether stealth is active:

```powershell
node scripts/diag-browser.js
```

The script prints the picked driver, the user-agent, and critical fingerprint
flags such as `navigator.webdriver`.

### Install Kiro CLI on Windows

```powershell
irm 'https://cli.kiro.dev/install.ps1' | iex
```

### Headless auth

Kiro CLI headless mode requires an API key:

```powershell
$env:KIRO_API_KEY = "ksk_xxxxxxxx"
```

By default, the adapter auto-detects CLI mode when both `kiro-cli` and
`KIRO_API_KEY` are available. You can also force a mode:

```env
KIRO_RUNTIME=http
KIRO_CLI_PATH=C:\Users\<you>\AppData\Local\Kiro-Cli\kiro-cli.exe
KIRO_TRUST_TOOLS=read_file,write_file,shell
```

If `KIRO_TRUST_TOOLS` is empty, the current bridge falls back to
`--trust-all-tools` so non-interactive coding sessions do not stall on
approval prompts.

## Current limitations

- Prompt text alone does not create tool capability; the runtime must support it.
- Kiro CLI headless mode is still text-only in this bridge. For image inputs, use `KIRO_RUNTIME=http`.
- `image_file` / `file_id` inputs are not implemented for Kiro yet. Use HTTPS image URLs or `data:` URLs instead.
- Very small or malformed inline images can still be rejected upstream as `Improperly formed request.`
- Kiro CLI headless mode requires `KIRO_API_KEY`. Browser login alone is not enough for proxy automation.
- The current Kiro bridge supports direct HTTP and optional headless CLI. ACP/native session support can still be expanded later.

## Adding a new provider type

1. Create `src/providers/myprovider.js`, extending `BaseProvider`.
2. Register it in `src/providers/index.js`.
3. The type becomes selectable in the dashboard.

For custom upstreams that are already OpenAI-compatible, use the `openai`
provider type and point it at the upstream base URL.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | Runtime mode |
| `ADMIN_USERNAME` | `admin` | Dashboard login |
| `ADMIN_PASSWORD` | `changeme` | Change this |
| `SESSION_SECRET` | `dev-secret-change-me` | Long random string |
| `SESSION_TTL_SEC` | `604800` | Admin session TTL in seconds |
| `SESSION_PRUNE_INTERVAL_MS` | `3600000` | Interval for pruning expired admin sessions from SQLite |
| `SESSION_SECURE_COOKIE` | `0` | Set to `1` only when serving over HTTPS |
| `DB_PATH` | `./data/akira-proxy.db` | SQLite file location |
| `KIRO_API_KEY` | _(empty)_ | Enables Kiro CLI headless mode |
| `KIRO_CLI_PATH` | auto-detect | Override path to `kiro-cli` |
| `KIRO_RUNTIME` | `auto` | `auto`, `cli`, or `http` |
| `KIRO_GENERATE_URL` | native default | Optional override for Kiro `generateAssistantResponse` URL |
| `KIRO_USAGE_BASE` | `https://q.us-east-1.amazonaws.com` | Optional override for `getUsageLimits` base URL |
| `KIRO_TRUST_TOOLS` | _(empty)_ | Optional comma-separated tool allowlist; empty falls back to `--trust-all-tools` |
| `ACCOUNT_ERROR_COOLDOWN_SEC` | `300` | Cooldown before an errored account becomes eligible again |
| `ACCOUNT_SELECTION_MODE` | `smart` | `smart` uses safe round-robin, `round_robin` cycles strictly by account order |
| `ACCOUNT_MIN_REUSE_GAP_SEC` | `45` | In `smart` mode, prefer accounts that have not been used recently when alternatives exist |
| `BACKUP_ENABLED` | `1` | Set to `0` to disable the MySQL/MariaDB mirror |
| `BACKUP_INTERVAL_MS` | `1800000` | Interval between snapshots, in ms (min 60000) |
| `BACKUP_MYSQL_HOST` | `127.0.0.1` | MySQL host for the mirror |
| `BACKUP_MYSQL_PORT` | `3306` | MySQL port |
| `BACKUP_MYSQL_USER` | `root` | MySQL user |
| `BACKUP_MYSQL_PASSWORD` | _(empty)_ | MySQL password |
| `BACKUP_MYSQL_DATABASE` | `akira_proxy` | Database name (auto-created if missing) |
| `SYNC_MODE` | `disabled` | `disabled`, `hub`, or `peer` |
| `SYNC_NODE_ID` | auto | Stable id for this instance; auto-generated and persisted if empty |
| `SYNC_HUB_URL` | _(empty)_ | Peer-only: base URL of the hub (`https://router.example.com`) |
| `SYNC_SECRET` | _(empty)_ | Shared bearer token for `/api/sync/*` (required on both sides) |
| `SYNC_INTERVAL_MS` | `15000` | Peer push/pull cadence |
| `SYNC_PUSH_LIMIT` | `500` | Max changes shipped per push batch |
| `SYNC_PULL_LIMIT` | `500` | Max changes fetched per pull batch |
| `SYNC_REQUEST_TIMEOUT_MS` | `20000` | HTTP timeout for sync calls |

## MySQL/MariaDB auto backup

SQLite is the primary database. Every `BACKUP_INTERVAL_MS` (default 30
minutes) the app replicates all core tables to a MySQL/MariaDB instance so
you have a warm standby if the SQLite file ever gets corrupted.

What gets mirrored:

- `schema_migrations`
- `providers`
- `api_keys`
- `models`
- `provider_accounts`
- `request_logs`

The backup runs a full snapshot (TRUNCATE + batched INSERTs, wrapped in a
transaction with `FOREIGN_KEY_CHECKS = 0`). The target database is auto
created if it does not exist yet.

Verify manually:

```powershell
mysql -u root -h 127.0.0.1 akira_proxy -e "SELECT COUNT(*) FROM provider_accounts;"
```

From the dashboard: the Workers page shows a **MySQL backup** card with
status, last run, next run, per-table row counts, and a **Run backup now**
button. The REST endpoints are also available:

- `GET  /api/admin/backup/status`
- `POST /api/admin/backup/run`

Emergency restore sketch (if SQLite is unusable): point a throwaway
instance at the MySQL dump, or dump → convert back to SQLite with a one
off script since the column names are intentionally identical.

## Multi-instance sync (local ↔ VPS)

You can run Akira Proxy on a VPS and on your local machine and have them
share providers, accounts, models, and API keys automatically. The VPS
acts as a hub; every local machine is a peer that pushes/pulls changes.

### How it works

- SQLite stays the source of truth on each instance. No async DB driver,
  no shared connection.
- Every synced row carries a `uuid`, an origin `node_id`, and a
  `deleted_at` flag. SQLite triggers fan local writes out into a
  `sync_outbox` change log.
- Peers handshake with the hub, then push their outbox to
  `POST /api/sync/push` and pull the hub's changes from
  `GET /api/sync/changes?since=<cursor>` on a configurable cadence
  (default 15s).
- Conflicts are resolved last-write-wins by `updated_at`; ties break by
  `node_id` so both sides converge deterministically.
- DELETEs are stored as soft-deletes so peers see tombstones and can
  apply them. Hard deletes would resurrect rows on the next push cycle,
  so the admin routes were rewired to soft-delete.
- Synced tables: `providers`, `provider_accounts`, `models`, `api_keys`.
  Not synced: `request_logs` (volume), `admin_sessions` (per-instance),
  `schema_migrations`, `sync_*` (sync infrastructure itself).

### Hub setup (VPS)

```env
SYNC_MODE=hub
SYNC_NODE_ID=vps-prod         # any stable string you like
SYNC_SECRET=<openssl rand -hex 32>
```

Restart the app. The endpoints `/api/sync/handshake`,
`/api/sync/changes`, `/api/sync/push`, `/api/sync/status` go live with
shared-token bearer auth.

Important: expose the app on HTTPS in production (CloudPanel can
terminate TLS via its built-in reverse proxy — see below). Bearer tokens
in plain HTTP are bad practice.

### Peer setup (local)

```env
SYNC_MODE=peer
SYNC_NODE_ID=laptop-dewa
SYNC_HUB_URL=https://router.example.com
SYNC_SECRET=<same-as-hub>
SYNC_INTERVAL_MS=15000
```

Boot the peer (`npm run dev`). Watch the logs:

```
[sync] peer mode (node_id=laptop-dewa) -> https://router.example.com; cadence=15000ms
```

Within ~15 seconds you should see the hub's accounts and providers
appear locally. Adding an account on the laptop now propagates to the
VPS automatically; logging in to a Kiro/Codex account on the VPS shows
up on the laptop's dashboard within a cycle.

### Inspecting / forcing a cycle

From the dashboard or CLI:

```bash
curl -H "Cookie: connect.sid=..." http://localhost:3000/api/admin/sync/status
curl -X POST -H "Cookie: connect.sid=..." http://localhost:3000/api/admin/sync/run
```

`status` returns the current mode, last run, peer cursors, outbox size,
and any pending error. `run` triggers an immediate handshake + push +
pull cycle (peer mode only; hubs only respond to incoming requests).

### Deploying on Ubuntu CloudPanel

1. Install Node 22.5+ on the VPS:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. In CloudPanel, create a new **Node.js** site (e.g.
   `router.example.com`). Set the App Port to `3000`, the App Root to
   the project directory, and the Startup File to `src/server.js`.

3. SSH into the site user, clone the repo into the site root, then:

   ```bash
   npm install
   cp .env.example .env
   # edit .env — set ADMIN_PASSWORD, SESSION_SECRET, SYNC_MODE=hub,
   # SYNC_SECRET, BACKUP_MYSQL_PASSWORD, etc.
   npm run migrate
   npm run seed
   ```

4. CloudPanel → Site → SSL/TLS: issue a Let's Encrypt cert. The built-in
   reverse proxy handles HTTPS termination on 443 and forwards to the
   Node app on 3000.

5. Restart the Node app from CloudPanel. Confirm:

   ```bash
   curl https://router.example.com/healthz
   curl -H "Authorization: Bearer $SYNC_SECRET" \
        https://router.example.com/api/sync/status
   ```

6. CloudPanel ships MySQL by default. The MySQL/MariaDB mirror in
   `src/db/backup.js` will use it if you keep the defaults; just set
   `BACKUP_MYSQL_PASSWORD` to the password CloudPanel assigned to the
   site database user, and update `BACKUP_MYSQL_DATABASE`. The schema
   is created automatically on the first backup pass.

7. On your local machine set `SYNC_MODE=peer`, point `SYNC_HUB_URL` at
   the VPS HTTPS URL, reuse the same `SYNC_SECRET`, and you're done.

### Troubleshooting

- Peer logs `cycle failed: handshake returned 401` → secrets don't match.
- Peer logs `cycle failed: ENOTFOUND` → DNS/firewall issue; verify
  `curl -I $SYNC_HUB_URL/healthz` from the peer.
- Rows with `node_id = 'legacy'` in your DB are pre-sync rows from before
  migration 007 was applied. They get adopted at boot but won't emit
  outbox entries until they're touched (any UPDATE will re-emit).
- The outbox grows monotonically. It is safe to leave; if it ever
  bloats, you can `DELETE FROM sync_outbox WHERE id < (least cursor across
  sync_peers)` once all peers have caught up.
- Soft-deleted rows accumulate too. They are filtered out everywhere via
  `deleted_at IS NULL`. Periodic compaction is a future improvement.

## Status

This is still MVP scaffolding. Useful next steps:

- Deepen Kiro ACP/native session support beyond headless CLI bridging
- Finish automated Kiro login UX
- Add rate limiting per API key
- Expand per-provider multi-account rotation heuristics further
- Add model auto-discovery from provider `/models`
