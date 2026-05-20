'use strict';

const db = require('../db');
const { getAdapter } = require('../providers');
const {
  attachAccount,
  clearAccountError,
  clearProviderCurrentAccount,
  listProviderAccounts,
  markAccountError,
  markAccountExhausted,
  pickProviderAccount,
  shouldMarkExhausted,
} = require('./accounts');
const { warmupKiroAccount } = require('./kiroWarmup');
const { scheduleAfterRequest: scheduleKiroCooldown } = require('./kiroCooldown');
const { scheduleAfterRequest: scheduleCodexCooldown } = require('./codexCooldown');
const { insertLog } = require('./logger');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function errorBody(status, message, type, code) {
  return {
    status,
    body: {
      error: {
        message,
        type,
        ...(code ? { code } : {}),
      },
    },
  };
}

function resolveModelMapping(requestedModel) {
  return db.prepare(`
    SELECT m.*, p.id AS provider_id, p.enabled AS provider_enabled
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.name = ? AND m.enabled = 1 AND p.enabled = 1
      AND m.deleted_at IS NULL AND p.deleted_at IS NULL
  `).get(requestedModel);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens)) || 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function isUsageObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    'prompt_tokens' in value ||
    'completion_tokens' in value ||
    'input_tokens' in value ||
    'output_tokens' in value ||
    'total_tokens' in value
  );
}

function findUsageObject(value, seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (isUsageObject(value)) return value;

  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    const found = findUsageObject(entry, seen, depth + 1);
    if (found) return found;
  }

  return null;
}

function extractUsageMetrics(value) {
  return normalizeUsage(findUsageObject(value));
}

function mergeUsageMetrics(current, next) {
  if (!next.total_tokens && !next.prompt_tokens && !next.completion_tokens) {
    return current;
  }

  if (next.total_tokens >= current.total_tokens) return next;
  if (next.prompt_tokens >= current.prompt_tokens || next.completion_tokens >= current.completion_tokens) {
    return {
      prompt_tokens: Math.max(current.prompt_tokens, next.prompt_tokens),
      completion_tokens: Math.max(current.completion_tokens, next.completion_tokens),
      total_tokens: Math.max(current.total_tokens, next.total_tokens),
    };
  }

  return current;
}

function copyProxyHeaders(res, headers = {}, { stream = false } = {}) {
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (stream && lower === 'content-type') continue;
    res.setHeader(name, value);
  }
}

function extractErrorMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 500);
  if (body.error && typeof body.error.message === 'string') return body.error.message;
  return null;
}

function extractErrorCode(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.error && typeof body.error.code === 'string') return body.error.code;
  return null;
}

function extractErrorType(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.error && typeof body.error.type === 'string') return body.error.type;
  return null;
}

function shouldRetryWithAnotherAccount(result) {
  if (!result || typeof result.status !== 'number') return false;
  if ([401, 403, 408, 409, 423, 425, 429].includes(result.status)) return true;
  if (result.status >= 500) return true;

  const errorType = extractErrorType(result.body);
  return errorType === 'provider_error' || errorType === 'provider_auth_error';
}

function shouldQueueTokenRefresh(result, fallbackMessage) {
  const status = Number(result && result.status) || 0;
  const text = `${extractErrorCode(result && result.body) || ''} ${extractErrorType(result && result.body) || ''} ${fallbackMessage || ''}`.toLowerCase();
  if (status === 401 || status === 403) return true;
  return /token|refresh|auth|expired|unauthor/i.test(text);
}

function shouldRetryThrownError(err) {
  const text = String(err && err.message ? err.message : err).toLowerCase();
  return /timeout|timed out|socket|network|fetch failed|econnreset|econnrefused|enotfound|proxy/i.test(text);
}

function looksRateLimitedResult(result) {
  if (!result) return false;
  const status = Number(result.status || 0) || 0;
  const text = `${extractErrorMessage(result.body) || ''} ${extractErrorCode(result.body) || ''} ${extractErrorType(result.body) || ''}`.toLowerCase();
  return status === 429 || /rate|throttle|too many|quota|limit/.test(text);
}

