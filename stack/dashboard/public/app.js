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
const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtDur = (ms) => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
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
  const blocks = [];
  let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, '') });
    return `\u0000CODEBLOCK${blocks.length - 1}\u0000`;
  });
  src = escapeHtml(src);
  src = src.replace(/`([^`\n]+)`/g, '<code class="md-ic">$1</code>');
  src = src.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
           .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
           .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
           .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
           .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
           .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
           .replace(/(^|\s)\*([^*\n]+)\*/g, '$1<em>$2</em>')
           .replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = /^(https?:|mailto:|\/)/.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  src = src.replace(/(?:^[ \t]*[-*]\s+.+(?:\n|$))+/gm, block => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*[-*]\s+/, '')}</li>`).join('');
    return `<ul class="md-ul">${items}</ul>`;
  });
  src = src.replace(/(?:^[ \t]*\d+\.\s+.+(?:\n|$))+/gm, block => {
    const items = block.trim().split(/\n/).map(l => `<li>${l.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
    return `<ol class="md-ol">${items}</ol>`;
  });
  src = src.replace(/(?:^&gt;\s+.+(?:\n|$))+/gm, block => {
    const body = block.trim().split(/\n/).map(l => l.replace(/^&gt;\s+/, '')).join('<br>');
    return `<blockquote class="md-bq">${body}</blockquote>`;
  });
  src = src.split(/\n{2,}/).map(p => {
    if (/^<(h\d|ul|ol|pre|blockquote|p)/.test(p.trim())) return p;
    return `<p>${p.trim().replace(/\n/g, '<br>')}</p>`;
  }).join('');
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
  view: (location.hash.replace(/^#\/?/, '') || 'dashboard'),
  stats: null, services: null, models: [], pull: [],
  chat: [], chatModel: '', chatBusy: false, chatStatus: null,
  savedChats: [], activeChatId: null, chatDirty: false, showSavedList: false,
  chatJobId: null, chatStartTs: null,
  actionMsg: '',
  codeAgent: { enabled: false, sessions: [], active: null, messages: [], busy: false, status: null, abort: null,
    pickerOpen: false, pickerPath: '/media/ojee/NVME/Code/[GIT]/Claude', pickerEntries: [], pickerParent: null,
    historyOpen: false, historyList: [], historyView: null, historyMessages: [] },
};

// ─── localStorage persistence ───────────────────────────────────────────
const persistChat = () => {
  try {
    localStorage.setItem('chat_state', JSON.stringify({
      chat: state.chat,
      chatModel: state.chatModel,
      activeChatId: state.activeChatId,
      chatDirty: state.chatDirty,
      chatJobId: state.chatJobId,
      chatBusy: state.chatBusy,
      chatStartTs: state.chatStartTs,
    }));
  } catch {}
};

const restoreChat = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('chat_state'));
    if (saved && saved.chat && saved.chat.length) {
      state.chat = saved.chat;
      state.chatModel = saved.chatModel || '';
      state.activeChatId = saved.activeChatId || null;
      state.chatDirty = saved.chatDirty || false;
      state.chatJobId = saved.chatJobId || null;
      // If was busy, try to reconnect
      if (saved.chatBusy && saved.chatJobId) {
        state.chatBusy = true;
        state.chatStartTs = saved.chatStartTs || null;
        state.chatStatus = 'reconnecting';
      }
    }
  } catch {}
};

const persistCode = () => {
  try {
    localStorage.setItem('code_state', JSON.stringify({
      active: state.codeAgent.active,
      messages: state.codeAgent.messages,
      busy: state.codeAgent.busy,
      startTs: state.codeAgent.startTs || null,
    }));
  } catch {}
};

const restoreCode = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('code_state'));
    if (saved && saved.active) {
      state.codeAgent.active = saved.active;
      state.codeAgent.messages = saved.messages || [];
      if (saved.busy) {
        state.codeAgent.busy = true;
        state.codeAgent.startTs = saved.startTs || null;
        state.codeAgent.status = 'reconnecting';
      }
    }
  } catch {}
};

window.addEventListener('hashchange', () => {
  state.view = location.hash.replace(/^#\/?/, '') || 'dashboard';
  render();
});

const setView = (v) => {
  state.view = v;
  history.replaceState(null, '', '#/' + v);
  render();
};

// ─── Header ─────────────────────────────────────────────────────────────
const renderHeader = (stats) => el('div', { class: 'header' },
  el('div', { class: 'brand-wrap' },
    brandIcon(),
    el('span', { class: 'brand' }, 'AGENT')
  ),
  el('nav', { class: 'top-nav' },
    el('button', { class: 'nav-btn' + (state.view === 'dashboard' ? ' active' : ''), onclick: () => setView('dashboard') }, 'Dashboard'),
    state.codeAgent.enabled
      ? el('button', { class: 'nav-btn' + (state.view === 'code' ? ' active' : ''), onclick: () => setView('code') }, 'Claude Code')
      : null
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
  if (!s) return el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, 'System'), el('div', { class: 'muted' }, 'loading\u2026'));
  const cpuTemp = (s.temps || []).find(t => t.label === 'CPU Package');
  const g = s.gpu;
  const d = s.disk;
  const diskIO = (d.read_per_s != null || d.write_per_s != null)
    ? `\u2191${fmt(d.write_per_s || 0)}/s \u2193${fmt(d.read_per_s || 0)}/s` : null;
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, 'System'),
    statRow('Uptime', fmtUp(s.uptime)),
    statRow('OS', s.os),
    statRow('CPU', s.cpu.model),
    statRow('CPU Load', `${s.cpu.physical}c/${s.cpu.cores}t \u2014 ${s.cpu.avg.toFixed(0)}%`),
    cpuTemp ? statRow('CPU Temp', `${cpuTemp.current}\u00B0C`, cpuTemp.current > 80) : null,
    g ? statRow('GPU', `${g.vendor ? g.vendor + ' ' : ''}${g.model}`) : null,
    g && g.util != null ? statRow('GPU Load', `${g.util}%${g.vram_mb ? ` \u00B7 ${(g.vram_mb / 1024).toFixed(1)} GB VRAM` : ''}`) : null,
    g && g.temp != null ? statRow('GPU Temp', `${g.temp}\u00B0C`, g.temp > 85) : null,
    statRow('RAM', `${fmt(s.memory.used)} / ${fmt(s.memory.total)} (${s.memory.percent}%)`),
    statRow('Swap', `${fmt(s.swap.used)} / ${fmt(s.swap.total)}`),
    statRow('Disk /', `${fmt(s.disk.used)} / ${fmt(s.disk.total)} (${s.disk.percent}%)`),
    s.home ? statRow('Disk /home', `${fmt(s.home.used)} / ${fmt(s.home.total)} (${s.home.percent}%)`) : null,
    diskIO ? statRow('Disk I/O', diskIO) : null,
    statRow('Network', `\u2191${fmt(s.network.sent_per_s)}/s \u2193${fmt(s.network.recv_per_s)}/s`),
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
  state.actionMsg = `Running ${action}\u2026`; render();
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
    el('a', { class: 'link-btn', href: 'https://chat.agent.ojee.net', target: '_blank' }, 'Open WebUI \u2192', el('div', { class: 'link-sub' }, 'Full chat interface (with RAG)')),
    el('a', { class: 'link-btn', href: 'https://flow.agent.ojee.net', target: '_blank' }, 'n8n \u2192', el('div', { class: 'link-sub' }, 'Workflow automation'))
  );
};

// ─── Chat actions ───────────────────────────────────────────────────────
const newChat = () => {
  state.chat = [];
  state.activeChatId = null;
  state.chatDirty = false;
  state.chatStatus = null;
  state.chatJobId = null;
  state.chatStartTs = null;
  persistChat();
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
  persistChat();
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
  persistChat();
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
  persistChat();
  render();
};

const loadSavedChats = async () => {
  const list = await api('/api/chats');
  state.savedChats = Array.isArray(list) ? list : [];
};

// ─── Chat panel ─────────────────────────────────────────────────────────
const typingDots = () => el('span', { class: 'typing-dots' },
  el('span', {}, '\u25CF'), el('span', {}, '\u25CF'), el('span', {}, '\u25CF')
);

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
    ? [el('div', { class: 'chat-empty' }, 'Ask anything\u2026')]
    : state.chat.map((m, i) => {
      const isLast = i === lastIdx;
      const streaming = isLast && m.role === 'assistant' && state.chatBusy;
      const bodyEl = el('div', { class: 'md-body' });
      if (streaming && !m.content) {
        bodyEl.appendChild(typingDots());
      } else if (m.role === 'assistant') {
        bodyEl.innerHTML = renderMarkdown(m.content);
        if (streaming) {
          const cursor = el('span', { class: 'typing-cursor' }, '\u258D');
          bodyEl.appendChild(cursor);
        }
      } else {
        bodyEl.textContent = m.content;
      }

      if (m.role === 'user') {
        return el('div', { class: 'chat-msg chat-user' },
          el('div', { class: 'chat-label-row' },
            el('div', { class: 'chat-label' }, 'user'),
            m.ts ? el('span', { class: 'chat-time' }, fmtTime(m.ts)) : null
          ),
          bodyEl
        );
      }

      const model = m.model || state.chatModel;
      const toolList = m.tools || [];
      const statusText = !streaming ? null
        : (state.chatStatus && state.chatStatus.startsWith('searching') ? state.chatStatus
        : (m.content ? 'typing' : 'thinking'));

      // Live timer: show elapsed time always (counting up while streaming)
      const elapsed = streaming && state.chatStartTs
        ? Date.now() - state.chatStartTs
        : m.elapsed_ms;
      const timeStr = m.ts ? fmtTime(m.ts) : '';
      const durStr = elapsed != null ? fmtDur(elapsed) : '';
      const timeDisplay = timeStr + (durStr ? ' \u00B7 ' + durStr : '');

      const chipRow = el('div', { class: 'chat-chips' },
        model ? chip('model', model, svgChip('model')) : null,
        ...toolList.map(t => chip('tool', t, svgChip(t))),
        statusText ? chip('status', statusText + '\u2026', svgChip('status')) : null,
        // Always show time/duration (live timer element for streaming)
        timeDisplay ? el('span', { class: 'chat-time' + (streaming ? ' live-timer' : ''), 'data-start': streaming ? state.chatStartTs : '' }, timeDisplay) : null
      );
      return el('div', { class: 'chat-msg chat-assistant' }, chipRow, bodyEl);
    });

  const log = el('div', { class: 'chat-log' }, ...logChildren);

  const input = el('textarea', { class: 'chat-input', rows: '1', placeholder: state.chatModel ? 'Ask anything\u2026' : 'Pull a model first' });
  input.value = localStorage.getItem('draft_main') || '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_main', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text || state.chatBusy || !state.chatModel) return;
    const now = Date.now();
    state.chat.push({ role: 'user', content: text, ts: now });
    state.chat.push({ role: 'assistant', content: '', model: state.chatModel, tools: [], ts: null, elapsed_ms: null });
    state.chatBusy = true;
    state.chatStatus = 'thinking';
    state.chatDirty = true;
    state.chatStartTs = now;
    input.value = '';
    localStorage.removeItem('draft_main');
    persistChat();
    render();

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.chatModel,
          messages: state.chat.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
        }),
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
            if (j.job_id) {
              state.chatJobId = j.job_id;
              persistChat();
            } else if (j.message?.content) {
              if (state.chatStatus !== 'typing') state.chatStatus = 'typing';
              state.chat[state.chat.length - 1].content += j.message.content;
              render();
            } else if (j.tool_call) {
              state.chatStatus = `searching \u00B7 ${j.tool_call.name.replace(/^(get|list|read|web)_/, '')}`;
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
    // Set timestamp to NOW (completion time) and compute elapsed
    const last = state.chat[state.chat.length - 1];
    if (last && last.role === 'assistant') {
      last.ts = Date.now();
      last.elapsed_ms = state.chatStartTs ? Date.now() - state.chatStartTs : null;
    }
    state.chatJobId = null;
    state.chatBusy = false;
    state.chatStatus = null;
    state.chatStartTs = null;
    persistChat();
    render();
  };

  const stop = () => { state.chatAbort?.abort(); };

  const modelSel = el('select', { class: 'chat-select', onchange: (e) => { state.chatModel = e.target.value; persistChat(); render(); } },
    ...(state.models.length ? state.models : [{ name: 'no models' }]).map(m =>
      el('option', { value: m.name, ...(m.name === state.chatModel ? { selected: true } : {}) }, m.name)
    )
  );

  const toolbar = el('div', { class: 'chat-toolbar' },
    el('button', { class: 'btn sm', onclick: newChat, title: 'New chat' }, '+ New'),
    el('button', { class: 'btn sm', onclick: saveChat, title: 'Save this chat', disabled: state.chat.length === 0 }, 'Save'),
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
                el('button', { class: 'saved-del', onclick: (e) => deleteChat(c.id, e), title: 'Delete' }, '\u00D7')
              )
            )
      )
    : null;

  const activeIndicator = state.activeChatId
    ? el('div', { class: 'chat-active-badge' }, `editing: ${(state.savedChats.find(c => c.id === state.activeChatId) || {}).title || '\u2014'}`)
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

// ─── Code Agent panel (Claude Code on the Loq laptop) ─────────────────
const caLoadDir = async (p) => {
  const data = await api('/api/code-agent/dirs' + (p ? '?path=' + encodeURIComponent(p) : ''));
  if (data) {
    state.codeAgent.pickerPath = data.path;
    state.codeAgent.pickerParent = data.parent;
    state.codeAgent.pickerEntries = data.entries || [];
  }
  render();
};

const caRefreshSessions = async () => {
  const data = await api('/api/code-agent/sessions');
  if (data) state.codeAgent.sessions = data.active || [];
  render();
};

const caOpenHere = async () => {
  const cwd = state.codeAgent.pickerPath;
  const d = await api('/api/code-agent/sessions', { method: 'POST', body: JSON.stringify({ cwd }) });
  if (d && d.id) {
    state.codeAgent.active = d.id;
    state.codeAgent.messages = [];
    state.codeAgent.pickerOpen = false;
    persistCode();
    await caRefreshSessions();
  }
};

const caSelect = async (id) => {
  state.codeAgent.active = id;
  state.codeAgent.messages = [];
  persistCode();
  render();
  const h = await api(`/api/code-agent/sessions/${id}/history`);
  if (h?.messages) state.codeAgent.messages = h.messages;
  persistCode();
  render();
};

const caClose = async (id, e) => {
  if (e) e.stopPropagation();
  if (!confirm('Close this session? (Claude history is kept on disk.)')) return;
  await api(`/api/code-agent/sessions/${id}`, { method: 'DELETE' });
  if (state.codeAgent.active === id) {
    state.codeAgent.active = null;
    state.codeAgent.messages = [];
    state.codeAgent.busy = false;
    persistCode();
  }
  await caRefreshSessions();
};

// Reconnect to a code-agent session that was still streaming when the tab closed.
// If the child process is gone (404), just mark done and keep what's in messages.
const caReconnect = async (id) => {
  try {
    const r = await fetch(`/api/code-agent/sessions/${id}/stream`, { headers: headers() });
    if (!r.ok) {
      state.codeAgent.busy = false;
      state.codeAgent.status = null;
      state.codeAgent.startTs = null;
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (last && last.role === 'assistant' && !last.text) last.text = '*(session ended while disconnected)*';
      persistCode();
      render();
      return;
    }
    render();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const ensureLastAssistant = () => {
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (!last || last.role !== 'assistant') {
        state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6);
        if (p === '[DONE]') continue;
        try {
          const evt = JSON.parse(p);
          if (evt.type === 'text') {
            ensureLastAssistant();
            state.codeAgent.messages[state.codeAgent.messages.length - 1].text += evt.text;
            state.codeAgent.status = 'typing';
          } else if (evt.type === 'tool_use') {
            state.codeAgent.messages.push({ role: 'tool_use', tool: evt.tool, input: evt.input, ts: Date.now() });
            state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
            state.codeAgent.status = `running ${evt.tool}`;
          } else if (evt.type === 'tool_result') {
            state.codeAgent.status = 'thinking';
          } else if (evt.type === 'result') {
            state.codeAgent.status = evt.is_error ? 'error' : null;
          }
          persistCode();
          render();
        } catch {}
      }
    }
  } catch {}
  while (state.codeAgent.messages.length && state.codeAgent.messages[state.codeAgent.messages.length - 1].role === 'assistant' && !state.codeAgent.messages[state.codeAgent.messages.length - 1].text) {
    state.codeAgent.messages.pop();
  }
  for (let i = state.codeAgent.messages.length - 1; i >= 0; i--) {
    const m = state.codeAgent.messages[i];
    if (m.role === 'assistant' && m.ts && m.elapsed_ms == null) { m.elapsed_ms = Date.now() - m.ts; break; }
  }
  state.codeAgent.busy = false;
  state.codeAgent.status = null;
  state.codeAgent.startTs = null;
  persistCode();
  render();
};

const caSend = async (text) => {
  if (!state.codeAgent.active || !text.trim()) return;
  // Allow sending even while busy (message will queue on the server)
  const now = Date.now();
  state.codeAgent.messages.push({ role: 'user', text, ts: now });
  state.codeAgent.messages.push({ role: 'assistant', text: '', ts: now, elapsed_ms: null });
  state.codeAgent.busy = true;
  state.codeAgent.status = 'thinking';
  state.codeAgent.startTs = now;
  persistCode();
  render();
  try {
    const r = await fetch(`/api/code-agent/sessions/${state.codeAgent.active}/messages`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
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
        const p = line.slice(6);
        if (p === '[DONE]') continue;
        try {
          const evt = JSON.parse(p);
          const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
          if (evt.type === 'text') { last.text += evt.text; state.codeAgent.status = 'typing'; persistCode(); render(); }
          else if (evt.type === 'tool_use') { state.codeAgent.messages.push({ role: 'tool_use', tool: evt.tool, input: evt.input, ts: Date.now() }); state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null }); state.codeAgent.status = `running ${evt.tool}`; persistCode(); render(); }
          else if (evt.type === 'tool_result') { state.codeAgent.status = 'thinking'; render(); }
          else if (evt.type === 'result') { state.codeAgent.status = evt.is_error ? 'error' : null; }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (last) last.text = (last.text || '') + `\n\nError: ${e.message}`;
    }
  }
  while (state.codeAgent.messages.length && state.codeAgent.messages[state.codeAgent.messages.length - 1].role === 'assistant' && !state.codeAgent.messages[state.codeAgent.messages.length - 1].text) {
    state.codeAgent.messages.pop();
  }
  for (let i = state.codeAgent.messages.length - 1; i >= 0; i--) {
    const m = state.codeAgent.messages[i];
    if (m.role === 'assistant' && m.ts && m.elapsed_ms == null) { m.elapsed_ms = Date.now() - m.ts; break; }
  }
  state.codeAgent.busy = false;
  state.codeAgent.status = null;
  state.codeAgent.abort = null;
  state.codeAgent.startTs = null;
  persistCode();
  render();
};

// ─── Claude Code history browser ─────────────────────────────────────
const caLoadHistory = async () => {
  state.codeAgent.historyOpen = true;
  state.codeAgent.historyView = null;
  state.codeAgent.historyMessages = [];
  render();
  const data = await api('/api/code-agent/history');
  state.codeAgent.historyList = data?.conversations || [];
  render();
};

const caViewHistory = async (conv) => {
  state.codeAgent.historyView = conv;
  state.codeAgent.historyMessages = [];
  render();
  const data = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`);
  state.codeAgent.historyMessages = data?.messages || [];
  render();
};

const caDeleteHistory = async (conv, e) => {
  if (e) e.stopPropagation();
  if (!confirm(`Delete "${conv.title.slice(0, 60)}${conv.title.length > 60 ? '…' : ''}"?\n\nThis removes the conversation file from disk.`)) return;
  const r = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
  if (r?.ok) {
    state.codeAgent.historyList = state.codeAgent.historyList.filter(c => !(c.project === conv.project && c.id === conv.id));
    if (state.codeAgent.historyView && state.codeAgent.historyView.id === conv.id) {
      state.codeAgent.historyView = null;
      state.codeAgent.historyMessages = [];
    }
    render();
  }
};

const panelCodeAgent = () => {
  const ca = state.codeAgent;
  const activeSession = ca.sessions.find(s => s.id === ca.active);

  // Directory picker modal
  if (ca.pickerOpen) {
    const rows = [];
    if (ca.pickerParent && ca.pickerParent !== ca.pickerPath) {
      rows.push(el('div', { class: 'ca-dir-row', onclick: () => caLoadDir(ca.pickerParent) },
        svgChip('list_dir'), el('span', {}, '..')));
    }
    for (const e of ca.pickerEntries.filter(x => x.type === 'dir')) {
      rows.push(el('div', { class: 'ca-dir-row', onclick: () => caLoadDir(e.path) },
        svgChip('list_dir'), el('span', {}, e.name)));
    }
    return el('div', { class: 'panel ca-picker' },
      el('div', { class: 'panel-head' }, 'Open Claude Code In...'),
      el('div', { class: 'ca-path' }, ca.pickerPath),
      el('div', { class: 'ca-dir-list' }, ...rows),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn sm', onclick: () => { ca.pickerOpen = false; render(); } }, 'Cancel'),
        el('button', { class: 'btn sm primary', onclick: caOpenHere }, 'Open here')
      )
    );
  }

  // History browser
  if (ca.historyOpen) {
    if (ca.historyView) {
      // Viewing a specific past conversation
      const msgs = ca.historyMessages.map(m => {
        if (m.role === 'tool_use') {
          const input = typeof m.input === 'object' ? JSON.stringify(m.input).slice(0, 120) : String(m.input || '').slice(0, 120);
          return el('div', { class: 'ca-tool' }, svgChip('list_models'), el('span', {}, `${m.tool}(${input})`));
        }
        return el('div', { class: m.role === 'user' ? 'chat-msg chat-user' : 'chat-msg chat-assistant' },
          el('div', { class: 'chat-label-row' },
            el('div', { class: 'chat-label' }, m.role === 'user' ? 'user' : 'claude')
          ),
          el('div', { class: 'md-body', html: m.role === 'assistant' ? renderMarkdown(m.text) : undefined }, m.role === 'user' ? m.text : null)
        );
      });
      return el('div', { class: 'panel' },
        el('div', { class: 'panel-head' }, 'History'),
        el('button', { class: 'btn sm', onclick: () => { ca.historyView = null; ca.historyMessages = []; render(); } }, '\u2190 Back'),
        el('div', { class: 'ca-hist-title' }, ca.historyView.title),
        el('div', { class: 'ca-hist-meta' }, `Project: ${ca.historyView.project} \u00B7 ${ca.historyView.messageCount} events`),
        el('div', { class: 'chat-wrap' },
          el('div', { class: 'chat-log' }, ...msgs)
        )
      );
    }
    // History list
    return el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, 'Past Conversations'),
      el('button', { class: 'btn sm', onclick: () => { ca.historyOpen = false; render(); } }, '\u2190 Back'),
      ca.historyList.length === 0
        ? el('div', { class: 'muted small' }, 'no past conversations found')
        : el('div', { class: 'ca-hist-list' },
            ...ca.historyList.map(conv =>
              el('div', { class: 'saved-item', onclick: () => caViewHistory(conv) },
                el('button', { class: 'saved-del', onclick: (e) => caDeleteHistory(conv, e), title: 'Delete' }, '\u00D7'),
                el('div', { class: 'saved-title' }, conv.title),
                el('div', { class: 'ca-hist-date' }, fmtTime(conv.modified))
              )
            )
          )
    );
  }

  // Session chat view
  const msgs = ca.messages.map((m, i) => {
    if (m.role === 'tool_use') {
      const input = typeof m.input === 'object' ? JSON.stringify(m.input).slice(0, 120) : String(m.input || '').slice(0, 120);
      return el('div', { class: 'ca-tool' }, svgChip('list_models'), el('span', {}, `${m.tool}(${input})`));
    }
    const isLast = i === ca.messages.length - 1;
    const streaming = isLast && m.role === 'assistant' && ca.busy;
    const timeChip = m.ts && !streaming
      ? el('span', { class: 'chat-time' }, fmtTime(m.ts) + (m.elapsed_ms ? ' \u00B7 ' + fmtDur(m.elapsed_ms) : ''))
      : null;
    return el('div', { class: m.role === 'user' ? 'chat-msg chat-user' : 'chat-msg chat-assistant' },
      el('div', { class: 'chat-label-row' },
        el('div', { class: 'chat-label' }, m.role === 'user' ? 'user' : 'claude'),
        timeChip
      ),
      el('div', { class: 'md-body', html: m.role === 'assistant' ? renderMarkdown(m.text) : undefined }, m.role === 'user' ? m.text : null)
    );
  });

  const input = el('textarea', { class: 'chat-input', rows: '1', placeholder: activeSession ? 'message Claude\u2026' : 'pick a session' });
  input.value = localStorage.getItem('draft_code') || '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const v = input.value.trim();
      if (v) { input.value = ''; localStorage.removeItem('draft_code'); caSend(v); }
    }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_code', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  const sessionTabs = ca.sessions.map(s =>
    el('div', { class: 'ca-sess' + (s.id === ca.active ? ' active' : ''), onclick: () => caSelect(s.id) },
      el('span', { class: 'ca-sess-title' }, s.title),
      el('span', { class: 'ca-sess-cwd' }, s.cwd.replace(/^\/media\/ojee\/NVME\/Code\/\[GIT\]\//, '')),
      el('button', { class: 'ca-sess-del', onclick: (e) => caClose(s.id, e), title: 'Close' }, '\u00D7')
    )
  );

  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, 'Claude Code'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn sm primary', onclick: () => { ca.pickerOpen = true; render(); caLoadDir(ca.pickerPath); } }, '+ New session'),
      el('button', { class: 'btn sm', onclick: caRefreshSessions }, 'Refresh'),
      el('button', { class: 'btn sm', onclick: caLoadHistory }, 'History')
    ),
    ca.sessions.length ? el('div', { class: 'ca-sess-list' }, ...sessionTabs) : el('div', { class: 'muted small' }, 'no active sessions'),
    activeSession ? el('div', { class: 'chat-wrap' },
      el('div', { class: 'ca-active-head' },
        el('span', { class: 'ca-active-title' }, activeSession.title),
        el('span', { class: 'ca-active-cwd' }, activeSession.cwd),
        ca.status ? el('span', { class: 'chat-chip chip-status' }, svgChip('status'), el('span', { class: 'chip-label' }, ca.status)) : null
      ),
      el('div', { class: 'chat-log' }, ...msgs),
      el('div', { class: 'chat-form' },
        input,
        ca.busy ? el('button', {
          class: 'btn chat-send chat-stop',
          onclick: () => ca.abort?.abort()
        }, 'Stop') : null,
        el('button', {
          class: 'btn primary chat-send',
          onclick: () => {
            const v = input.value.trim();
            if (v) { input.value = ''; localStorage.removeItem('draft_code'); caSend(v); }
          }
        }, 'Send')
      )
    ) : null
  );
};

