'use strict';

/**
 * Codex (ChatGPT subscription) adapter.
 *
 * Talks to the same backend used by the official `codex` CLI:
 *   - Auth refresh:      POST https://auth.openai.com/oauth/token (form-urlencoded)
 *   - Chat / completions: POST https://chatgpt.com/backend-api/codex/responses (SSE)
 *   - Models:             GET  https://chatgpt.com/backend-api/codex/models
 *   - Usage:              GET  https://chatgpt.com/backend-api/wham/usage
 *
 * Tokens come from `provider_accounts` (populated by scripts/login-codex.js).
 *
 * Required headers on chat requests (all enforced by upstream — missing any
 * one yields 401/403):
 *   authorization:        Bearer <access_token>
 *   originator:           codex-cli
 *   user-agent:           codex-cli/1.0.18 (<os>; <arch>)
 *   version:              0.129.0
 *   chatgpt-account-id:   <uuid from id_token>
 *   session_id:           <uuid, MUST be consistent within a single conversation>
 *   accept:               text/event-stream
 *
 * Responses API ↔ Chat Completions translation:
 *   - chatCompletions(payload): rewrite to Responses-shape input, call
 *     /codex/responses with stream=true, translate SSE events to OpenAI
 *     chat.completion.chunk frames.
 *   - responses(payload): proxy directly. The Codex backend already speaks
 *     the Responses API.
 */

const crypto = require('crypto');
const os = require('os');
const { Readable } = require('stream');
const BaseProvider = require('./base');
const { safeJsonParse } = require('../utils/common');
const db = require('../db');

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHAT_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
// Real Codex client uses GET {base}/wham/usage (ChatGpt path style) — the
// account-scoped /accounts/{id}/usage path is not served on chatgpt.com and
// gets flagged by Cloudflare as a suspicious request.
// See openai/codex: codex-rs/backend-client/src/client.rs::get_rate_limits_many.
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const CODEX_VERSION = '0.129.0';
// Must match a first-party originator recognized by ChatGPT's edge
// (see codex-rs/login/src/auth/default_client.rs::is_first_party_originator).
// Valid values: "codex_cli_rs", "codex-tui", "codex_vscode", "Codex *".
// Using anything else causes /backend-api/* to return 403.
const CODEX_ORIGINATOR = 'codex_cli_rs';
function buildUserAgent() {
  const platform = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : 'Linux';
  const arch = os.arch() === 'x64' ? 'x86_64' : os.arch();
  // Mirror the real Rust CLI UA shape: "codex_cli_rs/<ver> (<os>; <arch>)".
  return `codex_cli_rs/${CODEX_VERSION} (${platform}; ${arch})`;
}
const CODEX_UA = buildUserAgent();

// ---------------- subscription classifier ----------------

/**
 * Map the ChatGPT /wham/usage payload into a normalized subscription record
 * similar to Kiro's classifySubscription().
 *
 * Payload shape (from real ChatGPT backend):
 *   {
 *     "plan_type": "plus",
 *     "rate_limit": {
 *       "allowed": true,
 *       "limit_reached": false,
 *       "primary_window":   { "used_percent": 1, "limit_window_seconds": 18000,  "reset_after_seconds": 18000,  "reset_at": 1778698096 },
 *       "secondary_window": { "used_percent": 3, "limit_window_seconds": 604800, "reset_after_seconds": 579215, "reset_at": 1779259310 }
 *     },
 *     "additional_rate_limits": [ ... ]   // optional, same shape
 *   }
 *
 * We map primary_window → primary (5h bucket) and secondary_window → secondary
 * (weekly bucket). Legacy field names (`rate_limits.primary.used_percent`) are
 * accepted for backward compatibility with older probe payloads.
 */
