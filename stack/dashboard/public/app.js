// ─── DOM helper + utils ────────────────────────────────────────────────
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === false || v == null) return;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  });
  children.flat().forEach(c => {
    if (c == null || c === false) return;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return n;
};
const svg = (inner, attrs = {}) => {
  const w = el('span', { class: attrs.class || 'icon-wrap', html: `<svg viewBox="${attrs.viewBox || '0 0 24 24'}" width="${attrs.size || 16}" height="${attrs.size || 16}" fill="none">${inner}</svg>` });
  return w;
};

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
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
const fmtBytes = (b) => {
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

// ─── Auth ──────────────────────────────────────────────────────────────
let token = localStorage.getItem('auth_token') || '';
const headers = () => ({ Authorization: `Bearer ${token}` });
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { ...headers(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { logout(); return null; }
  if (r.status === 404) return null;
  try { return await r.json(); } catch { return null; }
};

// ─── Markdown (sanitized) ──────────────────────────────────────────────
const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderMarkdown(text) {
  if (!text) return '';
  const T_OPEN = '<' + 'thinking>', T_CLOSE = '</' + 'thinking>';
  text = text.split(new RegExp(T_OPEN + '[\\s\\S]*?' + T_CLOSE, 'gi')).join('');
  const oi = text.toLowerCase().indexOf(T_OPEN);
  if (oi !== -1) text = text.slice(0, oi);
  const ci = text.toLowerCase().indexOf(T_CLOSE);
  if (ci !== -1) text = text.slice(ci + T_CLOSE.length);
  text = text.trim();
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
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const safe = /^(https?:|mailto:|\/)/.test(u) ? u : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
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
    const langAttr = b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : '';
    return `<pre class="md-code"${langAttr}><code>${escapeHtml(b.code)}</code></pre>`;
  });
  return src;
}

// ─── Icons ─────────────────────────────────────────────────────────────
const brandIcon = (cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', cls || 'brand-icon');
  s.innerHTML = '<path fill="#00aaaa" d="m11 14.5c0 .828-.672 1.5-1.5 1.5s-1.5-.672-1.5-1.5.672-1.5 1.5-1.5 1.5.672 1.5 1.5zm3.5-1.5c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5 1.5-.672 1.5-1.5-.672-1.5-1.5-1.5zm5.5 0v3c.008.585-.55 1.108-1.134.973-.438 1.735-1.998 3.027-3.866 3.027h-6c-1.868 0-3.429-1.292-3.866-3.027-.583.135-1.141-.388-1.134-.973v-3c-.008-.585.55-1.108 1.134-.973.438-1.734 1.998-3.027 3.866-3.027h2v-1c0-.553.448-1 1-1s1 .447 1 1v1h2c1.868 0 3.429 1.292 3.866 3.027.583-.135 1.141.388 1.134.973zm-3 0c0-1.103-.897-2-2-2h-6c-1.103 0-2 .897-2 2v3c0 1.103.897 2 2 2h6c1.103 0 2-.897 2-2zm7-3.276v9.276c0 2.757-2.243 5-5 5h-14c-2.757 0-5-2.243-5-5v-9.276c0-1.665.824-3.214 2.204-4.145l6.999-4.724c1.699-1.146 3.895-1.146 5.594 0l7 4.724c1.379.931 2.203 2.479 2.203 4.145zm-2 0c0-.999-.494-1.928-1.322-2.486l-7-4.724c-.509-.345-1.094-.517-1.678-.517s-1.168.172-1.678.517l-7 4.723c-.828.559-1.322 1.487-1.322 2.486v9.276c0 1.654 1.346 3 3 3h14c1.654 0 3-1.346 3-3z"/>';
  return s;
};

const ICONS = {
  cpu:      '<rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="9" y="9" width="6" height="6" stroke="currentColor" stroke-width="1.6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  ram:      '<rect x="2" y="7" width="20" height="10" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M6 7v10M10 7v10M14 7v10M18 7v10" stroke="currentColor" stroke-width="1.2"/>',
  disk:     '<ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" stroke-width="1.6"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  gpu:      '<rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="12" r="2.5" stroke="currentColor" stroke-width="1.4"/><circle cx="16" cy="12" r="2.5" stroke="currentColor" stroke-width="1.4"/>',
  net:      '<path d="M2 12c5-7 15-7 20 0M5 16c3-4 11-4 14 0M9 19c1-1 5-1 6 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  temp:     '<path d="M14 14V5a2 2 0 0 0-4 0v9a4 4 0 1 0 4 0z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="17" r="1" fill="currentColor"/>',
  reload:   '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  download: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  power:    '<path d="M12 2v10M5 6.3a9 9 0 1 0 14 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  arrow:    '<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  arrow_left: '<path d="M19 12H5M11 18l-6-6 6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  chevron_down: '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  x:        '<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  plus:     '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  trash:    '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  pencil:   '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  send:     '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  stop:     '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  spark:    '<path d="M12 2l2.39 7.36H22l-6.18 4.49L18.21 21 12 16.51 5.79 21l2.39-7.15L2 9.36h7.61L12 2z" fill="currentColor"/>',
  model:    '<path fill="currentColor" d="M9 3h6v2h2a2 2 0 0 1 2 2v2h2v2h-2v2h2v2h-2v2a2 2 0 0 1-2 2h-2v2H9v-2H7a2 2 0 0 1-2-2v-2H3v-2h2v-2H3v-2h2V7a2 2 0 0 1 2-2h2V3zm0 6v6h6V9H9z"/>',
  message:  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  code:     '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  folder:   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
  history:  '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  list:     '<path d="M8 6h13M8 12h13M8 18h13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/>',
  search:   '<circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  globe:    '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  file:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6"/>',
  workflow: '<circle cx="5" cy="5" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="19" cy="5" r="2.5" fill="currentColor"/><circle cx="19" cy="19" r="2.5" fill="currentColor"/><path d="M7 6l4 5M17 7l-4 4M14 13l4 5" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  spinner:  '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" stroke-dasharray="12 6" stroke-linecap="round" fill="none"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1.2s" repeatCount="indefinite"/></circle>',
  chart:    '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  tools:    '<path d="M14.7 6.3a4 4 0 0 1-5.7 5.7L3 18l3 3 6-6a4 4 0 0 1 5.7-5.7l-3-3z M5 21l7-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  link:     '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
  settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  logout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  copy:     '<rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6" fill="none"/>',
};
const ico = (name, size = 16) => svg(ICONS[name] || '', { size });

// Tool name → icon mapping for chat chips
const TOOL_ICON = {
  web_search: 'search', web_fetch: 'globe',
  get_stats: 'chart', get_services: 'list', list_models: 'list',
  read_file: 'file', list_dir: 'folder',
};
const TOOL_LABELS = {
  web_search: 'Web search', web_fetch: 'Web page',
  get_stats: 'System stats', get_services: 'Services', list_models: 'Models',
  read_file: 'File read', list_dir: 'Directory',
  n8n_list_workflows: 'List workflows', n8n_get_workflow: 'Read workflow',
  n8n_create_workflow: 'New workflow', n8n_update_workflow: 'Update workflow',
  n8n_activate_workflow: 'Activate workflow', n8n_deactivate_workflow: 'Deactivate workflow',
  n8n_quick_workflow: 'Build workflow',
};
const toolIcon = (name) => name && name.startsWith('n8n_') ? 'workflow' : (TOOL_ICON[name] || 'tools');
const toolLabel = (name) => TOOL_LABELS[name] || name.replace(/_/g, ' ');

// ─── Login ─────────────────────────────────────────────────────────────
const renderLogin = () => {
  document.body.innerHTML = '';
  const err = el('div', { class: 'login-err' });
  const input = el('input', { type: 'password', placeholder: 'Password', class: 'login-input', autofocus: true });
  const form = el('form', {
    class: 'login-box', autocomplete: 'off',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await fetch('/api/auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value }),
        });
        const d = await r.json();
        if (d.token) { token = d.token; localStorage.setItem('auth_token', token); boot(); }
        else err.textContent = 'Invalid password';
      } catch { err.textContent = 'Connection failed'; }
    },
  },
    brandIcon('login-logo'),
    el('div', { class: 'login-title' }, 'AGENT'),
    input,
    el('button', { type: 'submit', class: 'login-btn' }, 'Authenticate'),
    err,
  );
  document.body.append(el('div', { class: 'login-wrap' }, form));
  input.focus();
};
const logout = () => { token = ''; localStorage.removeItem('auth_token'); renderLogin(); };