// ─── Live timer interval ─────────────────────────────────────────────────
let liveTimerInterval = null;

const startLiveTimer = () => {
  if (liveTimerInterval) clearInterval(liveTimerInterval);
  liveTimerInterval = setInterval(() => {
    const timerEl = document.querySelector('.live-timer');
    if (!timerEl || !state.chatBusy || !state.chatStartTs) {
      clearInterval(liveTimerInterval);
      liveTimerInterval = null;
      return;
    }
    const last = state.chat[state.chat.length - 1];
    const timeStr = last?.ts ? fmtTime(last.ts) : '';
    const elapsed = Date.now() - state.chatStartTs;
    timerEl.textContent = (timeStr ? timeStr + ' \u00B7 ' : '') + fmtDur(elapsed);
  }, 1000);
};

// ─── Render (preserves scroll positions + chat input) ────────────────────
const render = () => {
  // Preserve any .chat-input's value across renders, even when it isn't the
  // focused element (e.g. user clicked Stop — focus moves to the button, but
  // their drafted next message should survive the re-render).
  const oldInput = document.querySelector('.chat-input');
  const active = document.activeElement;
  const preserved = oldInput ? {
    value: oldInput.value,
    start: oldInput.selectionStart,
    end: oldInput.selectionEnd,
    focused: oldInput === active,
  } : null;

  // If a <select> dropdown is currently open (focused), defer the re-render
  if (document.activeElement && document.activeElement.tagName === 'SELECT') return;

  // Save scroll positions for all panels + chat-log + page
  const oldPanels = document.querySelectorAll('.panel');
  const panelScrolls = Array.from(oldPanels).map(p => ({ top: p.scrollTop, left: p.scrollLeft }));
  const oldLog = document.querySelector('.chat-log');
  const prevScroll = oldLog ? oldLog.scrollTop : 0;
  const stickToBottom = oldLog ? (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 60) : true;
  const pageScrollY = window.scrollY || document.documentElement.scrollTop || 0;

  document.body.innerHTML = '';
  const content = state.view === 'code'
    ? el('div', { class: 'code-page' }, panelCodeAgent())
    : el('div', { class: 'grid' }, panelSystem(), panelServices(), panelActions(), panelChat());
  document.body.append(
    el('div', { class: 'dash' },
      renderHeader(state.stats),
      content
    )
  );

  if (preserved) {
    const newInput = document.querySelector('.chat-input');
    if (newInput) {
      newInput.value = preserved.value;
      if (preserved.focused) {
        newInput.focus();
        try { newInput.setSelectionRange(preserved.start, preserved.end); } catch {}
      }
      newInput.style.height = 'auto';
      newInput.style.height = Math.min(newInput.scrollHeight, 160) + 'px';
    }
  }

  // Restore chat-log scroll
  const newLog = document.querySelector('.chat-log');
  if (newLog) newLog.scrollTop = stickToBottom ? newLog.scrollHeight : prevScroll;

  // Restore panel scroll positions (same order: system, services, actions, chat)
  const newPanels = document.querySelectorAll('.panel');
  newPanels.forEach((p, i) => {
    if (panelScrolls[i]) {
      p.scrollTop = panelScrolls[i].top;
      p.scrollLeft = panelScrolls[i].left;
    }
  });

  // Restore page scroll (mobile)
  if (pageScrollY) window.scrollTo(0, pageScrollY);

  // Start live timer if streaming
  if (state.chatBusy && state.chatStartTs) startLiveTimer();
};

