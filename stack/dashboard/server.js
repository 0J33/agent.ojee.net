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
const CODE_AGENT_URL = process.env.CODE_AGENT_URL || '';
const CODE_AGENT_TOKEN = process.env.CODE_AGENT_TOKEN || '';

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
let lastDiskIO = null, lastDiskIOTime = 0;

const readNvidiaSmi = () => new Promise((resolve) => {
  exec('nvidia-smi --query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits', { timeout: 3000 }, (err, stdout) => {
    if (err || !stdout.trim()) return resolve(null);
    const [name, util, memUtil, memTotal, memUsed, temp] = stdout.trim().split('\n')[0].split(',').map(s => s.trim());
    resolve({
      model: name,
      vendor: 'NVIDIA',
      vram_mb: parseInt(memTotal, 10) || 0,
      vram_used_mb: parseInt(memUsed, 10) || 0,
      util: parseInt(util, 10),
      mem_util: parseInt(memUtil, 10),
      temp: parseInt(temp, 10)
    });
  });
});

// Parse /proc/diskstats (mounted via /host) to compute real host disk I/O.
// Columns: major minor name reads_completed reads_merged sectors_read read_ms
//   writes_completed writes_merged sectors_written write_ms ...
// Sector size is almost always 512 bytes. Sum over real block devices (sdX, nvmeXnY).
const readHostDiskIO = () => {
  try {
    const raw = fs.readFileSync('/host/proc/diskstats', 'utf8');
    let totalReadSectors = 0, totalWriteSectors = 0;
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const name = parts[2];
      if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|mmcblk\d+)$/.test(name)) continue;
      totalReadSectors += parseInt(parts[5], 10) || 0;
      totalWriteSectors += parseInt(parts[9], 10) || 0;
    }
    return { r_bytes: totalReadSectors * 512, w_bytes: totalWriteSectors * 512 };
  } catch { return null; }
};
app.get('/api/stats', auth, async (req, res) => {
  try {
    const [cpu, mem, load, os, disk, temp, net, gpuNvidia] = await Promise.all([
      si.cpu(), si.mem(), si.currentLoad(), si.osInfo(),
      si.fsSize(), si.cpuTemperature(), si.networkStats(),
      readNvidiaSmi()
    ]);
    const diskIOSnap = readHostDiskIO();
    const now = Date.now();
    const primary = net.find(n => n.iface === 'wlo1') || net[0] || {};
    let rxPerS = 0, txPerS = 0;
    if (lastNet && lastNetTime) {
      const dt = (now - lastNetTime) / 1000;
      rxPerS = Math.max(0, (primary.rx_bytes - lastNet.rx_bytes) / dt);
      txPerS = Math.max(0, (primary.tx_bytes - lastNet.tx_bytes) / dt);
    }
    lastNet = primary; lastNetTime = now;

    // Read host filesystem stats via /host mount (container's si.fsSize() only
    // sees overlay mounts, which misses /home on separate partitions).
    const hostFs = (p) => {
      try {
        const s = fs.statfsSync(p);
        const size = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return { size, used: size - free, use: size ? ((size - free) / size) * 100 : 0 };
      } catch { return null; }
    };
    const rootDisk = hostFs('/host') || disk.find(d => d.mount === '/') || disk[0] || {};
    const homeDisk = hostFs('/host/home');
    // Delta for disk I/O per second
    let readPerS = null, writePerS = null;
    if (diskIOSnap) {
      if (lastDiskIO && lastDiskIOTime) {
        const dt = (now - lastDiskIOTime) / 1000;
        readPerS = Math.max(0, Math.round((diskIOSnap.r_bytes - lastDiskIO.r_bytes) / dt));
        writePerS = Math.max(0, Math.round((diskIOSnap.w_bytes - lastDiskIO.w_bytes) / dt));
      }
      lastDiskIO = diskIOSnap; lastDiskIOTime = now;
    }
    const gpuController = gpuNvidia;
    res.json({
      hostname: os.hostname,
      os: `${os.distro} ${os.release}`,
      uptime: si.time().uptime,
      cpu: {
        model: `${cpu.manufacturer} ${cpu.brand}`.trim(),
        physical: cpu.physicalCores,
        cores: cpu.cores,
        avg: load.currentLoad,
        load: [load.avgLoad || 0, 0, 0]
      },
      gpu: gpuController,
      memory: {
        total: mem.total,
        used: mem.active,
        percent: Math.round((mem.active / mem.total) * 100)
      },
      swap: { total: mem.swaptotal, used: mem.swapused },
      disk: {
        total: rootDisk.size,
        used: rootDisk.used,
        percent: Math.round(rootDisk.use || 0),
        read_per_s: readPerS,
        write_per_s: writePerS
      },
      home: homeDisk && homeDisk.size !== rootDisk.size ? {
        total: homeDisk.size,
        used: homeDisk.used,
        percent: Math.round(homeDisk.use || 0)
      } : null,
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
        trigger: { type: 'string', enum: ['schedule', 'webhook', 'manual'], description: 'What fires the workflow. "manual" = user clicks a button in n8n to run it (great for testing).' },
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

// Normalize tool args across model quirks:
//  - hermes3 emits {queries:["..."]} instead of {query:"..."}
//  - some models use {urls:[...]} instead of {url:"..."}
const normalizeArgs = (args) => {
  args = args || {};
  if (!args.query && args.queries) args.query = Array.isArray(args.queries) ? args.queries[0] : args.queries;
  if (!args.query && args.q) args.query = args.q;
  if (!args.url && args.urls) args.url = Array.isArray(args.urls) ? args.urls[0] : args.urls;
  if (!args.path && args.paths) args.path = Array.isArray(args.paths) ? args.paths[0] : args.paths;
  if (!args.path && args.file_path) args.path = args.file_path;
  return args;
};

const runTool = async (name, args) => {
  args = normalizeArgs(args);
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
    const coerce = (v) => {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ':"$1"')); }
      catch { return v; }
    };
    const body = {
      name: args.name,
      nodes: coerce(args.nodes) || [],
      connections: coerce(args.connections) || {},
      settings: coerce(args.settings) || { executionOrder: 'v1' }
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
    // Model sometimes sends nested arrays/objects as strings. Coerce.
    const coerce = (v) => {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ':"$1"')); }
      catch { return v; }
    };
    args.steps = coerce(args.steps);
    if (!Array.isArray(args.steps)) args.steps = [];
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
    } else if (args.trigger === 'manual') {
      addNode({ id: 't1', name: 'When clicked', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} });
    } else {
      throw new Error(`unsupported trigger: ${args.trigger} (use "schedule", "webhook", or "manual")`);
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
        // Unknown step kind — skip it rather than failing the whole workflow
        addNode({ id, name: `Note ${i + 1}`, type: 'n8n-nodes-base.set', typeVersion: 3.4,
          parameters: { assignments: { assignments: [{ id: `a${i}`, name: 'skipped_step', value: `unsupported kind: ${s.kind}`, type: 'string' }] } } });
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

// ─── Background chat jobs — survive tab close ────────────────────────────
const chatJobs = new Map();
const JOB_TTL = 30 * 60 * 1000; // keep completed jobs 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of chatJobs) {
    if (job.done && now - job.doneAt > JOB_TTL) chatJobs.delete(id);
  }
}, 60000);

