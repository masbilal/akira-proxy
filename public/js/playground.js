/* Playground conversation state + chat/responses proxy calls */

const messages = [];
const $ = (id) => document.getElementById(id);

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      if (part && typeof part.output === 'string') return part.output;
      if (part && typeof part.input === 'string') return part.input;
      if (part && (part.type === 'input_image' || part.type === 'image_url')) return '[image]';
      return '';
    })
    .filter(Boolean);

  return parts.join('\n');
}

function extractImageSources(content) {
  if (!Array.isArray(content)) return [];

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'input_image' && typeof part.image_url === 'string') {
        return { src: part.image_url, detail: part.detail || 'auto', label: 'image' };
      }
      if (part.type === 'image_url') {
        if (typeof part.image_url === 'string') {
          return { src: part.image_url, detail: part.detail || 'auto', label: 'image' };
        }
        if (part.image_url && typeof part.image_url.url === 'string') {
          return { src: part.image_url.url, detail: part.image_url.detail || part.detail || 'auto', label: 'image' };
        }
      }
      if (typeof part.image_url === 'string') {
        return { src: part.image_url, detail: part.detail || 'auto', label: 'image' };
      }
      return null;
    })
    .filter(Boolean);
}

function formatNamedInvocation(name, args, label) {
  const safeName = name || 'unknown';
  if (!args) return `[${label}] ${safeName}`;
  return `[${label}] ${safeName}\n${args}`;
}

function formatToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return '';

  return toolCalls
    .map((toolCall) => {
      const name = toolCall?.function?.name || toolCall?.name || toolCall?.id;
      const args = toolCall?.function?.arguments || toolCall?.arguments || '';
      return formatNamedInvocation(name, args, 'tool call');
    })
    .join('\n\n');
}

function assistantTextFromChatMessage(message) {
  const content = flattenContent(message?.content);
  if (content) return content;

  const toolCalls = formatToolCalls(message?.tool_calls);
  if (toolCalls) return toolCalls;

  if (message?.function_call) {
    return formatNamedInvocation(
      message.function_call.name,
      message.function_call.arguments,
      'function call'
    );
  }

  return '(no content)';
}

function assistantTextFromChatChunk(choice) {
  const payload = choice?.delta || choice?.message || {};
  const content = flattenContent(payload?.content);
  if (content) return content;

  const toolCalls = formatToolCalls(payload?.tool_calls);
  if (toolCalls) return `\n${toolCalls}`;

  if (payload?.function_call) {
    return `\n${formatNamedInvocation(
      payload.function_call.name,
      payload.function_call.arguments,
      'function call'
    )}`;
  }

  return '';
}

function formatResponseOutputItem(item) {
  if (!item || typeof item !== 'object') return '';

  if (item.type === 'message') {
    const content = flattenContent(item.content);
    if (content) return content;
  }

  if (/call/i.test(String(item.type || ''))) {
    const name = item.name || item.function?.name || item.id || item.type;
    const args = item.arguments || item.input || '';
    const output = flattenContent(item.output);
    let text = formatNamedInvocation(name, args, item.type);
    if (output) text += `\n${output}`;
    return text;
  }

  return flattenContent(item.content || item.output || item.input);
}

function assistantTextFromResponseObject(data) {
  if (typeof data?.output_text === 'string' && data.output_text) {
    return data.output_text;
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = output.map(formatResponseOutputItem).filter(Boolean);
  return parts.join('\n\n') || '(no content)';
}

function assistantTextFromResponsesEvent(event) {
  if (!event || typeof event !== 'object') return '';

  if (typeof event.delta === 'string' && String(event.type || '').includes('output_text.delta')) {
    return event.delta;
  }

  if (event.item && /call/i.test(String(event.item.type || ''))) {
    return `\n${formatResponseOutputItem(event.item)}`;
  }

  return '';
}

function responseObjectFromSseTranscript(raw) {
  const lines = String(raw || '').split('\n');
  let lastResponse = null;

  for (const line of lines) {
    const match = /^data:\s?(.*)$/.exec(line);
    if (!match) continue;
    const payload = match[1].trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.response) lastResponse = parsed.response;
    } catch {
      // Ignore non-JSON payloads.
    }
  }

  return lastResponse;
}

function parseExtraJson() {
  const raw = $('extraJson')?.value.trim() || '';
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Extra JSON is invalid: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Extra JSON must be a JSON object.');
  }

  return parsed;
}

function toChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'input_text') return { type: 'text', text: part.text || '' };
      if (part.type === 'input_image') {
        return {
          type: 'image_url',
          image_url: {
            url: part.image_url,
            detail: part.detail || 'auto',
          },
        };
      }
      return part;
    })
    .filter(Boolean);
}

function buildChatBody({ model, system, temperature, maxTokens, stream }) {
  return {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages
        .filter((message) => !message.pending && (message.role === 'user' || message.role === 'assistant'))
        .map((message) => ({
          role: message.role,
          content: toChatContent(message.content),
        })),
    ],
    temperature,
    max_tokens: maxTokens,
    stream,
  };
}

function buildResponsesBody({ model, system, temperature, maxTokens, stream }) {
  return {
    model,
    input: messages
      .filter((message) => !message.pending && (message.role === 'user' || message.role === 'assistant'))
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ...(system ? { instructions: system } : {}),
    temperature,
    max_output_tokens: maxTokens,
    stream,
  };
}

function buildRequestBody(mode, options) {
  const base = mode === 'responses' ? buildResponsesBody(options) : buildChatBody(options);
  return {
    ...base,
    ...parseExtraJson(),
  };
}

function usageLabel(data) {
  const usage = data?.usage || {};
  return usage.total_tokens ?? usage.output_tokens ?? '?';
}

function setStatus(status) {
  $('status').textContent = status;
}

function updateVisionMeta() {
  const input = $('imageFile');
  const meta = $('imageFileMeta');
  const file = input?.files?.[0];
  if (!meta) return;

  if (!file) {
    meta.textContent = 'No file selected.';
    return;
  }

  const kb = Math.round(file.size / 1024);
  meta.textContent = `${file.name} · ${kb} KB`;
}

function clearVisionInputs() {
  if ($('imageUrl')) $('imageUrl').value = '';
  if ($('imageFile')) $('imageFile').value = '';
  updateVisionMeta();
}

function render() {
  const box = $('messages');
  box.innerHTML = '';

  for (const message of messages) {
    const wrap = document.createElement('div');
    wrap.className = 'flex gap-3 ' + (message.role === 'user' ? 'justify-end' : '');

    const bubble = document.createElement('div');
    bubble.className =
      'max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap ' +
      (message.role === 'user'
        ? 'bg-brand-500 text-white'
        : message.role === 'assistant'
        ? 'bg-slate-100 text-slate-900'
        : 'bg-rose-50 text-rose-700 border border-rose-200 text-xs font-mono');

    const text = flattenContent(message.content);
    bubble.textContent = text || (message.pending ? '...' : '');

    const images = extractImageSources(message.content);
    if (images.length) {
      if (text) {
        bubble.textContent = text;
      } else {
        bubble.textContent = '[image]';
      }

      for (const image of images) {
        const img = document.createElement('img');
        img.src = image.src;
        img.alt = image.label || 'image';
        img.className = 'mt-2 rounded-md border max-h-40 object-contain bg-white/70';
        bubble.appendChild(document.createElement('br'));
        bubble.appendChild(img);
      }
    }

    if (message.pending) bubble.classList.add('opacity-60');
    wrap.appendChild(bubble);
    box.appendChild(wrap);
  }

  box.scrollTop = box.scrollHeight;
}

function clearConversation() {
  messages.length = 0;
  render();
  $('details').textContent = '';
  $('detailsTimer').textContent = '';
  setStatus('ready');
}