// ─── Reconnect to background chat job ────────────────────────────────────
const reconnectChatJob = async (jobId) => {
  try {
    const r = await fetch(`/api/chat/jobs/${jobId}`, {
      headers: { ...headers() },
    });
    if (!r.ok) {
      // Job gone — mark as finished
      state.chatBusy = false;
      state.chatStatus = null;
      state.chatJobId = null;
      state.chatStartTs = null;
      const last = state.chat[state.chat.length - 1];
      if (last && last.role === 'assistant' && !last.content) last.content = '*(session expired)*';
      persistChat();
      render();
      return;
    }
    render();
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
            state.chatStatus = 'typing';
            state.chat[state.chat.length - 1].content += j.message.content;
            render();
          } else if (j.tool_call) {
            state.chatStatus = `searching \u00B7 ${j.tool_call.name.replace(/^(get|list|read|web)_/, '')}`;
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
  } catch {}
  const last = state.chat[state.chat.length - 1];
  if (last && last.role === 'assistant') {
    last.ts = Date.now();
    last.elapsed_ms = state.chatStartTs ? Date.now() - state.chatStartTs : null;
  }
  state.chatJobId = null;
  state.chatBusy = false;
  state.chatStatus = null;
  state.chatStartTs = null;
  persistChat();
  if (state.activeChatId) saveChat().catch(() => {});
  render();
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
  if (!state.codeAgent.checked) {
    state.codeAgent.checked = true;
    const cfg = await api('/api/code-agent/config');
    state.codeAgent.enabled = !!cfg?.enabled;
  }
  if (state.codeAgent.enabled && !state.codeAgent.busy) {
    const s = await api('/api/code-agent/sessions');
    if (s?.active) state.codeAgent.sessions = s.active;
  }
  render();
};

// ─── Boot ───────────────────────────────────────────────────────────────
const boot = async () => {
  restoreChat();
  restoreCode();
  await loadSavedChats();
  render();
  refresh();
  setInterval(refresh, 5000);

  // Reconnect to active background job if tab was closed/refreshed
  if (state.chatBusy && state.chatJobId) {
    reconnectChatJob(state.chatJobId);
  }
  // Code-agent: if we had a session, refresh history + reattach if busy
  if (state.codeAgent.active) {
    try {
      const h = await api(`/api/code-agent/sessions/${state.codeAgent.active}/history`);
      if (h?.messages && h.messages.length >= state.codeAgent.messages.length) {
        state.codeAgent.messages = h.messages;
        persistCode();
        render();
      }
    } catch {}
    if (state.codeAgent.busy) caReconnect(state.codeAgent.active);
  }
};

if (!token) renderLogin();
else boot();