// ─── State ─────────────────────────────────────────────────────────────
const HISTORY_LEN = 60;
let state = {
  view: location.hash.replace(/^#\/?/, '') || 'dashboard',  // mobile section
  stats: null, services: null, models: [], pull: [],
  history: { cpu: [], ram: [], swap: [], net_in: [], net_out: [], disk_read: [], disk_write: [] },
  chat: [], chatModel: '', chatBusy: false, chatStatus: null,
  savedChats: [], activeChatId: null, chatDirty: false, showSavedList: false,
  chatJobId: null, chatStartTs: null,
  actionMsg: '',
  toasts: [],
  chatMode: localStorage.getItem('chat_mode') || 'chat',  // 'chat' | 'code' | 'loq' | 'think'
  loqAgent: {
    reachable: false, controlReachable: false, checked: false, controlOnline: false,
    models: [], chatModel: localStorage.getItem('loq_model') || '',
    chat: [], busy: false, status: null, dirty: false,
    jobId: null, startTs: null,
    activeChatId: null, showSavedList: false,
  },
  thinkAgent: {
    chatModel: localStorage.getItem('think_model') || 'qwen2.5:32b',
    chat: [], busy: false, status: null, dirty: false,
    jobId: null, startTs: null,
    activeChatId: null, showSavedList: false,
  },
  codeAgent: {
    enabled: false, checked: false,
    sessions: [], active: null, messages: [],
    busy: false, status: null, startTs: null,
    pickerOpen: false,
    pickerPath: '/media/ojee/NVME/Code/[GIT]/Claude',
    pickerEntries: [], pickerParent: null,
    historyOpen: false, historyList: [],
    historyView: null, historyMessages: [], historyShowTools: false, historyCwd: null,
  },
};

// ─── Persistence ───────────────────────────────────────────────────────
const persistChat = () => {
  try {
    localStorage.setItem('chat_state', JSON.stringify({
      chat: state.chat, chatModel: state.chatModel, activeChatId: state.activeChatId,
      chatDirty: state.chatDirty, chatJobId: state.chatJobId,
      chatBusy: state.chatBusy, chatStartTs: state.chatStartTs,
    }));
  } catch {}
};
const restoreChat = () => {
  try {
    const s = JSON.parse(localStorage.getItem('chat_state'));
    if (s && s.chat && s.chat.length) {
      state.chat = s.chat;
      state.chatModel = s.chatModel || '';
      state.activeChatId = s.activeChatId || null;
      state.chatDirty = s.chatDirty || false;
      state.chatJobId = s.chatJobId || null;
      if (s.chatBusy && s.chatJobId) {
        state.chatBusy = true;
        state.chatStartTs = s.chatStartTs || null;
        state.chatStatus = 'reconnecting';
      }
    }
  } catch {}
};
const persistLoq = () => {
  try {
    localStorage.setItem('loq_state', JSON.stringify({
      chat: state.loqAgent.chat,
      chatModel: state.loqAgent.chatModel,
      busy: state.loqAgent.busy,
      jobId: state.loqAgent.jobId,
      startTs: state.loqAgent.startTs || null,
    }));
  } catch {}
};
const restoreLoq = () => {
  try {
    const s = JSON.parse(localStorage.getItem('loq_state'));
    if (s) {
      state.loqAgent.chat = s.chat || [];
      state.loqAgent.chatModel = s.chatModel || state.loqAgent.chatModel;
      if (s.busy && s.jobId) {
        state.loqAgent.busy = true;
        state.loqAgent.jobId = s.jobId;
        state.loqAgent.startTs = s.startTs || null;
        state.loqAgent.status = 'reconnecting';
      }
    }
  } catch {}
};
const persistThink = () => {
  try {
    localStorage.setItem('think_state', JSON.stringify({
      chat: state.thinkAgent.chat,
      chatModel: state.thinkAgent.chatModel,
      busy: state.thinkAgent.busy,
      jobId: state.thinkAgent.jobId,
      startTs: state.thinkAgent.startTs || null,
      activeChatId: state.thinkAgent.activeChatId,
      dirty: state.thinkAgent.dirty,
    }));
  } catch {}
};
const restoreThink = () => {
  try {
    const s = JSON.parse(localStorage.getItem('think_state'));
    if (s) {
      state.thinkAgent.chat = s.chat || [];
      state.thinkAgent.chatModel = s.chatModel || state.thinkAgent.chatModel;
      state.thinkAgent.activeChatId = s.activeChatId || null;
      state.thinkAgent.dirty = s.dirty || false;
      if (s.busy && s.jobId) {
        state.thinkAgent.busy = true;
        state.thinkAgent.jobId = s.jobId;
        state.thinkAgent.startTs = s.startTs || null;
        state.thinkAgent.status = 'reconnecting';
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
    const s = JSON.parse(localStorage.getItem('code_state'));
    if (s && s.active) {
      state.codeAgent.active = s.active;
      state.codeAgent.messages = s.messages || [];
      if (s.busy) {
        state.codeAgent.busy = true;
        state.codeAgent.startTs = s.startTs || null;
        state.codeAgent.status = 'reconnecting';
      }
    }
  } catch {}
};

window.addEventListener('hashchange', () => {
  state.view = location.hash.replace(/^#\/?/, '') || 'dashboard';
  render();
});
const setMobileView = (v) => {
  state.view = v;
  history.replaceState(null, '', '#/' + v);
  render();
};

// ─── Toasts ────────────────────────────────────────────────────────────
const toast = (msg, kind = 'info', dur = 3500) => {
  const id = randId();
  state.toasts.push({ id, msg, kind });
  renderToasts();
  setTimeout(() => {
    state.toasts = state.toasts.filter(t => t.id !== id);
    renderToasts();
  }, dur);
};
const renderToasts = () => {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = el('div', { class: 'toast-stack' });
    document.body.appendChild(stack);
  }
  stack.innerHTML = '';
  for (const t of state.toasts) {
    stack.appendChild(el('div', { class: `toast ${t.kind}` }, t.msg));
  }
};

// ─── Header ────────────────────────────────────────────────────────────
const renderHeader = () => el('div', { class: 'header' },
  el('div', { class: 'brand-wrap' }, brandIcon(), el('span', { class: 'brand' }, 'AGENT')),
  el('div', { class: 'header-right' },
    el('span', { class: state.stats ? 'status-pill' : 'status-pill offline' }, state.stats ? 'Online' : 'Offline'),
    el('button', { class: 'btn ghost icon', onclick: logout, title: 'Logout' }, ico('logout', 16)),
  ),
);

// ─── Bottom-tab nav (mobile) ───────────────────────────────────────────
const renderBottomTabs = () => {
  const tab = (id, label, icon) => el('button', {
    class: 'bottom-tab' + (state.view === id ? ' active' : ''),
    onclick: () => setMobileView(id),
  }, ico(icon, 22), el('span', {}, label));
  return el('div', { class: 'bottom-tabs' },
    tab('dashboard', 'Stats', 'chart'),
    tab('services', 'Services', 'list'),
    tab('actions', 'Actions', 'tools'),
    tab('chat', 'Chat', 'message'),
  );
};

// ─── SVG primitives: gauge + sparkline ─────────────────────────────────
// Returns a circular gauge SVG. Stroke color comes from CSS via the parent's
// .warn/.danger class — don't set inline stroke here or it'd override CSS.
// When temp is provided, render it as a small text inside the ring below the
// percent (no extra DOM, no badge — feels like part of the gauge itself).
const gaugeSvg = (pct, temp) => {
  const r = 30, cx = 38, cy = 38;
  const circ = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, pct)) / 100) * circ;
  const hasTemp = temp != null;
  const tHot = hasTemp && temp > 85;
  const tWarm = hasTemp && temp > 70;
  const tcls = tHot ? ' hot' : tWarm ? ' warm' : '';
  const pctY = hasTemp ? '38%' : '50%';
  const pctCls = hasTemp ? ' with-temp' : '';
  const tempText = hasTemp
    ? `<text class="gauge-temp-text${tcls}" x="50%" y="66%" dominant-baseline="middle" text-anchor="middle">${temp}°C</text>`
    : '';
  return `<svg viewBox="0 0 76 76" width="76" height="76">
    <circle class="gauge-track" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="6"/>
    <circle class="gauge-fill" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="6"
      stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text class="gauge-text${pctCls}" x="50%" y="${pctY}" dominant-baseline="middle" text-anchor="middle">${Math.round(pct)}%</text>
    ${tempText}
  </svg>`;
};
const gauge = (label, pct, sub, opts = {}) => {
  const t = opts.temp;
  const tHot = t != null && t > 85;
  const tWarm = t != null && t > 70;
  const cls = (pct > 90 || tHot) ? ' danger'
            : (pct > 75 || tWarm) ? ' warn' : '';
  return el('div', { class: 'gauge' + cls,
    html: `${gaugeSvg(pct, t)}<div class="gauge-label">${escapeHtml(label)}</div>${sub ? `<div class="gauge-sub">${escapeHtml(sub)}</div>` : ''}` });
};

// Sparkline SVG from values array (auto-scaled)
const sparkSvg = (values, color = 'var(--accent)') => {
  if (!values.length) return '<svg viewBox="0 0 100 32" width="100%" height="32"></svg>';
  const w = 100, h = 32, pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / range);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${pts.join(' L')}`;
  const fill = `${line} L${(pad + (values.length - 1) * step).toFixed(2)},${h - pad} L${pad},${h - pad} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <path d="${fill}" class="sparkline-fill"/>
    <path d="${line}" class="sparkline-line" style="stroke:${color}"/>
  </svg>`;
};
const sparklineCard = (label, value, values, color) =>
  el('div', { class: 'sparkline-card', html: `
    <div class="sparkline-card-head"><span>${escapeHtml(label)}</span><span class="sparkline-card-val">${escapeHtml(value)}</span></div>
    ${sparkSvg(values, color)}
  ` });

// Dual-line sparkline (e.g. read↑/write↓, in↑/out↓) sharing a common Y axis
const sparkSvg2 = (vals1, vals2, color1 = 'var(--accent)', color2 = 'var(--accent-dark)') => {
  const w = 100, h = 32, pad = 2;
  const all = [...vals1, ...vals2];
  if (!all.length) return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"></svg>`;
  const max = Math.max(...all, 1);
  const make = (vals) => {
    if (!vals.length) return '';
    const step = (w - pad * 2) / Math.max(vals.length - 1, 1);
    return vals.map((v, i) => `${(pad + i * step).toFixed(2)},${(pad + (h - pad * 2) * (1 - v / max)).toFixed(2)}`).join(' L');
  };
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <path d="M${make(vals1)}" stroke="${color1}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="M${make(vals2)}" stroke="${color2}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
};
const sparklineCard2 = (label, val1, val2, lbl1, lbl2, vals1, vals2, c1 = 'var(--accent)', c2 = 'var(--accent-dark)') =>
  el('div', { class: 'sparkline-card', html: `
    <div class="sparkline-card-head"><span>${escapeHtml(label)}</span><span class="sparkline-card-val">${escapeHtml(val1)} / ${escapeHtml(val2)}</span></div>
    ${sparkSvg2(vals1, vals2, c1, c2)}
    <div class="spark-legend">
      <span><span class="dot" style="background:${c1}"></span>${escapeHtml(lbl1)}</span>
      <span><span class="dot" style="background:${c2}"></span>${escapeHtml(lbl2)}</span>
    </div>
  ` });

// ─── Panels ────────────────────────────────────────────────────────────
const panelSystem = () => {
  const s = state.stats;
  if (!s) {
    return el('div', { class: 'panel', 'data-panel': 'dashboard' },
      el('div', { class: 'panel-head' }, el('span', {}, 'System')),
      el('div', { class: 'gauge-grid' },
        el('div', { class: 'skeleton skeleton-gauge' }),
        el('div', { class: 'skeleton skeleton-gauge' }),
        el('div', { class: 'skeleton skeleton-gauge' }),
        el('div', { class: 'skeleton skeleton-gauge' }),
      ),
      el('div', { class: 'skeleton skeleton-row' }),
      el('div', { class: 'skeleton skeleton-row' }),
      el('div', { class: 'skeleton skeleton-row' }),
    );
  }

  const cpuTemp = (s.temps || []).find(t => t.label === 'CPU Package');
  const g = s.gpu;
  const truncate = (str, n) => !str ? '' : (str.length <= n ? str : str.slice(0, n - 1) + '…');
  const cpuShort = truncate(s.cpu.model || '', 24);
  // Some lspci entries already include the vendor in the model string (e.g.
  // "NVIDIA GeForce MX250") so don't prepend it again.
  const gpuName = g ? (g.model || '') : '';
  const gpuVendor = g && g.vendor && !gpuName.toLowerCase().includes(g.vendor.toLowerCase())
    ? g.vendor + ' ' : '';
  const gpuShort = truncate(gpuVendor + gpuName, 24);

  const swapPct = s.swap?.total ? Math.round((s.swap.used / s.swap.total) * 100) : 0;

  // Top banner: OS + uptime + hostname
  const banner = el('div', { class: 'sys-banner' },
    el('div', { class: 'sys-banner-item' }, ico('power', 14),
      el('span', { class: 'k' }, 'Up'), el('span', { class: 'v' }, fmtUp(s.uptime))),
    el('div', { class: 'sys-banner-item' }, ico('cpu', 14),
      el('span', { class: 'k' }, 'OS'), el('span', { class: 'v' }, s.os || '—')),
    s.hostname ? el('div', { class: 'sys-banner-item' }, ico('net', 14),
      el('span', { class: 'k' }, 'Host'), el('span', { class: 'v' }, s.hostname)) : null,
  );

  const gauges = el('div', { class: 'gauge-grid' },
    gauge('CPU', s.cpu.avg, cpuShort, { temp: cpuTemp ? cpuTemp.current : null }),
    g && g.util != null
      ? gauge('GPU', g.util, `${gpuShort}${g.vram_mb ? ' · ' + (g.vram_mb / 1024).toFixed(1) + 'G' : ''}`, { temp: g.temp })
      : null,
    gauge('RAM', s.memory.percent, `${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}`),
    s.swap && s.swap.total ? gauge('Swap', swapPct, `${fmtBytes(s.swap.used)} / ${fmtBytes(s.swap.total)}`) : null,
    gauge('Disk /', s.disk.percent, `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}`),
    s.home ? gauge('Disk /home', s.home.percent, `${fmtBytes(s.home.used)} / ${fmtBytes(s.home.total)}`) : null,
  );

  const sparks = el('div', { class: 'sparkline-row' },
    sparklineCard2('Disk I/O',
      `↓${fmtBytes(s.disk?.read_per_s || 0)}/s`, `↑${fmtBytes(s.disk?.write_per_s || 0)}/s`,
      'read', 'write',
      state.history.disk_read, state.history.disk_write),
    sparklineCard2('Network',
      `↓${fmtBytes(s.network?.recv_per_s || 0)}/s`, `↑${fmtBytes(s.network?.sent_per_s || 0)}/s`,
      'in', 'out',
      state.history.net_in, state.history.net_out),
  );

  return el('div', { class: 'panel', 'data-panel': 'dashboard' },
    el('div', { class: 'panel-head' },
      el('span', {}, 'System'),
      el('span', { class: 'head-actions' }, ico('cpu', 14)),
    ),
    banner,
    gauges,
    sparks,
  );
};

