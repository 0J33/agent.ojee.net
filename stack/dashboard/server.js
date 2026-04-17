const express = require('express');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const si = require('systeminformation');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-me';
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
const N8N_BASE = process.env.N8N_BASE_URL || 'http://n8n:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

const n8nApi = async (path, opts = {}) => {
  if (!N8N_API_KEY) throw new Error('N8N_API_KEY not set in .env — generate one in n8n Settings → n8n API');
  const r = await fetch(`${N8N_BASE}/api/v1${path}`, {
    ...opts,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  if (!r.ok) throw new Error(`n8n api ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body).slice(0, 300)}`);
  return body;
};

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Auth ─────────────────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  if (req.body.password !== PASSWORD) return res.status(401).json({ error: 'invalid' });
  const token = jwt.sign({ sub: 'user' }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  try { jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'unauthorized' }); }
};

// ─── Stats ────────────────────────────────────────────────────────────────
let lastNet = null, lastNetTime = 0;
app.get('/api/stats', auth, async (req, res) => {
  try {
    const [cpu, mem, load, os, disk, temp, net] = await Promise.all([
      si.cpu(), si.mem(), si.currentLoad(), si.osInfo(),
      si.fsSize(), si.cpuTemperature(), si.networkStats()
    ]);
    const now = Date.now();
    const primary = net.find(n => n.iface === 'wlo1') || net[0] || {};
    let rxPerS = 0, txPerS = 0;
    if (lastNet && lastNetTime) {
      const dt = (now - lastNetTime) / 1000;
      rxPerS = Math.max(0, (primary.rx_bytes - lastNet.rx_bytes) / dt);
      txPerS = Math.max(0, (primary.tx_bytes - lastNet.tx_bytes) / dt);
    }
    lastNet = primary; lastNetTime = now;

    const rootDisk = disk.find(d => d.mount === '/') || disk[0] || {};
    res.json({
      hostname: os.hostname,
      os: `${os.distro} ${os.release}`,
      uptime: si.time().uptime,
      cpu: {
        model: cpu.manufacturer + ' ' + cpu.brand,
        physical: cpu.physicalCores,
        cores: cpu.cores,
        avg: load.currentLoad,
        load: [load.avgLoad || 0, 0, 0]
      },
      memory: {
        total: mem.total,
        used: mem.active,
        percent: Math.round((mem.active / mem.total) * 100)
      },
      swap: { total: mem.swaptotal, used: mem.swapused },
      disk: {
        total: rootDisk.size,
        used: rootDisk.used,
        percent: Math.round(rootDisk.use || 0)
      },
      temps: [
        temp.main != null ? { label: 'CPU Package', current: Math.round(temp.main) } : null
      ].filter(Boolean),
      network: {
        sent_per_s: Math.round(txPerS),
        recv_per_s: Math.round(rxPerS)
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Services (docker + systemd) ──────────────────────────────────────────
const execP = (cmd) => new Promise((resolve) => {
  exec(cmd, { timeout: 5000 }, (err, stdout) => resolve(stdout || ''));
});

const checkOllama = async () => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { timeout: 2000 });
    return r.ok;
  } catch { return false; }
};

app.get('/api/services', auth, async (req, res) => {
  const [compose, ollamaUp] = await Promise.all([
    execP('docker ps --format "{{.Names}}|{{.State}}|{{.Status}}"'),
    checkOllama(),
  ]);
  const svc = {};
  compose.split('\n').filter(Boolean).forEach(l => {
    const [name, state, status] = l.split('|');
    svc[name] = { desc: name, active: state === 'running', status };
  });
  svc.ollama = { desc: 'Ollama LLM Server', active: ollamaUp, status: ollamaUp ? 'Reachable on :11434' : 'Not reachable' };
  res.json(svc);
});

// ─── Ollama ───────────────────────────────────────────────────────────────
app.get('/api/models', auth, async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/pull-progress', auth, (req, res) => {
  try {
    const raw = fs.readFileSync('/host-tmp/ollama-pull.log', 'utf8');
    // Ollama's TUI uses ANSI cursor codes (no newlines). Convert all ANSI
    // escape sequences + carriage returns to newlines so we can split lines
    // and dedupe the repeating progress frames.
    const clean = raw
      .replace(/\x1B\[[?\d;]*[a-zA-Z]/g, '\n')
      .replace(/\r/g, '\n');
    const all = clean.split('\n').map(l => l.trim()).filter(Boolean);
    // Collapse by prefix — for each distinct prefix (pulling manifest,
    // pulling <sha>, verifying, writing, success), keep only the latest frame.
    const byPrefix = new Map();
    const order = [];
    for (const line of all) {
      const m = line.match(/^(pulling (?:manifest|[0-9a-f]+)|verifying[^:]*|writing[^:]*|downloading[^:]*|success)/i);
      const prefix = m ? m[1].toLowerCase() : `__${line}`;
      if (!byPrefix.has(prefix)) order.push(prefix);
      byPrefix.set(prefix, line);
    }
    const final = order.map(p => byPrefix.get(p));
    res.json({ lines: final.slice(-8) });
  } catch {
    res.json({ lines: ['no active pull'] });
  }
});

// ─── Tools (web + read-only system — no writes, no shell) ──────────────
const HOST_ROOT = '/host';
const stripHtml = (s) => s
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

// Extract the meaty parts of an HTML page: title, meta description, og:*,
// then body text. Preserves info from JS-rendered SPAs that only have meta.
const extractPage = (html) => {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  const metaRe = /<meta\s+(?:name|property)\s*=\s*["']([^"']+)["']\s+content\s*=\s*["']([^"']*)["']/gi;
  const meta = {};
  let m; while ((m = metaRe.exec(html))) {
    if (!meta[m[1]]) meta[m[1]] = m[2].trim();
  }
  const body = stripHtml(html);
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  const descKeys = ['description', 'og:description', 'twitter:description'];
  for (const k of descKeys) if (meta[k] && !parts.some(p => p.includes(meta[k]))) { parts.push(`${k}: ${meta[k]}`); break; }
  const otherMeta = ['og:title', 'og:site_name', 'author', 'keywords', 'og:type'];
  for (const k of otherMeta) if (meta[k]) parts.push(`${k}: ${meta[k]}`);
  if (body && body.length > 20) parts.push(`Content: ${body}`);
  return parts.join('\n');
};

const hostPath = (p) => {
  if (!p || typeof p !== 'string') throw new Error('path required');
  if (!p.startsWith('/')) throw new Error('path must be absolute');
  return path.join(HOST_ROOT, p);
};

const TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web via DuckDuckGo and auto-fetch the top 2 result pages. Returns a JSON array where each item has {title, url, snippet, content} — content is the actual page text (HTML stripped, 3k char cap). Use this for ANY current/real-world fact: time, weather, news, prices, releases, people, places. If the content contains the answer, extract it. If not, say you don\'t know.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch a URL and return its text content (HTML stripped, 15k char cap).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'get_stats', description: 'Live system stats: CPU %, memory used/total, disk usage, CPU temperature, GPU info if present.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_services', description: 'Docker compose services in the agent stack and their running state.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_models', description: 'Ollama models installed locally.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file on the server host by absolute path (e.g. /etc/os-release, /home/ojee/stack/.env — but .env is sensitive). 50k char cap.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List a directory on the server host by absolute path. Returns [{name, type}].', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'n8n_list_workflows', description: 'List all n8n workflows. Returns array of {id, name, active}.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'n8n_get_workflow', description: 'Get a single n8n workflow in full (nodes, connections, settings).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'n8n_create_workflow', description: 'Create a new n8n workflow. The workflow is created INACTIVE; call n8n_activate_workflow afterwards. Pass name, nodes array, and connections object following n8n schema.', parameters: { type: 'object', properties: { name: { type: 'string' }, nodes: { type: 'array' }, connections: { type: 'object' }, settings: { type: 'object' } }, required: ['name', 'nodes', 'connections'] } } },
  { type: 'function', function: { name: 'n8n_update_workflow', description: 'Update an existing n8n workflow (replaces nodes/connections).', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, nodes: { type: 'array' }, connections: { type: 'object' }, settings: { type: 'object' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'n8n_activate_workflow', description: 'Activate a workflow (turns it on so triggers fire).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'n8n_deactivate_workflow', description: 'Deactivate a workflow (stops triggers).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  { type: 'function', function: {
    name: 'n8n_quick_workflow',
    description: 'Build a simple n8n workflow from a high-level description without needing to know n8n schema. PREFER THIS over n8n_create_workflow for anything simple. Pass name, trigger (schedule or webhook), and a list of steps. The server builds valid n8n JSON.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        trigger: { type: 'string', enum: ['schedule', 'webhook'], description: 'What fires the workflow' },
        every_hours: { type: 'number', description: 'For schedule: interval in hours (e.g. 1 for hourly). Default 1.' },
        every_minutes: { type: 'number', description: 'For schedule: interval in minutes. Overrides every_hours if given.' },
        webhook_path: { type: 'string', description: 'For webhook: URL path (e.g. "my-hook")' },
        webhook_method: { type: 'string', enum: ['GET', 'POST'], description: 'For webhook: HTTP method, default POST' },
        steps: {
          type: 'array',
          description: 'Ordered list of steps. Each step: { kind: "http"|"llm"|"set"|"email", ... }',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['http', 'llm', 'set', 'email'] },
              url: { type: 'string', description: 'http: target URL' },
              method: { type: 'string', description: 'http: GET/POST/etc, default GET' },
              body: { type: 'string', description: 'http: JSON body string for POST' },
              prompt: { type: 'string', description: 'llm: prompt template (use {{$json.field}} for webhook fields)' },
              model: { type: 'string', description: 'llm: ollama model name, defaults to llama3.1:8b' },
              field: { type: 'string', description: 'set: new field name' },
              value: { type: 'string', description: 'set: new field value' },
              to: { type: 'string', description: 'email: recipient' },
              subject: { type: 'string', description: 'email: subject' },
              text: { type: 'string', description: 'email: body text' }
            },
            required: ['kind']
          }
        }
      },
      required: ['name', 'trigger', 'steps']
    }
  } }
];

