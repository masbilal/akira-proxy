/**
 * Chat UI - ChatGPT/Claude-like interface
 * Features: Session management, model selection, markdown rendering, code highlighting
 */

// State
let currentSession = null;
let messages = [];
let isStreaming = false;

// DOM Elements
const $ = (id) => document.getElementById(id);
const sessionList = $('sessionList');
const messagesContainer = $('messagesContainer');
const messagesEl = $('messages');
const userInput = $('userInput');
const sendBtn = $('sendBtn');
const newChatBtn = $('newChatBtn');
const modelSelect = $('modelSelect');
const apiKeySelect = $('apiKeySelect');
const chatTitle = $('chatTitle');
const chatStatus = $('chatStatus');
const tokenCount = $('tokenCount');

// ============================================
// Markdown Renderer with Syntax Highlighting
// ============================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Configure marked
if (typeof marked !== 'undefined') {
  marked.setOptions({
    highlight: function(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch (e) {}
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true
  });
}

function renderMarkdown(text) {
  if (!text) return '';
  
  // Pre-process code blocks to add headers and copy buttons
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const langLabel = lang || 'plaintext';
    const escapedCode = escapeHtml(code.trim());
    const highlighted = lang && hljs.getLanguage(lang) 
      ? hljs.highlight(code.trim(), { language: lang }).value 
      : escapeHtml(code.trim());
    
    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span>${langLabel}</span>
        <button class="copy-btn" onclick="copyCode(this)">Copy</button>
      </div>
      <pre><code class="hljs language-${langLabel}">${highlighted}</code></pre>
    </div>`;
  });
  
  // Use marked for the rest
  if (typeof marked !== 'undefined') {
    // Don't let marked process code blocks again
    processed = processed.replace(/<div class="code-block-wrapper">[\s\S]*?<\/div>/g, (match) => {
      return `__CODE_BLOCK_${Math.random().toString(36).substr(2, 9)}__`;
    });
    
    let rendered = marked.parse(processed);
    
    // Restore code blocks
    const codeBlocks = processed.match(/__CODE_BLOCK_[a-z0-9]+__/g) || [];
    // They were already replaced, so we need to re-replace from original
    
    return rendered;
  }
  
  return escapeHtml(text);
}

// Copy code to clipboard
window.copyCode = function(btn) {
  const codeBlock = btn.closest('.code-block-wrapper').querySelector('code');
  const text = codeBlock.textContent;
  
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
};

// ============================================
// Message Rendering
// ============================================

function createMessageElement(msg) {
  const div = document.createElement('div');
  div.className = `message-enter flex gap-4 ${msg.role === 'user' ? 'justify-end' : ''}`;
  div.dataset.id = msg.id;
  
  if (msg.role === 'user') {
    div.innerHTML = `
      <div class="max-w-2xl">
        <div class="bg-brand-500/20 border border-brand-500/30 rounded-xl px-4 py-3 text-sm">
          ${escapeHtml(msg.content)}
        </div>
      </div>
    `;
  } else if (msg.role === 'assistant') {
    div.innerHTML = `
      <div class="w-8 h-8 shrink-0 rounded-lg bg-purple-500/20 flex items-center justify-center">
        <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
        </svg>
      </div>
      <div class="flex-1 max-w-2xl">
        <div class="prose text-sm text-zinc-200">
          ${renderMarkdown(msg.content)}
        </div>
      </div>
    `;
  } else if (msg.role === 'system') {
    div.innerHTML = `
      <div class="w-8 h-8 shrink-0 rounded-lg bg-amber-500/20 flex items-center justify-center">
        <svg class="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </div>
      <div class="flex-1 max-w-2xl">
        <div class="text-sm text-zinc-400 italic">${escapeHtml(msg.content)}</div>
      </div>
    `;
  }
  
  return div;
}

function createTypingIndicator() {
  const div = document.createElement('div');
  div.id = 'typingIndicator';
  div.className = 'flex gap-4';
  div.innerHTML = `
    <div class="w-8 h-8 shrink-0 rounded-lg bg-purple-500/20 flex items-center justify-center">
      <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
      </svg>
    </div>
    <div class="flex-1 max-w-2xl">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  return div;
}

function renderMessages() {
  messagesEl.innerHTML = '';
  
  if (messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="text-center py-20">
        <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-500/20 flex items-center justify-center">
          <svg class="w-8 h-8 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
          </svg>
        </div>
        <h2 class="text-xl font-medium text-zinc-300 mb-2">Start a new conversation</h2>
        <p class="text-sm text-zinc-500">Select a model and start chatting</p>
      </div>
    `;
    return;
  }
  
  messages.forEach(msg => {
    messagesEl.appendChild(createMessageElement(msg));
  });
  
  scrollToBottom();
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ============================================
// API Interactions
// ============================================

async function createSession() {
  const model = modelSelect.value;
  const apiKeyId = apiKeySelect.value;
  
  const res = await fetch('/chat/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, api_key_id: apiKeyId || null })
  });
  
  const data = await res.json();
  return data.session;
}

async function loadSession(uuid) {
  const res = await fetch(`/chat/api/sessions/${uuid}`);
  const data = await res.json();
  
  currentSession = data.session;
  messages = data.messages || [];
  modelSelect.value = currentSession.model;
  apiKeySelect.value = currentSession.api_key_id || '';
  chatTitle.textContent = currentSession.title;
  
  renderMessages();
  updateSessionListActive();
}

async function deleteSession(uuid) {
  await fetch(`/chat/api/sessions/${uuid}`, { method: 'DELETE' });
  
  if (currentSession && currentSession.uuid === uuid) {
    currentSession = null;
    messages = [];
    chatTitle.textContent = 'New Chat';
    renderMessages();
  }
  
  refreshSessionList();
}

async function refreshSessionList() {
  const res = await fetch('/chat/api/sessions');
  const data = await res.json();
  
  sessionList.innerHTML = '';
  
  if (data.sessions.length === 0) {
    sessionList.innerHTML = '<div class="text-center text-zinc-500 text-sm py-8">No conversations yet</div>';
    return;
  }
  
  data.sessions.forEach(s => {
    const div = document.createElement('div');
    div.className = `session-item group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-zinc-800 transition-colors ${currentSession && currentSession.uuid === s.uuid ? 'bg-zinc-800' : ''}`;
    div.dataset.uuid = s.uuid;
    div.innerHTML = `
      <svg class="w-4 h-4 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
      </svg>
      <span class="flex-1 text-sm truncate">${escapeHtml(s.title)}</span>
      <span class="text-xs text-zinc-600">${s.message_count || 0}</span>
      <button class="delete-session opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-all" data-uuid="${s.uuid}">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
      </button>
    `;
    sessionList.appendChild(div);
  });
}

function updateSessionListActive() {
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('bg-zinc-800', currentSession && el.dataset.uuid === currentSession.uuid);
  });
}

async function saveMessage(role, content, tokens = 0) {
  if (!currentSession) return null;
  
  const res = await fetch(`/chat/api/sessions/${currentSession.uuid}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, content, tokens })
  });
  
  const data = await res.json();
  return data.message;
}