const panelServices = () => {
  const sv = state.services;
  if (!sv) {
    return el('div', { class: 'panel', 'data-panel': 'services' },
      el('div', { class: 'panel-head' }, el('span', {}, 'Services')),
      el('div', { class: 'svc-list' },
        el('div', { class: 'skeleton skeleton-row' }),
        el('div', { class: 'skeleton skeleton-row' }),
        el('div', { class: 'skeleton skeleton-row' }),
      ),
    );
  }
  return el('div', { class: 'panel', 'data-panel': 'services' },
    el('div', { class: 'panel-head' }, el('span', {}, 'Services')),
    el('div', { class: 'svc-list' },
      ...Object.entries(sv).map(([name, s]) =>
        el('div', { class: 'svc-card' },
          el('span', { class: s.active ? 'svc-dot' : 'svc-dot off' }),
          el('div', { class: 'svc-info' },
            el('div', { class: 'svc-name' }, s.desc || name),
            el('div', { class: 'svc-meta' }, s.status || (s.active ? 'Running' : 'Stopped')),
          ),
        ),
      ),
    ),
  );
};

const doAction = async (action, label) => {
  const tid = randId();
  state.toasts.push({ id: tid, msg: el('span', { class: 'mono' }, ico('spinner', 14), ' ', label || action), kind: 'info' });
  renderToasts();
  const d = await api('/api/action', { method: 'POST', body: JSON.stringify({ action }) });
  state.toasts = state.toasts.filter(t => t.id !== tid);
  if (d?.ok) toast(`${label || action}: OK`, 'success');
  else toast(`${label || action}: ${d?.stderr || d?.error || 'failed'}`, 'danger', 6000);
};

const panelActions = () => el('div', { class: 'panel', 'data-panel': 'actions' },
  el('div', { class: 'panel-head' }, el('span', {}, 'Actions')),
  el('div', { class: 'btn-row' },
    el('button', { class: 'btn', onclick: () => doAction('restart-openwebui', 'Restart WebUI') }, ico('reload'), ' WebUI'),
    el('button', { class: 'btn', onclick: () => doAction('restart-n8n', 'Restart n8n') }, ico('reload'), ' n8n'),
    el('button', { class: 'btn', onclick: () => doAction('restart-dashboard', 'Restart Dashboard') }, ico('reload'), ' Dashboard'),
    el('button', { class: 'btn', onclick: () => doAction('pull-images', 'Pull Images') }, ico('download'), ' Pull'),
    el('button', { class: 'btn', onclick: () => doAction('compose-up', 'Compose Up') }, ico('power'), ' Up'),
    el('button', { class: 'btn danger', onclick: () => { if (confirm('Bring stack down?')) doAction('compose-down', 'Compose Down'); } }, ico('power'), ' Down'),
  ),
  el('div', { class: 'panel-section' }, 'Model pull'),
  el('div', { class: 'pull-box' }, (state.pull || []).join('\n') || 'no active pull'),
  el('div', { class: 'panel-section' }, 'Quick links'),
  el('a', { class: 'link-card', href: 'https://chat.agent.ojee.net', target: '_blank' },
    el('div', { class: 'link-card-title' },
      el('span', {}, 'Open WebUI'),
      el('span', { class: 'link-card-sub' }, 'Full chat with RAG'),
    ),
    ico('arrow', 16),
  ),
  el('a', { class: 'link-card', href: 'https://flow.agent.ojee.net', target: '_blank' },
    el('div', { class: 'link-card-title' },
      el('span', {}, 'n8n'),
      el('span', { class: 'link-card-sub' }, 'Workflow automation'),
    ),
    ico('arrow', 16),
  ),
);

