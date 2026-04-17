const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === false || v == null) return;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach(c => { if (c == null || c === false) return;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
};
const fmt = (b) => {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};
const fmtUp = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};
const randId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

let token = localStorage.getItem('auth_token') || '';
const headers = () => ({ Authorization: `Bearer ${token}` });

const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { ...headers(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { logout(); return null; }
  if (r.status === 404) return null;
  try { return await r.json(); } catch { return null; }
};

// ─── Markdown rendering (self-contained, sanitized) ─────────────────────
const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function renderMarkdown(text) {
  if (!text) return '';
  // Extract code blocks first to protect them from other replacements
  const blocks = [];
  let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\u0000CODEBLOCK${blocks.length - 1}\u0000`;
  });
  src = escapeHtml(src);
  // Inline code (after escape, so HTML inside is already escaped)
  src = src.replace(/`([^`\n]+)`/g, '<code class="md-ic">$1</code>');
  // Headings
  src = src.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
           .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
           .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
           .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
           .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
           .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  // Bold / italic
  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
           .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>')
           .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
  // Links [text](url)
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = /^(https?:|mailto:|\/)/.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Bullet lists
  src = src.replace(/(?:^[ \t]*[-*]\s+.+(?:\n|$))+/gm, block => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*[-*]\s+/, '')}</li>`).join('');
    return `<ul class="md-ul">${items}</ul>`;
  });
  // Numbered lists
  src = src.replace(/(?:^[ \t]*\d+\.\s+.+(?:\n|$))+/gm, block => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
    return `<ol class="md-ol">${items}</ol>`;
  });
  // Blockquote
  src = src.replace(/(?:^&gt;\s+.+(?:\n|$))+/gm, block => {
    const body = block.trim().split(/\n/).map(l => l.replace(/^&gt;\s+/, '')).join('<br>');
    return `<blockquote class="md-bq">${body}</blockquote>`;
  });
  // Paragraphs (double newline)
  src = src.split(/\n{2,}/).map(p => {
    if (/^<(h\d|ul|ol|pre|blockquote|p)/.test(p.trim())) return p;
    return `<p>${p.trim().replace(/\n/g, '<br>')}</p>`;
  }).join('');
  // Restore code blocks
  src = src.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => {
    const b = blocks[+i];
    const escCode = escapeHtml(b.code);
    const langAttr = b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : '';
    return `<pre class="md-code"${langAttr}><code>${escCode}</code></pre>`;
  });
  return src;
}

// ─── Icon ───────────────────────────────────────────────────────────────
const brandIcon = (cls) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls || 'brand-icon');
  svg.innerHTML = '<path fill="#00aaaa" d="m11 14.5c0 .828-.672 1.5-1.5 1.5s-1.5-.672-1.5-1.5.672-1.5 1.5-1.5 1.5.672 1.5 1.5zm3.5-1.5c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5 1.5-.672 1.5-1.5-.672-1.5-1.5-1.5zm5.5 0v3c.008.585-.55 1.108-1.134.973-.438 1.735-1.998 3.027-3.866 3.027h-6c-1.868 0-3.429-1.292-3.866-3.027-.583.135-1.141-.388-1.134-.973v-3c-.008-.585.55-1.108 1.134-.973.438-1.734 1.998-3.027 3.866-3.027h2v-1c0-.553.448-1 1-1s1 .447 1 1v1h2c1.868 0 3.429 1.292 3.866 3.027.583-.135 1.141.388 1.134.973zm-3 0c0-1.103-.897-2-2-2h-6c-1.103 0-2 .897-2 2v3c0 1.103.897 2 2 2h6c1.103 0 2-.897 2-2zm7-3.276v9.276c0 2.757-2.243 5-5 5h-14c-2.757 0-5-2.243-5-5v-9.276c0-1.665.824-3.214 2.204-4.145l6.999-4.724c1.699-1.146 3.895-1.146 5.594 0l7 4.724c1.379.931 2.203 2.479 2.203 4.145zm-2 0c0-.999-.494-1.928-1.322-2.486l-7-4.724c-.509-.345-1.094-.517-1.678-.517s-1.168.172-1.678.517l-7 4.723c-.828.559-1.322 1.487-1.322 2.486v9.276c0 1.654 1.346 3 3 3h14c1.654 0 3-1.346 3-3z"/>';
  return svg;
};

// ─── Login ──────────────────────────────────────────────────────────────
const renderLogin = () => {
  document.body.innerHTML = '';
  const err = el('div', { class: 'login-err' });
  const input = el('input', { type: 'password', placeholder: 'Password', class: 'login-input', autofocus: true });
  const form = el('form', {
    class: 'login-box',
    autocomplete: 'off',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await fetch('/api/auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value })
        });
        const d = await r.json();
        if (d.token) { token = d.token; localStorage.setItem('auth_token', token); boot(); }
        else err.textContent = 'Invalid password';
      } catch { err.textContent = 'Connection failed'; }
    }
  },
    brandIcon('login-logo'),
    el('div', { class: 'login-title' }, 'AGENT'),
    input,
    el('button', { type: 'submit', class: 'login-btn' }, 'Authenticate'),
    err
  );
  document.body.append(el('div', { class: 'login-wrap' }, form));
  input.focus();
};

const logout = () => { token = ''; localStorage.removeItem('auth_token'); renderLogin(); };

// ─── State ──────────────────────────────────────────────────────────────
let state = {
  stats: null, services: null, models: [], pull: [],
  chat: [], chatModel: '', chatBusy: false, chatStatus: null,
  savedChats: [], activeChatId: null, chatDirty: false, showSavedList: false,
  actionMsg: '',
};

// ─── Header ─────────────────────────────────────────────────────────────
const renderHeader = (stats) => el('div', { class: 'header' },
  el('div', { class: 'brand-wrap' },
    brandIcon(),
    el('span', { class: 'brand' }, 'AGENT')
  ),
  el('div', { class: 'header-right' },
    el('span', { class: stats ? 'online' : 'online offline' }, stats ? 'ONLINE' : 'OFFLINE'),
    el('button', { class: 'logout', onclick: logout }, 'Logout')
  )
);

// ─── Panels ─────────────────────────────────────────────────────────────
const statRow = (label, val, warn) =>
  el('div', { class: 'stat-row' },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: warn ? 'stat-val warn' : 'stat-val' }, val)
  );

const bar = (label, pct) => {
  const warn = pct > 85;
  return [
    el('div', { class: 'bar-label' }, `${label} ${pct.toFixed(0)}%`),
    el('div', { class: 'bar' }, el('div', { class: warn ? 'bar-fill warn' : 'bar-fill', style: `width:${pct}%` }))
  ];
};

const panelSystem = () => {
  const s = state.stats;
  if (!s) return el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, 'System'), el('div', { class: 'muted' }, 'loading…'));
  const cpuTemp = (s.temps || []).find(t => t.label === 'CPU Package');
  const g = s.gpu;
  const d = s.disk;
  const diskIO = (d.read_per_s != null || d.write_per_s != null)
    ? `↑${fmt(d.write_per_s || 0)}/s ↓${fmt(d.read_per_s || 0)}/s` : null;
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, 'System'),
    statRow('Uptime', fmtUp(s.uptime)),
    statRow('OS', s.os),
    statRow('CPU', s.cpu.model),
    statRow('CPU Load', `${s.cpu.physical}c/${s.cpu.cores}t — ${s.cpu.avg.toFixed(0)}%`),
    cpuTemp ? statRow('CPU Temp', `${cpuTemp.current}°C`, cpuTemp.current > 80) : null,
    g ? statRow('GPU', `${g.vendor ? g.vendor + ' ' : ''}${g.model}`) : null,
    g && g.util != null ? statRow('GPU Load', `${g.util}%${g.vram_mb ? ` · ${(g.vram_mb / 1024).toFixed(1)} GB VRAM` : ''}`) : null,
    g && g.temp != null ? statRow('GPU Temp', `${g.temp}°C`, g.temp > 85) : null,
    statRow('RAM', `${fmt(s.memory.used)} / ${fmt(s.memory.total)} (${s.memory.percent}%)`),
    statRow('Swap', `${fmt(s.swap.used)} / ${fmt(s.swap.total)}`),
    statRow('Disk /', `${fmt(s.disk.used)} / ${fmt(s.disk.total)} (${s.disk.percent}%)`),
    s.home ? statRow('Disk /home', `${fmt(s.home.used)} / ${fmt(s.home.total)} (${s.home.percent}%)`) : null,
    diskIO ? statRow('Disk I/O', diskIO) : null,
    statRow('Network', `↑${fmt(s.network.sent_per_s)}/s ↓${fmt(s.network.recv_per_s)}/s`),
    ...bar('CPU', s.cpu.avg),
    g && g.util != null ? bar('GPU', g.util) : [],
    ...bar('RAM', s.memory.percent),
    ...bar('Disk /', s.disk.percent),
    s.home ? bar('Disk /home', s.home.percent) : []
  );
};

const panelServices = () => {
  const sv = state.services || {};
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, 'Services'),
    ...Object.entries(sv).map(([name, s]) =>
      el('div', { class: 'svc-row' },
        el('span', { class: s.active ? 'svc-dot' : 'svc-dot off' }),
        el('div', { class: 'svc-info' },
          el('div', { class: 'svc-name' }, s.desc || name),
          el('div', { class: 'svc-meta' }, s.status || (s.active ? 'Running' : 'Stopped'))
        )
      )
    )
  );
};

const doAction = async (action) => {
  state.actionMsg = `Running ${action}…`; render();
  const d = await api('/api/action', { method: 'POST', body: JSON.stringify({ action }) });
  state.actionMsg = d?.ok ? `${action}: OK` : `${action}: ${d?.stderr || d?.error || 'failed'}`;
  render();
  setTimeout(() => { state.actionMsg = ''; render(); }, 4000);
};

const panelActions = () => {
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, 'Actions'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', onclick: () => doAction('restart-openwebui') }, 'Restart WebUI'),
      el('button', { class: 'btn', onclick: () => doAction('restart-n8n') }, 'Restart n8n'),
      el('button', { class: 'btn', onclick: () => doAction('restart-dashboard') }, 'Restart Dashboard'),
      el('button', { class: 'btn', onclick: () => doAction('pull-images') }, 'Pull Images'),
      el('button', { class: 'btn', onclick: () => doAction('compose-up') }, 'Compose Up'),
      el('button', { class: 'btn', onclick: () => doAction('compose-down') }, 'Compose Down')
    ),
    state.actionMsg ? el('div', { class: 'action-msg' }, state.actionMsg) : null,
    el('div', { class: 'panel-head sub' }, 'Model Pull Progress'),
    el('div', { class: 'pull-box' }, (state.pull || []).join('\n') || 'no active pull'),
    el('div', { class: 'panel-head sub' }, 'Quick Links'),
    el('a', { class: 'link-btn', href: 'https://chat.agent.ojee.net', target: '_blank' }, 'Open WebUI →', el('div', { class: 'link-sub' }, 'Full chat interface (with RAG)')),
    el('a', { class: 'link-btn', href: 'https://flow.agent.ojee.net', target: '_blank' }, 'n8n →', el('div', { class: 'link-sub' }, 'Workflow automation'))
  );
};

// ─── Chat actions ───────────────────────────────────────────────────────
const newChat = () => {
  state.chat = [];
  state.activeChatId = null;
  state.chatDirty = false;
  state.chatStatus = null;
  render();
};

const clearChat = () => {
  if (state.chat.length && !confirm('Clear current chat?')) return;
  newChat();
};

const saveChat = async () => {
  if (!state.chat.length) return;
  const id = state.activeChatId || randId();
  const firstUser = state.chat.find(m => m.role === 'user');
  const title = (firstUser?.content || 'Chat').slice(0, 80);
  await api(`/api/chats/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title, model: state.chatModel, messages: state.chat }),
  });
  state.activeChatId = id;
  state.chatDirty = false;
  await loadSavedChats();
  render();
};