const runTool = async (name, args) => {
  args = args || {};
  if (name === 'web_search') {
    const q = encodeURIComponent(args.query || '');
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await r.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m; while ((m = re.exec(html)) && results.length < 6) {
      let url = decodeURIComponent(m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&amp;/g, '&').replace(/[&?]rut=.*$/, ''));
      results.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3]) });
    }
    if (!results.length) return 'no results';
    // Auto-fetch top 2 pages so model gets real content, not just snippets.
    // Heuristic: surface answer-relevant paragraphs at the top (navigation
    // menus on big sites push actual data too far down for 8B models).
    const keywords = ['current local', 'current time', 'local time', 'currently', 'today is', 'time is', 'temperature', 'price of', 'cost of', 'now playing', 'latest'];
    await Promise.all(results.slice(0, 2).map(async (res) => {
      try {
        const r2 = await fetch(res.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 });
        const full = extractPage(await r2.text());
        let best = '';
        for (const kw of keywords) {
          const idx = full.toLowerCase().indexOf(kw);
          if (idx >= 0) {
            best = full.slice(Math.max(0, idx - 40), idx + 400);
            break;
          }
        }
        res.content = (best ? `[key excerpt] ${best}\n\n` : '') + full.slice(0, best ? 1800 : 3000);
      } catch { res.content = '(fetch failed)'; }
    }));
    return results;
  }
  if (name === 'web_fetch') {
    const r = await fetch(args.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    const text = extractPage(await r.text());
    return text.slice(0, 15000) || '(page has no extractable text)';
  }
  if (name === 'get_stats') {
    const [cpu, mem, disk, temp, gpu, os, load] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.cpuTemperature(), si.graphics().catch(() => null), si.osInfo(), si.currentLoad()
    ]);
    return {
      cpu_pct: Math.round(cpu.currentLoad),
      load_avg: load.avgLoad,
      mem: { used_gb: +(mem.used / 1e9).toFixed(2), total_gb: +(mem.total / 1e9).toFixed(2), pct: Math.round(mem.used / mem.total * 100) },
      disk: disk.filter(d => ['/', '/home'].includes(d.mount)).map(d => ({ mount: d.mount, used_pct: Math.round(d.use), free_gb: +((d.size - d.used) / 1e9).toFixed(1) })),
      cpu_temp_c: temp.main,
      gpu: gpu?.controllers?.map(g => ({ name: g.model, vram_mb: g.vram, util_pct: g.utilizationGpu, temp_c: g.temperatureGpu })) || [],
      os: `${os.distro} ${os.release} (kernel ${os.kernel})`
    };
  }
  if (name === 'get_services') {
    return await new Promise((resolve) => {
      exec('docker compose -f /host-stack/docker-compose.yml ps --format json', { timeout: 10000 }, (_err, stdout) => {
        try {
          const rows = stdout.trim().split('\n').filter(Boolean).map(l => {
            const j = JSON.parse(l);
            return { name: j.Name, service: j.Service, state: j.State, status: j.Status };
          });
          resolve(rows);
        } catch { resolve(stdout || 'no services'); }
      });
    });
  }
  if (name === 'list_models') {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const data = await r.json();
    return (data.models || []).map(m => ({ name: m.name, size_gb: +(m.size / 1e9).toFixed(2), modified: m.modified_at }));
  }
  if (name === 'read_file') {
    const content = fs.readFileSync(hostPath(args.path), 'utf8');
    return content.slice(0, 50000);
  }
  if (name === 'list_dir') {
    const entries = fs.readdirSync(hostPath(args.path), { withFileTypes: true });
    return entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
  }
  if (name === 'n8n_list_workflows') {
    const r = await n8nApi('/workflows');
    return (r.data || []).map(w => ({ id: w.id, name: w.name, active: w.active }));
  }
  if (name === 'n8n_get_workflow') {
    return await n8nApi(`/workflows/${args.id}`);
  }
  if (name === 'n8n_create_workflow') {
    const body = {
      name: args.name,
      nodes: args.nodes || [],
      connections: args.connections || {},
      settings: args.settings || { executionOrder: 'v1' }
    };
    const r = await n8nApi('/workflows', { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, name: r.name, active: r.active };
  }
  if (name === 'n8n_update_workflow') {
    const existing = await n8nApi(`/workflows/${args.id}`);
    const body = {
      name: args.name ?? existing.name,
      nodes: args.nodes ?? existing.nodes,
      connections: args.connections ?? existing.connections,
      settings: args.settings ?? existing.settings ?? { executionOrder: 'v1' }
    };
    const r = await n8nApi(`/workflows/${args.id}`, { method: 'PUT', body: JSON.stringify(body) });
    return { id: r.id, name: r.name, active: r.active };
  }
  if (name === 'n8n_activate_workflow') {
    return await n8nApi(`/workflows/${args.id}/activate`, { method: 'POST' });
  }
  if (name === 'n8n_deactivate_workflow') {
    return await n8nApi(`/workflows/${args.id}/deactivate`, { method: 'POST' });
  }
  if (name === 'n8n_quick_workflow') {
    const nodes = [];
    const connections = {};
    let x = 250, prev = null;
    const addNode = (spec) => {
      nodes.push({ ...spec, position: [x, 300] });
      if (prev) {
        connections[prev] = { main: [[{ node: spec.name, type: 'main', index: 0 }]] };
      }
      prev = spec.name;
      x += 220;
    };
    // Trigger
    if (args.trigger === 'schedule') {
      const interval = args.every_minutes
        ? { field: 'minutes', minutesInterval: args.every_minutes }
        : { field: 'hours', hoursInterval: args.every_hours || 1 };
      addNode({ id: 't1', name: 'Trigger', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
        parameters: { rule: { interval: [interval] } } });
    } else if (args.trigger === 'webhook') {
      addNode({ id: 't1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2,
        parameters: { path: args.webhook_path || 'hook', httpMethod: args.webhook_method || 'POST', responseMode: 'onReceived' } });
    } else {
      throw new Error(`unsupported trigger: ${args.trigger}`);
    }
    // Steps
    (args.steps || []).forEach((s, i) => {
      const id = `s${i + 1}`;
      if (s.kind === 'http') {
        const params = { method: s.method || 'GET', url: s.url, options: {} };
        if (s.body) { params.sendBody = true; params.contentType = 'json'; params.jsonBody = s.body; }
        addNode({ id, name: `HTTP ${i + 1}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: params });
      } else if (s.kind === 'llm') {
        addNode({ id, name: `LLM ${i + 1}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
          parameters: {
            method: 'POST', url: 'http://host.docker.internal:11434/api/generate', options: {},
            sendBody: true, contentType: 'json',
            jsonBody: JSON.stringify({ model: s.model || 'llama3.1:8b', prompt: s.prompt || '', stream: false })
          } });
      } else if (s.kind === 'set') {
        addNode({ id, name: `Set ${i + 1}`, type: 'n8n-nodes-base.set', typeVersion: 3.4,
          parameters: { assignments: { assignments: [{ id: `a${i}`, name: s.field, value: s.value, type: 'string' }] } } });
      } else if (s.kind === 'email') {
        addNode({ id, name: `Email ${i + 1}`, type: 'n8n-nodes-base.emailSend', typeVersion: 2.1,
          parameters: { toEmail: s.to, subject: s.subject, text: s.text, options: {} } });
      } else {
        throw new Error(`unknown step kind: ${s.kind}`);
      }
    });
    const r = await n8nApi('/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: args.name, nodes, connections, settings: { executionOrder: 'v1' } })
    });
    return { id: r.id, name: r.name, active: r.active, url: `https://agent.ojee.net/flow/workflow/${r.id}`, steps: nodes.length };
  }
  throw new Error(`unknown tool: ${name}`);
};