// ─── Chat actions ──────────────────────────────────────────────────────
const newChat = () => {
  state.chat = []; state.activeChatId = null; state.chatDirty = false;
  state.chatStatus = null; state.chatJobId = null; state.chatStartTs = null;
  persistChat(); render();
};
const clearChat = () => { if (state.chat.length && !confirm('Clear current chat?')) return; newChat(); };
const saveChat = async () => {
  if (!state.chat.length) return;
  const id = state.activeChatId || randId();
  const firstUser = state.chat.find(m => m.role === 'user');
  const title = (firstUser?.content || 'Chat').slice(0, 80);
  await api(`/api/chats/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title, model: state.chatModel, messages: state.chat }),
  });
  state.activeChatId = id; state.chatDirty = false;
  await loadSavedChats(); persistChat(); render();
};
const loadChat = async (id) => {
  if (state.chatDirty && !state.activeChatId && !confirm('Discard unsaved chat?')) return;
  const c = await api(`/api/chats/${id}`);
  if (!c) return;
  state.chat = c.messages || [];
  state.activeChatId = c.id;
  state.chatModel = c.model || state.chatModel;
  state.chatDirty = false;
  state.showSavedList = false;
  state.chatBusy = false; state.chatStatus = null; state.chatJobId = null; state.chatStartTs = null;
  persistChat(); render();
};
const deleteChat = async (id, e) => {
  e?.stopPropagation();
  if (!confirm('Delete this chat?')) return;
  await api(`/api/chats/${id}`, { method: 'DELETE' });
  if (state.activeChatId === id) { state.chat = []; state.activeChatId = null; }
  await loadSavedChats(); persistChat(); render();
};
const renameChat = async (id, e) => {
  e?.stopPropagation();
  const c = state.savedChats.find(x => x.id === id);
  const t = prompt('Rename chat:', c?.title || '');
  if (!t || t === c?.title) return;
  const full = await api(`/api/chats/${id}`);
  if (full) { full.title = t; await api(`/api/chats/${id}`, { method: 'PUT', body: JSON.stringify(full) }); await loadSavedChats(); render(); }
};
const loadSavedChats = async () => {
  const list = await api('/api/chats');
  state.savedChats = Array.isArray(list) ? list : [];
};

// ─── Chat message rendering ────────────────────────────────────────────
const typingDots = () => el('span', { class: 'typing-dots' }, el('span'), el('span'), el('span'));
const chip = (kind, label, iconName) => el('span', { class: `chat-chip chip-${kind}`, title: label },
  ico(iconName, 12), el('span', {}, label));

const renderChatMsg = (m, opts = {}) => {
  const { isLast = false, busy = false, busyStatus = null, busyStart = null } = opts;
  const streaming = isLast && m.role === 'assistant' && busy;

  const body = el('div', { class: 'md-body' });
  if (streaming && !m.content && !m.text) {
    body.appendChild(typingDots());
  } else if (m.role === 'assistant') {
    const txt = m.content || m.text || '';
    body.innerHTML = renderMarkdown(txt) || (streaming ? '' : '<em class="muted">(empty)</em>');
    if (streaming) body.appendChild(el('span', { class: 'typing-cursor' }, '▍'));
  } else {
    body.textContent = m.content || m.text || '';
  }

  if (m.role === 'tool_use') {
    const inputStr = typeof m.input === 'object' ? JSON.stringify(m.input).slice(0, 120) : String(m.input || '').slice(0, 120);
    return el('div', { class: 'ca-tool' }, ico('tools', 12), el('span', {}, `${m.tool}(${inputStr})`));
  }

  if (m.role === 'user') {
    return el('div', { class: 'chat-msg chat-user' },
      el('div', { class: 'chat-label-row' },
        el('div', { class: 'chat-label' }, 'You'),
        m.ts ? el('span', { class: 'chat-time' }, fmtTime(m.ts)) : null,
      ),
      body,
    );
  }

  // Assistant message
  const model = m.model || (state.chatMode === 'chat' ? state.chatModel : null);
  const tools = m.tools || [];
  const filesChanged = m.files_changed || [];
  const statusText = streaming
    ? (busyStatus && busyStatus !== 'typing' && busyStatus !== 'reconnecting' ? busyStatus : ((m.content || m.text) ? 'typing' : 'thinking'))
    : null;

  const elapsed = streaming && busyStart ? Date.now() - busyStart : m.elapsed_ms;
  const timeStr = m.ts && !streaming ? fmtTime(m.ts) : '';
  const durStr = elapsed != null ? fmtDur(elapsed) : '';
  const timeDisplay = (timeStr ? timeStr : '') + (durStr ? (timeStr ? ' · ' : '') + durStr : '');

  const chipRow = el('div', { class: 'chat-chips' },
    model ? chip('model', model, 'model') : null,
    ...tools.map(t => chip('tool', toolLabel(t), toolIcon(t))),
    ...filesChanged.map(f => chip('tool', f, 'file')),
    statusText ? chip('status', statusText + '…', 'spinner') : null,
    timeDisplay
      ? el('span', {
          class: 'chat-time' + (streaming ? ' live-timer' : ''),
          'data-start': streaming && busyStart ? String(busyStart) : '',
          'data-prefix': streaming && timeStr ? timeStr : '',
        }, timeDisplay)
      : null,
  );

  return el('div', { class: 'chat-msg chat-assistant' }, chipRow, body);
};

// ─── Chat panel (unified Ollama + Code) ───────────────────────────────
const setChatMode = (mode) => {
  state.chatMode = mode;
  localStorage.setItem('chat_mode', mode);
  render();
};

const chatModesSwitch = () => el('div', { class: 'chat-modes' },
  el('button', { class: 'chat-mode-btn' + (state.chatMode === 'chat' ? ' active' : ''), onclick: () => setChatMode('chat') },
    'Chat'),
  state.codeAgent.enabled ? el('button', { class: 'chat-mode-btn' + (state.chatMode === 'code' ? ' active' : ''), onclick: () => setChatMode('code') },
    'Code') : null,
  (state.loqAgent.reachable || state.loqAgent.controlReachable) ? el('button', { class: 'chat-mode-btn' + (state.chatMode === 'loq' ? ' active' : ''), onclick: () => setChatMode('loq') },
    'Loq') : null,
  el('button', { class: 'chat-mode-btn' + (state.chatMode === 'think' ? ' active' : ''), onclick: () => setChatMode('think'), title: 'Slow large model — Discord pings when done' },
    'Think'),
);

const panelChat = () => {
  if (state.chatMode === 'code' && state.codeAgent.enabled) return panelChatCode();
  if (state.chatMode === 'loq' && (state.loqAgent.reachable || state.loqAgent.controlReachable)) return panelChatLoq();
  if (state.chatMode === 'think') return panelChatThink();
  return panelChatOllama();
};

// ─── Ollama chat ───────────────────────────────────────────────────────
const panelChatOllama = () => {
  const lastIdx = state.chat.length - 1;
  const log = el('div', { class: 'chat-log' });

  if (state.chat.length === 0) {
    log.appendChild(el('div', { class: 'chat-empty' },
      ico('message', 28),
      el('div', {}, 'Ask anything'),
    ));
  } else {
    state.chat.forEach((m, i) => log.appendChild(renderChatMsg(m, {
      isLast: i === lastIdx, busy: state.chatBusy, busyStatus: state.chatStatus, busyStart: state.chatStartTs,
    })));
  }

  const input = el('textarea', {
    class: 'chat-input', rows: '1',
    placeholder: state.chatModel ? 'Message…' : 'Pull a model first',
  });
  input.value = localStorage.getItem('draft_main') || '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_main', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text || state.chatBusy || !state.chatModel) return;
    const now = Date.now();
    state.chat.push({ role: 'user', content: text, ts: now });
    state.chat.push({ role: 'assistant', content: '', model: state.chatModel, tools: [], ts: null, elapsed_ms: null });
    state.chatBusy = true; state.chatStatus = 'thinking';
    state.chatDirty = true; state.chatStartTs = now;
    input.value = ''; localStorage.removeItem('draft_main');
    persistChat(); render();

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.chatModel,
          messages: state.chat.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6);
          if (p === '[DONE]') { gotDone = true; continue; }
          try {
            const j = JSON.parse(p);
            if (j.job_id) { state.chatJobId = j.job_id; persistChat(); }
            else if (j.clear_message) {
              state.chat[state.chat.length - 1].content = '';
              render();
            } else if (j.message?.content) {
              if (state.chatStatus !== 'typing') state.chatStatus = 'typing';
              state.chat[state.chat.length - 1].content += j.message.content;
              render();
            } else if (j.tool_call) {
              state.chatStatus = `${j.tool_call.name.replace(/^(get|list|read|web)_/, '')}`;
              const last = state.chat[state.chat.length - 1];
              if (!last.tools) last.tools = [];
              if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
              render();
            } else if (j.tool_result) {
              state.chatStatus = 'thinking'; render();
            }
          } catch {}
        }
      }
      // Stream ended without [DONE] — proxy/network dropped the connection
      // but the server job is still running.  Reconnect and let the replay
      // finish the message.
      if (!gotDone && state.chatJobId) {
        state.chatStatus = 'reconnecting'; persistChat(); render();
        reconnectChatJob(state.chatJobId);
        return;
      }
      if (state.activeChatId) saveChat().catch(() => {});
    } catch (e) {
      if (e.name === 'AbortError') {
        const last = state.chat[state.chat.length - 1];
        if (!last.content) last.content = '*(stopped)*';
        else last.content += '\n\n*(stopped)*';
      } else if (state.chatJobId) {
        state.chatStatus = 'reconnecting'; persistChat(); render();
        reconnectChatJob(state.chatJobId);
        return;
      } else {
        state.chat[state.chat.length - 1].content = `Error: ${e.message}`;
      }
    }
    const last = state.chat[state.chat.length - 1];
    if (last && last.role === 'assistant') {
      last.ts = Date.now();
      last.elapsed_ms = state.chatStartTs ? Date.now() - state.chatStartTs : null;
    }
    state.chatJobId = null; state.chatBusy = false;
    state.chatStatus = null; state.chatStartTs = null;
    persistChat(); render();
  };

  const stop = () => { state.chatAbort?.abort(); };

  const modelSel = el('select', { class: 'chat-select', onchange: (e) => { state.chatModel = e.target.value; persistChat(); render(); } },
    ...(state.models.length ? state.models : [{ name: 'no models' }]).map(m =>
      el('option', { value: m.name, ...(m.name === state.chatModel ? { selected: true } : {}) }, m.name),
    ),
  );

  const toolbar = el('div', { class: 'chat-toolbar' },
    modelSel,
    el('button', { class: 'btn sm', onclick: newChat, title: 'New chat' }, ico('plus', 14)),
    el('button', { class: 'btn sm', onclick: saveChat, title: 'Save chat', disabled: state.chat.length === 0 }, 'Save'),
    el('button', { class: 'btn sm', onclick: () => { state.showSavedList = !state.showSavedList; render(); }, title: 'Browse saved' }, `${state.showSavedList ? 'Hide' : 'Saved'} (${state.savedChats.length})`),
  );

  const savedList = state.showSavedList
    ? el('div', { class: 'saved-list' },
        state.savedChats.length === 0
          ? el('div', { class: 'muted', style: 'padding:10px;text-align:center;font-size:0.78rem' }, 'no saved chats')
          : state.savedChats.map(c =>
              el('div', { class: 'saved-item' + (c.id === state.activeChatId ? ' active' : ''), onclick: () => loadChat(c.id) },
                el('div', { class: 'saved-title' }, c.title),
                el('div', { class: 'saved-actions' },
                  el('button', { class: 'btn ghost icon', onclick: (e) => renameChat(c.id, e), title: 'Rename' }, ico('pencil', 12)),
                  el('button', { class: 'btn ghost icon danger', onclick: (e) => deleteChat(c.id, e), title: 'Delete' }, ico('trash', 12)),
                ),
              ),
            ),
      )
    : null;

  const activeBadge = state.activeChatId
    ? el('div', { class: 'chat-active-badge' }, `editing: ${(state.savedChats.find(c => c.id === state.activeChatId) || {}).title || '—'}`)
    : null;

  return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
    el('div', { class: 'panel-head' },
      el('span', {}, 'Chat'),
      chatModesSwitch(),
    ),
    toolbar,
    savedList,
    activeBadge,
    el('div', { class: 'chat-wrap' },
      log,
      el('div', { class: 'chat-form' },
        input,
        el('button', {
          class: 'btn primary chat-send' + (state.chatBusy ? ' chat-stop' : ''),
          onclick: state.chatBusy ? stop : send,
          disabled: !state.chatModel,
          title: state.chatBusy ? 'Stop' : 'Send',
        }, state.chatBusy ? ico('stop', 14) : ico('send', 14)),
      ),
    ),
  );
};

// ─── Loq Ollama (second local model on the laptop) ─────────────────────
// Saved-chat helpers for loq mode — reuse the same /api/chats backend so
// chats are unified across modes, but operate on state.loqAgent state.
const loqNewChat = () => {
  const lq = state.loqAgent;
  lq.chat = []; lq.activeChatId = null; lq.dirty = false;
  lq.status = null; lq.jobId = null; lq.startTs = null;
  persistLoq(); render();
};
const loqSaveChat = async () => {
  const lq = state.loqAgent;
  if (!lq.chat.length) return;
  const id = lq.activeChatId || randId();
  const firstUser = lq.chat.find(m => m.role === 'user');
  const title = (firstUser?.content || 'Chat').slice(0, 80);
  await api(`/api/chats/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title, model: lq.chatModel, messages: lq.chat }),
  });
  lq.activeChatId = id; lq.dirty = false;
  await loadSavedChats();
  persistLoq(); render();
};
const loqLoadChat = async (id) => {
  const lq = state.loqAgent;
  if (lq.dirty && !lq.activeChatId && !confirm('Discard unsaved chat?')) return;
  const c = await api(`/api/chats/${id}`);
  if (!c) return;
  lq.chat = c.messages || [];
  lq.activeChatId = c.id;
  // Only switch to the saved model if loq actually has it
  if (c.model && lq.models.some(m => m.name === c.model)) lq.chatModel = c.model;
  lq.dirty = false; lq.showSavedList = false;
  lq.busy = false; lq.status = null; lq.jobId = null; lq.startTs = null;
  persistLoq(); render();
};

const loqStartStop = async (action) => {
  const r = await fetch(`/api/loq/${action}`, { method: 'POST', headers: headers() });
  let data; try { data = await r.json(); } catch { data = {}; }
  toast(`Loq ${action}: ${r.ok ? (data.message || 'OK') : (data.error || 'failed')}`, r.ok ? 'success' : 'danger', 5000);
  // Refresh status soon after
  setTimeout(refresh, 1500);
};

const reconnectLoqJob = async (jobId) => {
  const lastIdx = state.loqAgent.chat.length - 1;
  const lastMsg = state.loqAgent.chat[lastIdx];
  const snapshot = lastMsg && lastMsg.role === 'assistant'
    ? { content: lastMsg.content || '', tools: (lastMsg.tools || []).slice() } : null;
  try {
    const r = await fetch(`/api/loq/jobs/${jobId}`, { headers: headers() });
    if (!r.ok) {
      state.loqAgent.busy = false; state.loqAgent.status = null;
      state.loqAgent.jobId = null; state.loqAgent.startTs = null;
      const last = state.loqAgent.chat[state.loqAgent.chat.length - 1];
      if (last?.role === 'assistant' && !last.content && snapshot?.content) last.content = snapshot.content;
      if (last?.role === 'assistant' && !last.content) last.content = '*(session expired)*';
      persistLoq(); render(); return;
    }
    if (lastMsg && lastMsg.role === 'assistant') { lastMsg.content = ''; lastMsg.tools = []; }
    render();
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = ''; let gotAny = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6); if (p === '[DONE]') continue;
        try {
          const j = JSON.parse(p); gotAny = true;
          if (j.clear_message) {
            state.loqAgent.chat[state.loqAgent.chat.length - 1].content = '';
            render();
          } else if (j.message?.content) {
            state.loqAgent.status = 'typing';
            state.loqAgent.chat[state.loqAgent.chat.length - 1].content += j.message.content;
            render();
          } else if (j.tool_call) {
            state.loqAgent.status = j.tool_call.name.replace(/^(get|list|read|web)_/, '');
            const last = state.loqAgent.chat[state.loqAgent.chat.length - 1];
            if (!last.tools) last.tools = [];
            if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
            render();
          } else if (j.tool_result) { state.loqAgent.status = 'thinking'; render(); }
        } catch {}
      }
    }
    const last = state.loqAgent.chat[state.loqAgent.chat.length - 1];
    if (last?.role === 'assistant' && !last.content && snapshot?.content) {
      last.content = snapshot.content; last.tools = snapshot.tools;
    }
  } catch {}
  const last = state.loqAgent.chat[state.loqAgent.chat.length - 1];
  if (last?.role === 'assistant') {
    last.ts = Date.now();
    last.elapsed_ms = state.loqAgent.startTs ? Date.now() - state.loqAgent.startTs : null;
    if (!last.content && snapshot?.content) { last.content = snapshot.content; last.tools = snapshot.tools; }
  }
  state.loqAgent.jobId = null; state.loqAgent.busy = false;
  state.loqAgent.status = null; state.loqAgent.startTs = null;
  persistLoq(); render();
};