const loadChat = async (id) => {
  if (state.chatDirty && !state.activeChatId) {
    if (!confirm('Discard unsaved chat?')) return;
  }
  const chat = await api(`/api/chats/${id}`);
  if (!chat) return;
  state.chat = chat.messages || [];
  state.activeChatId = chat.id;
  state.chatModel = chat.model || state.chatModel;
  state.chatDirty = false;
  state.showSavedList = false;
  render();
};

const deleteChat = async (id, e) => {
  if (e) e.stopPropagation();
  if (!confirm('Delete this chat?')) return;
  await api(`/api/chats/${id}`, { method: 'DELETE' });
  if (state.activeChatId === id) {
    state.chat = [];
    state.activeChatId = null;
  }
  await loadSavedChats();
  render();
};

const loadSavedChats = async () => {
  const list = await api('/api/chats');
  state.savedChats = Array.isArray(list) ? list : [];
};

// ─── Chat panel ─────────────────────────────────────────────────────────
const typingDots = () => el('span', { class: 'typing-dots' },
  el('span', {}, '●'), el('span', {}, '●'), el('span', {}, '●')
);

// Inline SVG paths keyed by chip kind (all 14x14, currentColor stroke/fill).
const SVG_PATHS = {
  model:       '<path fill="currentColor" d="M9 3h6v2h2a2 2 0 0 1 2 2v2h2v2h-2v2h2v2h-2v2a2 2 0 0 1-2 2h-2v2H9v-2H7a2 2 0 0 1-2-2v-2H3v-2h2v-2H3v-2h2V7a2 2 0 0 1 2-2h2V3zm0 6v6h6V9H9z"/>',
  web_search:  '<circle cx="10" cy="10" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14 14l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
  web_fetch:   '<path d="M12 3v10m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  get_stats:   '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  get_services:'<rect x="3" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="14" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="14" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>',
  list_models: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  read_file:   '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v6h6M8 13h8M8 17h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  list_dir:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  n8n:         '<circle cx="5" cy="5" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><circle cx="19" cy="19" r="2.5" fill="currentColor"/><path d="M7 6l4 5M17 7l-4 4M14 13l4 5" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  status:      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="12 6" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.2s" repeatCount="indefinite"/></circle>'
};
const svgChip = (kind) => {
  // Group all n8n_* tools under the shared n8n icon
  const resolved = kind && kind.startsWith('n8n_') ? 'n8n' : kind;
  const key = SVG_PATHS[resolved] ? resolved : 'model';
  const wrap = el('span', { class: 'chip-icon', html: `<svg viewBox="0 0 24 24" width="12" height="12">${SVG_PATHS[key]}</svg>` });
  return wrap;
};
const TOOL_LABELS = {
  web_search: 'Web search',
  web_fetch: 'Web page',
  get_stats: 'System stats',
  get_services: 'Services',
  list_models: 'Models',
  read_file: 'File read',
  list_dir: 'Directory',
  n8n_list_workflows: 'List workflows',
  n8n_get_workflow: 'Read workflow',
  n8n_create_workflow: 'New workflow',
  n8n_update_workflow: 'Update workflow',
  n8n_activate_workflow: 'Activate workflow',
  n8n_deactivate_workflow: 'Deactivate workflow',
  n8n_quick_workflow: 'Build workflow'
};
const chipLabel = (kind, raw) => kind === 'tool' ? (TOOL_LABELS[raw] || raw.replace(/_/g, ' ')) : raw;
const chip = (kind, raw, icon) => {
  const label = chipLabel(kind, raw);
  return el('span', { class: `chat-chip chip-${kind}`, title: raw },
    icon, el('span', { class: 'chip-label' }, label)
  );
};