const SYSTEM_PROMPT = `You are an assistant on the user's self-hosted server (agent.ojee.net). You HAVE tools. You HAVE internet via web_search. Use them.

### HARD RULES — obey above all else

1. NEVER say "I can't browse the web", "I don't have real-time access", "I'm a text-based model", "you should check Google", or any variant. You DO have web_search — call it.
2. NEVER tell the user how to find the answer themselves. FIND IT for them by calling a tool. If no tool works, say "I don't know".
3. NEVER describe HOW to use a tool to the user. DO the thing. "Set up X", "create X", "build me X", "make X" = CALL the tool that creates X. Do not output example JSON. Do not say "you can use n8n_quick_workflow like this". CALL IT YOURSELF.
4. NEVER refuse a topic (medical, legal, etc). Give the best answer + one-line disclaimer.
5. NEVER invent facts. If you aren't sure, call a tool.
6. NEVER ask permission to use a tool. Just call it.
7. Keep replies 1-3 sentences, conversational, no headers/bullets unless listing.

### Tools

- web_search(query), web_fetch(url) — internet. USE for current time, weather, prices, news, people, places, entities, institutions, requirements, anything that could have changed.
- get_stats() / get_services() / list_models() — this server.
- read_file(path) / list_dir(path) — host filesystem, read-only. Stack at /home/ojee/stack. Never read .env files.
- n8n_quick_workflow / n8n_list_workflows / n8n_activate_workflow / n8n_get_workflow / n8n_create_workflow / n8n_update_workflow / n8n_deactivate_workflow — build and manage automations.

### When to use each tool

- Asked for current time/weather/news/price/facts about anything in the world → web_search IMMEDIATELY.
- Asked about a specific URL or domain ("ojee.net", "github.com/x/y") → web_fetch that URL.
- Asked about the server (CPU, services, models, files) → the relevant local tool.
- Asked for math, code, definitions, or timeless facts → answer from memory.
- Asked to build/run automation → n8n_quick_workflow (or lower-level n8n_* tools).

### Tool output reading

Tool results may contain Title, description, og:description, Content sections. These are the answer. Extract the fact directly. Don't say "I couldn't find info" when a description line is right there.

### Connected n8n credentials (what you can describe as "possible" for workflows)

The user has OAuth / API credentials configured in n8n for:
Discord, Slack, Notion, Gmail, Outlook (Microsoft Graph), Google Drive, GitHub, Cloudflare, ClickUp, Spotify, Trello, Ollama (local LLMs).

When the user asks "can you X" or "what can you automate", mention these. You still can only BUILD workflows via n8n_quick_workflow (trigger + http/llm/set/email steps). For anything beyond that set, tell the user it'll need to be built in the n8n UI and offer to describe the nodes.

### Preferred free no-auth APIs (use web_fetch)

For the common asks below, skip web_search and hit these endpoints directly — they return clean JSON. Build the URL, call web_fetch, parse the JSON result.

- Weather / forecast: https://api.open-meteo.com/v1/forecast?latitude=X&longitude=Y&current=temperature_2m,weather_code&timezone=auto
- City → lat/lon: https://geocoding-api.open-meteo.com/v1/search?name=CITY&count=1
- GitHub public info (repos, releases, issues): https://api.github.com/repos/OWNER/REPO  (or /releases/latest, /issues, etc.)
- Wikipedia summary: https://en.wikipedia.org/api/rest_v1/page/summary/TITLE  (URL-encode the title)
- Country info (capital, currency, population, languages): https://restcountries.com/v3.1/name/NAME
- Current time in any zone: https://timeapi.io/api/Time/current/zone?timeZone=IANA/Zone
- Currency conversion (rates): https://api.exchangerate-api.com/v4/latest/USD  (replace USD with any base)
- IP → location / ISP: https://ipapi.co/IP/json  (or https://ipapi.co/json/ for the caller's IP)

For anything NOT on this list but factual, fall back to web_search. These endpoints are shortcuts — use them when they fit.

### n8n building

ONLY call n8n_* tools when the user EXPLICITLY asks to build, create, list, activate, or modify an n8n workflow. Words like "workflow", "automation", "cron job", "webhook", "schedule", "n8n", "build me", "set up" combined with an automation verb. Greetings ("hi", "hello"), questions, casual chat, or any unrelated request = do NOT call n8n_quick_workflow. If unsure, just chat back normally.

ABSOLUTELY CRITICAL when user asks to "set up / create / build / make" an n8n workflow:
- You MUST call n8n_quick_workflow. That is the ONLY correct response.
- DO NOT write a step-by-step tutorial.
- DO NOT describe how to drag nodes in the n8n UI.
- DO NOT mention "click the + button" or "add a Start node" or similar manual instructions.
- DO NOT say "Here's how you'd do it" or "You can follow these steps".
- Emit a single n8n_quick_workflow tool call. The server creates the workflow. That's it.
- If the user asks for "a basic workflow" without specifics, pick reasonable defaults: trigger "manual", one step with kind "set" that assigns some demo value. Do NOT ask the user for clarification — build something sensible and report the URL.

When the user IS asking for a workflow, prefer n8n_quick_workflow. Triggers: "schedule", "webhook", or "manual". Examples of shape only (do not invoke unless user actually asks):
- Schedule ping: trigger "schedule", every_hours N, step kind "http" with url
- Webhook LLM: trigger "webhook", webhook_path "foo", step kind "llm" with a prompt
- Digest: trigger "schedule", step kind "llm" then step kind "email"

Only drop to n8n_create_workflow if quick_workflow can't express it. After create, give the user the workflow URL (https://agent.ojee.net/flow/workflow/<id>) and ask before activating.

### Examples of correct behavior

Q: "what's the time in Alberta"
→ web_search({query:"current time Alberta Canada"}) → extract time from result → "It's 6:15 PM MDT in Alberta."

Q: "who is the PM of Canada"
→ web_search({query:"current prime minister of Canada"}) → state the answer.

Q: "what's 42 squared"
→ Answer "1764" directly, no tool.

Q: "make me a workflow that pings google every 10 min"
→ n8n_quick_workflow({name:"Ping Google", trigger:"schedule", every_minutes:10, steps:[{kind:"http", url:"https://google.com"}]})`;