const panelChatLoq = () => {
  const lq = state.loqAgent;

  // Ollama is down but the control service answers: show a "stopped" empty
  // state with a prominent Start button instead of the normal chat UI.
  if (!lq.reachable && lq.controlReachable) {
    return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
      el('div', { class: 'panel-head' }, el('span', {}, 'Loq'), chatModesSwitch()),
      el('div', { class: 'chat-empty', style: 'gap: 16px' },
        ico('power', 28),
        el('div', {}, 'Loq Ollama is stopped'),
        el('div', { class: 'muted', style: 'font-size: 0.78rem' }, 'Start it to chat with a local model on the laptop.'),
        el('button', { class: 'btn primary', style: 'margin-top: 8px', onclick: () => loqStartStop('start') },
          ico('power', 14), ' Start'),
      ),
    );
  }

  const lastIdx = lq.chat.length - 1;
  const log = el('div', { class: 'chat-log' });
  if (lq.chat.length === 0) {
    log.appendChild(el('div', { class: 'chat-empty' },
      ico('message', 28),
      el('div', {}, lq.chatModel ? `Loq · ${lq.chatModel}` : 'Pick a model below'),
    ));
  } else {
    lq.chat.forEach((m, i) => log.appendChild(renderChatMsg(m, {
      isLast: i === lastIdx, busy: lq.busy, busyStatus: lq.status, busyStart: lq.startTs,
    })));
  }

  const input = el('textarea', {
    class: 'chat-input', rows: '1',
    placeholder: lq.chatModel ? 'Message Loq…' : 'Pull a model on Loq first',
  });
  input.value = localStorage.getItem('draft_loq') || '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_loq', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text || lq.busy || !lq.chatModel) return;
    const now = Date.now();
    lq.chat.push({ role: 'user', content: text, ts: now });
    lq.chat.push({ role: 'assistant', content: '', model: lq.chatModel, tools: [], ts: null, elapsed_ms: null });
    lq.busy = true; lq.status = 'thinking';
    lq.dirty = true; lq.startTs = now;
    input.value = ''; localStorage.removeItem('draft_loq');
    lq.abort = new AbortController();
    persistLoq(); render();
    try {
      const r = await fetch('/api/loq/chat', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: lq.chatModel,
          messages: lq.chat.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
        }),
        signal: lq.abort.signal,
      });
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = '';
      let gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6);
          if (p === '[DONE]') { gotDone = true; continue; }
          try {
            const j = JSON.parse(p);
            if (j.job_id) { lq.jobId = j.job_id; persistLoq(); }
            else if (j.clear_message) {
              lq.chat[lq.chat.length - 1].content = '';
              render();
            } else if (j.message?.content) {
              if (lq.status !== 'typing') lq.status = 'typing';
              lq.chat[lq.chat.length - 1].content += j.message.content;
              render();
            } else if (j.tool_call) {
              lq.status = j.tool_call.name.replace(/^(get|list|read|web)_/, '');
              const last = lq.chat[lq.chat.length - 1];
              if (!last.tools) last.tools = [];
              if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
              render();
            } else if (j.tool_result) { lq.status = 'thinking'; render(); }
          } catch {}
        }
      }
      // Stream ended without [DONE] — proxy/network dropped the connection
      // but the server job is still running.  Reconnect and let the replay
      // finish the message.
      if (!gotDone && lq.jobId) {
        lq.status = 'reconnecting'; persistLoq(); render();
        reconnectLoqJob(lq.jobId);
        return;
      }
      if (lq.activeChatId) loqSaveChat().catch(() => {});
    } catch (e) {
      if (e.name === 'AbortError') {
        // user-initiated stop — keep whatever content streamed so far
        const last = lq.chat[lq.chat.length - 1];
        if (last?.role === 'assistant' && !last.content) last.content = '*(stopped)*';
      } else if (lq.jobId) {
        lq.status = 'reconnecting'; persistLoq(); render();
        reconnectLoqJob(lq.jobId);
        return;
      } else {
        lq.chat[lq.chat.length - 1].content = `Error: ${e.message}`;
      }
    }
    const last = lq.chat[lq.chat.length - 1];
    if (last?.role === 'assistant') {
      last.ts = Date.now();
      last.elapsed_ms = lq.startTs ? Date.now() - lq.startTs : null;
    }
    lq.jobId = null; lq.busy = false;
    lq.status = null; lq.startTs = null;
    persistLoq(); render();
  };

  const modelSel = el('select', { class: 'chat-select',
    onchange: (e) => { lq.chatModel = e.target.value; localStorage.setItem('loq_model', e.target.value); render(); } },
    ...(lq.models.length ? lq.models : [{ name: 'no models on loq' }]).map(m =>
      el('option', { value: m.name, ...(m.name === lq.chatModel ? { selected: true } : {}) }, m.name),
    ),
  );

  const toolbar = el('div', { class: 'chat-toolbar' },
    modelSel,
    el('button', { class: 'btn sm', onclick: loqNewChat, title: 'New chat' }, ico('plus', 14)),
    el('button', { class: 'btn sm', onclick: loqSaveChat, title: 'Save chat', disabled: lq.chat.length === 0 }, 'Save'),
    el('button', { class: 'btn sm', onclick: () => { lq.showSavedList = !lq.showSavedList; render(); }, title: 'Browse saved' }, `${lq.showSavedList ? 'Hide' : 'Saved'} (${state.savedChats.length})`),
    el('button', { class: 'btn sm', title: 'Start Ollama on loq', onclick: () => loqStartStop('start') }, ico('power', 14), ' Start'),
    el('button', { class: 'btn sm danger', title: 'Stop Ollama on loq (frees VRAM)', onclick: () => loqStartStop('stop') }, ico('stop', 14), ' Stop'),
  );

  const savedList = lq.showSavedList
    ? el('div', { class: 'saved-list' },
        state.savedChats.length === 0
          ? el('div', { class: 'muted', style: 'padding:10px;text-align:center;font-size:0.78rem' }, 'no saved chats')
          : state.savedChats.map(c =>
              el('div', { class: 'saved-item' + (c.id === lq.activeChatId ? ' active' : ''), onclick: () => loqLoadChat(c.id) },
                el('div', { class: 'saved-title' }, c.title),
                el('div', { class: 'saved-actions' },
                  el('button', { class: 'btn ghost icon', onclick: (e) => renameChat(c.id, e), title: 'Rename' }, ico('pencil', 12)),
                  el('button', { class: 'btn ghost icon danger', onclick: (e) => deleteChat(c.id, e), title: 'Delete' }, ico('trash', 12)),
                ),
              ),
            ),
      )
    : null;

  const activeBadge = lq.activeChatId
    ? el('div', { class: 'chat-active-badge' }, `editing: ${(state.savedChats.find(c => c.id === lq.activeChatId) || {}).title || '—'}`)
    : null;

  return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
    el('div', { class: 'panel-head' },
      el('span', {}, 'Loq'),
      chatModesSwitch(),
    ),
    toolbar,
    savedList,
    activeBadge,
    el('div', { class: 'chat-wrap' },
      log,
      el('div', { class: 'chat-form' },
        input,
        el('button', {
          class: 'btn primary chat-send' + (lq.busy ? ' chat-stop' : ''),
          onclick: lq.busy ? () => lq.abort?.abort() : send,
          disabled: !lq.chatModel,
          title: lq.busy ? 'Stop' : 'Send',
        }, lq.busy ? ico('stop', 14) : ico('send', 14)),
      ),
    ),
  );
};

// ─── Think mode (slow large local model on HP — async-friendly) ─────────
// Same /api/chat machinery on the backend (full system prompt + every
// tool, including n8n) but routed at /api/think/chat with a 30 min
// timeout and a Discord ping when the job finishes.