const panelChat = () => {
  const lastIdx = state.chat.length - 1;

  const logChildren = state.chat.length === 0
    ? [el('div', { class: 'chat-empty' }, 'Ask anything…')]
    : state.chat.map((m, i) => {
      const isLast = i === lastIdx;
      const streaming = isLast && m.role === 'assistant' && state.chatBusy;
      const bodyEl = el('div', { class: 'md-body' });
      if (streaming && !m.content) {
        bodyEl.appendChild(typingDots());
      } else if (m.role === 'assistant') {
        bodyEl.innerHTML = renderMarkdown(m.content);
        if (streaming) {
          const cursor = el('span', { class: 'typing-cursor' }, '▍');
          bodyEl.appendChild(cursor);
        }
      } else {
        bodyEl.textContent = m.content;
      }

      if (m.role === 'user') {
        return el('div', { class: 'chat-msg chat-user' },
          el('div', { class: 'chat-label' }, 'user'),
          bodyEl
        );
      }

      const model = m.model || state.chatModel;
      const toolList = m.tools || [];
      const statusText = !streaming ? null
        : (state.chatStatus && state.chatStatus.startsWith('searching') ? state.chatStatus
        : (m.content ? 'typing' : 'thinking'));
      const chipRow = el('div', { class: 'chat-chips' },
        model ? chip('model', model, svgChip('model')) : null,
        ...toolList.map(t => chip('tool', t, svgChip(t))),
        statusText ? chip('status', statusText + '…', svgChip('status')) : null
      );
      return el('div', { class: 'chat-msg chat-assistant' }, chipRow, bodyEl);
    });

  const log = el('div', { class: 'chat-log' }, ...logChildren);

  const input = el('textarea', { class: 'chat-input', rows: '1', placeholder: state.chatModel ? 'Ask anything…' : 'Pull a model first' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // Auto-grow textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text || state.chatBusy || !state.chatModel) return;
    state.chat.push({ role: 'user', content: text });
    state.chat.push({ role: 'assistant', content: '', model: state.chatModel, tools: [] });
    state.chatBusy = true;
    state.chatStatus = 'thinking';
    state.chatDirty = true;
    input.value = '';
    render();

    const ac = new AbortController();
    state.chatAbort = ac;
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.chatModel,
          messages: state.chat.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
        }),
        signal: ac.signal
      });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.message?.content) {
              if (state.chatStatus !== 'typing') state.chatStatus = 'typing';
              state.chat[state.chat.length - 1].content += j.message.content;
              render();
            } else if (j.tool_call) {
              state.chatStatus = `searching · ${j.tool_call.name.replace(/^(get|list|read|web)_/, '')}`;
              const last = state.chat[state.chat.length - 1];
              if (!last.tools) last.tools = [];
              if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
              render();
            } else if (j.tool_result) {
              state.chatStatus = 'thinking';
              render();
            }
          } catch {}
        }
      }
      // Auto-save if active chat exists
      if (state.activeChatId) { saveChat().catch(() => {}); }
    } catch (e) {
      if (e.name === 'AbortError') {
        const last = state.chat[state.chat.length - 1];
        if (!last.content) last.content = '*(stopped)*';
        else last.content += '\n\n*(stopped)*';
      } else {
        state.chat[state.chat.length - 1].content = `Error: ${e.message}`;
      }
    }
    state.chatAbort = null;
    state.chatBusy = false;
    state.chatStatus = null;
    render();
  };

  const stop = () => { state.chatAbort?.abort(); };

  const modelSel = el('select', { class: 'chat-select', onchange: (e) => { state.chatModel = e.target.value; render(); } },
    ...(state.models.length ? state.models : [{ name: 'no models' }]).map(m =>
      el('option', { value: m.name, ...(m.name === state.chatModel ? { selected: true } : {}) }, m.name)
    )
  );

  const toolbar = el('div', { class: 'chat-toolbar' },
    el('button', { class: 'btn sm', onclick: newChat, title: 'New chat' }, '+ New'),
    el('button', { class: 'btn sm', onclick: saveChat, title: 'Save this chat', disabled: state.chat.length === 0 }, state.activeChatId ? 'Update' : 'Save'),
    el('button', { class: 'btn sm', onclick: clearChat, title: 'Clear current chat', disabled: state.chat.length === 0 }, 'Clear'),
    el('button', { class: 'btn sm', onclick: () => { state.showSavedList = !state.showSavedList; render(); }, title: 'Show saved chats' },
      `Saved (${state.savedChats.length})`)
  );

  const savedList = state.showSavedList
    ? el('div', { class: 'saved-list' },
        state.savedChats.length === 0
          ? el('div', { class: 'muted small' }, 'no saved chats yet')
          : state.savedChats.map(c =>
              el('div', { class: 'saved-item' + (c.id === state.activeChatId ? ' active' : ''), onclick: () => loadChat(c.id) },
                el('div', { class: 'saved-title' }, c.title),
                el('button', { class: 'saved-del', onclick: (e) => deleteChat(c.id, e), title: 'Delete' }, '×')
              )
            )
      )
    : null;

  const activeIndicator = state.activeChatId
    ? el('div', { class: 'chat-active-badge' }, `editing: ${(state.savedChats.find(c => c.id === state.activeChatId) || {}).title || '—'}`)
    : null;

  return el('div', { class: 'panel chat-panel' },
    el('div', { class: 'panel-head' }, 'Chat'),
    modelSel,
    toolbar,
    savedList,
    activeIndicator,
    el('div', { class: 'chat-wrap' },
      log,
      el('div', { class: 'chat-form' },
        input,
        el('button', {
          class: 'btn primary chat-send' + (state.chatBusy ? ' chat-stop' : ''),
          onclick: state.chatBusy ? stop : send,
          disabled: !state.chatModel
        }, state.chatBusy ? 'Stop' : 'Send')
      )
    )
  );
};