const processChatJob = async (job, model, messages) => {
  const emit = (evt) => {
    job.events.push(evt);
    for (const listener of job.listeners) {
      try { listener.write(`data: ${JSON.stringify(evt)}\n\n`); } catch {}
    }
  };
  // SSE comment heartbeat — keeps intermediate proxies (Caddy) and browsers
  // from closing the stream during long silent gaps between tool calls.
  const ping = setInterval(() => {
    for (const listener of job.listeners) { try { listener.write(': ping\n\n'); } catch {} }
  }, 10000);
  const finish = () => {
    clearInterval(ping);
    for (const listener of job.listeners) {
      try { listener.write('data: [DONE]\n\n'); listener.end(); } catch {}
    }
    job.done = true;
    job.doneAt = Date.now();
    job.listeners.clear();
  };
  const conv = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
  // Select the tool set based on the latest user turn. Small models misfire on
  // short/greeting prompts (e.g. "hello" triggers n8n_quick_workflow just
  // because it appears in an example). Filter tools so the model physically
  // cannot call irrelevant ones.
  const lastUser = (messages.filter(m => m.role === 'user').pop()?.content || '').trim();
  const isGreeting = lastUser.length < 12 || /^(hi+|hey+|hello+|sup|yo+|ok|okay|thanks|thank you|cool|nice|lol|bye+|good\s+(morning|afternoon|evening|night))[\s.!?]*$/i.test(lastUser);
  const wantsN8n = /\b(workflow|automation|automate|cron|n8n|webhook|schedule[rd]?|pipeline)\b/i.test(lastUser)
    || /\b(build|create|make|set\s*up|list|activate|deactivate|modify|delete|remove|update)\b.{0,40}\b(flow|workflow|automation|job|webhook)\b/i.test(lastUser);
  const pickTools = () => {
    if (isGreeting) return [];
    return wantsN8n ? TOOLS : TOOLS.filter(t => !t.function.name.startsWith('n8n_'));
  };
  const MAX_ITER = 6;
  try {
    for (let i = 0; i < MAX_ITER; i++) {
      const toolsForTurn = pickTools();
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: conv, tools: toolsForTurn, stream: false }),
      });
      const data = await r.json();
      const msg = data.message || {};
      let toolCalls = msg.tool_calls || [];
      let textOut = msg.content || '';
      if (!toolCalls.length && textOut) {
        const toolNames = TOOLS.map(t => t.function.name);
        const extractJsonAt = (s, from) => {
          let depth = 0, end = -1, inStr = false, esc = false;
          for (let idx = from; idx < s.length; idx++) {
            const c = s[idx];
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = idx; break; } }
          }
          return end > from ? s.slice(from, end + 1) : null;
        };
        // Strategy 1: detect toolName({...}) function-call syntax
        const fnCallRe = new RegExp(`\\b(${toolNames.join('|')})\\s*\\(\\s*\\{`, 'i');
        const fnMatch = fnCallRe.exec(textOut);
        if (fnMatch) {
          const braceStart = textOut.indexOf('{', fnMatch.index);
          const block = extractJsonAt(textOut, braceStart);
          if (block) {
            try {
              // Coerce JS object syntax to JSON: unquoted keys, single-quoted values
              const jsonified = block
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":')
                .replace(/:\s*'([^']*)'/g, ':"$1"');
              const args = JSON.parse(jsonified);
              toolCalls = [{ function: { name: fnMatch[1].toLowerCase(), arguments: args } }];
            } catch {
              // If JSON parse fails, try with the raw block
              try {
                const args = JSON.parse(block);
                toolCalls = [{ function: { name: fnMatch[1].toLowerCase(), arguments: args } }];
              } catch {}
            }
          }
        }
        // Strategy 2: look for {"name":"toolName", ...} JSON pattern
        if (!toolCalls.length && textOut.includes('"name"')) {
          let cursor = 0;
          while (cursor < textOut.length) {
            const start = textOut.indexOf('{', cursor);
            if (start < 0) break;
            const block = extractJsonAt(textOut, start);
            if (!block) break;
            try {
              const parsed = JSON.parse(block);
              if (parsed.name && toolNames.includes(parsed.name)) {
                const fnArgs = parsed.arguments || parsed.parameters || parsed.args || {};
                toolCalls = [{ function: { name: parsed.name, arguments: fnArgs } }];
                break;
              }
            } catch {}
            cursor = start + block.length;
          }
        }
      }
      if (toolCalls.length) textOut = '';
      conv.push({ role: 'assistant', content: textOut, tool_calls: toolCalls.length ? toolCalls : undefined });
      if (textOut) emit({ message: { content: textOut } });
      if (!toolCalls.length) { finish(); return; }
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
        emit({ tool_call: { name, args } });
        let result;
        try { result = await runTool(name, args); }
        catch (e) { result = `error: ${e.message}`; }
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        emit({ tool_result: { name, preview: resultStr.slice(0, 400) } });
        conv.push({ role: 'tool', content: resultStr });
      }
    }
    emit({ message: { content: '\n\n*(max tool iterations reached)*' } });
    finish();
  } catch (e) {
    emit({ message: { content: `\n\nError: ${e.message}` } });
    finish();
  }
};