function classifySubscription(input) {
  if (!input || typeof input !== 'object') return { tier: 'unknown', planType: null };

  const planType = String(input.plan_type || input.chatgpt_plan_type || '').trim().toLowerCase();
  // The ChatGPT backend returns exact strings for `plan_type`:
  //   free | plus | pro | business | team | enterprise | edu
  // Use exact matches first, then prefix fallbacks for future variants
  // (e.g. "plus-trial" or "business-trial"). Order matters because some
  // strings share prefixes with others (`pro` vs `plus`).
  const EXACT_TIERS = new Set(['free', 'plus', 'pro', 'business', 'team', 'enterprise', 'edu']);
  let tier = 'unknown';
  if (EXACT_TIERS.has(planType)) {
    tier = planType;
  } else if (planType) {
    if (planType.startsWith('enterprise')) tier = 'enterprise';
    else if (planType.startsWith('business')) tier = 'business';
    else if (planType.startsWith('team')) tier = 'team';
    else if (planType.startsWith('edu')) tier = 'edu';
    else if (planType.startsWith('plus')) tier = 'plus';
    else if (planType.startsWith('pro')) tier = 'pro';
    else if (planType.startsWith('free')) tier = 'free';
  }

  const mapWindow = (w) => {
    if (!w || typeof w !== 'object') return null;
    const used = Number(w.used_percent ?? w.usedPercent ?? 0);
    const resets = Number(w.reset_at || w.resets_at || w.resetsAt || 0) || null;
    const winSec = Number(w.limit_window_seconds || w.window_seconds || 0) || null;
    return {
      used_percent: used,
      reset_at: resets,
      resets_at: resets,
      window_seconds: winSec,
      window_duration_mins: winSec ? Math.round(winSec / 60) : null,
    };
  };

  // Primary source: /wham/usage returns a single `rate_limit` object with
  // primary_window / secondary_window children.
  const rl = input.rate_limit || input.rateLimit || {};
  let primary = mapWindow(rl.primary_window || rl.primaryWindow);
  let secondary = mapWindow(rl.secondary_window || rl.secondaryWindow);

  // Legacy / older probe shape: { rate_limits: { primary, secondary } }.
  if (!primary && !secondary) {
    const legacy = input.rate_limits || input.rateLimits || {};
    primary = mapWindow(legacy.primary);
    secondary = mapWindow(legacy.secondary);
  }

  const usage = primary
    ? {
        limit: 100,
        current: primary.used_percent,
        unit: 'percent',
        resetsAt: primary.reset_at,
      }
    : null;

  return {
    tier,
    planType: planType || null,
    primary: primary || null,
    secondary: secondary || null,
    usage,
    capturedAt: Math.floor(Date.now() / 1000),
  };
}