// ─── Render (preserves chat input state) ────────────────────────────────
const render = () => {
  const active = document.activeElement;
  const wasChatInput = active && active.classList && active.classList.contains('chat-input');
  const preserved = wasChatInput ? {
    value: active.value, start: active.selectionStart, end: active.selectionEnd,
  } : null;

  // If a <select> dropdown is currently open (focused), defer the re-render
  // so we don't snap it shut during the 5s stats poll. The next tick (or the
  // next user action that calls render()) will redraw once it's closed.
  if (document.activeElement && document.activeElement.tagName === 'SELECT') return;

  const oldLog = document.querySelector('.chat-log');
  const prevScroll = oldLog ? oldLog.scrollTop : 0;
  const stickToBottom = oldLog ? (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 60) : true;
  const pageScrollY = window.scrollY || document.documentElement.scrollTop || 0;

  document.body.innerHTML = '';
  document.body.append(
    el('div', { class: 'dash' },
      renderHeader(state.stats),
      el('div', { class: 'grid' },
        panelSystem(),
        panelServices(),
        panelActions(),
        panelChat()
      )
    )
  );

  if (preserved) {
    const newInput = document.querySelector('.chat-input');
    if (newInput) {
      newInput.value = preserved.value;
      newInput.focus();
      try { newInput.setSelectionRange(preserved.start, preserved.end); } catch {}
      // Re-apply auto-grow
      newInput.style.height = 'auto';
      newInput.style.height = Math.min(newInput.scrollHeight, 160) + 'px';
    }
  }

  const newLog = document.querySelector('.chat-log');
  if (newLog) newLog.scrollTop = stickToBottom ? newLog.scrollHeight : prevScroll;
  if (pageScrollY) window.scrollTo(0, pageScrollY);
};

// ─── Polling ────────────────────────────────────────────────────────────
const refresh = async () => {
  if (!token) return;
  const [stats, services, models, pull] = await Promise.all([
    api('/api/stats'),
    api('/api/services'),
    api('/api/models'),
    api('/api/pull-progress')
  ]);
  if (stats) state.stats = stats;
  if (services) state.services = services;
  if (models?.models) {
    // Sort so preferred models appear first in the dropdown
    const preferred = ['llama3.1:8b', 'llama3.2:3b', 'qwen2.5:7b'];
    const byPref = (a, b) => {
      const ia = preferred.indexOf(a.name);
      const ib = preferred.indexOf(b.name);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    };
    state.models = [...models.models].sort(byPref);
    if (!state.chatModel && state.models.length) {
      state.chatModel = state.models[0].name;
    }
  }
  if (pull) state.pull = pull.lines;
  render();
};

// ─── Boot ───────────────────────────────────────────────────────────────
const boot = async () => {
  await loadSavedChats();
  render();
  refresh();
  setInterval(refresh, 5000);
};

if (!token) renderLogin();
else boot();