const thinkNewChat = () => {
  const t = state.thinkAgent;
  t.chat = []; t.activeChatId = null; t.dirty = false;
  t.status = null; t.jobId = null; t.startTs = null;
  persistThink(); render();
};
const thinkSaveChat = async () => {
  const t = state.thinkAgent;
  if (!t.chat.length) return;
  const id = t.activeChatId || randId();
  const firstUser = t.chat.find(m => m.role === 'user');
  const title = (firstUser?.content || 'Think chat').slice(0, 80);
  await api(`/api/chats/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title, model: t.chatModel, messages: t.chat }),
  });
  t.activeChatId = id; t.dirty = false;
  await loadSavedChats();
  persistThink(); render();
};
const thinkLoadChat = async (id) => {
  const t = state.thinkAgent;
  if (t.dirty && !t.activeChatId && !confirm('Discard unsaved chat?')) return;
  const c = await api(`/api/chats/${id}`);
  if (!c) return;
  t.chat = c.messages || [];
  t.activeChatId = c.id;
  if (c.model) t.chatModel = c.model;
  t.dirty = false; t.showSavedList = false;
  t.busy = false; t.status = null; t.jobId = null; t.startTs = null;
  persistThink(); render();
};

const reconnectThinkJob = async (jobId) => {
  const t = state.thinkAgent;
  const lastMsg = t.chat[t.chat.length - 1];
  const snapshot = lastMsg && lastMsg.role === 'assistant'
    ? { content: lastMsg.content || '', tools: (lastMsg.tools || []).slice() } : null;
  try {
    const r = await fetch(`/api/think/jobs/${jobId}`, { headers: headers() });
    if (!r.ok) {
      t.busy = false; t.status = null; t.jobId = null; t.startTs = null;
      const last = t.chat[t.chat.length - 1];
      if (last?.role === 'assistant' && !last.content && snapshot?.content) last.content = snapshot.content;
      if (last?.role === 'assistant' && !last.content) last.content = '*(session expired)*';
      persistThink(); render(); return;
    }
    if (lastMsg && lastMsg.role === 'assistant') { lastMsg.content = ''; lastMsg.tools = []; }
    render();
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = ''; let gotDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6);
        if (p === '[DONE]') { gotDone = true; continue; }
        try {
          const j = JSON.parse(p);
          if (j.clear_message) {
            t.chat[t.chat.length - 1].content = ''; render();
          } else if (j.message?.content) {
            t.status = 'typing';
            t.chat[t.chat.length - 1].content += j.message.content; render();
          } else if (j.tool_call) {
            t.status = j.tool_call.name.replace(/^(get|list|read|web)_/, '');
            const last = t.chat[t.chat.length - 1];
            if (!last.tools) last.tools = [];
            if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
            render();
          } else if (j.tool_result) { t.status = 'thinking'; render(); }
        } catch {}
      }
    }
  } catch {}
  const last = t.chat[t.chat.length - 1];
  if (last?.role === 'assistant') {
    last.ts = Date.now();
    last.elapsed_ms = t.startTs ? Date.now() - t.startTs : null;
    if (!last.content && snapshot?.content) { last.content = snapshot.content; last.tools = snapshot.tools; }
  }
  t.jobId = null; t.busy = false; t.status = null; t.startTs = null;
  if (t.activeChatId) thinkSaveChat().catch(() => {});
  persistThink(); render();
};

const panelChatThink = () => {
  const t = state.thinkAgent;
  const lastIdx = t.chat.length - 1;
  const log = el('div', { class: 'chat-log' });

  if (t.chat.length === 0) {
    log.appendChild(el('div', { class: 'chat-empty' },
      ico('message', 28),
      el('div', {}, t.chatModel ? `Think · ${t.chatModel}` : 'Pick a model'),
      el('div', { class: 'muted', style: 'font-size: 0.78rem; max-width: 360px; text-align: center' },
        'Slow on purpose — uses a large local model with the full toolset (web, n8n, server stats, files). Send a hard question, close the tab, get pinged on Discord when it\'s done.'),
    ));
  } else {
    t.chat.forEach((m, i) => log.appendChild(renderChatMsg(m, {
      isLast: i === lastIdx, busy: t.busy, busyStatus: t.status, busyStart: t.startTs,
    })));
  }

  const input = el('textarea', {
    class: 'chat-input', rows: '1',
    placeholder: t.chatModel ? 'Ask the slow model anything…' : 'Pick a model',
  });
  input.value = localStorage.getItem('draft_think') || '';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_think', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  const send = async () => {
    const text = input.value.trim();
    if (!text || t.busy || !t.chatModel) return;
    const now = Date.now();
    t.chat.push({ role: 'user', content: text, ts: now });
    t.chat.push({ role: 'assistant', content: '', model: t.chatModel, tools: [], ts: null, elapsed_ms: null });
    t.busy = true; t.status = 'thinking'; t.dirty = true; t.startTs = now;
    input.value = ''; localStorage.removeItem('draft_think');
    t.abort = new AbortController();
    persistThink(); render();
    try {
      const r = await fetch('/api/think/chat', {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: t.chatModel,
          messages: t.chat.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
        }),
        signal: t.abort.signal,
      });
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = ''; let gotDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6);
          if (p === '[DONE]') { gotDone = true; continue; }
          try {
            const j = JSON.parse(p);
            if (j.job_id) { t.jobId = j.job_id; persistThink(); }
            else if (j.clear_message) {
              t.chat[t.chat.length - 1].content = ''; render();
            } else if (j.message?.content) {
              if (t.status !== 'typing') t.status = 'typing';
              t.chat[t.chat.length - 1].content += j.message.content; render();
            } else if (j.tool_call) {
              t.status = j.tool_call.name.replace(/^(get|list|read|web)_/, '');
              const last = t.chat[t.chat.length - 1];
              if (!last.tools) last.tools = [];
              if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
              render();
            } else if (j.tool_result) { t.status = 'thinking'; render(); }
          } catch {}
        }
      }
      if (!gotDone && t.jobId) {
        t.status = 'reconnecting'; persistThink(); render();
        reconnectThinkJob(t.jobId);
        return;
      }
      if (t.activeChatId) thinkSaveChat().catch(() => {});
    } catch (e) {
      if (e.name === 'AbortError') {
        const last = t.chat[t.chat.length - 1];
        if (last?.role === 'assistant' && !last.content) last.content = '*(stopped)*';
      } else if (t.jobId) {
        t.status = 'reconnecting'; persistThink(); render();
        reconnectThinkJob(t.jobId);
        return;
      } else {
        t.chat[t.chat.length - 1].content = `Error: ${e.message}`;
      }
    }
    const last = t.chat[t.chat.length - 1];
    if (last?.role === 'assistant') {
      last.ts = Date.now();
      last.elapsed_ms = t.startTs ? Date.now() - t.startTs : null;
    }
    t.jobId = null; t.busy = false; t.status = null; t.startTs = null;
    persistThink(); render();
  };

  // Model picker — Think runs on HP's Ollama, so use state.models (server list).
  const modelSel = el('select', { class: 'chat-select',
    onchange: (e) => { t.chatModel = e.target.value; localStorage.setItem('think_model', e.target.value); render(); } },
    ...(state.models.length ? state.models : [{ name: 'no models on HP' }]).map(m =>
      el('option', { value: m.name, ...(m.name === t.chatModel ? { selected: true } : {}) }, m.name),
    ),
  );

  const toolbar = el('div', { class: 'chat-toolbar' },
    modelSel,
    el('button', { class: 'btn sm', onclick: thinkNewChat, title: 'New chat' }, ico('plus', 14)),
    el('button', { class: 'btn sm', onclick: thinkSaveChat, title: 'Save chat', disabled: t.chat.length === 0 }, 'Save'),
    el('button', { class: 'btn sm', onclick: () => { t.showSavedList = !t.showSavedList; render(); }, title: 'Browse saved' }, `${t.showSavedList ? 'Hide' : 'Saved'} (${state.savedChats.length})`),
  );

  const savedList = t.showSavedList
    ? el('div', { class: 'saved-list' },
        state.savedChats.length === 0
          ? el('div', { class: 'muted', style: 'padding:10px;text-align:center;font-size:0.78rem' }, 'no saved chats')
          : state.savedChats.map(c =>
              el('div', { class: 'saved-item' + (c.id === t.activeChatId ? ' active' : ''), onclick: () => thinkLoadChat(c.id) },
                el('div', { class: 'saved-title' }, c.title),
                el('div', { class: 'saved-actions' },
                  el('button', { class: 'btn ghost icon', onclick: (e) => renameChat(c.id, e), title: 'Rename' }, ico('pencil', 12)),
                  el('button', { class: 'btn ghost icon danger', onclick: (e) => deleteChat(c.id, e), title: 'Delete' }, ico('trash', 12)),
                ),
              ),
            ),
      )
    : null;

  const activeBadge = t.activeChatId
    ? el('div', { class: 'chat-active-badge' }, `editing: ${(state.savedChats.find(c => c.id === t.activeChatId) || {}).title || '—'}`)
    : null;

  return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
    el('div', { class: 'panel-head' },
      el('span', {}, 'Think'),
      chatModesSwitch(),
    ),
    toolbar,
    savedList,
    activeBadge,
    el('div', { class: 'chat-wrap' },
      log,
      el('div', { class: 'chat-form' },
        input,
        el('button', {
          class: 'btn primary chat-send' + (t.busy ? ' chat-stop' : ''),
          onclick: t.busy ? () => t.abort?.abort() : send,
          disabled: !t.chatModel,
          title: t.busy ? 'Stop' : 'Send',
        }, t.busy ? ico('stop', 14) : ico('send', 14)),
      ),
    ),
  );
};

// ─── Code Agent (Claude Code) ──────────────────────────────────────────
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
  if (d?.id) {
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
  persistCode(); render();
  const h = await api(`/api/code-agent/sessions/${id}/history`);
  if (h?.messages) state.codeAgent.messages = h.messages;
  persistCode(); render();
};
const caRename = async (id, e) => {
  e?.stopPropagation();
  const s = state.codeAgent.sessions.find(x => x.id === id);
  const t = prompt('Rename session:', s?.title || '');
  if (!t || t === s?.title) return;
  const r = await api(`/api/code-agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) });
  if (r && !r.error) await caRefreshSessions();
};
const caClose = async (id, e) => {
  e?.stopPropagation();
  if (!confirm('Close this session? (Claude history is kept on disk.)')) return;
  await api(`/api/code-agent/sessions/${id}`, { method: 'DELETE' });
  if (state.codeAgent.active === id) {
    state.codeAgent.active = null; state.codeAgent.messages = [];
    state.codeAgent.busy = false; persistCode();
  }
  await caRefreshSessions();
};

const caReconnect = async (id) => {
  // Snapshot: if reconnect produces nothing, restore what we had.
  const snapshot = state.codeAgent.messages.map(m => ({ ...m }));
  try {
    const r = await fetch(`/api/code-agent/sessions/${id}/stream`, { headers: headers() });
    if (!r.ok) {
      state.codeAgent.busy = false; state.codeAgent.status = null; state.codeAgent.startTs = null;
      const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
      if (last && last.role === 'assistant') {
        if (last.text) last.text = last.text.replace(/\n?\n?Error: .+$/, '').trim();
        if (!last.text) last.text = '*(session ended while disconnected)*';
      }
      persistCode(); render(); return;
    }
    const lastUserIdx = state.codeAgent.messages.reduce((a, m, i) => m.role === 'user' ? i : a, -1);
    if (lastUserIdx >= 0) state.codeAgent.messages.splice(lastUserIdx + 1);
    render();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let gotAny = false;
    const ensureLast = () => {
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
          const e = JSON.parse(p);
          gotAny = true;
          if (e.type === 'text') { ensureLast(); state.codeAgent.messages[state.codeAgent.messages.length - 1].text += e.text; state.codeAgent.status = 'typing'; }
          else if (e.type === 'tool_use') {
            state.codeAgent.messages.push({ role: 'tool_use', tool: e.tool, input: e.input, ts: Date.now() });
            state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
            state.codeAgent.status = `running ${e.tool}`;
          }
          else if (e.type === 'tool_result') state.codeAgent.status = 'thinking';
          else if (e.type === 'result') state.codeAgent.status = e.is_error ? 'error' : null;
          persistCode(); render();
        } catch {}
      }
    }
    // If we got NOTHING from the stream and our local state is empty/shorter, restore snapshot
    if (!gotAny && snapshot.length > state.codeAgent.messages.length) {
      state.codeAgent.messages = snapshot;
    }
  } catch {}
  while (state.codeAgent.messages.length && state.codeAgent.messages[state.codeAgent.messages.length - 1].role === 'assistant' && !state.codeAgent.messages[state.codeAgent.messages.length - 1].text) {
    state.codeAgent.messages.pop();
  }
  for (let i = state.codeAgent.messages.length - 1; i >= 0; i--) {
    const m = state.codeAgent.messages[i];
    if (m.role === 'assistant' && m.ts && m.elapsed_ms == null) { m.elapsed_ms = Date.now() - m.ts; break; }
  }
  state.codeAgent.busy = false; state.codeAgent.status = null; state.codeAgent.startTs = null;
  persistCode(); render();
};