// ---------------- helpers ----------------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomChatcmplId() {
  return `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
}

function randomRespId() {
  return `resp_${crypto.randomBytes(12).toString('hex')}`;
}

function ensureSessionId(payload, cfg) {
  // Prefer caller-provided value (kept across retries); fall back to a fresh
  // UUID. The session_id MUST be consistent within a single conversation, but
  // since each /v1/chat/completions call is logically one conversation, a
  // fresh UUID per request is safe.
  return (
    (payload && payload.metadata && payload.metadata.session_id) ||
    (cfg && cfg.sessionId) ||
    crypto.randomUUID()
  );
}

function ensureChatgptAccountId(account, cfg) {
  // The login script stores it in account config_json.chatgptAccountId.
  return (
    (cfg && cfg.chatgptAccountId) ||
    (account && account.chatgpt_account_id) ||
    null
  );
}

function normalizeContentText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string' || Array.isArray(part.content)) {
          return normalizeContentText(part.content);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

/**
 * Normalize a single `image_url` part (chat.completions shape) into an
 * `input_image` content item understood by the Codex /responses backend.
 *
 * Accepts the common OpenAI shapes:
 *   { type: 'image_url', image_url: 'https://...' }
 *   { type: 'image_url', image_url: { url: 'data:image/png;base64,...', detail: 'high' } }
 *   { type: 'input_image', image_url: '...', detail?: '...' }
 *
 * Returns null when no usable URL is present.
 */
function normalizeImagePartForCodex(part) {
  if (!part || typeof part !== 'object') return null;

  // Already a Responses-API input_image.
  if (part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url) {
    const item = { type: 'input_image', image_url: part.image_url };
    if (part.detail) item.detail = String(part.detail);
    return item;
  }

  // chat.completions shape with image_url.
  const raw = part.image_url;
  let url = '';
  let detail = null;
  if (typeof raw === 'string') {
    url = raw;
  } else if (raw && typeof raw === 'object') {
    if (typeof raw.url === 'string') url = raw.url;
    if (raw.detail) detail = String(raw.detail);
  }
  // Anthropic-style `source: { type: 'base64', media_type, data }` → data URL.
  if (!url && part.source && typeof part.source === 'object') {
    const src = part.source;
    if (src.type === 'base64' && typeof src.data === 'string' && src.data) {
      const mime = src.media_type || src.mediaType || 'image/png';
      url = `data:${mime};base64,${src.data}`;
    } else if (src.type === 'url' && typeof src.url === 'string') {
      url = src.url;
    }
  }
  if (!url) return null;

  const item = { type: 'input_image', image_url: url };
  if (detail) item.detail = detail;
  return item;
}

/**
 * Build a Responses-API content[] array for a user message, preserving text
 * AND images. Each text chunk becomes `{type:'input_text', text}` and each
 * image becomes `{type:'input_image', image_url, detail?}`.
 *
 * Falls back to a single `input_text` item when content is a bare string.
 */
function userContentToCodexContent(content) {
  if (content == null) {
    return [{ type: 'input_text', text: '' }];
  }
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: normalizeContentText(content) }];
  }

  const items = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === 'string') {
      if (part) items.push({ type: 'input_text', text: part });
      continue;
    }
    if (typeof part !== 'object') continue;

    // Text-ish parts.
    if (part.type === 'text' || part.type === 'input_text') {
      const text = typeof part.text === 'string' ? part.text : normalizeContentText(part);
      if (text) items.push({ type: 'input_text', text });
      continue;
    }

    // Image parts.
    if (
      part.type === 'image_url' ||
      part.type === 'input_image' ||
      part.type === 'image' ||
      part.image_url ||
      (part.source && typeof part.source === 'object')
    ) {
      const img = normalizeImagePartForCodex(part);
      if (img) items.push(img);
      continue;
    }

    // Fallback: any other object with a .text field.
    if (typeof part.text === 'string' && part.text) {
      items.push({ type: 'input_text', text: part.text });
    }
  }

  // Guarantee at least one item so the upstream schema stays valid.
  if (!items.length) items.push({ type: 'input_text', text: '' });
  return items;
}

/**
 * Translate a chat.completions payload into a Codex /responses request body.
 * The Codex backend understands the Responses API natively, so we map:
 *   messages[] → input[] (each item has type='message', role, content[])
 *   system messages → instructions (concatenated)
 *   tool_calls / tool messages → function_call / function_call_output items
 */
function chatPayloadToCodexBody(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const input = [];
  const instructionParts = [];

  for (const m of messages) {
    if (!m || !m.role) continue;

    if (m.role === 'system') {
      const text = normalizeContentText(m.content).trim();
      if (text) instructionParts.push(text);
      continue;
    }

    if (m.role === 'tool' || m.role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: normalizeContentText(m.content),
      });
      continue;
    }

    if (m.role === 'assistant') {
      const text = normalizeContentText(m.content).trim();
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || !tc.function) continue;
          input.push({
            type: 'function_call',
            call_id: tc.id || `call_${crypto.randomUUID()}`,
            name: tc.function.name || '',
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments || {}),
          });
        }
      }
      continue;
    }

    // user (and any other unknown role we route as user)
    input.push({
      type: 'message',
      role: 'user',
      content: userContentToCodexContent(m.content),
    });
  }

  const body = {
    model: payload.model,
    input,
    stream: true,
    // Codex backend rejects requests without this flag:
    //   {"detail":"Store must be set to false"}
    store: false,
  };
  if (instructionParts.length) {
    body.instructions = instructionParts.join('\n\n');
  } else {
    // Upstream (`/backend-api/codex/responses`) requires a non-empty
    // `instructions` string and rejects requests with:
    //   {"detail":"Instructions are required"}
    // Callers using the plain chat.completions shape may omit the system role,
    // so provide a minimal default assistant persona.
    body.instructions = 'You are a helpful assistant.';
  }

  // Tools: pass through OpenAI-style function tool defs.
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools
      .map((t) => {
        const spec = t && (t.function || t);
        if (!spec || !spec.name) return null;
        return {
          type: 'function',
          name: spec.name,
          description: spec.description || '',
          parameters: spec.parameters || { type: 'object', properties: {} },
        };
      })
      .filter(Boolean);
  }
  if (payload.tool_choice) body.tool_choice = payload.tool_choice;
  // NOTE: the Codex `/responses` upstream rejects several OpenAI sampling
  // parameters with 400 {"detail":"Unsupported parameter: <name>"}. Confirmed
  // unsupported so far: `max_output_tokens`, `max_tokens`, `temperature`,
  // `top_p`, `presence_penalty`, `frequency_penalty`, `n`, `logprobs`, `stop`,
  // `seed`, `response_format`. We drop them silently rather than forward.

  return body;
}

/**
 * Strip every sampling/limit parameter the Codex `/responses` endpoint rejects
 * with 400. Used by both chatCompletions() (after translation) and responses()
 * (direct pass-through).
 */
const CODEX_UNSUPPORTED_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'max_tokens',
  'max_output_tokens',
  'n',
  'logprobs',
  'top_logprobs',
  'stop',
  'seed',
  'response_format',
  'logit_bias',
  'parallel_tool_calls',
  'service_tier',
  'user',
];

function stripUnsupportedCodexParams(body) {
  if (!body || typeof body !== 'object') return body;
  for (const key of CODEX_UNSUPPORTED_PARAMS) {
    if (key in body) delete body[key];
  }
  return body;
}

// ---------------- adapter ----------------

class CodexProvider extends BaseProvider {
  _account() {
    // When routed through accounts.attachAccount(), provider.account holds the
    // selected provider_accounts row. Fall back to provider row for migration
    // compatibility (older single-account setups).
    return this.provider.account || this.provider;
  }

  _cfg() {
    const account = this._account();
    return safeJsonParse(account.config_json || this.provider.config_json, {});
  }

  _tokenStatus() {
    const account = this._account();
    if (!account.access_token) return 'missing';
    const exp = account.token_expires_at || 0;
    // Refresh proactively a minute before expiry.
    if (exp > 0 && exp <= nowSec() + 60) return 'expired';
    return 'ok';
  }

  async _refreshIfNeeded(force = false) {
    if (!force && this._tokenStatus() === 'ok') return;
    const account = this._account();
    if (!account.refresh_token) {
      const e = new Error('Codex token expired and no refresh_token available. Re-run `npm run login:codex`.');
      e.code = 'token_expired_no_refresh';
      throw e;
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: CLIENT_ID,
      scope: 'openid profile email offline_access',
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'accept': 'application/json',
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (res.status !== 200) {
      const e = new Error(`Codex refresh_token failed status=${res.status} body=${text.slice(0, 240)}`);
      e.code = 'refresh_failed';
      e.status = res.status;
      throw e;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw Object.assign(new Error('Codex refresh_token returned non-JSON'), { code: 'refresh_bad_response' });
    }
    const access = parsed.access_token;
    if (!access) throw Object.assign(new Error('Codex refresh_token missing access_token'), { code: 'refresh_no_access' });

    const newRefresh = parsed.refresh_token || account.refresh_token;
    const expiresIn = Number(parsed.expires_in) || 3600 * 24 * 5;
    const exp = nowSec() + expiresIn;
    const ts = nowSec();

    if (this.provider.account) {
      db.prepare(`
        UPDATE provider_accounts
        SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(access, newRefresh, exp, ts, account.id);
      this.provider.account.access_token = access;
      this.provider.account.refresh_token = newRefresh;
      this.provider.account.token_expires_at = exp;
    } else {
      // Legacy: tokens on the provider row itself.
      db.prepare(`
        UPDATE providers
        SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(access, newRefresh, exp, ts, this.provider.id);
      this.provider.access_token = access;
      this.provider.refresh_token = newRefresh;
      this.provider.token_expires_at = exp;
    }
  }

  _baseHeaders({ sessionId } = {}) {
    const account = this._account();
    const cfg = this._cfg();
    const headers = {
      'authorization': `Bearer ${account.access_token}`,
      'originator': CODEX_ORIGINATOR,
      'user-agent': CODEX_UA,
      'version': CODEX_VERSION,
    };
    const accountId = ensureChatgptAccountId(account, cfg);
    if (accountId) headers['chatgpt-account-id'] = accountId;
    if (sessionId) headers['session_id'] = sessionId;
    return headers;
  }

  _chatHeaders(sessionId) {
    return {
      ...this._baseHeaders({ sessionId }),
      'accept': 'text/event-stream',
      'content-type': 'application/json',
    };
  }

  async _postCodex(payload, { signal, sessionId } = {}) {
    return fetch(CHAT_URL, {
      method: 'POST',
      headers: this._chatHeaders(sessionId),
      body: JSON.stringify(payload),
      signal,
    });
  }

  /**
   * Streaming pass-through for /v1/responses. The Codex backend already
   * emits Responses-API-shaped SSE events, so we forward them verbatim.
   */
  async responses(payload, { signal } = {}) {
    try {
      await this._refreshIfNeeded();
    } catch (err) {
      return this._authFailure(err);
    }

    const cfg = this._cfg();
    const sessionId = ensureSessionId(payload, cfg);
    const wantsStream = Boolean(payload && payload.stream);

    // Force stream upstream — Codex /responses always uses SSE.
    // Codex backend also requires store:false; inject if caller omitted it.
    const upstreamPayload = stripUnsupportedCodexParams({
      ...payload,
      stream: true,
      store: false,
    });
    let res;
    try {
      res = await this._postCodex(upstreamPayload, { signal, sessionId });
    } catch (err) {
      return this._upstreamFailure(err);
    }

    if (res.status !== 200) {
      return this._statusFailure(res);
    }

    if (wantsStream) {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: res.body,
      };
    }

    // Non-streaming: collect the SSE events and reconstruct a Responses-API body.
    const collected = await collectResponsesStream(res.body);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: collected,
    };
  }

  /**
   * OpenAI chat.completions over Codex. We translate to Responses input,
   * call /codex/responses, then re-translate the SSE stream into chat
   * completion chunks.
   */
  async chatCompletions(payload, { signal } = {}) {
    try {
      await this._refreshIfNeeded();
    } catch (err) {
      return this._authFailure(err);
    }

    const cfg = this._cfg();
    const sessionId = ensureSessionId(payload, cfg);
    const wantsStream = Boolean(payload && payload.stream);
    const codexBody = chatPayloadToCodexBody(payload);

    let res;
    try {
      res = await this._postCodex(codexBody, { signal, sessionId });
    } catch (err) {
      return this._upstreamFailure(err);
    }

    if (res.status !== 200) {
      return this._statusFailure(res);
    }

    if (wantsStream) {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: codexStreamToChatChunks(res.body, payload.model),
      };
    }

    const collected = await collectResponsesStream(res.body);
    const chatBody = responsesBodyToChatBody(collected, payload.model);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: chatBody,
    };
  }

  async fetchUsageInfo() {
    // First attempt with whatever token we currently have (time-based refresh
    // only runs if expired).
    let result = await this._fetchUsageOnce();
    // If ChatGPT rejected the token (401/403), it may be revoked server-side
    // even though our clock says it's valid. Force a refresh and retry once.
    if ((result.status === 401 || result.status === 403) && this._account().refresh_token) {
      try {
        await this._refreshIfNeeded(true);
      } catch (err) {
        // Refresh itself failed — return the original rejection with a hint
        // that the refresh_token is also bad.
        return {
          status: result.status,
          body: {
            error: {
              code: 'refresh_failed_after_rejection',
              message: `ChatGPT rejected access_token and refresh_token also failed: ${err.message}`,
            },
          },
        };
      }
      result = await this._fetchUsageOnce();
    }
    return result;
  }

  async _fetchUsageOnce() {
    await this._refreshIfNeeded();
    const account = this._account();
    const cfg = this._cfg();
    const accountId = ensureChatgptAccountId(account, cfg);
    if (!accountId) {
      return { status: 400, body: { error: { message: 'chatgpt_account_id missing; re-run npm run login:codex' } } };
    }
    // GET /backend-api/wham/usage returns the current user's rate limits keyed
    // by the bearer token; the account id goes in the `chatgpt-account-id`
    // header to disambiguate workspaces. Mirrors the real Rust client's
    // chatgpt_get_request headers \u2014 sending /responses-style headers like
    // `originator` / `version` / `session_id` here triggers Cloudflare.
    const res = await fetch(USAGE_URL, {
      headers: {
        'authorization': `Bearer ${account.access_token}`,
        'chatgpt-account-id': accountId,
        'user-agent': CODEX_UA,
        'accept': 'application/json',
        'content-type': 'application/json',
      },
    });
    const text = await res.text();
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    // When ChatGPT's edge rejects us (expired session, Cloudflare block, plan
    // not eligible) it typically returns an HTML page. Normalize that into a
    // structured error object so callers don't have to parse HTML.
    if (contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/i.test(text)) {
      return {
        status: res.status,
        body: {
          error: {
            code: 'upstream_html_response',
            message: res.status === 401 || res.status === 403
              ? 'ChatGPT rejected the access token (re-login required)'
              : res.status === 429
                ? 'Rate limited by ChatGPT edge'
                : `ChatGPT returned an HTML page (status ${res.status})`,
          },
        },
      };
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  async listModels() {
    // Try the live models endpoint first — the set of slugs a ChatGPT account
    // can reach depends on plan tier and rolling availability. Fall back to a
    // static list only if the call fails so the UI always has *something*.
    try {
      await this._refreshIfNeeded();
      const account = this._account();
      const cfg = this._cfg();
      const accountId = ensureChatgptAccountId(account, cfg);
      if (accountId) {
        const res = await fetch(MODELS_URL, {
          headers: {
            'authorization': `Bearer ${account.access_token}`,
            'chatgpt-account-id': accountId,
            'user-agent': CODEX_UA,
            'accept': 'application/json',
          },
        });
        if (res.status === 200) {
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/json')) {
            const j = await res.json();
            const list = Array.isArray(j && j.models) ? j.models : [];
            const mapped = list
              .filter((m) => m && typeof m.slug === 'string' && m.supported_in_api !== false)
              .map((m) => ({ id: m.slug, object: 'model', owned_by: 'codex' }));
            if (mapped.length) return mapped;
          }
        }
      }
    } catch {
      // fall through to static list
    }
    return [
      { id: 'gpt-5.5', object: 'model', owned_by: 'codex' },
      { id: 'gpt-5.4', object: 'model', owned_by: 'codex' },
      { id: 'gpt-5.4-mini', object: 'model', owned_by: 'codex' },
    ];
  }

  // ---------- error helpers ----------

  _authFailure(err) {
    return {
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          message: err.message,
          type: 'provider_auth_error',
          code: err.code || 'refresh_failed',
        },
      },
    };
  }

  _upstreamFailure(err) {
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          message: `Codex upstream call failed: ${err && err.message ? err.message : err}`,
          type: 'provider_error',
          code: 'codex_upstream_error',
        },
      },
    };
  }

  async _statusFailure(res) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch { /* noop */ }
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
    return {
      status: res.status,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          message: `Codex upstream ${res.status}`,
          type: res.status === 401 || res.status === 403 ? 'provider_auth_error' : 'provider_error',
          upstream: parsed,
        },
      },
    };
  }
}

// ---------------- SSE event-stream helpers ----------------

/**
 * Async iterator over `data: {...}` events from a Codex Responses SSE stream.
 * Yields the parsed JSON payload of each `data:` line (excluding `[DONE]`).
 *
 * Handles named events (`event: foo\ndata: {...}`) and bare data frames.
 */
async function* iterateSseEvents(stream) {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buf = '';

  // Both web ReadableStream and Node Readable are iterable in modern Node.
  const reader =
    typeof stream.getReader === 'function'
      ? stream.getReader()
      : null;

  const readChunk = async () => {
    if (reader) {
      const { value, done } = await reader.read();
      return { value, done };
    }
    // Fall back to async iteration on a Node Readable.
    const it = stream[Symbol.asyncIterator]();
    const r = await it.next();
    return { value: r.value, done: r.done };
  };

  let evt = { event: null, dataLines: [] };
  const emit = function* () {
    if (!evt.dataLines.length) return;
    const dataStr = evt.dataLines.join('\n');
    if (dataStr === '[DONE]') {
      evt = { event: null, dataLines: [] };
      return;
    }
    let parsed;
    try { parsed = JSON.parse(dataStr); } catch { parsed = dataStr; }
    yield { event: evt.event, data: parsed };
    evt = { event: null, dataLines: [] };
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await readChunk();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const rawLine = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);

      if (rawLine === '') {
        // Frame boundary
        for (const item of emit()) yield item;
        continue;
      }
      if (rawLine.startsWith(':')) continue; // SSE comment

      const colon = rawLine.indexOf(':');
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
      const value = colon < 0 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');

      if (field === 'event') evt.event = value;
      else if (field === 'data') evt.dataLines.push(value);
      // Ignore id/retry fields.
    }
  }

  // Flush any trailing event without a final blank line.
  buf += decoder.decode();
  if (buf.length) {
    const lines = buf.split('\n');
    for (const rawLine of lines) {
      if (rawLine.startsWith('data:')) evt.dataLines.push(rawLine.slice(5).replace(/^ /, ''));
      else if (rawLine.startsWith('event:')) evt.event = rawLine.slice(6).replace(/^ /, '');
    }
  }
  for (const item of emit()) yield item;
}

/**
 * Consume a Codex /responses SSE stream into a single Responses-API body
 * shaped roughly like the synchronous /v1/responses payload.
 *
 * NOTE: Codex requires `store=false`, which means the final
 * `response.completed` event ships with an empty `output` array. We must
 * aggregate the text and tool-call deltas ourselves from the event stream
 * (response.output_text.delta, response.function_call_arguments.delta, etc.)
 * and synthesize the `output[]` / `output_text` fields expected by the
 * downstream chat.completion converter.
 */
async function collectResponsesStream(stream) {
  let finalResp = null;
  // Per output_index → accumulator for a message (text) or function_call (args).
  const items = new Map();

  const getItem = (idx, kind) => {
    let it = items.get(idx);
    if (!it) {
      it = kind === 'function_call'
        ? { kind: 'function_call', output_index: idx, call_id: '', name: '', arguments: '' }
        : { kind: 'message', output_index: idx, role: 'assistant', text: '', id: '' };
      items.set(idx, it);
    }
    return it;
  };

  for await (const ev of iterateSseEvents(stream)) {
    if (!ev || !ev.data || typeof ev.data !== 'object') continue;
    const d = ev.data;
    const t = ev.event || d.type;

    if (t === 'response.output_item.added' && d.item) {
      const idx = typeof d.output_index === 'number' ? d.output_index : items.size;
      if (d.item.type === 'function_call') {
        const it = getItem(idx, 'function_call');
        it.call_id = d.item.call_id || d.item.id || it.call_id;
        it.name = d.item.name || it.name;
        if (typeof d.item.arguments === 'string') it.arguments = d.item.arguments;
      } else if (d.item.type === 'message') {
        const it = getItem(idx, 'message');
        it.id = d.item.id || it.id;
      }
      continue;
    }

    if (t === 'response.output_text.delta' || t === 'response.text.delta') {
      const idx = typeof d.output_index === 'number' ? d.output_index : 0;
      const it = getItem(idx, 'message');
      it.text += (d.delta || d.text || '');
      continue;
    }

    if (t === 'response.function_call_arguments.delta') {
      const idx = typeof d.output_index === 'number' ? d.output_index : 0;
      const it = getItem(idx, 'function_call');
      it.arguments += (d.delta || '');
      continue;
    }

    if (t === 'response.function_call_arguments.done') {
      const idx = typeof d.output_index === 'number' ? d.output_index : 0;
      const it = getItem(idx, 'function_call');
      if (typeof d.arguments === 'string' && d.arguments.length >= it.arguments.length) {
        it.arguments = d.arguments;
      }
      continue;
    }

    if (t === 'response.completed' || t === 'response.done') {
      finalResp = d.response || d;
    }
  }

  // Build output[] from whatever we aggregated, sorted by output_index.
  const output = [];
  let collectedText = '';
  const sortedIdx = Array.from(items.keys()).sort((a, b) => a - b);
  for (const idx of sortedIdx) {
    const it = items.get(idx);
    if (it.kind === 'message' && it.text) {
      output.push({
        id: it.id || undefined,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: it.text }],
      });
      collectedText += it.text;
    } else if (it.kind === 'function_call') {
      output.push({
        type: 'function_call',
        call_id: it.call_id,
        name: it.name,
        arguments: it.arguments,
      });
    }
  }

  if (finalResp && typeof finalResp === 'object') {
    // Prefer our aggregated output since `store=false` responses ship an
    // empty `output` array in the completed event.
    if (!Array.isArray(finalResp.output) || finalResp.output.length === 0) {
      finalResp.output = output;
    }
    if (!finalResp.output_text) finalResp.output_text = collectedText;
    if (!finalResp.id) finalResp.id = randomRespId();
    if (!finalResp.object) finalResp.object = 'response';
    return finalResp;
  }

  return {
    id: randomRespId(),
    object: 'response',
    created: nowSec(),
    output,
    output_text: collectedText,
    usage: null,
    status: 'completed',
  };
}

/**
 * Translate a Codex /responses SSE stream into a Node Readable that emits
 * OpenAI chat.completion.chunk SSE frames.
 */
function codexStreamToChatChunks(stream, model) {
  const out = new Readable({ read() {} });
  const id = randomChatcmplId();
  const created = nowSec();
  let toolCallIndex = 0;
  // Tracks streaming tool calls keyed by Responses-API output index so we can
  // emit the `function.arguments` deltas as chat-completion tool_call deltas.
  const toolCalls = new Map();

  const writeChunk = (delta, finishReason = null, extra = {}) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: model || (extra && extra.model) || 'gpt-5-codex',
      choices: [
        {
          index: 0,
          delta: delta || {},
          finish_reason: finishReason,
        },
      ],
      ...(extra && extra.usage ? { usage: extra.usage } : {}),
    };
    out.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  (async () => {
    try {
      // Initial role chunk (matches OpenAI's first frame).
      writeChunk({ role: 'assistant', content: '' });

      let usage = null;
      let lastFinish = 'stop';

      for await (const ev of iterateSseEvents(stream)) {
        if (!ev || !ev.data) continue;
        const t = ev.event || ev.data.type || '';

        if (t === 'response.output_text.delta' || t === 'response.text.delta') {
          const text = ev.data.delta || ev.data.text || '';
          if (text) writeChunk({ content: text });
          continue;
        }

        if (t === 'response.output_item.added' && ev.data.item && ev.data.item.type === 'function_call') {
          const item = ev.data.item;
          const idx = toolCallIndex++;
          toolCalls.set(ev.data.output_index ?? item.id ?? idx, idx);
          writeChunk({
            tool_calls: [
              {
                index: idx,
                id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
                type: 'function',
                function: {
                  name: item.name || '',
                  arguments: typeof item.arguments === 'string' ? item.arguments : '',
                },
              },
            ],
          });
          lastFinish = 'tool_calls';
          continue;
        }

        if (t === 'response.function_call_arguments.delta') {
          const key = ev.data.output_index ?? ev.data.item_id;
          const idx = toolCalls.has(key) ? toolCalls.get(key) : 0;
          const argsDelta = ev.data.delta || '';
          if (argsDelta) {
            writeChunk({
              tool_calls: [
                {
                  index: idx,
                  function: { arguments: argsDelta },
                },
              ],
            });
          }
          lastFinish = 'tool_calls';
          continue;
        }

        if (t === 'response.completed' || t === 'response.done') {
          const r = ev.data.response || ev.data;
          if (r && r.usage) {
            const u = r.usage;
            usage = {
              prompt_tokens: Number(u.input_tokens || u.prompt_tokens || 0) || 0,
              completion_tokens: Number(u.output_tokens || u.completion_tokens || 0) || 0,
              total_tokens: Number(u.total_tokens || 0) || 0,
            };
            if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          }
          if (r && r.status === 'incomplete') lastFinish = 'length';
          break;
        }

        if (t === 'response.failed' || t === 'error') {
          const message = (ev.data.error && ev.data.error.message) || ev.data.message || 'Codex stream error';
          out.push(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: model || 'gpt-5-codex',
            choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
            error: { message, type: 'provider_error', code: 'codex_stream_error' },
          })}\n\n`);
          out.push('data: [DONE]\n\n');
          out.push(null);
          return;
        }
      }

      // Final frame with finish_reason + usage.
      writeChunk({}, lastFinish, usage ? { usage } : {});
      out.push('data: [DONE]\n\n');
      out.push(null);
    } catch (err) {
      out.push(`data: ${JSON.stringify({
        error: { message: err.message, type: 'provider_error', code: 'codex_stream_failed' },
      })}\n\n`);
      out.push('data: [DONE]\n\n');
      out.push(null);
    }
  })();

  // Wrap as web-style ReadableStream-ish object so modelProxy.streamResultToClient works.
  return readableToWebLike(out);
}

