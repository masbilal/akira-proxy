'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const BaseProvider = require('./base');
const { safeJsonParse } = require('../utils/common');
const { parseEventStream } = require('./_eventstream');
const db = require('../db');
const { resolveProxy, buildProxyAgent, logProxyUsage } = require('../services/proxyService');

// Some Windows/local setups expose a certificate chain that Node's bundled CA
// store cannot verify for Kiro/Amazon Q endpoints, while Chromium and
// PowerShell can. Allow an opt-out via KIRO_STRICT_TLS=1.
if (process.env.KIRO_STRICT_TLS !== '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

/**
 * Kiro adapter — OAuth PKCE flow against auth.desktop.kiro.dev,
 * chat via the native CodeWhisperer/Kiro generateAssistantResponse endpoint.
 *
 * Tokens are obtained by `scripts/login-kiro.js` (OAuth PKCE) and stored in
 * provider_accounts. Older provider-row tokens are still read as a fallback.
 */

const REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const Q_USAGE_BASE = 'https://q.us-east-1.amazonaws.com';
const KIRO_GENERATE_URL = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse';
const UA = 'akira-proxy/0.1.0 (Kiro adapter)';
const KIRO_IDE_UA = 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0';
const KIRO_AMZ_UA = 'aws-sdk-js/3.0.0 kiro-ide/1.0.0';
const DEFAULT_CLI_PATH = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Local', 'Kiro-Cli', 'kiro-cli.exe')
  : path.join(os.homedir(), '.local', 'bin', 'kiro-cli');

/**
 * Classify a /getUsageLimits response body into a normalized subscription record.
 *
 * Observed upstream type values:
 *   Q_DEVELOPER_STANDALONE_FREE     → tier: "free"
 *   Q_DEVELOPER_STANDALONE_PRO      → tier: "pro"           (Kiro Pro)
 *   Q_DEVELOPER_STANDALONE_POWER    → tier: "power"         (Kiro Power)
 *   Q_DEVELOPER_ENTERPRISE          → tier: "enterprise"
 * Anything else → tier: "unknown"
 *
 * Heuristic fallbacks use `subscriptionTitle` (e.g. "KIRO FREE", "KIRO PRO")
 * and `upgradeCapability` (UPGRADE_CAPABLE strongly implies free tier).
 */
function classifySubscription(body) {
  if (!body || typeof body !== 'object') return { tier: 'unknown' };
  const info = body.subscriptionInfo || {};
  const type = String(info.type || '').toUpperCase();
  const title = String(info.subscriptionTitle || '').toUpperCase();
  const upgradeCap = String(info.upgradeCapability || '').toUpperCase();

  let tier = 'unknown';
  if (/FREE/.test(type) || /FREE/.test(title)) tier = 'free';
  else if (/PRO(?!FESSIONAL)?/.test(type) || /PRO/.test(title)) tier = 'pro';
  else if (/POWER/.test(type) || /POWER/.test(title)) tier = 'power';
  else if (/ENTERPRISE/.test(type) || /ENTERPRISE/.test(title)) tier = 'enterprise';
  else if (upgradeCap === 'UPGRADE_CAPABLE') tier = 'free';

  // Pull usage numbers from the first usageBreakdownList entry (credits).
  const breakdown = Array.isArray(body.usageBreakdownList) ? body.usageBreakdownList[0] : null;
  const usage = breakdown
    ? {
        limit: Number(breakdown.usageLimit ?? 0),
        current: Number(breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0),
        unit: breakdown.displayName || 'Credits',
        overageCap: Number(breakdown.overageCap ?? 0),
        overageRate: Number(breakdown.overageRate ?? 0),
      }
    : null;

  return {
    tier,
    type: info.type || null,
    title: info.subscriptionTitle || null,
    upgradeCapability: info.upgradeCapability || null,
    overageCapability: info.overageCapability || null,
    overageStatus: body.overageConfiguration?.overageStatus || null,
    daysUntilReset: body.daysUntilReset || 0,
    nextResetAt: body.nextDateReset || null,
    usage,
    capturedAt: Math.floor(Date.now() / 1000),
  };
}

function payloadUsesVision(payload) {
  const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
  return messages.some((message) => {
    if (!message) return false;
    const parts = Array.isArray(message.content)
      ? message.content
      : [message.content].filter(Boolean);
    return parts.some((part) => (
      part &&
      (
        part.type === 'input_image' ||
        part.type === 'image_url' ||
        part.type === 'image_file' ||
        part.image_url ||
        part.file_id
      )
    ));
  });
}

function responsesPayloadUsesVision(payload) {
  const input = payload && payload.input;
  if (!Array.isArray(input)) return false;

  return input.some((item) => {
    if (!item) return false;
    if (item.type === 'input_image' || item.type === 'image_url' || item.type === 'image_file') {
      return true;
    }
    const parts = Array.isArray(item.content)
      ? item.content
      : [item.content].filter(Boolean);
    return parts.some((part) => (
      part &&
      (
        part.type === 'input_image' ||
        part.type === 'image_url' ||
        part.type === 'image_file' ||
        part.image_url ||
        part.file_id
      )
    ));
  });
}

function unsupportedVisionResponse() {
  return {
    status: 501,
    headers: { 'content-type': 'application/json' },
    body: {
      error: {
        message:
          'The Kiro CLI headless runtime currently supports plain text chat only. ' +
          'Switch to KIRO_RUNTIME=http for image inputs.',
        type: 'unsupported_feature',
        code: 'kiro_vision_not_supported',
      },
    },
  };
}

function commandExists(candidate) {
  return Boolean(candidate && typeof candidate === 'string' && !candidate.includes(path.sep));
}

function resolveCliPath(cfg = {}) {
  const configured = cfg.cliPath || process.env.KIRO_CLI_PATH;
  const candidates = [
    configured,
    DEFAULT_CLI_PATH,
    process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    if (candidate.includes(path.sep)) {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
      continue;
    }
    if (commandExists(candidate)) return candidate;
  }

  return null;
}

function resolveCliApiKey(cfg = {}) {
  return cfg.apiKey || process.env.KIRO_API_KEY || null;
}

function resolveCliRuntimeMode(cfg = {}) {
  return String(cfg.runtime || process.env.KIRO_RUNTIME || 'auto').trim().toLowerCase();
}

function shouldUseCliRuntime(cfg = {}) {
  const mode = resolveCliRuntimeMode(cfg);
  if (mode === 'http' || mode === 'upstream') return false;
  if (mode === 'cli') return true;
  return Boolean(resolveCliPath(cfg) && resolveCliApiKey(cfg));
}

function cliUnavailableResponse(cliPathHint) {
  return {
    status: 503,
    headers: { 'content-type': 'application/json' },
    body: {
      error: {
        message:
          'Kiro CLI headless mode is enabled, but `kiro-cli` was not found. ' +
          `Set KIRO_CLI_PATH or install Kiro CLI.${cliPathHint ? ` Looked for: ${cliPathHint}` : ''}`,
        type: 'provider_config_error',
        code: 'kiro_cli_not_found',
      },
    },
  };
}

function cliAuthMissingResponse() {
  return {
    status: 401,
    headers: { 'content-type': 'application/json' },
    body: {
      error: {
        message:
          'Kiro CLI headless mode requires a Kiro API key. Set `KIRO_API_KEY` in the server ' +
          'environment or store `apiKey` in the Kiro provider config before using coding tools.',
        type: 'provider_auth_error',
        code: 'kiro_cli_api_key_missing',
      },
    },
  };
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
        if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image_file') {
          return '[image omitted]';
        }
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

function messagesToCliPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';

  return messages
    .map((message) => {
      if (!message || !message.role) return '';
      const text = normalizeContentText(message.content).trim();
      if (!text) return '';
      return `[${message.role}]\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function responsesToCliPrompt(payload) {
  const blocks = [];
  const instructions = normalizeContentText(payload && payload.instructions).trim();
  if (instructions) {
    blocks.push(`[system]\n${instructions}`);
  }

  const input = payload && payload.input;
  if (typeof input === 'string') {
    blocks.push(`[user]\n${input}`);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (item.type === 'message' || item.role) {
        const role = item.role || 'user';
        const text = normalizeContentText(item.content).trim();
        if (text) blocks.push(`[${role}]\n${text}`);
        continue;
      }
      if (item.type === 'input_text' || item.type === 'text') {
        const text = normalizeContentText(item.text || item.content).trim();
        if (text) blocks.push(`[user]\n${text}`);
        continue;
      }
      if (item.type === 'input_image' || item.type === 'image_url' || item.type === 'image_file') {
        blocks.push('[user]\n[image omitted]');
      }
    }
  } else if (input && typeof input === 'object') {
    const role = input.role || 'user';
    const text = normalizeContentText(input.content).trim();
    if (text) blocks.push(`[${role}]\n${text}`);
  }

  return blocks.join('\n\n');
}

function messagesToKiroContent(messages) {
  if (!Array.isArray(messages) || !messages.length) return { content: '', history: [] };
  const out = { content: '', history: [] };
  // The last user message becomes `content`. All prior messages become history
  // formatted as "role: content" blocks (simple, works well enough).
  const last = messages[messages.length - 1];
  out.content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content ?? '');
  // Build history: pair up user+assistant turns
  const prior = messages.slice(0, -1);
  let pendingUser = null;
  for (const m of prior) {
    const text =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (m.role === 'user' || m.role === 'system') {
      if (pendingUser) out.history.push({ userInputMessage: { content: pendingUser }, assistantResponseMessage: { content: '' } });
      pendingUser = m.role === 'system' ? `[system]\n${text}` : text;
    } else if (m.role === 'assistant') {
      out.history.push({
        userInputMessage: { content: pendingUser || '' },
        assistantResponseMessage: { content: text },
      });
      pendingUser = null;
    }
  }
  if (pendingUser) {
    // Dangling user message that's not the last one — rare; prepend to main content
    out.content = pendingUser + '\n\n' + out.content;
  }
  return out;
}

function safeArgsString(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function parseToolArguments(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return { value };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
    return { value: parsed };
  } catch {
    return { raw: value };
  }
}

function normalizeToolSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, required: [] };
  }
  return {
    ...schema,
    required: Array.isArray(schema.required) ? schema.required : [],
  };
}

function convertOpenAIToolsToKiro(tools) {
  if (!Array.isArray(tools) || !tools.length) return [];

  return tools
    .map((tool) => {
      const spec = tool && (tool.function || tool);
      const name = spec && spec.name ? String(spec.name) : '';
      if (!name) return null;

      return {
        toolSpecification: {
          name,
          description: spec.description ? String(spec.description) : `Tool: ${name}`,
          inputSchema: {
            json: normalizeToolSchema(spec.parameters || spec.input_schema),
          },
        },
      };
    })
    .filter(Boolean);
}

function inferImageFormatFromMime(mime) {
  const normalized = String(mime || '').toLowerCase();
  if (!normalized.includes('/')) return 'png';
  return normalized.split('/')[1].split(';')[0].split('+')[0] || 'png';
}

function extractImageUrlFromPart(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.image_url === 'string') return part.image_url;
  if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
  if (typeof part.url === 'string') return part.url;
  return '';
}

function isImageContentPart(part) {
  return Boolean(
    part &&
    (
      part.type === 'image_url' ||
      part.type === 'input_image' ||
      part.type === 'image_file' ||
      part.file_id
    )
  );
}

async function imagePartToKiroImage(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.file_id) {
    const err = new Error('Kiro image_file/file_id inputs are not implemented on this router.');
    err.code = 'kiro_image_file_not_supported';
    throw err;
  }

  const imageUrl = extractImageUrlFromPart(part);
  if (!imageUrl) return null;

  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/i.exec(imageUrl);
  if (dataUrlMatch) {
    return {
      format: inferImageFormatFromMime(dataUrlMatch[1]),
      source: { bytes: dataUrlMatch[2] },
    };
  }

  if (!/^https?:\/\//i.test(imageUrl)) {
    return null;
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    const err = new Error(`Failed to fetch image URL: ${response.status}`);
    err.code = 'kiro_image_fetch_failed';
    throw err;
  }

  const mime = response.headers.get('content-type') || 'image/png';
  const bytes = Buffer.from(await response.arrayBuffer()).toString('base64');
  return {
    format: inferImageFormatFromMime(mime),
    source: { bytes },
  };
}

async function extractUserTextAndImages(content) {
  if (typeof content === 'string') {
    return { text: content.trim(), images: [] };
  }
  if (content && typeof content === 'object' && !Array.isArray(content) && isImageContentPart(content)) {
    const image = await imagePartToKiroImage(content);
    return { text: '', images: image ? [image] : [] };
  }
  if (!Array.isArray(content)) {
    return { text: normalizeContentText(content).trim(), images: [] };
  }

  const textParts = [];
  const images = [];

  for (const part of content) {
    if (!part || part.type === 'tool_result') continue;

    if (isImageContentPart(part)) {
      const image = await imagePartToKiroImage(part);
      if (image) {
        images.push(image);
      } else {
        const imageUrl = extractImageUrlFromPart(part);
        if (imageUrl) textParts.push(`[Image: ${imageUrl}]`);
      }
      continue;
    }

    if (typeof part === 'string') {
      textParts.push(part);
      continue;
    }

    if (typeof part.text === 'string') {
      textParts.push(part.text);
      continue;
    }

    if (typeof part.content === 'string' || Array.isArray(part.content)) {
      const text = normalizeContentText(part.content).trim();
      if (text) textParts.push(text);
    }
  }

  return {
    text: textParts.join('\n').trim(),
    images,
  };
}

function inferKiroToolsFromMessages(messages) {
  const names = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;

    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = call && call.function && call.function.name;
        if (name) names.add(String(name));
      }
    }

    if (message.function_call && message.function_call.name) {
      names.add(String(message.function_call.name));
    }

    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'tool_use' && block.name) {
          names.add(String(block.name));
        }
      }
    }
  }

  return Array.from(names).map((name) => ({
    toolSpecification: {
      name,
      description: `Tool: ${name}`,
      inputSchema: {
        json: { type: 'object', properties: {}, required: [] },
      },
    },
  }));
}

function contentTextExcludingToolResults(content) {
  if (!Array.isArray(content)) return normalizeContentText(content).trim();

  return content
    .filter((part) => part && part.type !== 'tool_result')
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
    .join('\n')
    .trim();
}

function normalizeToolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return normalizeContentText(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return typeof part.text === 'string' ? part.text : normalizeContentText(part);
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeAssistantToolUses(message) {
  const out = [];

  if (Array.isArray(message && message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = call && call.function;
      if (!fn || !fn.name) continue;
      out.push({
        toolUseId: call.id || `call_${crypto.randomUUID()}`,
        name: fn.name,
        input: parseToolArguments(fn.arguments),
      });
    }
  }

  if (message && message.function_call && message.function_call.name) {
    out.push({
      toolUseId: message.tool_call_id || `call_${crypto.randomUUID()}`,
      name: message.function_call.name,
      input: parseToolArguments(message.function_call.arguments),
    });
  }

  if (Array.isArray(message && message.content)) {
    for (const block of message.content) {
      if (!block || block.type !== 'tool_use') continue;
      out.push({
        toolUseId: block.id || block.tool_use_id || `call_${crypto.randomUUID()}`,
        name: block.name || '',
        input: block.input && typeof block.input === 'object' ? block.input : parseToolArguments(block.input),
      });
    }
  }

  return out.filter((item) => item.name);
}

function toolChoiceInstruction(toolChoice) {
  if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none') return '';
  if (toolChoice === 'required') {
    return 'You must respond by calling one of the provided tools before giving any final answer.';
  }

  const chosenName = toolChoice && toolChoice.function && toolChoice.function.name;
  if (!chosenName) return '';
  return `You must respond by calling the tool named "${chosenName}" before giving any final answer.`;
}

async function convertOpenAIMessagesToKiro(messages, tools, model, toolChoice) {
  const history = [];
  let currentMessage = null;
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;

  const flushPending = () => {
    if (currentRole === 'user') {
      const userInputMessage = {
        content: pendingUserContent.join('\n\n').trim() || 'continue',
        modelId: model,
      };

      if (pendingImages.length > 0) {
        userInputMessage.images = pendingImages;
      }

      if (pendingToolResults.length > 0) {
        userInputMessage.userInputMessageContext = { toolResults: pendingToolResults };
      }

      if (tools.length > 0 && history.length === 0) {
        if (!userInputMessage.userInputMessageContext) {
          userInputMessage.userInputMessageContext = {};
        }
        userInputMessage.userInputMessageContext.tools = tools;
      }

      const userMsg = { userInputMessage };
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
      return;
    }

    if (currentRole === 'assistant') {
      history.push({
        assistantResponseMessage: {
          content: pendingAssistantContent.join('\n\n').trim() || '...',
        },
      });
      pendingAssistantContent = [];
    }
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !message.role) continue;

    let role = message.role;
    if (role === 'system' || role === 'tool' || role === 'function') role = 'user';

    if (currentRole !== null && role !== currentRole) flushPending();
    currentRole = role;

    if (role === 'user') {
      if (Array.isArray(message.content)) {
        const toolResultBlocks = message.content.filter((part) => part && part.type === 'tool_result');
        for (const block of toolResultBlocks) {
          pendingToolResults.push({
            toolUseId: block.tool_use_id || block.id || '',
            status: 'success',
            content: [{ text: normalizeToolResultText(block.content) }],
          });
        }
      }

      if (message.role === 'tool' || message.role === 'function') {
        pendingToolResults.push({
          toolUseId: message.tool_call_id || '',
          status: 'success',
          content: [{ text: normalizeContentText(message.content) }],
        });
      } else {
        const { text: content, images } = await extractUserTextAndImages(message.content);
        if (images.length > 0) pendingImages.push(...images);
        if (content) pendingUserContent.push(content);
      }
      continue;
    }

    if (role !== 'assistant') continue;

    const textContent = Array.isArray(message.content)
      ? message.content
          .filter((part) => part && part.type !== 'tool_use')
          .map((part) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (typeof part.text === 'string') return part.text;
            return '';
          })
          .filter(Boolean)
          .join('\n')
          .trim()
      : normalizeContentText(message.content).trim();

    const toolUses = normalizeAssistantToolUses(message);
    if (textContent) pendingAssistantContent.push(textContent);

    if (toolUses.length > 0) {
      flushPending();
      const last = history[history.length - 1];
      if (last && last.assistantResponseMessage) {
        last.assistantResponseMessage.toolUses = toolUses;
      }
      currentRole = null;
    }
  }

  if (currentRole !== null) flushPending();

  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  if (!currentMessage) {
    currentMessage = {
      userInputMessage: {
        content: 'continue',
        modelId: model,
      },
    };
  }

  const firstHistoryTools = history[0] &&
    history[0].userInputMessage &&
    history[0].userInputMessage.userInputMessageContext &&
    history[0].userInputMessage.userInputMessageContext.tools;

  for (const item of history) {
    if (item.userInputMessage && item.userInputMessage.userInputMessageContext) {
      delete item.userInputMessage.userInputMessageContext.tools;
      if (Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
        delete item.userInputMessage.userInputMessageContext;
      }
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  }

  const mergedHistory = [];
  for (const item of history) {
    const previous = mergedHistory[mergedHistory.length - 1];
    if (item.userInputMessage && previous && previous.userInputMessage) {
      previous.userInputMessage.content += `\n\n${item.userInputMessage.content}`;
      if (item.userInputMessage.userInputMessageContext && !previous.userInputMessage.userInputMessageContext) {
        previous.userInputMessage.userInputMessageContext = item.userInputMessage.userInputMessageContext;
      }
      continue;
    }
    mergedHistory.push(item);
  }

  if (firstHistoryTools) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = firstHistoryTools;
  }

  const choiceHint = toolChoiceInstruction(toolChoice);
  if (choiceHint) {
    currentMessage.userInputMessage.content = `${currentMessage.userInputMessage.content}\n\n[tool-choice]\n${choiceHint}`;
  }

  return { history: mergedHistory, currentMessage };
}

async function buildKiroChatRequest(payload, cfg) {
  const explicitTools = payload.tool_choice === 'none' ? [] : convertOpenAIToolsToKiro(payload.tools);
  const toolDefs = explicitTools.length > 0 ? explicitTools : inferKiroToolsFromMessages(payload.messages);
  const translated = await convertOpenAIMessagesToKiro(
    payload.messages || [],
    toolDefs,
    payload.model,
    payload.tool_choice
  );

  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: crypto.randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: translated.currentMessage.userInputMessage.content || 'continue',
          modelId: payload.model,
          origin: 'AI_EDITOR',
          ...(Array.isArray(translated.currentMessage.userInputMessage.images) &&
          translated.currentMessage.userInputMessage.images.length > 0
            ? { images: translated.currentMessage.userInputMessage.images }
            : {}),
          ...(translated.currentMessage.userInputMessage.userInputMessageContext
            ? { userInputMessageContext: translated.currentMessage.userInputMessage.userInputMessageContext }
            : {}),
        },
      },
      history: translated.history,
    },
    ...(cfg.profileArn ? { profileArn: cfg.profileArn } : {}),
  };
}

function extractKiroUsage(payload, currentUsage) {
  // Kiro's streaming protocol does NOT emit token counts today — only
  // `meteringEvent` (credit cost) and `contextUsageEvent` (context %). The
  // pre-release `metricsEvent` shape is still accepted here as a
  // forward-compat fallback in case the upstream ever starts returning real
  // token metrics. Anything else is ignored so we don't overwrite our
  // client-side estimate with `0`.
  const metrics = payload && (payload.metricsEvent || payload);
  if (!metrics || typeof metrics !== 'object') return currentUsage;

  const rawPrompt = metrics.inputTokens ?? metrics.prompt_tokens ?? null;
  const rawCompletion = metrics.outputTokens ?? metrics.completion_tokens ?? null;
  const rawTotal = metrics.totalTokens ?? metrics.total_tokens ?? null;

  if (rawPrompt == null && rawCompletion == null && rawTotal == null) {
    return currentUsage;
  }

  const promptTokens = Number(rawPrompt ?? currentUsage.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(rawCompletion ?? currentUsage.completion_tokens ?? 0) || 0;
  const totalTokens = Number(rawTotal ?? (promptTokens + completionTokens)) || 0;

  if (!promptTokens && !completionTokens && !totalTokens) return currentUsage;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

/**
 * Approximate token count for a UTF-8 string using the widely used
 * "~4 characters per token" heuristic (matches OpenAI's tiktoken "cl100k_base"
 * within ~5–10 % on mixed English/Indonesian/code prompts). Good enough for
 * usage telemetry; clients that need exact counts can tokenize upstream.
 */
function estimateTokensFromText(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : String(text);
  if (!str.length) return 0;
  // Use a conservative divisor of 4 (chars/token). Round up so a 1-char
  // message still counts as 1 token, mirroring how real tokenizers behave.
  return Math.max(1, Math.ceil(str.length / 4));
}

/**
 * Walk an OpenAI chat.completions `messages[]` array and estimate its total
 * prompt-token cost. Each message carries a small framing overhead (role
 * marker, separators) which we approximate at 3 tokens per message, mirroring
 * OpenAI's "every message follows <|start|>role\n content<|end|>" formula.
 */
function estimatePromptTokensFromMessages(messages, tools) {
  let total = 0;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg) continue;
      total += 3; // role/separator overhead
      if (msg.role) total += estimateTokensFromText(msg.role);
      if (msg.name) total += estimateTokensFromText(msg.name);
      if (typeof msg.content === 'string') {
        total += estimateTokensFromText(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (typeof part === 'string') {
            total += estimateTokensFromText(part);
          } else if (typeof part.text === 'string') {
            total += estimateTokensFromText(part.text);
          } else if (part.type === 'image_url' || part.type === 'input_image') {
            // OpenAI bills vision inputs at 85 tokens for the `low` detail
            // base cost; use that as a flat estimate since we can't fetch
            // the image dimensions reliably here.
            total += 85;
          }
        }
      } else if (msg.content && typeof msg.content === 'object') {
        try { total += estimateTokensFromText(JSON.stringify(msg.content)); } catch { /* ignore */ }
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || !tc.function) continue;
          if (tc.function.name) total += estimateTokensFromText(tc.function.name);
          if (tc.function.arguments) {
            total += estimateTokensFromText(
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments)
            );
          }
        }
      }
      if (msg.tool_call_id) total += estimateTokensFromText(msg.tool_call_id);
    }
    // Every reply is implicitly primed with <|start|>assistant<|message|>
    total += 3;
  }
  if (Array.isArray(tools) && tools.length) {
    try {
      total += estimateTokensFromText(JSON.stringify(tools));
    } catch { /* ignore */ }
  }
  return total;
}

function toolInputToArgumentText(value) {
  if (typeof value === 'string') return value;
  return safeArgsString(value);
}

function responsesPartToChatPart(part) {
  if (!part || typeof part !== 'object') return null;

  if (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') {
    return { type: 'text', text: part.text || part.content || '' };
  }

  if (part.type === 'input_image' || part.type === 'image_url' || part.type === 'image_file' || part.file_id) {
    const imageUrl = extractImageUrlFromPart(part);
    if (!imageUrl && !part.file_id) return null;
    if (part.file_id) return { type: 'image_file', file_id: part.file_id };
    return {
      type: 'image_url',
      image_url: {
        url: imageUrl,
        detail: part.detail || (part.image_url && part.image_url.detail) || 'auto',
      },
    };
  }

  if (typeof part.text === 'string') {
    return { type: 'text', text: part.text };
  }

  return null;
}

function normalizeResponseMessageContent(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const part = responsesPartToChatPart(content);
    if (part) return [part];
    return normalizeContentText(content);
  }
  if (!Array.isArray(content)) return normalizeContentText(content);

  return content
    .map((part) => responsesPartToChatPart(part))
    .filter(Boolean);
}

function responseOutputToToolContent(output) {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  if (Array.isArray(output)) return output.map((item) => normalizeContentText(item)).filter(Boolean).join('\n');
  return safeArgsString(output);
}

function responsesPayloadToChatPayload(payload) {
  const messages = [];

  if (payload && payload.instructions) {
    messages.push({ role: 'system', content: payload.instructions });
  }

  const appendItem = (item) => {
    if (!item) return;

    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      return;
    }

    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string' ? item.arguments : safeArgsString(item.arguments),
          },
        }],
      });
      return;
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.tool_call_id || item.id || '',
        content: responseOutputToToolContent(item.output),
      });
      return;
    }

    if (item.type === 'message' || item.role) {
      messages.push({
        role: item.role || 'user',
        content: normalizeResponseMessageContent(item.content),
      });
      return;
    }

    if (
      item.type === 'input_text' ||
      item.type === 'text' ||
      item.type === 'output_text' ||
      item.type === 'input_image' ||
      item.type === 'image_url' ||
      item.type === 'image_file' ||
      item.file_id
    ) {
      messages.push({
        role: 'user',
        content: [responsesPartToChatPart(item)].filter(Boolean),
      });
    }
  };

  const input = payload && payload.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendItem(item);
  } else if (input && typeof input === 'object') {
    appendItem(input);
  }

  return {
    model: payload.model,
    messages,
    tools: Array.isArray(payload.tools) ? payload.tools : undefined,
    tool_choice: payload.tool_choice,
    temperature: payload.temperature,
    max_tokens: payload.max_output_tokens,
    stream: Boolean(payload.stream),
  };
}

function chatBodyToResponsesBody(chatBody, requestedModel) {
  const choice = chatBody && Array.isArray(chatBody.choices) ? chatBody.choices[0] : null;
  const message = choice && choice.message ? choice.message : {};
  const output = [];
  let outputText = '';

  if (typeof message.content === 'string' && message.content) {
    outputText = message.content;
    output.push({
      id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: message.content,
        annotations: [],
      }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      output.push({
        id: `fc_${crypto.randomBytes(6).toString('hex')}`,
        type: 'function_call',
        call_id: toolCall.id || `call_${crypto.randomUUID()}`,
        name: toolCall.function && toolCall.function.name ? toolCall.function.name : '',
        arguments: toolCall.function && typeof toolCall.function.arguments === 'string'
          ? toolCall.function.arguments
          : safeArgsString(toolCall.function && toolCall.function.arguments),
        status: 'completed',
      });
    }
  }

  return {
    id: chatBody.id ? String(chatBody.id).replace(/^chatcmpl/, 'resp') : `resp_${crypto.randomBytes(6).toString('hex')}`,
    object: 'response',
    created: chatBody.created || Math.floor(Date.now() / 1000),
    model: requestedModel || chatBody.model,
    status: 'completed',
    output,
    output_text: outputText,
    usage: {
      input_tokens: Number(chatBody?.usage?.prompt_tokens ?? 0) || 0,
      output_tokens: Number(chatBody?.usage?.completion_tokens ?? 0) || 0,
      total_tokens: Number(chatBody?.usage?.total_tokens ?? 0) || 0,
    },
  };
}

class KiroProvider extends BaseProvider {
  _cfg() {
    const account = this.provider.account || {};
    return safeJsonParse(account.config_json || this.provider.config_json, {});
  }

  _resolveCliConfig() {
    const cfg = this._cfg();
    return {
      cfg,
      cliPath: resolveCliPath(cfg),
      apiKey: resolveCliApiKey(cfg),
      runtimeMode: resolveCliRuntimeMode(cfg),
      useCli: shouldUseCliRuntime(cfg),
    };
  }

  _account() {
    return this.provider.account || this.provider;
  }

  _generateUrl() {
    const cfg = this._cfg();
    return cfg.generateUrl || process.env.KIRO_GENERATE_URL || KIRO_GENERATE_URL;
  }

  _usageBase() {
    const cfg = this._cfg();
    return cfg.usageBase || process.env.KIRO_USAGE_BASE || Q_USAGE_BASE;
  }

  _tokenStatus() {
    const account = this._account();
    if (!account.access_token) return 'missing';
    const exp = account.token_expires_at || 0;
    if (exp > 0 && exp <= Math.floor(Date.now() / 1000)) return 'expired';
    return 'ok';
  }

  async _refreshIfNeeded(force = false) {
    if (!force && this._tokenStatus() !== 'expired') return;
    const account = this._account();
    if (!account.refresh_token) {
      const e = new Error('Token expired and no refresh_token available. Re-run `npm run login:kiro`.');
      e.code = 'token_expired_no_refresh';
      throw e;
    }

    // Resolve proxy via feature flag (refresh_token)
    const providerId = this.provider.account ? this.provider.id : this.provider.id;
    const accountId = this.provider.account ? this.provider.account.id : null;
    const proxy = resolveProxy({
      feature: 'refresh_token',
      providerId,
      accountId,
    });
    const agent = proxy ? await buildProxyAgent(proxy) : null;

    const fetchOptions = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ refreshToken: account.refresh_token }),
    };
    if (agent) fetchOptions.dispatcher = agent;

    const start = Date.now();
    let res;
    try {
      res = await fetch(REFRESH_URL, fetchOptions);
    } catch (err) {
      if (proxy) {
        logProxyUsage(proxy.id, providerId, accountId, 'refresh_token', false, Date.now() - start, err.message);
      }
      throw err;
    }

    const text = await res.text();
    if (res.status !== 200) {
      if (proxy) {
        logProxyUsage(proxy.id, providerId, accountId, 'refresh_token', false, Date.now() - start, `HTTP ${res.status}`);
      }
      // CloudFront / WAF block at the edge has nothing to do with the
      // refresh token itself — surface that distinctly so the operator
      // doesn't waste time re-issuing tokens.
      const isCloudFrontBlock = res.status === 403
        && /cloudfront/i.test(res.headers.get('server') || '')
        && /text\/html/i.test(res.headers.get('content-type') || '');
      const reason = isCloudFrontBlock
        ? `egress IP blocked by CloudFront (POP=${res.headers.get('x-amz-cf-pop') || '?'}); enable a proxy for the refresh_token feature`
        : `body=${text.slice(0, 200)}`;
      const e = new Error(`refreshToken failed status=${res.status} ${reason}`);
      e.code = isCloudFrontBlock ? 'edge_blocked' : 'refresh_failed';
      e.status = res.status;
      e.upstreamBlocked = isCloudFrontBlock;
      throw e;
    }
    if (proxy) {
      logProxyUsage(proxy.id, providerId, accountId, 'refresh_token', true, Date.now() - start, null);
    }
    const body = JSON.parse(text);
    const access = body.accessToken || body.access_token;
    if (!access) throw Object.assign(new Error('refreshToken missing accessToken'), { code: 'refresh_no_access' });
    const newRefresh = body.refreshToken || body.refresh_token || account.refresh_token;
    let exp = 0;
    if (body.expiresAt) {
      const n = Number(body.expiresAt);
      exp = Number.isFinite(n) && n > 1e10 ? Math.floor(n / 1000) : Math.floor(n);
    }
    if (!exp && body.expiresIn) exp = Math.floor(Date.now() / 1000) + Number(body.expiresIn);
    if (!exp) exp = Math.floor(Date.now() / 1000) + 3600;

    if (this.provider.account) {
      db.prepare(`
        UPDATE provider_accounts SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=?
        WHERE id=?
      `).run(access, newRefresh, exp, Math.floor(Date.now() / 1000), account.id);
      this.provider.account.access_token = access;
      this.provider.account.refresh_token = newRefresh;
      this.provider.account.token_expires_at = exp;
    } else {
      db.prepare(`
        UPDATE providers SET access_token=?, refresh_token=?, token_expires_at=?, updated_at=?
        WHERE id=?
      `).run(access, newRefresh, exp, Math.floor(Date.now() / 1000), this.provider.id);
      this.provider.access_token = access;
      this.provider.refresh_token = newRefresh;
      this.provider.token_expires_at = exp;
    }
  }

  _authHeaders({ generate = false } = {}) {
    const account = this._account();
    const headers = {
      authorization: `Bearer ${account.access_token}`,
      'content-type': 'application/json',
    };
    if (generate) {
      headers.accept = 'application/vnd.amazon.eventstream';
      headers['x-amz-target'] = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
      headers['x-amz-user-agent'] = KIRO_AMZ_UA;
      headers['amz-sdk-request'] = 'attempt=1; max=3';
      headers['amz-sdk-invocation-id'] = crypto.randomUUID();
      headers['user-agent'] = KIRO_IDE_UA;
      return headers;
    }
    headers['user-agent'] = UA;
    return headers;
  }

  async _postKiroRequest(body, { signal, allowAuthRetry = true } = {}) {
    // Resolve proxy via feature flag (api_request) so chat traffic can also
    // bypass IP-level CloudFront blocks. Identical to refresh_token path.
    const providerId = this.provider.id;
    const accountId = this.provider.account ? this.provider.account.id : null;
    const proxy = resolveProxy({ feature: 'api_request', providerId, accountId });
    const agent = proxy ? await buildProxyAgent(proxy) : null;

    const fetchOptions = {
      method: 'POST',
      headers: this._authHeaders({ generate: true }),
      body: JSON.stringify(body),
      signal,
    };
    if (agent) fetchOptions.dispatcher = agent;

    const start = Date.now();
    let res;
    try {
      res = await fetch(this._generateUrl(), fetchOptions);
    } catch (err) {
      if (proxy) {
        logProxyUsage(proxy.id, providerId, accountId, 'api_request', false, Date.now() - start, err.message);
      }
      throw err;
    }
    if (proxy) {
      logProxyUsage(proxy.id, providerId, accountId, 'api_request', res.ok, Date.now() - start, res.ok ? null : `HTTP ${res.status}`);
    }

    if (allowAuthRetry && (res.status === 401 || res.status === 403) && this._account().refresh_token) {
      try {
        await this._refreshIfNeeded(true);
        return this._postKiroRequest(body, { signal, allowAuthRetry: false });
      } catch {
        return res;
      }
    }

    return res;
  }

  _buildCliArgs(prompt, payload, cfg) {
    const args = ['chat', '--no-interactive', '--wrap', 'never'];
    const trustTools = cfg.trustTools || process.env.KIRO_TRUST_TOOLS || '';
    if (trustTools) {
      args.push(`--trust-tools=${trustTools}`);
    } else {
      args.push('--trust-all-tools');
    }

    if (payload && payload.model) {
      args.push('--model', payload.model);
    }
    if (cfg.agent) {
      args.push('--agent', cfg.agent);
    }
    if (cfg.agentEngine) {
      args.push('--agent-engine', cfg.agentEngine);
    }
    if (cfg.mode) {
      args.push('--mode', cfg.mode);
    }

    args.push(prompt || 'Hello');
    return args;
  }

  _mapCliError(code, stdout, stderr) {
    const message = [stderr, stdout].filter(Boolean).join('\n').trim() || `kiro-cli exited with code ${code}`;

    if (/Not logged in\. Set the KIRO_API_KEY environment variable/i.test(message)) {
      return cliAuthMissingResponse();
    }

    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: {
        error: {
          message,
          type: 'provider_error',
          code: 'kiro_cli_failed',
        },
      },
    };
  }

  _runCliHeadless(prompt, payload, { stream = false, responseMode = 'chat' } = {}) {
    const { cfg, cliPath, apiKey } = this._resolveCliConfig();
    if (!cliPath) {
      return Promise.resolve(cliUnavailableResponse(DEFAULT_CLI_PATH));
    }
    if (!apiKey) {
      return Promise.resolve(cliAuthMissingResponse());
    }

    const args = this._buildCliArgs(prompt, payload, cfg);
    const cwd = cfg.workingDirectory || process.cwd();
    const model = payload && payload.model ? payload.model : 'kiro';
    const created = Math.floor(Date.now() / 1000);
    const completionId = `${responseMode === 'responses' ? 'resp' : 'chatcmpl'}-${crypto.randomBytes(6).toString('hex')}`;
    const messageId = `msg_${crypto.randomBytes(6).toString('hex')}`;

    if (stream) {
      const out = new Readable({ read() {} });
      const child = spawn(cliPath, args, {
        cwd,
        env: { ...process.env, KIRO_API_KEY: apiKey },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let full = '';
      let stderr = '';
      let failed = false;

      if (responseMode === 'responses') {
        const createdEvent = {
          type: 'response.created',
          response: {
            id: completionId,
            object: 'response',
            created,
            model,
            status: 'in_progress',
          },
        };
        out.push(`data: ${JSON.stringify(createdEvent)}\n\n`);
      }

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (!text) return;
        full += text;

        if (responseMode === 'responses') {
          out.push(`data: ${JSON.stringify({
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: text,
          })}\n\n`);
          return;
        }

        out.push(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`);
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        failed = true;
        out.push(`data: ${JSON.stringify({ error: { message: err.message, code: 'kiro_cli_spawn_failed' } })}\n\n`);
        out.push('data: [DONE]\n\n');
        out.push(null);
      });

      child.on('close', (code) => {
        if (failed) return;
        if (code !== 0) {
          const mapped = this._mapCliError(code, full, stderr);
          out.push(`data: ${JSON.stringify(mapped.body)}\n\n`);
          out.push('data: [DONE]\n\n');
          out.push(null);
          return;
        }

        if (responseMode === 'responses') {
          out.push(`data: ${JSON.stringify({
            type: 'response.output_text.done',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text: full,
          })}\n\n`);
          out.push(`data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: completionId,
              object: 'response',
              created,
              model,
              status: 'completed',
              output: [
                {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: full, annotations: [] }],
                },
              ],
              output_text: full,
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
          })}\n\n`);
          out.push('data: [DONE]\n\n');
          out.push(null);
          return;
        }

        out.push(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })}\n\n`);
        out.push('data: [DONE]\n\n');
        out.push(null);
      });

      return Promise.resolve({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: {
          getReader() {
            const it = out[Symbol.asyncIterator]();
            return {
              async read() {
                const { value, done } = await it.next();
                if (done) return { done: true, value: undefined };
                return { done: false, value: Buffer.isBuffer(value) ? value : Buffer.from(value) };
              },
            };
          },
        },
      });
    }

    return new Promise((resolve) => {
      const child = spawn(cliPath, args, {
        cwd,
        env: { ...process.env, KIRO_API_KEY: apiKey },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        resolve({
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: {
            error: {
              message: err.message,
              type: 'provider_error',
              code: 'kiro_cli_spawn_failed',
            },
          },
        });
      });

      child.on('close', (code) => {
        if (code !== 0) {
          resolve(this._mapCliError(code, stdout, stderr));
          return;
        }

        const full = stdout.trimEnd();
        if (responseMode === 'responses') {
          resolve({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: {
              id: completionId,
              object: 'response',
              created,
              model,
              status: 'completed',
              output: [
                {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: full, annotations: [] }],
                },
              ],
              output_text: full,
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
          });
          return;
        }

        resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: {
            id: completionId,
            object: 'chat.completion',
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: full },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          },
        });
      });
    });
  }

  _webLikeFromReadable(readable) {
    return {
      getReader() {
        const it = readable[Symbol.asyncIterator]();
        return {
          async read() {
            const { value, done } = await it.next();
            if (done) return { done: true, value: undefined };
            return { done: false, value: Buffer.isBuffer(value) ? value : Buffer.from(value) };
          },
        };
      },
    };
  }

  _streamKiroChatResponse(kiroStream, model, originalPayload) {
    const id = 'chatcmpl-' + crypto.randomBytes(6).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const out = new Readable({ read() {} });

    // Kiro streams do not report token usage. Estimate prompt tokens from the
    // outbound OpenAI chat payload and accumulate completion tokens from the
    // text/tool deltas we observe, so downstream clients get a reasonable
    // `usage` block in the final chunk.
    const promptTokensEstimate = originalPayload
      ? estimatePromptTokensFromMessages(originalPayload.messages, originalPayload.tools)
      : 0;
    let completionText = '';
    let toolArgsText = '';

    (async () => {
      let chunkIndex = 0;
      let hasToolCalls = false;
      let usage = {
        prompt_tokens: promptTokensEstimate,
        completion_tokens: 0,
        total_tokens: promptTokensEstimate,
      };
      let upstreamUsage = null; // if Kiro ever sends real numbers, prefer those
      const seenToolIds = new Map();
      let nextToolIndex = 0;

      const finalizeUsage = () => {
        if (upstreamUsage && upstreamUsage.prompt_tokens && upstreamUsage.completion_tokens) {
          return upstreamUsage;
        }
        const completionEstimate =
          estimateTokensFromText(completionText) +
          estimateTokensFromText(toolArgsText);
        const prompt = upstreamUsage && upstreamUsage.prompt_tokens
          ? upstreamUsage.prompt_tokens
          : promptTokensEstimate;
        const completion = upstreamUsage && upstreamUsage.completion_tokens
          ? upstreamUsage.completion_tokens
          : completionEstimate;
        return {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        };
      };

      try {
        for await (const ev of parseEventStream(kiroStream)) {
          const eventType = ev.headers[':event-type'];

          if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && ev.payload?.content) {
            completionText += ev.payload.content;
            out.push(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: chunkIndex === 0
                  ? { role: 'assistant', content: ev.payload.content }
                  : { content: ev.payload.content },
                finish_reason: null,
              }],
            })}\n\n`);
            chunkIndex += 1;
            continue;
          }

          if (eventType === 'toolUseEvent' && ev.payload) {
            hasToolCalls = true;
            const toolUses = Array.isArray(ev.payload) ? ev.payload : [ev.payload];

            for (const toolUse of toolUses) {
              const toolCallId = toolUse.toolUseId || `call_${crypto.randomUUID()}`;
              let toolIndex = seenToolIds.get(toolCallId);

              if (toolIndex == null) {
                toolIndex = nextToolIndex;
                nextToolIndex += 1;
                seenToolIds.set(toolCallId, toolIndex);
                if (toolUse.name) toolArgsText += toolUse.name;
                out.push(`data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: 'assistant' } : {}),
                      tool_calls: [{
                        index: toolIndex,
                        id: toolCallId,
                        type: 'function',
                        function: {
                          name: toolUse.name || '',
                          arguments: '',
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                })}\n\n`);
                chunkIndex += 1;
              }

              if (toolUse.input !== undefined) {
                const argumentText = toolInputToArgumentText(toolUse.input);
                if (!argumentText) continue;
                toolArgsText += argumentText;
                out.push(`data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        function: {
                          arguments: argumentText,
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                })}\n\n`);
                chunkIndex += 1;
              }
            }
            continue;
          }

          if (eventType === 'metricsEvent') {
            const updated = extractKiroUsage(ev.payload, usage);
            if (updated !== usage) upstreamUsage = updated;
            continue;
          }

          if (eventType === 'messageStopEvent') {
            usage = finalizeUsage();
            out.push(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
              }],
              usage,
            })}\n\n`);
            out.push('data: [DONE]\n\n');
            out.push(null);
            return;
          }
        }

        usage = finalizeUsage();
        out.push(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
          }],
          usage,
        })}\n\n`);
        out.push('data: [DONE]\n\n');
        out.push(null);
      } catch (err) {
        out.push(`data: ${JSON.stringify({ error: { message: err.message, code: 'kiro_stream_parse_failed' } })}\n\n`);
        out.push('data: [DONE]\n\n');
        out.push(null);
      }
    })();

    return this._webLikeFromReadable(out);
  }

  async _collectKiroChatResponse(kiroStream, model, originalPayload) {
    const id = 'chatcmpl-' + crypto.randomBytes(6).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    let content = '';
    let upstreamUsage = null;
    let hasToolCalls = false;
    const toolCalls = [];
    const toolIndexById = new Map();

    for await (const ev of parseEventStream(kiroStream)) {
      const eventType = ev.headers[':event-type'];

      if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && ev.payload?.content) {
        content += ev.payload.content;
        continue;
      }

      if (eventType === 'toolUseEvent' && ev.payload) {
        hasToolCalls = true;
        const toolUses = Array.isArray(ev.payload) ? ev.payload : [ev.payload];
        for (const toolUse of toolUses) {
          const toolCallId = toolUse.toolUseId || `call_${crypto.randomUUID()}`;
          let toolIndex = toolIndexById.get(toolCallId);
          if (toolIndex == null) {
            toolIndex = toolCalls.length;
            toolIndexById.set(toolCallId, toolIndex);
            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: toolUse.name || '',
                arguments: '',
              },
            });
          }
          if (toolUse.input !== undefined) {
            const argumentText = toolInputToArgumentText(toolUse.input);
            if (argumentText) {
              toolCalls[toolIndex].function.arguments += argumentText;
            }
          }
        }
        continue;
      }

      if (eventType === 'metricsEvent') {
        const updated = extractKiroUsage(ev.payload, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        if (updated && (updated.prompt_tokens || updated.completion_tokens || updated.total_tokens)) {
          upstreamUsage = updated;
        }
      }
    }

    // Kiro does not report token usage; estimate from the outbound payload +
    // aggregated assistant output. If `metricsEvent` ever ships real numbers,
    // those win.
    let usage;
    if (upstreamUsage) {
      usage = upstreamUsage;
    } else {
      const promptTokens = originalPayload
        ? estimatePromptTokensFromMessages(originalPayload.messages, originalPayload.tools)
        : 0;
      let completionTokens = estimateTokensFromText(content);
      for (const tc of toolCalls) {
        if (tc.function?.name) completionTokens += estimateTokensFromText(tc.function.name);
        if (tc.function?.arguments) completionTokens += estimateTokensFromText(tc.function.arguments);
      }
      usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content || (toolCalls.length ? null : ''),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
        }],
        usage,
      },
    };
  }

  _streamChatAsResponses(chatStream, model) {
    const responseId = `resp_${crypto.randomBytes(6).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const out = new Readable({ read() {} });
    const reader = chatStream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const messageItem = {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    };
    let messageStarted = false;
    const toolItems = new Map();
    const outputOrder = [];
    let outputText = '';
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    out.push(`event: response.created\n`);
    out.push(`data: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created,
        model,
        status: 'in_progress',
        output: [],
      },
    })}\n\n`);

    const ensureMessageStarted = () => {
      if (messageStarted) return;
      messageStarted = true;
      outputOrder.push(messageItem);
      out.push(`event: response.output_item.added\n`);
      out.push(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        response_id: responseId,
        output_index: outputOrder.length - 1,
        item: messageItem,
      })}\n\n`);
    };

    const ensureToolItem = (index, payload) => {
      let item = toolItems.get(index);
      if (item) return item;
      item = {
        id: `fc_${crypto.randomBytes(6).toString('hex')}`,
        type: 'function_call',
        call_id: payload.id || `call_${crypto.randomUUID()}`,
        name: (payload.function && payload.function.name) || '',
        arguments: '',
        status: 'in_progress',
      };
      toolItems.set(index, item);
      outputOrder.push(item);
      out.push(`event: response.output_item.added\n`);
      out.push(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        response_id: responseId,
        output_index: outputOrder.length - 1,
        item,
      })}\n\n`);
      return item;
    };

    (async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const match = /^data:\s?(.*)$/.exec(line);
            if (!match) continue;
            const payload = match[1].trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }

            const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
            if (parsed.usage && typeof parsed.usage === 'object') {
              usage = {
                input_tokens: Number(parsed.usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
                output_tokens: Number(parsed.usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
                total_tokens: Number(parsed.usage.total_tokens ?? usage.total_tokens ?? 0) || 0,
              };
            }
            if (!choice) continue;

            const delta = choice.delta || {};
            if (typeof delta.content === 'string' && delta.content) {
              ensureMessageStarted();
              outputText += delta.content;
              messageItem.content[0].text = outputText;
              out.push(`event: response.output_text.delta\n`);
              out.push(`data: ${JSON.stringify({
                type: 'response.output_text.delta',
                response_id: responseId,
                item_id: messageItem.id,
                output_index: outputOrder.indexOf(messageItem),
                content_index: 0,
                delta: delta.content,
              })}\n\n`);
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const toolDelta of delta.tool_calls) {
                const toolIndex = Number(toolDelta.index ?? 0) || 0;
                const item = ensureToolItem(toolIndex, toolDelta);
                if (toolDelta.id) item.call_id = toolDelta.id;
                if (toolDelta.function && toolDelta.function.name) item.name = toolDelta.function.name;
                if (toolDelta.function && typeof toolDelta.function.arguments === 'string' && toolDelta.function.arguments) {
                  item.arguments += toolDelta.function.arguments;
                  out.push(`event: response.function_call_arguments.delta\n`);
                  out.push(`data: ${JSON.stringify({
                    type: 'response.function_call_arguments.delta',
                    response_id: responseId,
                    item_id: item.id,
                    output_index: outputOrder.indexOf(item),
                    delta: toolDelta.function.arguments,
                  })}\n\n`);
                }
              }
            }

            if (choice.finish_reason) {
              if (messageStarted) {
                messageItem.status = 'completed';
                out.push(`event: response.output_text.done\n`);
                out.push(`data: ${JSON.stringify({
                  type: 'response.output_text.done',
                  response_id: responseId,
                  item_id: messageItem.id,
                  output_index: outputOrder.indexOf(messageItem),
                  content_index: 0,
                  text: outputText,
                })}\n\n`);
                out.push(`event: response.output_item.done\n`);
                out.push(`data: ${JSON.stringify({
                  type: 'response.output_item.done',
                  response_id: responseId,
                  output_index: outputOrder.indexOf(messageItem),
                  item: messageItem,
                })}\n\n`);
              }

              for (const item of toolItems.values()) {
                item.status = 'completed';
                out.push(`event: response.function_call_arguments.done\n`);
                out.push(`data: ${JSON.stringify({
                  type: 'response.function_call_arguments.done',
                  response_id: responseId,
                  item_id: item.id,
                  output_index: outputOrder.indexOf(item),
                  arguments: item.arguments,
                })}\n\n`);
                out.push(`event: response.output_item.done\n`);
                out.push(`data: ${JSON.stringify({
                  type: 'response.output_item.done',
                  response_id: responseId,
                  output_index: outputOrder.indexOf(item),
                  item,
                })}\n\n`);
              }

              out.push(`event: response.completed\n`);
              out.push(`data: ${JSON.stringify({
                type: 'response.completed',
                response: {
                  id: responseId,
                  object: 'response',
                  created,
                  model,
                  status: 'completed',
                  output: outputOrder,
                  output_text: outputText,
                  usage,
                },
              })}\n\n`);
              out.push('data: [DONE]\n\n');
              out.push(null);
              return;
            }
          }
        }

        out.push(`event: response.completed\n`);
        out.push(`data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            created,
            model,
            status: 'completed',
            output: outputOrder,
            output_text: outputText,
            usage,
          },
        })}\n\n`);
        out.push('data: [DONE]\n\n');
        out.push(null);
      } catch (err) {
        out.push(`data: ${JSON.stringify({ error: { message: err.message, code: 'kiro_responses_stream_failed' } })}\n\n`);
        out.push('data: [DONE]\n\n');
        out.push(null);
      }
    })();

    return this._webLikeFromReadable(out);
  }

  /**
   * Fetch subscription + usage info from Amazon Q. Returns the parsed body
   * (object shape is defined by the upstream) plus status.
   *
   * Auto-refreshes the token if needed.
   */
  async fetchUsageInfo() {
    await this._refreshIfNeeded();
    const cfg = this._cfg();
    const params = new URLSearchParams({
      origin: 'AI_EDITOR',
      resourceType: 'AGENTIC_REQUEST',
    });
    if (cfg.profileArn) params.set('profileArn', cfg.profileArn);

    // Resolve proxy via feature flag (subscription_check)
    const providerId = this.provider.id;
    const accountId = this.provider.account ? this.provider.account.id : null;
    const proxy = resolveProxy({
      feature: 'subscription_check',
      providerId,
      accountId,
    });
    const agent = proxy ? await buildProxyAgent(proxy) : null;

    const fetchOptions = { headers: this._authHeaders() };
    if (agent) fetchOptions.dispatcher = agent;

    const start = Date.now();
    let res;
    try {
      res = await fetch(`${this._usageBase()}/getUsageLimits?${params}`, fetchOptions);
    } catch (err) {
      if (proxy) {
        logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', false, Date.now() - start, err.message);
      }
      throw err;
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (proxy) {
      logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', res.ok, Date.now() - start, res.ok ? null : `HTTP ${res.status}`);
    }
    return { status: res.status, body };
  }

  /**
   * Generate a Stripe checkout URL so the account can be upgraded to Pro,
   * WITHOUT launching a browser. Replicates the flow used by the
   * `kiro_login_upgrade.py` reference adapter:
   *
   *   1. GET https://app.kiro.dev/home with cookies { AccessToken, Idp=Google }
   *      and scrape `<meta name="user-id" content="...">` from the HTML.
   *   2. GET the same URL again with the UserId cookie added and scrape
   *      `<meta name="csrf-token" content="...">`.
   *   3. POST a CBOR-encoded body { subscriptionType, profileArn } to
   *      /service/KiroWebPortalService/operation/GenerateSubscriptionManagementUrl
   *      using bearer auth + the csrf token.
   *   4. Decode the CBOR response and return `encodedVerificationUrl` — the
   *      full Stripe Checkout URL (including the required `#fid=` fragment).
   *
   * Returns an object `{ ok, checkoutUrl?, status?, error?, code? }`. Never
   * throws for expected auth/parse failures; those surface as `{ ok: false }`.
   */
  async generateStripeUrl({ subscriptionType = 'Q_DEVELOPER_STANDALONE_PRO' } = {}) {
    try {
      await this._refreshIfNeeded();
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'refresh_failed' };
    }
    const account = this._account();
    const cfg = this._cfg();
    const accessToken = account.access_token;
    const profileArn = cfg.profileArn;
    if (!accessToken) return { ok: false, error: 'missing access_token', code: 'token_missing' };
    if (!profileArn) return { ok: false, error: 'missing profileArn in config', code: 'missing_profile_arn' };

    // Web portal sits behind the same CloudFront edge as /refreshToken, so
    // route through the proxy registered for `subscription_check` (this is
    // a usage / management call, not a chat call).
    const providerId = this.provider.id;
    const accountId = this.provider.account ? this.provider.account.id : null;
    const proxy = resolveProxy({ feature: 'subscription_check', providerId, accountId });
    const dispatcher = proxy ? await buildProxyAgent(proxy) : null;
    const withDispatcher = (opts) => (dispatcher ? { ...opts, dispatcher } : opts);

    const HOME_URL = 'https://app.kiro.dev/home';
    const SUB_URL = 'https://app.kiro.dev/service/KiroWebPortalService/operation/GenerateSubscriptionManagementUrl';
    const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';

    const cookies1 = [`AccessToken=${accessToken}`, 'Idp=Google'].join('; ');
    let res1;
    try {
      res1 = await fetch(HOME_URL, withDispatcher({
        headers: { 'user-agent': USER_AGENT, cookie: cookies1 },
        redirect: 'follow',
      }));
    } catch (err) {
      if (proxy) logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', false, 0, err.message);
      return { ok: false, error: `fetch /home failed: ${err.message}`, code: 'home_fetch_failed' };
    }
    const html1 = await res1.text();
    const finalUrl = (res1.url || '').toString();
    if (finalUrl.includes('/signin')) {
      return { ok: false, error: 'access_token rejected (redirected to /signin)', code: 'token_rejected', status: res1.status };
    }
    const uidMatch = html1.match(/<meta\s+name="user-id"\s+content="([^"]+)"/i);
    if (!uidMatch) {
      return { ok: false, error: 'could not extract user-id meta from /home', code: 'missing_user_id', status: res1.status };
    }
    const userId = uidMatch[1];

    const cookies2 = [`AccessToken=${accessToken}`, 'Idp=Google', `UserId=${userId}`].join('; ');
    let res2;
    try {
      res2 = await fetch(HOME_URL, withDispatcher({
        headers: { 'user-agent': USER_AGENT, cookie: cookies2 },
        redirect: 'follow',
      }));
    } catch (err) {
      if (proxy) logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', false, 0, err.message);
      return { ok: false, error: `fetch /home (with UserId) failed: ${err.message}`, code: 'home_fetch2_failed' };
    }
    const html2 = await res2.text();
    const csrfMatch = html2.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
    if (!csrfMatch) {
      return { ok: false, error: 'could not extract csrf-token meta from /home', code: 'missing_csrf', status: res2.status };
    }
    const csrfToken = csrfMatch[1];

    let encode;
    let decode;
    try {
      ({ encode, decode } = require('cbor-x'));
    } catch (err) {
      return { ok: false, error: `cbor-x not available: ${err.message}`, code: 'cbor_missing' };
    }
    const payloadBuf = encode({ subscriptionType, profileArn });

    let res3;
    try {
      res3 = await fetch(SUB_URL, withDispatcher({
        method: 'POST',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/cbor',
          'content-type': 'application/cbor',
          'smithy-protocol': 'rpc-v2-cbor',
          'x-amz-user-agent': 'aws-sdk-js/1.0.0 ua/2.1 os/Windows lang/js md/browser#Firefox_unknown m/N,M,E',
          authorization: `Bearer ${accessToken}`,
          'x-csrf-token': csrfToken,
          origin: 'https://app.kiro.dev',
          referer: 'https://app.kiro.dev/account/usage',
          cookie: cookies2,
        },
        body: payloadBuf,
      }));
    } catch (err) {
      if (proxy) logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', false, 0, err.message);
      return { ok: false, error: `generate-subscription-url POST failed: ${err.message}`, code: 'sub_post_failed' };
    }
    if (res3.status !== 200) {
      if (proxy) logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', false, 0, `HTTP ${res3.status}`);
      let preview = '';
      try { preview = (await res3.text()).slice(0, 300); } catch { /* ignore */ }
      return { ok: false, error: `upstream status=${res3.status} body=${preview}`, code: 'sub_post_non_200', status: res3.status };
    }
    let decoded;
    try {
      const buf = Buffer.from(await res3.arrayBuffer());
      decoded = decode(buf);
    } catch (err) {
      return { ok: false, error: `failed to decode CBOR response: ${err.message}`, code: 'cbor_decode_failed' };
    }
    const url = decoded && (decoded.encodedVerificationUrl || decoded.EncodedVerificationUrl);
    if (!url) {
      return { ok: false, error: 'response missing encodedVerificationUrl', code: 'no_verification_url' };
    }
    if (proxy) logProxyUsage(proxy.id, providerId, accountId, 'subscription_check', true, 0, null);
    return { ok: true, checkoutUrl: url, userId };
  }

  /**
   * Build the Amazon Q request payload from an OpenAI-style chat request.
   */
  async _buildKiroRequest(payload) {
    const cfg = this._cfg();
    return buildKiroChatRequest(payload, cfg);
  }

  async responses(payload, { signal } = {}) {
    const { useCli } = this._resolveCliConfig();
    if (useCli && responsesPayloadUsesVision(payload)) {
      return unsupportedVisionResponse();
    }
    if (useCli) {
      const prompt = responsesToCliPrompt(payload || {});
      return this._runCliHeadless(prompt, payload || {}, {
        stream: Boolean(payload && payload.stream),
        responseMode: 'responses',
      });
    }

    const chatPayload = responsesPayloadToChatPayload(payload || {});
    const chatResult = await this.chatCompletions(chatPayload, { signal });

    if (chatResult.stream && chatPayload.stream) {
      return {
        status: chatResult.status,
        headers: { 'content-type': 'text/event-stream' },
        stream: this._streamChatAsResponses(chatResult.stream, payload.model),
      };
    }

    if (chatResult.status !== 200) {
      return chatResult;
    }

    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: chatBodyToResponsesBody(chatResult.body, payload.model),
    };
  }

  async chatCompletions(payload, { signal } = {}) {
    const { useCli } = this._resolveCliConfig();
    if (useCli && payloadUsesVision(payload)) {
      return unsupportedVisionResponse();
    }
    if (useCli) {
      const prompt = messagesToCliPrompt(payload && payload.messages);
      return this._runCliHeadless(prompt, payload || {}, {
        stream: Boolean(payload && payload.stream),
        responseMode: 'chat',
      });
    }

    const status = this._tokenStatus();
    if (status === 'missing') {
      if (!this._account().refresh_token) {
        return {
          status: 401,
          headers: { 'content-type': 'application/json' },
          body: {
            error: {
              message: 'Kiro has no access token. Run `npm run login:kiro`.',
              type: 'provider_auth_error',
              code: 'token_missing',
            },
          },
        };
      }
      try {
        await this._refreshIfNeeded(true);
      } catch (err) {
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
    } else {
      try {
        await this._refreshIfNeeded();
      } catch (err) {
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
    }

    const cfg = this._cfg();
    if (!cfg.profileArn) {
      return {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: {
          error: {
            message: 'Kiro config missing profileArn. Re-run `npm run login:kiro`.',
            type: 'provider_config_error',
            code: 'missing_profile_arn',
          },
        },
      };
    }

    let kiroBody;
    try {
      kiroBody = await this._buildKiroRequest(payload);
    } catch (err) {
      return {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: {
          error: {
            message: err.message,
            type: 'invalid_request_error',
            code: err.code || 'kiro_request_build_failed',
          },
        },
      };
    }
    const res = await this._postKiroRequest(kiroBody, { signal });

    if (res.status !== 200) {
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return {
        status: res.status,
        headers: { 'content-type': 'application/json' },
        body: {
          error: {
            message: `Kiro upstream ${res.status}`,
            type: 'provider_error',
            upstream: parsed,
          },
        },
      };
    }

    if (payload.stream) {
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: this._streamKiroChatResponse(res.body, payload.model, payload),
      };
    }

    try {
      return await this._collectKiroChatResponse(res.body, payload.model, payload);
    } catch (err) {
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: {
          error: {
            message: `Kiro stream parse failed: ${err.message}`,
            type: 'provider_error',
            code: 'kiro_stream_parse_failed',
          },
        },
      };
    }
  }

  async listModels() {
    return [
      { id: 'claude-sonnet-4.5', object: 'model', owned_by: 'kiro' },
      { id: 'claude-sonnet-4', object: 'model', owned_by: 'kiro' },
      { id: 'claude-haiku-4.5', object: 'model', owned_by: 'kiro' },
      { id: 'deepseek-3.2', object: 'model', owned_by: 'kiro' },
    ];
  }
}

module.exports = KiroProvider;
module.exports.classifySubscription = classifySubscription;