const sseWrite = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

app.post('/api/chat', auth, async (req, res) => {
  const { model, messages } = req.body;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const conv = [
    { role: 'system', content: `You are a friendly, conversational assistant on the user's self-hosted Linux server (Zorin OS, agent.ojee.net). Respond like a human — natural sentences, no headers, no bullet points unless truly listing things.

Tools available (use silently — do not announce them):
- web_search(query), web_fetch(url) — you have internet via these.
- get_stats() — CPU, RAM, disk, temp, GPU.
- get_services() — docker services state.
- list_models() — installed models.
- read_file(path), list_dir(path) — host fs, read-only. Stack at /home/ojee/stack. Never read .env files.

CORE RULE — no hallucination:
Never invent facts. For anything factual that could have changed or you're not 100% sure about, use a tool to verify. If a tool gives no useful result, honestly say "I don't know" or "I couldn't find that" — do NOT guess.

Specific anti-hallucination rules:
- NEVER invent a name, identity, address, or biographical detail from search snippets unless the snippet explicitly and clearly states it about the exact entity asked about. If snippets are ambiguous or about different people with similar names, say so — do not pick one.
- When the user corrects you, do NOT swing to a completely different made-up answer. Instead: re-check the tool result, and if you still can't find clear info, admit it.
- If the user says "that is me" or similar, do not then re-describe them with different details. Simply accept and continue.

n8n automation workflows — when user asks to build/list/activate automation:

PRIMARY TOOL: n8n_quick_workflow — use this for any "build me a workflow" request. It takes simple parameters (no n8n schema knowledge needed). Examples:
- "every hour, ping httpbin" → n8n_quick_workflow({ name:"Hourly ping", trigger:"schedule", every_hours:1, steps:[{ kind:"http", url:"https://httpbin.org/get" }] })
- "webhook that calls LLM and returns result" → n8n_quick_workflow({ name:"Ask", trigger:"webhook", webhook_path:"ask", steps:[{ kind:"llm", prompt:"{{$json.body.question}}" }] })
- "daily summary email" → n8n_quick_workflow({ name:"Daily", trigger:"schedule", every_hours:24, steps:[{ kind:"llm", prompt:"write a daily motivational quote" }, { kind:"email", to:"me@example.com", subject:"Quote", text:"{{$json.response}}" }] })

Only use n8n_create_workflow directly (with full node JSON) if the user needs something n8n_quick_workflow can't express.

After any create: tell user the ID and URL, ask if they want it activated. Never auto-activate.
- Tools: n8n_list_workflows, n8n_get_workflow, n8n_create_workflow, n8n_update_workflow, n8n_activate_workflow, n8n_deactivate_workflow.

Workflow schema (n8n rejects anything extra — match EXACTLY):
- Top-level: { name, nodes:[], connections:{}, settings:{executionOrder:"v1"} }
- Each node MUST have EXACTLY these fields: id, name, type, typeVersion, position, parameters.
  • id: any string, unique per workflow (e.g. "a1","a2")
  • name: display name, unique per workflow
  • type: the node type id (see list below)
  • typeVersion: number (see list below — MUST match exactly)
  • position: [x, y] numbers e.g. [250, 300]
  • parameters: object with node-specific fields
- Do NOT put "settings", "credentials", "disabled", etc. on individual nodes unless specifically asked.
- Connections format: { "SourceNodeName": { "main": [ [ {"node":"TargetNodeName","type":"main","index":0} ] ] } }. Note the nested array — "main" is an array of arrays.

Node type reference (use these EXACT typeVersions):
- n8n-nodes-base.scheduleTrigger v1.2 — parameters: { rule: { interval: [{ field: "hours", hoursInterval: 1 }] } }  // or field: "minutes"/"days"
- n8n-nodes-base.webhook v2 — parameters: { path: "my-hook", httpMethod: "POST", responseMode: "onReceived" }
- n8n-nodes-base.httpRequest v4.2 — parameters: { method: "GET", url: "https://...", options: {} }  // POST: add sendBody:true, contentType:"json", jsonBody:"{\"key\":\"val\"}"
- n8n-nodes-base.set v3.4 — parameters: { assignments: { assignments: [{ id: "1", name: "field", value: "val", type: "string" }] } }
- n8n-nodes-base.if v2.2 — parameters: { conditions: { conditions: [{ leftValue: "={{$json.x}}", rightValue: "y", operator: { type: "string", operation: "equals" } }] } }
- n8n-nodes-base.code v2 — parameters: { jsCode: "return items.map(i => ({json: {...i.json, added: 1}}));" }

Full working example — "every hour, ping httpbin":
  nodes: [
    { id:"a1", name:"Every Hour", type:"n8n-nodes-base.scheduleTrigger", typeVersion:1.2, position:[250,300],
      parameters:{ rule:{ interval:[{ field:"hours", hoursInterval:1 }] } } },
    { id:"a2", name:"Ping", type:"n8n-nodes-base.httpRequest", typeVersion:4.2, position:[500,300],
      parameters:{ method:"GET", url:"https://httpbin.org/get", options:{} } }
  ]
  connections: { "Every Hour": { "main": [ [ { "node":"Ping", "type":"main", "index":0 } ] ] } }

Rules:
- Created workflows start INACTIVE. After n8n_create_workflow succeeds, tell the user the workflow ID, link to https://agent.ojee.net/flow/workflow/<id>, and ASK if they want it activated — never activate automatically.
- If n8n_create_workflow returns an error, read the error message, FIX the JSON (don't re-send empty args), and retry once.
- To call the local LLM from n8n: httpRequest node → method:"POST" → url:"http://host.docker.internal:11434/api/generate" → sendBody:true, contentType:"json", jsonBody with {model,prompt,stream:false}.
- When n8n_list_workflows returns [], say "You don't have any workflows yet" — do NOT fabricate entries.

URL / domain queries — use web_fetch, not web_search:
- If the user mentions a specific domain or URL (e.g. "ojee.net", "example.com/path", "github.com/foo/bar"), call web_fetch with "https://" + the domain/path. Do NOT search for it — fetch it directly to see the actual site content.
- Only fall back to web_search if the fetch fails or the site has no meaningful text.

Reading web_fetch / web_search results:
- Results contain lines like "Title:", "description:", "og:description:", "Content:". These ARE the page's info — USE them.
- If "description:" says "CSEN graduate, programmer, and engineer" — the answer is "they are a CSEN graduate who works as a programmer and engineer." Don't say "I couldn't find info" when a description is right there.
- JS-only SPAs often have meaningful meta tags and little body text. Meta tags are just as valid as body text.

What to search (web_search) — anything about the current world:
- Time in a city, date, weather, news, prices, sports, release dates, versions
- Any named person / place / product / event where freshness matters

What to call local tools for — anything about THIS server:
- get_stats (CPU/RAM/disk/temp/GPU), get_services, list_models, read_file, list_dir

What you may answer from memory (no tool):
- Math, arithmetic, basic algebra. ("17 * 23" = 391, no search.)
- Code, programming concepts, syntax.
- Grammar, spelling, definitions, translations.
- Timeless facts (history, science fundamentals, how things work).
- General reasoning and advice.
If you feel any doubt even about these — search or say you don't know.

IMPORTANT — always search for these (even if you think you know):
- Entry/admission requirements for any university, school, or program.
- Policies, prices, specs, or features of specific companies/products.
- Anything about a specific named institution, organization, product, or regulation.
Users asking about these want the REAL current answer, not your trained guess. Search first.

How to respond:
- NEVER refuse to answer. For medical, legal, financial, or other sensitive topics, give the most informative answer you can (using web_search when helpful) and add a single-line disclaimer at the end like "This is general information, not a substitute for professional advice." Do NOT say "I can't help with that" or redirect the user to a professional without first giving the actual answer.
- NEVER ask permission to use a tool. Never say "let me know when you're ready" or "I'll proceed if you want" or "would you like me to search". Just call the tool. The user already asked the question — answer it.
- When calling a tool: emit ONE tool call, nothing else. No prose, no "let me search", no JSON inside text.
- After a tool result: answer plainly. Don't say "I searched" or "according to the web" — just state it.
- 1-3 sentences, conversational. No markdown unless the user asks for a list/code/table.
- You have no write access — for actions, point the user to the dashboard buttons, /chat/, or /flow/.` },
    ...messages
  ];
  const MAX_ITER = 6;
  try {
    for (let i = 0; i < MAX_ITER; i++) {
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: conv, tools: TOOLS, stream: false }),
        signal: ac.signal
      });
      const data = await r.json();
      const msg = data.message || {};
      let toolCalls = msg.tool_calls || [];
      let textOut = msg.content || '';
      // Fallback: some models emit tool calls as JSON in content. Extract the
      // first valid one, then strip ALL remaining JSON-looking blocks so the
      // user never sees raw tool-call syntax.
      if (!toolCalls.length && textOut && textOut.includes('"name"')) {
        const extractJsonAt = (s, from) => {
          let depth = 0, end = -1, inStr = false, esc = false;
          for (let i = from; i < s.length; i++) {
            const c = s[i];
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          return end > from ? s.slice(from, end + 1) : null;
        };
        // Walk all {...} blocks, grab the first valid tool call
        let cursor = 0;
        while (cursor < textOut.length) {
          const start = textOut.indexOf('{', cursor);
          if (start < 0) break;
          const block = extractJsonAt(textOut, start);
          if (!block) break;
          try {
            const parsed = JSON.parse(block);
            if (parsed.name && TOOLS.some(t => t.function.name === parsed.name)) {
              const fnArgs = parsed.arguments || parsed.parameters || parsed.args || {};
              toolCalls = [{ function: { name: parsed.name, arguments: fnArgs } }];
              break;
            }
          } catch {}
          cursor = start + block.length;
        }
      }
      // If we have any tool call at all, hide ALL prose + JSON — model was
      // often narrating ("I'll search for...") or emitting multiple JSON blobs.
      // The real answer comes on the next iteration after tool results.
      if (toolCalls.length) textOut = '';
      conv.push({ role: 'assistant', content: textOut, tool_calls: toolCalls.length ? toolCalls : undefined });
      if (textOut) sseWrite(res, { message: { content: textOut } });
      if (!toolCalls.length) { res.write('data: [DONE]\n\n'); return res.end(); }
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
        sseWrite(res, { tool_call: { name, args } });
        let result;
        try { result = await runTool(name, args); }
        catch (e) { result = `error: ${e.message}`; }
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        sseWrite(res, { tool_result: { name, preview: resultStr.slice(0, 400) } });
        conv.push({ role: 'tool', content: resultStr });
      }
    }
    sseWrite(res, { message: { content: '\n\n*(max tool iterations reached)*' } });
    res.write('data: [DONE]\n\n'); res.end();
  } catch (e) {
    if (!res.writableEnded) {
      if (e.name === 'AbortError') { res.write('data: [DONE]\n\n'); }
      else { sseWrite(res, { message: { content: `\n\nError: ${e.message}` } }); res.write('data: [DONE]\n\n'); }
      res.end();
    }
  }
});