/**
 * Wrap a Node Readable into a minimal object exposing `getReader()` so the
 * existing streamResultToClient consumer (which calls `getReader()`) works.
 */
function readableToWebLike(readable) {
  const it = readable[Symbol.asyncIterator]();
  return {
    getReader() {
      return {
        async read() {
          const r = await it.next();
          if (r.done) return { done: true, value: undefined };
          const value = typeof r.value === 'string' ? Buffer.from(r.value) : r.value;
          return { done: false, value };
        },
        releaseLock() { /* noop */ },
        cancel() { try { readable.destroy(); } catch { /* noop */ } },
      };
    },
  };
}

/**
 * Convert a fully-collected Codex /responses body into an OpenAI
 * chat.completion body.
 */
function responsesBodyToChatBody(resp, requestedModel) {
  const out = Array.isArray(resp && resp.output) ? resp.output : [];
  let content = '';
  const toolCalls = [];

  for (const item of out) {
    if (!item) continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && part.type === 'output_text' && typeof part.text === 'string') {
          content += part.text;
        }
      }
      continue;
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
        type: 'function',
        function: {
          name: item.name || '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
    }
  }

  const message = { role: 'assistant', content: content || (toolCalls.length ? '' : '') };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = (resp && resp.usage) ? {
    prompt_tokens: Number(resp.usage.input_tokens || resp.usage.prompt_tokens || 0) || 0,
    completion_tokens: Number(resp.usage.output_tokens || resp.usage.completion_tokens || 0) || 0,
    total_tokens: Number(resp.usage.total_tokens || 0) || 0,
  } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

  return {
    id: randomChatcmplId(),
    object: 'chat.completion',
    created: Number(resp && resp.created) || nowSec(),
    model: requestedModel || (resp && resp.model) || 'gpt-5-codex',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : (resp && resp.status === 'incomplete' ? 'length' : 'stop'),
      },
    ],
    usage,
  };
}

module.exports = CodexProvider;
module.exports.classifySubscription = classifySubscription;
// Test-only exports — not part of the stable surface.
module.exports.__test = {
  chatPayloadToCodexBody,
  userContentToCodexContent,
  normalizeImagePartForCodex,
};