async function handleQuotaOrRateLimit(providerRow, accountRow, result) {
  const message = extractErrorMessage(result.body) || `upstream ${result.status}`;
  const code = extractErrorCode(result.body);

  if (providerRow.type === 'kiro') {
    try {
      const warmed = await warmupKiroAccount(providerRow, accountRow, { clearErrorOnAvailable: false });
      if (warmed.hasRemainingCredits) {
        markAccountError(accountRow.id, message, {
          status: result.status,
          code,
          kind: 'rate_limited',
          label: 'rate limited',
          cooldownSec: 180,
          needsWarmup: true,
        });
        clearProviderCurrentAccount(providerRow.id, accountRow.id);
        return 'rate_limited';
      }
      if (warmed.isExhausted) {
        markAccountExhausted(accountRow.id);
        clearProviderCurrentAccount(providerRow.id, accountRow.id);
        return 'exhausted';
      }
    } catch {
      // If the warmup probe fails, fall back to the previous conservative behavior.
    }
  }

  if (providerRow.type === 'codex') {
    try {
      const { warmupCodexAccount } = require('./codexWarmup');
      const warmed = await warmupCodexAccount(providerRow, accountRow, { clearErrorOnAvailable: false });
      if (warmed.isExhausted) {
        markAccountExhausted(accountRow.id);
        clearProviderCurrentAccount(providerRow.id, accountRow.id);
        return 'exhausted';
      }
      if (warmed.hasRemainingCredits) {
        // Primary (5h) bucket likely hit — cool down for the window's reset
        // time if we can read it, else default to 5 minutes.
        const primary = warmed.subscription && warmed.subscription.primary;
        const resetAt = Number(primary && primary.reset_at) || 0;
        const ttlSec = resetAt > 0
          ? Math.max(60, Math.min(3600, resetAt - Math.floor(Date.now() / 1000)))
          : 300;
        markAccountError(accountRow.id, message, {
          status: result.status,
          code,
          kind: 'rate_limited',
          label: 'rate limited',
          cooldownSec: ttlSec,
          needsWarmup: true,
        });
        clearProviderCurrentAccount(providerRow.id, accountRow.id);
        return 'rate_limited';
      }
    } catch {
      // Fallthrough to default exhausted marking.
    }
  }

  markAccountExhausted(accountRow.id);
  clearProviderCurrentAccount(providerRow.id, accountRow.id);
  return 'exhausted';
}

async function streamResultToClient(res, result) {
  const reader = result.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      res.write(chunk);

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const match = /^data:\s?(.*)$/.exec(line);
        if (!match) continue;
        const payload = match[1].trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          usage = mergeUsageMetrics(usage, extractUsageMetrics(parsed));
        } catch {
          // Ignore non-JSON SSE payloads.
        }
      }
    }
  } finally {
    res.end();
  }

  return usage;
}