async function updateSessionTitle(title) {
  if (!currentSession) return;
  
  await fetch(`/chat/api/sessions/${currentSession.uuid}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  
  chatTitle.textContent = title;
}

// ============================================
// Chat Completion (Proxy Integration)
// ============================================

async function sendMessage(content) {
  if (isStreaming) return;
  isStreaming = true;
  
  // Create session if needed
  if (!currentSession) {
    currentSession = await createSession();
    refreshSessionList();
  }
  
  // Add user message
  const userMsg = { role: 'user', content };
  messages.push(userMsg);
  renderMessages();
  
  // Save to DB
  await saveMessage('user', content);
  
  // Update title from first message
  if (messages.length === 1) {
    const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
    updateSessionTitle(title);
  }
  
  // Show typing indicator
  messagesEl.appendChild(createTypingIndicator());
  scrollToBottom();
  
  chatStatus.textContent = 'Generating...';
  sendBtn.disabled = true;
  
  try {
    // Build messages for API
    const apiMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));
    
    // Get API key
    let apiKey = null;
    const apiKeyId = apiKeySelect.value;
    if (apiKeyId) {
      // For the chat UI, we'll use a stored raw key or prompt
      // Since we don't store raw keys, we need an alternative
      // Option 1: Use session-based proxy auth
      // Option 2: Have user enter key in a modal
      
      // For now, we'll make an unauthenticated request to our own proxy
      // which will use the internal routing
    }
    
    // Build request body
    const body = {
      model: modelSelect.value,
      messages: apiMessages,
      stream: true
    };
    
    // Make streaming request to our chat API
    const res = await fetch('/chat/api/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chat-Session': currentSession.uuid
      },
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error?.message || error.error || 'Request failed');
    }
    
    // Remove typing indicator
    $('typingIndicator')?.remove();
    
    // Add assistant message placeholder
    const assistantMsg = { role: 'assistant', content: '' };
    messages.push(assistantMsg);
    const msgEl = createMessageElement(assistantMsg);
    messagesEl.appendChild(msgEl);
    
    // Stream response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        const match = /^data:\s?(.*)$/.exec(line);
        if (!match) continue;
        
        const payload = match[1].trim();
        if (!payload || payload === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          fullContent += delta;
          
          // Update message content
          assistantMsg.content = fullContent;
          const contentEl = msgEl.querySelector('.prose');
          if (contentEl) {
            contentEl.innerHTML = renderMarkdown(fullContent);
          }
          
          scrollToBottom();
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
    
    // Save assistant message
    await saveMessage('assistant', fullContent);
    
    chatStatus.textContent = 'Ready';
    refreshSessionList();
    
  } catch (err) {
    console.error('Chat error:', err);
    
    $('typingIndicator')?.remove();
    
    // Show error message
    const errorMsg = { role: 'system', content: `Error: ${err.message}` };
    messages.push(errorMsg);
    messagesEl.appendChild(createMessageElement(errorMsg));
    
    chatStatus.textContent = 'Error';
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
  }
}

// ============================================
// Event Handlers
// ============================================

// Send on Enter (Shift+Enter for new line)
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const content = userInput.value.trim();
    if (content && !isStreaming) {
      sendMessage(content);
      userInput.value = '';
      userInput.style.height = 'auto';
    }
  }
});

// Auto-resize textarea
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
  
  // Rough token estimate (4 chars per token)
  const tokens = Math.ceil(userInput.value.length / 4);
  tokenCount.textContent = `~${tokens} tokens`;
});

// Send button
sendBtn.addEventListener('click', () => {
  const content = userInput.value.trim();
  if (content && !isStreaming) {
    sendMessage(content);
    userInput.value = '';
    userInput.style.height = 'auto';
  }
});

// New chat button
newChatBtn.addEventListener('click', () => {
  currentSession = null;
  messages = [];
  chatTitle.textContent = 'New Chat';
  renderMessages();
  updateSessionListActive();
});

// Session list clicks
sessionList.addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('.delete-session');
  if (deleteBtn) {
    e.stopPropagation();
    deleteSession(deleteBtn.dataset.uuid);
    return;
  }
  
  const item = e.target.closest('.session-item');
  if (item) {
    loadSession(item.dataset.uuid);
  }
});

// Model/API key change - update session if active
modelSelect.addEventListener('change', async () => {
  if (currentSession) {
    await fetch(`/chat/api/sessions/${currentSession.uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelSelect.value })
    });
  }
});

apiKeySelect.addEventListener('change', async () => {
  if (currentSession) {
    await fetch(`/chat/api/sessions/${currentSession.uuid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key_id: apiKeySelect.value || null })
    });
  }
});

// Initialize
renderMessages();