function endpointForMode(mode, rawKey) {
  if (rawKey) {
    return mode === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  }
  return mode === 'responses' ? '/api/admin/playground/responses' : '/api/admin/playground/chat';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

async function collectVisionContentParts() {
  const parts = [];
  const detail = $('imageDetail')?.value || 'auto';
  const imageUrl = $('imageUrl')?.value.trim() || '';
  const imageFile = $('imageFile')?.files?.[0] || null;

  if (imageUrl) {
    parts.push({
      type: 'input_image',
      image_url: imageUrl,
      detail,
    });
  }

  if (imageFile) {
    const dataUrl = await fileToDataUrl(imageFile);
    parts.push({
      type: 'input_image',
      image_url: dataUrl,
      detail,
      filename: imageFile.name,
    });
  }

  return parts;
}

async function buildUserMessageContent(text) {
  const trimmed = text.trim();
  const visionParts = await collectVisionContentParts();

  if (!visionParts.length) return trimmed;

  const content = [];
  if (trimmed) {
    content.push({ type: 'input_text', text: trimmed });
  }
  content.push(...visionParts);
  return content;
}

async function send() {
  const text = $('userInput').value;
  const hasImageUrl = Boolean($('imageUrl')?.value.trim());
  const hasImageFile = Boolean($('imageFile')?.files?.length);
  if (!text.trim() && !hasImageUrl && !hasImageFile) return;

  const mode = $('apiMode').value;
  const model = $('model').value;
  const system = $('system').value.trim();
  const temperature = parseFloat($('temperature').value) || 0.7;
  const maxTokens = parseInt($('maxTokens').value, 10) || 512;
  const stream = $('stream').checked;
  const rawKey = $('apiKeyRaw').value.trim();

  const started = performance.now();
  setStatus('sending...');

  let assistantMsg = null;

  try {
    const userContent = await buildUserMessageContent(text);
    $('userInput').value = '';
    clearVisionInputs();

    messages.push({ role: 'user', content: userContent });
    assistantMsg = { role: 'assistant', content: '', pending: true };
    messages.push(assistantMsg);
    render();

    const body = buildRequestBody(mode, {
      model,
      system,
      temperature,
      maxTokens,
      stream,
    });

    const endpoint = endpointForMode(mode, rawKey);
    const headers = { 'content-type': 'application/json' };
    if (rawKey) {
      headers.authorization = `Bearer ${rawKey}`;
    } else {
      body.__api_key_id = Number($('apiKeyId').value);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const contentType = response.headers.get('content-type') || '';

    if (stream && (!response.ok || !contentType.includes('text/event-stream'))) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err.slice(0, 400)}`);
    }

    if (!response.ok && !stream) {
      const err = await response.text();
      throw new Error(`HTTP ${response.status}: ${err.slice(0, 400)}`);
    }

    if (stream) {
      assistantMsg.content = '';
      assistantMsg.pending = true;
      setStatus('streaming...');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalRaw = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        totalRaw += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const match = /^data:\s?(.*)$/.exec(line);
          if (!match) continue;
          const payload = match[1].trim();
          if (!payload || payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            const delta =
              mode === 'responses'
                ? assistantTextFromResponsesEvent(parsed)
                : assistantTextFromChatChunk(parsed?.choices?.[0]);
            if (delta) {
              assistantMsg.content += delta;
              render();
            }
          } catch {
            // Ignore non-JSON SSE payloads.
          }
        }
      }

      if (mode === 'responses' && !assistantMsg.content) {
        const completedResponse = responseObjectFromSseTranscript(totalRaw);
        assistantMsg.content = assistantTextFromResponseObject(completedResponse);
      }

      assistantMsg.pending = false;
      render();
      $('details').textContent = totalRaw.slice(-12000);
      const took = Math.round(performance.now() - started);
      $('detailsTimer').textContent = `${took} ms · streamed`;
      setStatus('done');
      return;
    }

    const data = await response.json();
    assistantMsg.content =
      mode === 'responses'
        ? assistantTextFromResponseObject(data)
        : assistantTextFromChatMessage(data?.choices?.[0]?.message);
    assistantMsg.pending = false;
    render();
    $('details').textContent = JSON.stringify(data, null, 2);
    const took = Math.round(performance.now() - started);
    $('detailsTimer').textContent = `${took} ms · ${usageLabel(data)} tokens`;
    setStatus('done');
  } catch (err) {
    if (assistantMsg) {
      assistantMsg.pending = false;
      assistantMsg.content = '';
    }
    messages.push({ role: 'error', content: String(err.message || err) });
    render();
    setStatus('error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('sendBtn').addEventListener('click', send);
  $('clearBtn').addEventListener('click', clearConversation);
  $('clearVisionBtn').addEventListener('click', clearVisionInputs);
  $('imageFile').addEventListener('change', updateVisionMeta);
  $('userInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  updateVisionMeta();

  // Preselect model from `?model=` query (used by models page "play" button).
  const params = new URLSearchParams(window.location.search);
  const preModel = params.get('model');
  if (preModel) {
    const sel = $('model');
    if (sel && [...sel.options].some((o) => o.value === preModel)) {
      sel.value = preModel;
    }
  }
});