const caSend = async (text) => {
  if (!state.codeAgent.active || !text.trim()) return;
  const now = Date.now();
  state.codeAgent.messages.push({ role: 'user', text, ts: now });
  state.codeAgent.messages.push({ role: 'assistant', text: '', ts: now, elapsed_ms: null });
  state.codeAgent.busy = true; state.codeAgent.status = 'thinking'; state.codeAgent.startTs = now;
  persistCode(); render();
  try {
    const r = await fetch(`/api/code-agent/sessions/${state.codeAgent.active}/messages`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let gotDone = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const p = line.slice(6);
        if (p === '[DONE]') { gotDone = true; continue; }
        try {
          const e = JSON.parse(p);
          const last = state.codeAgent.messages[state.codeAgent.messages.length - 1];
          if (e.type === 'text') { last.text += e.text; state.codeAgent.status = 'typing'; persistCode(); render(); }
          else if (e.type === 'tool_use') {
            state.codeAgent.messages.push({ role: 'tool_use', tool: e.tool, input: e.input, ts: Date.now() });
            state.codeAgent.messages.push({ role: 'assistant', text: '', ts: Date.now(), elapsed_ms: null });
            state.codeAgent.status = `running ${e.tool}`; persistCode(); render();
          }
          else if (e.type === 'tool_result') { state.codeAgent.status = 'thinking'; render(); }
          else if (e.type === 'result') { state.codeAgent.status = e.is_error ? 'error' : null; }
        } catch {}
      }
    }
    // Stream ended without [DONE] — connection dropped but the session
    // may still be producing output.  Reconnect and replay.
    if (!gotDone && state.codeAgent.active && state.codeAgent.busy) {
      state.codeAgent.status = 'reconnecting'; persistCode(); render();
      caReconnect(state.codeAgent.active);
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') {}
    else if (state.codeAgent.active) {
      state.codeAgent.status = 'reconnecting'; persistCode(); render();
      caReconnect(state.codeAgent.active); return;
    } else {
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
  state.codeAgent.busy = false; state.codeAgent.status = null; state.codeAgent.startTs = null;
  persistCode(); render();
};

// History browser
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
  state.codeAgent.historyCwd = null;
  render();
  const data = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`);
  state.codeAgent.historyMessages = data?.messages || [];
  state.codeAgent.historyCwd = data?.cwd || null;
  render();
};
const caContinue = async () => {
  const conv = state.codeAgent.historyView;
  const cwd = state.codeAgent.historyCwd;
  if (!conv || !cwd) { toast('Original directory not found', 'warn'); return; }
  const r = await api('/api/code-agent/sessions/resume', {
    method: 'POST',
    body: JSON.stringify({ id: conv.id, cwd, title: conv.title.slice(0, 60) }),
  });
  if (!r || r.error) { toast('Resume failed: ' + (r?.error || 'unknown'), 'danger'); return; }
  state.codeAgent.active = r.id;
  state.codeAgent.messages = state.codeAgent.historyMessages.slice();
  state.codeAgent.historyOpen = false;
  state.codeAgent.historyView = null;
  state.codeAgent.historyMessages = [];
  persistCode();
  await caRefreshSessions();
};
const caDeleteHistory = async (conv, e) => {
  e?.stopPropagation();
  if (!confirm(`Delete "${conv.title.slice(0, 60)}${conv.title.length > 60 ? '…' : ''}"?`)) return;
  const r = await api(`/api/code-agent/history/${encodeURIComponent(conv.project)}/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
  if (r?.ok) {
    state.codeAgent.historyList = state.codeAgent.historyList.filter(c => !(c.project === conv.project && c.id === conv.id));
    if (state.codeAgent.historyView?.id === conv.id) {
      state.codeAgent.historyView = null;
      state.codeAgent.historyMessages = [];
    }
    render();
  }
};

// Code chat panel (mode = "code")
const panelChatCode = () => {
  const ca = state.codeAgent;
  const activeSession = ca.sessions.find(s => s.id === ca.active);

  // Directory picker
  if (ca.pickerOpen) {
    const rows = [];
    if (ca.pickerParent && ca.pickerParent !== ca.pickerPath) {
      rows.push(el('div', { class: 'ca-dir-row', onclick: () => caLoadDir(ca.pickerParent) }, ico('arrow_left', 14), el('span', {}, 'Up a level')));
    }
    for (const e of ca.pickerEntries.filter(x => x.type === 'dir')) {
      rows.push(el('div', { class: 'ca-dir-row', onclick: () => caLoadDir(e.path) }, ico('folder', 14), el('span', {}, e.name)));
    }
    return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
      el('div', { class: 'panel-head' }, el('span', {}, 'Open Code In…'), chatModesSwitch()),
      el('div', { class: 'ca-path' }, ca.pickerPath),
      el('div', { class: 'ca-dir-list' }, ...rows),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn sm', onclick: () => { ca.pickerOpen = false; render(); } }, 'Cancel'),
        el('button', { class: 'btn sm primary', onclick: caOpenHere }, 'Open here'),
      ),
    );
  }

  // History browser
  if (ca.historyOpen) {
    if (ca.historyView) {
      const grouped = [];
      let toolCount = 0;
      for (const m of ca.historyMessages) {
        if (m.role === 'tool_use') { toolCount++; if (!ca.historyShowTools) continue; grouped.push(m); continue; }
        const last = grouped[grouped.length - 1];
        if (last && last.role === m.role && (last.role === 'user' || last.role === 'assistant')) {
          last.text = (last.text || '') + '\n\n' + (m.text || '');
        } else grouped.push({ ...m });
      }
      const msgs = grouped.map(m => renderChatMsg(m));
      return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
        el('div', { class: 'panel-head' }, el('span', {}, 'History'), chatModesSwitch()),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn sm', onclick: () => { ca.historyView = null; ca.historyMessages = []; ca.historyCwd = null; render(); } }, ico('arrow_left', 14), ' Back'),
          toolCount > 0 ? el('button', { class: 'btn sm', onclick: () => { ca.historyShowTools = !ca.historyShowTools; render(); } },
            ca.historyShowTools ? `Hide tools (${toolCount})` : `Show tools (${toolCount})`) : null,
          ca.historyCwd ? el('button', { class: 'btn sm primary', onclick: caContinue }, 'Continue ', ico('arrow', 14)) : null,
        ),
        el('div', { class: 'ca-hist-title' }, ca.historyView.title),
        el('div', { class: 'ca-hist-meta' }, `${ca.historyView.project} · ${ca.historyView.messageCount} events${ca.historyCwd ? ' · ' + ca.historyCwd : ''}`),
        el('div', { class: 'chat-wrap' }, el('div', { class: 'chat-log' }, ...msgs)),
      );
    }
    return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
      el('div', { class: 'panel-head' }, el('span', {}, 'History'), chatModesSwitch()),
      el('button', { class: 'btn sm', onclick: () => { ca.historyOpen = false; render(); } }, ico('arrow_left', 14), ' Back'),
      ca.historyList.length === 0
        ? el('div', { class: 'muted', style: 'padding:20px;text-align:center;font-size:0.78rem' }, 'no past conversations')
        : el('div', { class: 'ca-hist-list' },
            ...ca.historyList.map(conv =>
              el('div', { class: 'saved-item', onclick: () => caViewHistory(conv) },
                el('div', { class: 'saved-title' }, conv.title),
                el('div', { class: 'ca-hist-date' }, fmtTime(conv.modified)),
                el('button', { class: 'btn ghost icon danger', onclick: (e) => caDeleteHistory(conv, e), title: 'Delete' }, ico('trash', 12)),
              ),
            ),
          ),
    );
  }

  // Build session message log
  const log = el('div', { class: 'chat-log' });
  if (!activeSession) {
    log.appendChild(el('div', { class: 'chat-empty' },
      ico('code', 28),
      el('div', {}, ca.sessions.length ? 'Pick a session above' : 'Open a folder to start'),
    ));
  } else {
    const lastIdx = ca.messages.length - 1;
    ca.messages.forEach((m, i) => log.appendChild(renderChatMsg(m, {
      isLast: i === lastIdx, busy: ca.busy, busyStatus: ca.status, busyStart: ca.startTs,
    })));
  }

  const input = el('textarea', { class: 'chat-input', rows: '1',
    placeholder: activeSession ? 'Message Claude…' : 'Pick a session' });
  input.value = localStorage.getItem('draft_code') || '';
  const sendCode = () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = ''; localStorage.removeItem('draft_code');
    caSend(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCode(); }
  });
  input.addEventListener('input', () => {
    localStorage.setItem('draft_code', input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  const sessionTabs = ca.sessions.length
    ? el('div', { class: 'ca-sess-list' },
        ...ca.sessions.map(s =>
          el('div', { class: 'ca-sess' + (s.id === ca.active ? ' active' : ''), onclick: () => caSelect(s.id) },
            el('span', { class: 'ca-sess-title' }, s.title),
            el('span', { class: 'ca-sess-cwd' }, s.cwd.replace(/^\/media\/ojee\/NVME\/Code\/\[GIT\]\//, '')),
            el('div', { class: 'saved-actions' },
              el('button', { class: 'btn ghost icon', onclick: (e) => caRename(s.id, e), title: 'Rename' }, ico('pencil', 12)),
              el('button', { class: 'btn ghost icon danger', onclick: (e) => caClose(s.id, e), title: 'Close' }, ico('trash', 12)),
            ),
          ),
        ),
      )
    : el('div', { class: 'muted', style: 'padding:8px;font-size:0.78rem' }, 'no active sessions');

  const headerSection = el('div', { class: 'panel-head' },
    el('span', {}, 'Claude Code'),
    chatModesSwitch(),
  );

  const toolbar = el('div', { class: 'btn-row' },
    el('button', { class: 'btn sm primary', onclick: () => { ca.pickerOpen = true; render(); caLoadDir(ca.pickerPath); } }, ico('plus', 14), ' New'),
    el('button', { class: 'btn sm', onclick: caRefreshSessions }, ico('reload', 14)),
    el('button', { class: 'btn sm', onclick: caLoadHistory }, ico('history', 14), ' History'),
  );

  return el('div', { class: 'panel chat-panel', 'data-panel': 'chat' },
    headerSection,
    toolbar,
    sessionTabs,
    activeSession ? el('div', { class: 'chat-wrap' },
      el('div', { class: 'ca-active-head' },
        el('span', { class: 'ca-active-title' }, activeSession.title),
        el('span', { class: 'ca-active-cwd' }, activeSession.cwd),
      ),
      log,
      el('div', { class: 'chat-form' },
        input,
        ca.busy ? el('button', { class: 'btn chat-send chat-stop', title: 'Stop' }, ico('stop', 14)) : null,
        el('button', { class: 'btn primary chat-send', onclick: sendCode, title: 'Send' }, ico('send', 14)),
      ),
    ) : null,
  );
};

// ─── Live timer ────────────────────────────────────────────────────────
let liveTimerInterval = null;
const startLiveTimer = () => {
  if (liveTimerInterval) clearInterval(liveTimerInterval);
  liveTimerInterval = setInterval(() => {
    const timers = document.querySelectorAll('.live-timer');
    if (!timers.length) { clearInterval(liveTimerInterval); liveTimerInterval = null; return; }
    for (const t of timers) {
      const start = parseInt(t.dataset.start, 10);
      if (!start) continue;
      const elapsed = Date.now() - start;
      const prefix = t.dataset.prefix || '';
      t.textContent = (prefix ? prefix + ' · ' : '') + fmtDur(elapsed);
    }
  }, 1000);
};

// ─── Render ────────────────────────────────────────────────────────────
const render = () => {
  // Preserve input value/focus across re-renders
  const oldInput = document.querySelector('.chat-input');
  const active = document.activeElement;
  const preserved = oldInput ? {
    value: oldInput.value,
    start: oldInput.selectionStart,
    end: oldInput.selectionEnd,
    focused: oldInput === active,
  } : null;

  if (document.activeElement?.tagName === 'SELECT') return;

  // Save scroll positions
  const SCROLL = ['.panel', '.chat-log', '.ca-hist-list', '.ca-dir-list', '.ca-sess-list', '.saved-list'];
  const saved = {};
  for (const sel of SCROLL) saved[sel] = Array.from(document.querySelectorAll(sel)).map(p => ({ top: p.scrollTop, left: p.scrollLeft }));

  const oldLog = document.querySelector('.chat-log');
  const stickToBottom = oldLog ? (oldLog.scrollHeight - oldLog.scrollTop - oldLog.clientHeight < 60) : true;
  const pageY = window.scrollY || document.documentElement.scrollTop || 0;

  // Preserve toast stack across rebuilds
  const toastStack = document.querySelector('.toast-stack');
  if (toastStack) toastStack.remove();

  document.body.innerHTML = '';
  const grid = el('div', { class: 'grid' },
    panelSystem(),
    panelServices(),
    panelActions(),
    panelChat(),
  );
  // On mobile, mark the active panel
  const activePanel = state.view === 'chat' ? 'chat'
    : state.view === 'services' ? 'services'
    : state.view === 'actions' ? 'actions'
    : 'dashboard';
  for (const p of grid.children) {
    if (p.dataset.panel === activePanel) p.classList.add('mobile-active');
  }

  document.body.append(
    el('div', { class: 'dash' }, renderHeader(), grid),
    renderBottomTabs(),
  );
  if (toastStack) document.body.appendChild(toastStack);

  if (preserved) {
    const newInput = document.querySelector('.chat-input');
    if (newInput) {
      newInput.value = preserved.value;
      if (preserved.focused) {
        newInput.focus();
        try { newInput.setSelectionRange(preserved.start, preserved.end); } catch {}
      }
      newInput.style.height = 'auto';
      newInput.style.height = Math.min(newInput.scrollHeight, 200) + 'px';
    }
  }

  for (const sel of SCROLL) {
    const arr = saved[sel] || [];
    Array.from(document.querySelectorAll(sel)).forEach((e, i) => {
      const s = arr[i]; if (!s) return;
      if (sel === '.chat-log' && i === 0 && stickToBottom) e.scrollTop = e.scrollHeight;
      else { e.scrollTop = s.top; e.scrollLeft = s.left; }
    });
  }
  if (pageY) window.scrollTo(0, pageY);

  if ((state.chatBusy && state.chatStartTs) || (state.codeAgent.busy && state.codeAgent.startTs) || (state.loqAgent.busy && state.loqAgent.startTs)) startLiveTimer();
};

// ─── Reconnect chat job ────────────────────────────────────────────────
const reconnectChatJob = async (jobId) => {
  // Snapshot the current message so if reconnect returns nothing, we restore it
  const lastIdx = state.chat.length - 1;
  const lastMsg = state.chat[lastIdx];
  const snapshot = lastMsg && lastMsg.role === 'assistant'
    ? { content: lastMsg.content || '', tools: (lastMsg.tools || []).slice() }
    : null;

  try {
    const r = await fetch(`/api/chat/jobs/${jobId}`, { headers: headers() });
    if (!r.ok) {
      state.chatBusy = false; state.chatStatus = null;
      state.chatJobId = null; state.chatStartTs = null;
      const last = state.chat[state.chat.length - 1];
      if (last && last.role === 'assistant') {
        if (last.content) last.content = last.content.replace(/\n?\n?Error: .+$/, '').trim();
        if (!last.content && snapshot) last.content = snapshot.content;
        if (!last.content) last.content = '*(session expired)*';
      }
      persistChat(); render(); return;
    }
    // Server replays buffered events. Start from clean slate to avoid double-counting.
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.content = '';
      lastMsg.tools = [];
    }
    render();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let gotAny = false;
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
          const j = JSON.parse(p);
          gotAny = true;
          if (j.clear_message) {
            state.chat[state.chat.length - 1].content = '';
            render();
          } else if (j.message?.content) {
            state.chatStatus = 'typing';
            state.chat[state.chat.length - 1].content += j.message.content;
            render();
          } else if (j.tool_call) {
            state.chatStatus = `${j.tool_call.name.replace(/^(get|list|read|web)_/, '')}`;
            const last = state.chat[state.chat.length - 1];
            if (!last.tools) last.tools = [];
            if (!last.tools.includes(j.tool_call.name)) last.tools.push(j.tool_call.name);
            render();
          } else if (j.tool_result) {
            state.chatStatus = 'thinking'; render();
          }
        } catch {}
      }
    }
    // If reconnect produced nothing usable AND we had snapshot content, restore it
    const last = state.chat[state.chat.length - 1];
    if (last && last.role === 'assistant' && !last.content && snapshot && snapshot.content) {
      last.content = snapshot.content;
      last.tools = snapshot.tools;
    }
  } catch {}
  const last = state.chat[state.chat.length - 1];
  if (last && last.role === 'assistant') {
    last.ts = Date.now();
    last.elapsed_ms = state.chatStartTs ? Date.now() - state.chatStartTs : null;
    if (!last.content && snapshot && snapshot.content) {
      last.content = snapshot.content;
      last.tools = snapshot.tools;
    }
  }
  state.chatJobId = null; state.chatBusy = false;
  state.chatStatus = null; state.chatStartTs = null;
  persistChat();
  if (state.activeChatId) saveChat().catch(() => {});
  render();
};

