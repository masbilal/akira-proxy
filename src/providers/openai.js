'use strict';

const BaseProvider = require('./base');
const { safeJsonParse } = require('../utils/common');

/**
 * Generic OpenAI-compatible adapter.
 *
 * Works for any upstream that accepts OpenAI-style `POST {base_url}/chat/completions`
 * and/or `POST {base_url}/responses` requests with a Bearer token.
 *
 * `config_json` options:
 *   - headers:        { [k]: v }  extra static headers
 *   - path:           string      override chat path (default "/chat/completions")
 *   - responses_path: string      override responses path (default "/responses")
 */
class OpenAIProvider extends BaseProvider {
  _buildUrl(subpath) {
    const base = String(this.provider.base_url || '').replace(/\/+$/, '');
    return base + subpath;
  }

  _buildHeaders() {
    const account = this.provider.account || {};
    const cfg = safeJsonParse(account.config_json || this.provider.config_json, {});
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    };
    const apiKey = account.api_key || this.provider.api_key;
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`;
    }
    if (cfg && cfg.headers && typeof cfg.headers === 'object') {
      for (const [k, v] of Object.entries(cfg.headers)) headers[k.toLowerCase()] = String(v);
    }
    return headers;
  }

  async _postJson(path, payload, { signal } = {}) {
    const url = this._buildUrl(path);
    const res = await fetch(url, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    if (payload.stream) {
      // Return the raw body stream for SSE passthrough
      return { status: res.status, headers, stream: res.body };
    }

    // Non-streaming: parse JSON (or fall back to text)
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, headers, body };
  }

  async chatCompletions(payload, { signal } = {}) {
    const account = this.provider.account || {};
    const cfg = safeJsonParse(account.config_json || this.provider.config_json, {});
    const path = cfg.path || '/chat/completions';
    return this._postJson(path, payload, { signal });
  }

  async responses(payload, { signal } = {}) {
    const account = this.provider.account || {};
    const cfg = safeJsonParse(account.config_json || this.provider.config_json, {});
    const path = cfg.responses_path || '/responses';
    return this._postJson(path, payload, { signal });
  }

  async listModels() {
    try {
      const url = this._buildUrl('/models');
      const res = await fetch(url, { headers: this._buildHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.data)) return data.data;
      return [];
    } catch {
      return [];
    }
  }
}

module.exports = OpenAIProvider;