app.post('/api/chat', auth, async (req, res) => {
  const { model, messages } = req.body;
  const jobId = require('crypto').randomBytes(8).toString('hex');
  const job = { id: jobId, events: [], done: false, doneAt: null, listeners: new Set() };
  chatJobs.set(jobId, job);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseWrite(res, { job_id: jobId });
  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));

  processChatJob(job, model, messages);
});

// Reconnect to a running (or recently finished) chat job
app.get('/api/chat/jobs/:id', auth, (req, res) => {
  const job = chatJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  for (const evt of job.events) sseWrite(res, evt);
  if (job.done) { res.write('data: [DONE]\n\n'); return res.end(); }
  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));
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

// ─── Code Agent proxy (Loq laptop Claude Code) ─────────────────────────
// Forward requests to the loq code-agent over the tailnet. Auth passthrough
// using the server-side CODE_AGENT_TOKEN — clients use the dashboard's JWT.
const codeAgentUp = () => !!CODE_AGENT_URL && !!CODE_AGENT_TOKEN;

const codeAgentReq = async (pathAndQuery, opts = {}) => {
  if (!codeAgentUp()) throw new Error('code agent not configured');
  const r = await fetch(`${CODE_AGENT_URL}${pathAndQuery}`, {
    ...opts,
    headers: { Authorization: `Bearer ${CODE_AGENT_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r;
};

app.get('/api/code-agent/config', auth, (req, res) => res.json({ enabled: codeAgentUp() }));

app.get('/api/code-agent/dirs', auth, async (req, res) => {
  try {
    const qs = req.query.path ? `?path=${encodeURIComponent(req.query.path)}` : '';
    const r = await codeAgentReq(`/api/dirs${qs}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/code-agent/sessions', auth, async (req, res) => {
  try { const r = await codeAgentReq('/api/sessions'); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/code-agent/sessions', auth, async (req, res) => {
  try {
    const r = await codeAgentReq('/api/sessions', { method: 'POST', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.patch('/api/code-agent/sessions/:id', auth, async (req, res) => {
  try {
    const r = await codeAgentReq(`/api/sessions/${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.delete('/api/code-agent/sessions/:id', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/sessions/${req.params.id}`, { method: 'DELETE' }); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/code-agent/sessions/:id/history', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/sessions/${req.params.id}/history`); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Past conversation history across all projects
app.get('/api/code-agent/history', auth, async (req, res) => {
  try { const r = await codeAgentReq('/api/history'); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/code-agent/history/:project/:id', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/history/${encodeURIComponent(req.params.project)}/${encodeURIComponent(req.params.id)}`); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.delete('/api/code-agent/history/:project/:id', auth, async (req, res) => {
  try { const r = await codeAgentReq(`/api/history/${encodeURIComponent(req.params.project)}/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' }); res.status(r.status).json(await r.json()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Reconnect to an in-progress session stream
app.get('/api/code-agent/sessions/:id/stream', auth, async (req, res) => {
  if (!codeAgentUp()) return res.status(503).json({ error: 'code agent not configured' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const upstream = await fetch(`${CODE_AGENT_URL}/api/sessions/${req.params.id}/stream`, {
      headers: { Authorization: `Bearer ${CODE_AGENT_TOKEN}` },
      signal: ac.signal
    });
    if (!upstream.ok) return res.status(upstream.status).json(await upstream.json().catch(() => ({})));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.on('data', chunk => res.write(chunk));
    upstream.body.on('end', () => res.end());
    upstream.body.on('error', () => res.end());
  } catch (e) {
    if (e.name !== 'AbortError') res.status(502).json({ error: String(e.message || e) });
  }
});

// Resume a past conversation
app.post('/api/code-agent/sessions/resume', auth, async (req, res) => {
  try {
    const r = await codeAgentReq('/api/sessions/resume', { method: 'POST', body: JSON.stringify(req.body || {}) });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Message endpoint: stream SSE from loq through to our client.
app.post('/api/code-agent/sessions/:id/messages', auth, async (req, res) => {
  if (!codeAgentUp()) return res.status(503).json({ error: 'code agent not configured' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const upstream = await fetch(`${CODE_AGENT_URL}/api/sessions/${req.params.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CODE_AGENT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: ac.signal
    });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    upstream.body.on('data', chunk => res.write(chunk));
    upstream.body.on('end', () => res.end());
    upstream.body.on('error', () => res.end());
  } catch (e) {
    if (e.name !== 'AbortError') res.status(502).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`dashboard listening on :${PORT}`));