// ─── Polling ───────────────────────────────────────────────────────────
const pushHistory = (key, value) => {
  if (value == null || isNaN(value)) return;
  const arr = state.history[key];
  arr.push(value);
  if (arr.length > HISTORY_LEN) arr.shift();
};
const refresh = async () => {
  if (!token) return;
  const [stats, services, models, pull] = await Promise.all([
    api('/api/stats'),
    api('/api/services'),
    api('/api/models'),
    api('/api/pull-progress'),
  ]);
  if (stats) {
    state.stats = stats;
    pushHistory('cpu', stats.cpu?.avg);
    pushHistory('ram', stats.memory?.percent);
    pushHistory('swap', stats.swap?.total ? (stats.swap.used / stats.swap.total) * 100 : 0);
    pushHistory('net_in', stats.network?.recv_per_s || 0);
    pushHistory('net_out', stats.network?.sent_per_s || 0);
    pushHistory('disk_read', stats.disk?.read_per_s || 0);
    pushHistory('disk_write', stats.disk?.write_per_s || 0);
  }
  if (services) state.services = services;
  if (pull) state.pull = pull.lines;

  let needsRender = false;
  if (models?.models) {
    const pref = ['llama3.1:8b', 'hermes3:8b', 'qwen2.5:7b', 'qwen2.5-coder:7b', 'llama3.2:3b'];
    state.models = [...models.models].sort((a, b) => {
      const ia = pref.indexOf(a.name), ib = pref.indexOf(b.name);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    if (!state.chatModel && state.models.length) {
      state.chatModel = state.models[0].name;
      needsRender = true;
    }
  }
  if (!state.codeAgent.checked) {
    state.codeAgent.checked = true;
    const cfg = await api('/api/code-agent/config');
    const was = state.codeAgent.enabled;
    state.codeAgent.enabled = !!cfg?.enabled;
    if (was !== state.codeAgent.enabled) needsRender = true;
  }
  if (state.codeAgent.enabled && !state.codeAgent.busy) {
    const s = await api('/api/code-agent/sessions');
    if (s?.active) state.codeAgent.sessions = s.active;
  }
  // Probe loq laptop's Ollama (cheap, ~1.5s timeout server-side)
  if (!state.loqAgent.busy) {
    const lq = await api('/api/loq/status');
    if (lq) {
      const before = `${state.loqAgent.reachable}|${state.loqAgent.controlReachable}`;
      state.loqAgent.reachable = !!lq.reachable;
      state.loqAgent.controlReachable = !!lq.controlReachable;
      state.loqAgent.controlOnline = !!lq.daemon;
      state.loqAgent.models = lq.models || [];
      if (!state.loqAgent.chatModel && state.loqAgent.models.length) {
        state.loqAgent.chatModel = state.loqAgent.models[0].name;
      }
      const after = `${state.loqAgent.reachable}|${state.loqAgent.controlReachable}`;
      if (before !== after) needsRender = true;
    }
  }
  // Always re-render so gauges/sparklines update — DOM rebuild is cheap
  render();
};

// ─── Boot ──────────────────────────────────────────────────────────────
const boot = async () => {
  restoreChat();
  restoreCode();
  restoreLoq();
  restoreThink();
  await loadSavedChats();
  render();
  refresh();
  setInterval(refresh, 5000);

  if (state.chatBusy && state.chatJobId) {
    const last = state.chat[state.chat.length - 1];
    if (last?.role === 'assistant' && last.content) {
      last.content = last.content.replace(/\n?\n?Error: .+$/, '').trim();
    }
    state.chatStatus = 'reconnecting'; render();
    reconnectChatJob(state.chatJobId);
  }
  if (state.loqAgent.busy && state.loqAgent.jobId) {
    state.loqAgent.status = 'reconnecting'; render();
    reconnectLoqJob(state.loqAgent.jobId);
  }
  if (state.thinkAgent.busy && state.thinkAgent.jobId) {
    state.thinkAgent.status = 'reconnecting'; render();
    reconnectThinkJob(state.thinkAgent.jobId);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.chatBusy && state.chatJobId) {
      state.chatStatus = 'reconnecting'; render();
      reconnectChatJob(state.chatJobId);
    }
    if (state.loqAgent.busy && state.loqAgent.jobId) {
      state.loqAgent.status = 'reconnecting'; render();
      reconnectLoqJob(state.loqAgent.jobId);
    }
    if (state.thinkAgent.busy && state.thinkAgent.jobId) {
      state.thinkAgent.status = 'reconnecting'; render();
      reconnectThinkJob(state.thinkAgent.jobId);
    }
    if (state.codeAgent.busy && state.codeAgent.active) {
      state.codeAgent.status = 'reconnecting'; render();
      caReconnect(state.codeAgent.active);
    }
  });
  if (state.codeAgent.active) {
    try {
      const h = await api(`/api/code-agent/sessions/${state.codeAgent.active}/history`);
      if (h?.messages && h.messages.length >= state.codeAgent.messages.length) {
        state.codeAgent.messages = h.messages;
        persistCode(); render();
      }
    } catch {}
    if (state.codeAgent.busy) caReconnect(state.codeAgent.active);
  }

  // Keyboard shortcuts: Cmd/Ctrl+K for new chat, Esc to close history/picker
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') {
      if (state.codeAgent.pickerOpen) { state.codeAgent.pickerOpen = false; render(); }
      else if (state.codeAgent.historyOpen) {
        if (state.codeAgent.historyView) {
          state.codeAgent.historyView = null;
          state.codeAgent.historyMessages = [];
          state.codeAgent.historyCwd = null;
        } else state.codeAgent.historyOpen = false;
        render();
      } else if (state.showSavedList) {
        state.showSavedList = false; render();
      }
    }
  });
};

// Inject Inter font
const interLink = document.createElement('link');
interLink.rel = 'stylesheet';
interLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
document.head.appendChild(interLink);

if (!token) renderLogin();
else boot();