async function proxyModelRequest({
  body,
  res,
  apiKeyId = null,
  adapterMethod,
  endpoint,
}) {
  const started = Date.now();
  const requestBody = body || {};
  const requestedModel = requestBody.model;
  const stream = Boolean(requestBody.stream);

  if (!requestedModel) {
    const missing = errorBody(400, 'Missing `model` field', 'invalid_request_error');
    res.status(missing.status).json(missing.body);
    return;
  }

  const mapping = resolveModelMapping(requestedModel);
  if (!mapping) {
    const missing = errorBody(
      404,
      `Model '${requestedModel}' is not available on this router`,
      'invalid_request_error'
    );
    res.status(missing.status).json(missing.body);
    return;
  }

  const providerRow = db.prepare('SELECT * FROM providers WHERE id = ?').get(mapping.provider_id);
  const availableAccounts = listProviderAccounts(providerRow, { accountTier: mapping.account_tier });
  if (providerRow.type === 'kiro' && !availableAccounts.length) {
    const unavailable = errorBody(
      503,
      `No eligible ${mapping.account_tier || 'any'} Kiro account is available for model '${requestedModel}'`,
      'provider_account_unavailable'
    );
    res.status(unavailable.status).json(unavailable.body);
    return;
  }

  const upstreamPayload = { ...requestBody, model: mapping.upstream_model };
  const maxAttempts = Math.max(1, availableAccounts.length || 1);
  let finalResult = null;
  let finalThrownError = null;
  let finalAccountRow = null;
  const attemptedAccountIds = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentProviderRow = db.prepare('SELECT * FROM providers WHERE id = ?').get(mapping.provider_id);
    const accountRow = pickProviderAccount(currentProviderRow, {
      accountTier: mapping.account_tier,
      excludeAccountIds: Array.from(attemptedAccountIds),
    });
    if (currentProviderRow.type === 'kiro' && !accountRow) break;
    if (accountRow) attemptedAccountIds.add(accountRow.id);

    const routedProvider = attachAccount(currentProviderRow, accountRow);
    let adapter;
    try {
      adapter = getAdapter(routedProvider);
    } catch (err) {
      const failure = errorBody(500, err.message, 'provider_error');
      res.status(failure.status).json(failure.body);
      return;
    }

    if (typeof adapter[adapterMethod] !== 'function') {
      const unsupported = errorBody(
        501,
        `Provider '${currentProviderRow.name}' does not implement ${adapterMethod}()`,
        'unsupported_feature'
      );
      res.status(unsupported.status).json(unsupported.body);
      return;
    }

    try {
      const result = await adapter[adapterMethod](upstreamPayload, { stream });
      finalResult = result;
      finalThrownError = null;
      finalAccountRow = accountRow;

      if (result.stream && stream) {
        res.status(result.status);
        copyProxyHeaders(res, result.headers, { stream: true });
        res.setHeader('content-type', result.headers?.['content-type'] || 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');

        try {
          const usage = await streamResultToClient(res, result);
          if (accountRow) clearAccountError(accountRow.id);
          if (accountRow && currentProviderRow.type === 'kiro') {
            scheduleKiroCooldown(currentProviderRow, accountRow.id);
          }
          if (accountRow && currentProviderRow.type === 'codex') {
            scheduleCodexCooldown(currentProviderRow, accountRow.id);
          }
          insertLog({
            api_key_id: apiKeyId,
            provider_id: currentProviderRow.id,
            provider_account_id: accountRow ? accountRow.id : null,
            model_name: requestedModel,
            endpoint,
            status_code: result.status,
            duration_ms: Date.now() - started,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            stream: true,
          });
        } catch (err) {
          if (accountRow && shouldRetryThrownError(err)) {
            markAccountError(accountRow.id, String(err && err.message ? err.message : err), {
              status: 502,
              code: 'stream_proxy_error',
              queueTokenRefresh: Boolean(accountRow.refresh_token),
              tokenRefreshReason: String(err && err.message ? err.message : err),
            });
            clearProviderCurrentAccount(currentProviderRow.id, accountRow.id);
          }
          insertLog({
            api_key_id: apiKeyId,
            provider_id: currentProviderRow.id,
            provider_account_id: accountRow ? accountRow.id : null,
            model_name: requestedModel,
            endpoint,
            status_code: 502,
            duration_ms: Date.now() - started,
            stream: true,
            error: String(err && err.message ? err.message : err),
          });
        }
        return;
      }

      const accountFailure = accountRow && shouldRetryWithAnotherAccount(result);
      const retryable = accountFailure && attempt + 1 < maxAttempts;
      if (accountRow && result.status >= 400) {
        if ((currentProviderRow.type === 'kiro' || currentProviderRow.type === 'codex') && looksRateLimitedResult(result)) {
          await handleQuotaOrRateLimit(currentProviderRow, accountRow, result);
        } else if (shouldMarkExhausted(result)) {
          await handleQuotaOrRateLimit(currentProviderRow, accountRow, result);
        } else if (accountFailure) {
          markAccountError(accountRow.id, extractErrorMessage(result.body) || `upstream ${result.status}`, {
            status: result.status,
            code: extractErrorCode(result.body),
            queueTokenRefresh: Boolean(accountRow.refresh_token) && shouldQueueTokenRefresh(result, extractErrorMessage(result.body)),
            tokenRefreshReason: extractErrorMessage(result.body) || `upstream_${result.status}`,
          });
          clearProviderCurrentAccount(currentProviderRow.id, accountRow.id);
        }
      }

      if (retryable) {
        continue;
      }

      if (accountRow && result.status < 400) {
        clearAccountError(accountRow.id);
        if (currentProviderRow.type === 'kiro') {
          scheduleKiroCooldown(currentProviderRow, accountRow.id);
        }
        if (currentProviderRow.type === 'codex') {
          scheduleCodexCooldown(currentProviderRow, accountRow.id);
        }
      }
      break;
    } catch (err) {
      finalThrownError = err;
      finalResult = null;
      finalAccountRow = accountRow;

      const accountFailure = accountRow && shouldRetryThrownError(err);
      const retryable = accountFailure && attempt + 1 < maxAttempts;
      if (accountRow && accountFailure) {
        markAccountError(accountRow.id, String(err && err.message ? err.message : err), {
          status: 500,
          code: 'proxy_error',
          queueTokenRefresh: Boolean(accountRow.refresh_token),
          tokenRefreshReason: String(err && err.message ? err.message : err),
        });
        clearProviderCurrentAccount(currentProviderRow.id, accountRow.id);
      }
      if (retryable) {
        continue;
      }
      break;
    }
  }

  if (finalResult) {
    res.status(finalResult.status);
    copyProxyHeaders(res, finalResult.headers);
    if (finalResult.headers && finalResult.headers['content-type']) {
      res.setHeader('content-type', finalResult.headers['content-type']);
    }

    const usage = extractUsageMetrics(finalResult.body);
    insertLog({
      api_key_id: apiKeyId,
      provider_id: providerRow.id,
      provider_account_id: finalAccountRow ? finalAccountRow.id : null,
      model_name: requestedModel,
      endpoint,
      status_code: finalResult.status,
      duration_ms: Date.now() - started,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      stream: false,
      error: finalResult.status >= 400 ? extractErrorMessage(finalResult.body) : null,
    });

    res.send(finalResult.body);
    return;
  }

  insertLog({
    api_key_id: apiKeyId,
    provider_id: providerRow.id,
    provider_account_id: finalAccountRow ? finalAccountRow.id : null,
    model_name: requestedModel,
    endpoint,
    status_code: 500,
    duration_ms: Date.now() - started,
    stream,
    error: String(finalThrownError && finalThrownError.message ? finalThrownError.message : finalThrownError || 'Unknown proxy error'),
  });
  res.status(500).json({
    error: { message: String(finalThrownError && finalThrownError.message ? finalThrownError.message : finalThrownError || 'Unknown proxy error'), type: 'proxy_error' },
  });
}

module.exports = {
  extractUsageMetrics,
  proxyModelRequest,
};