// ─── Saved chats ──────────────────────────────────────────────────────────
const CHATS_DIR = '/app/data/chats';
fs.mkdirSync(CHATS_DIR, { recursive: true });
const chatFile = (id) => path.join(CHATS_DIR, `${id.replace(/[^a-z0-9-]/gi, '')}.json`);

app.get('/api/chats', auth, (req, res) => {
  try {
    const list = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        return { id: d.id, title: d.title, updated: d.updated, model: d.model };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated - a.updated);
    res.json(list);
  } catch { res.json([]); }
});

app.get('/api/chats/:id', auth, (req, res) => {
  const f = chatFile(req.params.id);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not found' });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
});

app.put('/api/chats/:id', auth, (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9-]/gi, '');
  if (!id) return res.status(400).json({ error: 'invalid id' });
  const data = {
    id,
    title: (req.body.title || 'Untitled').slice(0, 120),
    model: req.body.model || '',
    messages: Array.isArray(req.body.messages) ? req.body.messages : [],
    updated: Date.now(),
  };
  fs.writeFileSync(chatFile(id), JSON.stringify(data));
  res.json(data);
});

app.delete('/api/chats/:id', auth, (req, res) => {
  const f = chatFile(req.params.id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  res.json({ ok: true });
});

// ─── Actions (whitelisted, container-safe via docker.sock) ───────────────
const ACTIONS = {
  'restart-openwebui': 'docker restart openwebui',
  'restart-n8n': 'docker restart n8n',
  'restart-dashboard': 'docker restart dashboard',
  'pull-images': 'docker compose --project-directory /host-stack pull',
  'compose-up': 'docker compose --project-directory /host-stack up -d',
  'compose-down': 'docker compose --project-directory /host-stack down',
};

app.post('/api/action', auth, (req, res) => {
  const cmd = ACTIONS[req.body.action];
  if (!cmd) return res.status(400).json({ error: 'unknown action' });
  exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
    res.json({ ok: !err, stdout, stderr: stderr || (err ? err.message : '') });
  });
});

// ─── Static ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => console.log(`dashboard listening on :${PORT}`));
