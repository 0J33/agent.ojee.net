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
// Loq laptop: optional second Ollama instance + a small control HTTP API for
// start/stop. Both default to common tailnet addresses; either can be empty
// to disable the feature.
const LOQ_OLLAMA = process.env.LOQ_OLLAMA_URL || 'http://100.81.241.55:11434';
const LOQ_CONTROL = process.env.LOQ_CONTROL_URL || 'http://100.81.241.55:7779';
const LOQ_CONTROL_TOKEN = process.env.LOQ_CONTROL_TOKEN || '';
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
    name: 'n8n_run_workflow',
    description: 'Execute a workflow once via the n8n CLI inside the n8n container, regardless of trigger type. Returns the CLI exit code, stdout tail, and the latest execution record (id, status, error if any). USE THIS to test/debug a workflow you just built or patched — combine with n8n_get_execution to see node-by-node output and error messages.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  } },
  { type: 'function', function: {
    name: 'n8n_list_executions',
    description: 'List recent executions for a workflow, newest first. Returns [{id, status: success|error|running, startedAt, stoppedAt, mode}]. Use to find an execution id to inspect with n8n_get_execution.',
    parameters: { type: 'object', properties: { workflow_id: { type: 'string' }, limit: { type: 'number', description: 'default 10' } }, required: ['workflow_id'] }
  } },
  { type: 'function', function: {
    name: 'n8n_get_execution',
    description: 'Fetch a single execution including the per-node run data and any error messages. The result has shape { id, status, error?, nodes: { [name]: { error?, output_sample? } } } where output_sample is the first 500 chars of the node\'s JSON output. USE this to see WHY a workflow failed — read the error.message and the failing node\'s sample.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  } },
  { type: 'function', function: {
    name: 'n8n_patch_node',
    description: 'Patch a single node\'s parameters in an existing workflow without rewriting the whole nodes array. Identify the node by id (e.g. "s1") OR by name (e.g. "HTTP 1"). The given parameters are merged shallowly into the node\'s existing parameters. Use this to fix a bad URL, change a Discord message, etc., when n8n_get_workflow shows what to change.',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string' },
        node: { type: 'string', description: 'Node id (e.g. "s1") or name (e.g. "HTTP 1")' },
        parameters: { type: 'object', description: 'Object merged into node.parameters. Pass only the keys you want to change.' }
      },
      required: ['workflow_id', 'node', 'parameters']
    }
  } },
  { type: 'function', function: {
    name: 'n8n_quick_workflow',
    description: 'Build a simple n8n workflow from a high-level description without needing to know n8n schema. PREFER THIS over n8n_create_workflow for anything simple. Pass name, trigger (schedule or webhook), and a list of steps. The server builds valid n8n JSON.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        trigger: { type: 'string', enum: ['schedule', 'webhook', 'manual'], description: 'What fires the workflow. "manual" = user clicks a button in n8n to run it (great for testing).' },
        at_time: { type: 'string', description: 'For schedule: time of day in 24h "HH:MM" form. Server converts to a daily cron. Example: "02:55" = daily at 2:55 AM. PREFER THIS over every_hours when the user says "at HH:MM" or "every day at X". REQUIRES timezone unless the user wants UTC.' },
        cron: { type: 'string', description: 'For schedule: standard 5-field cron expression (min hour day-of-month month day-of-week). Example: "55 2 * * *" = daily at 02:55, "0 9 * * 1-5" = 9am every weekday. Use this for anything more complex than at_time.' },
        every_hours: { type: 'number', description: 'For schedule: interval in hours (e.g. 1 for hourly). Use only for true intervals like "every 4 hours" — NOT for "at 4 AM".' },
        every_minutes: { type: 'number', description: 'For schedule: interval in minutes. Use only for true intervals like "every 15 minutes" — NOT for "at H:55".' },
        timezone: { type: 'string', description: 'IANA timezone name for schedule interpretation, e.g. "Africa/Cairo", "America/New_York", "Europe/London". Without this, at_time/cron run in UTC. ALWAYS set this when the user mentions a city/country/timezone.' },
        webhook_path: { type: 'string', description: 'For webhook: URL path (e.g. "my-hook")' },
        webhook_method: { type: 'string', enum: ['GET', 'POST'], description: 'For webhook: HTTP method, default POST' },
        steps: {
          type: 'array',
          description: 'Ordered list of steps. Each step has a "kind" and kind-specific fields. Built-in kinds always available: http, llm, set, email. Integration kinds (credential-gated, auto-attached): discord, discord_bot, slack, notion, github, clickup, trello, sheets, calendar, docs, drive, outlook. The system prompt lists which integrations are actually configured right now — only use those.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['http', 'llm', 'set', 'email', 'discord', 'discord_bot', 'slack', 'notion', 'github', 'clickup', 'trello', 'sheets', 'calendar', 'docs', 'drive', 'outlook'] },
              url: { type: 'string', description: 'http: target URL' },
              method: { type: 'string', description: 'http: GET/POST/etc, default GET' },
              body: { type: 'string', description: 'http: JSON body string for POST' },
              prompt: { type: 'string', description: 'llm: prompt template (use {{$json.field}} for webhook fields)' },
              model: { type: 'string', description: 'llm: ollama model name, defaults to llama3.1:8b' },
              field: { type: 'string', description: 'set: new field name' },
              value: { type: 'string', description: 'set: new field value' },
              to: { type: 'string', description: 'email/outlook: recipient address' },
              subject: { type: 'string', description: 'email/outlook: subject line' },
              text: { type: 'string', description: 'email: body text (plain)' },
              message: { type: 'string', description: 'discord/discord_bot/slack: message content. Supports n8n expressions like {{$json.field}}.' },
              channel: { type: 'string', description: 'slack: channel name (no # prefix, default "general") OR channel ID starting with C. discord_bot: channel ID' },
              guild: { type: 'string', description: 'discord_bot: guild (server) ID' },
              database: { type: 'string', description: 'notion: database ID (the 32-char UUID from the DB URL)' },
              title: { type: 'string', description: 'notion/github/clickup/trello/calendar/docs/drive: page/issue/card/event/file title' },
              content: { type: 'string', description: 'notion/github/docs/trello/calendar: body/description text' },
              owner: { type: 'string', description: 'github: repo owner (user or org name)' },
              repo: { type: 'string', description: 'github: repo name' },
              operation: { type: 'string', description: 'per-integration operation override (e.g. github: "create"|"get"|"update"; sheets: "append"|"read"; calendar: "create"|"getAll")' },
              list: { type: 'string', description: 'clickup/trello: list ID' },
              document: { type: 'string', description: 'sheets: spreadsheet document ID' },
              tab: { type: 'string', description: 'sheets: sheet tab name, default "Sheet1"' },
              calendar: { type: 'string', description: 'calendar: calendar ID, default "primary"' },
              start: { type: 'string', description: 'calendar: ISO datetime start (e.g. "2026-04-20T10:00:00Z")' },
              end: { type: 'string', description: 'calendar: ISO datetime end' },
              folder: { type: 'string', description: 'drive/docs: parent folder ID, default "root"' },
              body: { type: 'string', description: 'outlook: email body (HTML)' }
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

// ─── n8n integration step kinds ─────────────────────────────────────────
// Each kind maps to the actual n8n node type, version, required credential
// type, a display label, and a params builder. Credentials are looked up at
// runtime via /credentials — integrations without a configured credential
// are filtered out of the advertised set so the model doesn't promise what
// the user can't run.
const rl = (value, mode = 'id') => ({ __rl: true, value: String(value == null ? '' : value), mode });
// Wrap a string in n8n's expression form ('=...') if it contains {{...}} but
// isn't already prefixed. n8n treats parameter values as literal strings
// unless they start with '=' — without this, "{{$json.field}}" arrives at
// Discord verbatim instead of being resolved.
const expr = (v) => {
  if (v == null) return v;
  const s = String(v);
  if (s.startsWith('=')) return s;
  return /\{\{[\s\S]*?\}\}/.test(s) ? '=' + s : s;
};

// `requires` lists fields the user must supply (no sensible default exists).
// Aliases let the model spell the same thing several ways. The validator
// considers a requirement satisfied if any alias is non-empty OR if any
// chained-step n8n expression is used (e.g. {{$json.title}}).
const N8N_INTEGRATIONS = {
  discord: {
    type: 'n8n-nodes-base.discord', version: 2, credType: 'discordWebhookApi', label: 'Discord (webhook)',
    requires: [
      { field: 'message', aliases: ['content', 'text'], hint: 'the text to send to the Discord channel (can use n8n expressions like {{$json.field}})' },
    ],
    params: s => ({
      authentication: 'webhook', resource: 'message',
      content: expr(s.message || s.content || s.text || ''), options: {},
    }),
  },
  discord_bot: {
    type: 'n8n-nodes-base.discord', version: 2, credType: 'discordBotApi', label: 'Discord (bot)',
    requires: [
      { field: 'guild', hint: 'the Discord server (guild) ID — a long numeric string from Server Settings → Widget' },
      { field: 'channel', hint: 'the Discord channel ID (right-click channel → Copy ID; requires Developer Mode)' },
      { field: 'message', aliases: ['content', 'text'], hint: 'the text to send' },
    ],
    params: s => ({
      authentication: 'botToken', resource: 'message',
      guildId: rl(s.guild || '', 'id'), channelId: rl(s.channel || '', 'id'),
      content: expr(s.message || s.content || s.text || ''), options: {},
    }),
  },
  slack: {
    type: 'n8n-nodes-base.slack', version: 2.2, credType: 'slackApi', label: 'Slack',
    requires: [
      { field: 'message', aliases: ['content', 'text'], hint: 'the text to post in Slack' },
    ],
    params: s => {
      const ch = String(s.channel || 'general').replace(/^#/, '');
      return {
        authentication: 'accessToken', resource: 'message', operation: 'post',
        select: 'channel',
        channelId: rl(ch, /^C[A-Z0-9]{6,}$/i.test(ch) ? 'id' : 'name'),
        text: expr(s.message || s.content || s.text || ''), otherOptions: {},
      };
    },
  },
  notion: {
    type: 'n8n-nodes-base.notion', version: 2.2, credType: 'notionApi', label: 'Notion',
    requires: [
      { field: 'database', hint: 'the Notion database UUID — open the database in Notion, copy the URL, the 32-char ID is the database UUID. The database must also be SHARED with the Notion integration in Notion (DB page → Connections → add)' },
      { field: 'title', hint: 'the title of the page to create' },
    ],
    params: s => ({
      resource: 'databasePage', operation: 'create',
      databaseId: rl(s.database || '', 'id'),
      title: expr(s.title || ''), simple: true,
      propertiesUi: { propertyValues: [] },
      blockUi: s.content ? { blockValues: [{ type: 'paragraph', textContent: expr(s.content) }] } : { blockValues: [] },
    }),
  },
  github: {
    type: 'n8n-nodes-base.github', version: 1.1, credType: 'githubApi', label: 'GitHub',
    requires: [
      { field: 'owner', hint: 'GitHub username or org that owns the repo' },
      { field: 'repo', hint: 'GitHub repository name (without owner prefix)' },
      { field: 'title', hint: 'the issue/PR title (only required for create operations)' },
    ],
    params: s => ({
      authentication: 'accessToken',
      resource: s.resource || 'issue', operation: s.operation || 'create',
      owner: rl(s.owner || '', 'name'), repository: rl(s.repo || '', 'name'),
      title: expr(s.title || ''), body: expr(s.content || s.message || s.text || ''),
      labels: [], assignees: [],
    }),
  },
  clickup: {
    type: 'n8n-nodes-base.clickUp', version: 1, credType: 'clickUpApi', label: 'ClickUp',
    requires: [
      { field: 'list', hint: 'the ClickUp list ID — open the list in ClickUp, copy the URL, the trailing number is the list ID' },
      { field: 'title', aliases: ['name'], hint: 'the task name' },
    ],
    params: s => ({
      resource: 'task', operation: s.operation || 'create',
      list: s.list || '', name: expr(s.title || s.name || ''),
      additionalFields: s.content ? { description: expr(s.content) } : {},
    }),
  },
  trello: {
    type: 'n8n-nodes-base.trello', version: 1, credType: 'trelloApi', label: 'Trello',
    requires: [
      { field: 'list', hint: 'the Trello list ID — get it from a Trello list URL or via the Trello API' },
      { field: 'title', aliases: ['name'], hint: 'the card name' },
    ],
    params: s => ({
      resource: 'card', operation: s.operation || 'create',
      listId: s.list || '', name: expr(s.title || s.name || ''), description: expr(s.content || ''),
    }),
  },
  sheets: {
    type: 'n8n-nodes-base.googleSheets', version: 4.5, credType: 'googleSheetsOAuth2Api', label: 'Google Sheets',
    requires: [
      { field: 'document', aliases: ['sheet'], hint: 'the Google Sheets spreadsheet ID — the long string in the URL between /d/ and /edit' },
    ],
    params: s => ({
      resource: 'sheet', operation: s.operation || 'append',
      documentId: rl(s.document || s.sheet || '', 'id'),
      sheetName: rl(s.tab || 'Sheet1', 'name'),
      columns: { mappingMode: 'autoMapInputData', value: {} }, options: {},
    }),
  },
  calendar: {
    type: 'n8n-nodes-base.googleCalendar', version: 1.2, credType: 'googleCalendarOAuth2Api', label: 'Google Calendar',
    requires: [
      { field: 'start', hint: 'event start time as ISO 8601 datetime, e.g. "2026-04-20T10:00:00Z" or "2026-04-20T13:00:00+02:00"' },
      { field: 'title', hint: 'the event title (becomes the calendar entry summary)' },
    ],
    params: s => ({
      resource: 'event', operation: s.operation || 'create',
      calendar: rl(s.calendar || 'primary', 'id'),
      start: expr(s.start || ''), end: expr(s.end || s.start || ''),
      additionalFields: { summary: expr(s.title || 'Event'), description: expr(s.content || '') },
    }),
  },
  docs: {
    type: 'n8n-nodes-base.googleDocs', version: 2, credType: 'googleDocsOAuth2Api', label: 'Google Docs',
    requires: [
      { field: 'title', hint: 'the document title' },
    ],
    params: s => ({
      operation: s.operation || 'create',
      folderId: rl(s.folder || 'root', 'id'),
      title: expr(s.title || 'Untitled'), body: expr(s.content || s.text || ''),
    }),
  },
  drive: {
    type: 'n8n-nodes-base.googleDrive', version: 3, credType: 'googleDriveOAuth2Api', label: 'Google Drive',
    requires: [
      { field: 'title', aliases: ['name'], hint: 'the file name to create (with extension, e.g. "report.txt")' },
    ],
    params: s => ({
      resource: 'file', operation: s.operation || 'upload',
      name: expr(s.title || s.name || 'untitled.txt'),
      driveId: rl('My Drive', 'list'), folderId: rl(s.folder || 'root', 'id'),
    }),
  },
  outlook: {
    type: 'n8n-nodes-base.microsoftOutlook', version: 2, credType: 'microsoftOutlookOAuth2Api', label: 'Outlook (email)',
    requires: [
      { field: 'to', hint: 'the recipient email address' },
      { field: 'subject', hint: 'the email subject line' },
      { field: 'body', aliases: ['text', 'message'], hint: 'the email body (HTML or plain text)' },
    ],
    params: s => ({
      resource: 'message', operation: 'send',
      subject: expr(s.subject || ''), bodyContent: expr(s.body || s.text || s.message || ''),
      bodyContentType: 'html', toRecipients: expr(s.to || ''), additionalFields: {},
    }),
  },
};

// Returns a list of {stepIndex, kind, field, hint} for missing required fields.
// A field counts as present if any alias is set OR if it contains an n8n
// expression ({{ ... }}) — those reference upstream steps and are only
// resolvable at runtime.
const validateSteps = (steps) => {
  const missing = [];
  const isPresent = v => {
    if (v == null) return false;
    const s = String(v).trim();
    return s.length > 0;
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const integ = N8N_INTEGRATIONS[step.kind];
    if (!integ || !integ.requires) continue;
    for (const req of integ.requires) {
      const names = [req.field, ...(req.aliases || [])];
      if (!names.some(n => isPresent(step[n]))) {
        missing.push({ stepIndex: i + 1, kind: step.kind, field: req.field, hint: req.hint });
      }
    }
  }
  return missing;
};

// ─── Runtime credential discovery ───────────────────────────────────────
// Fetches n8n's configured credentials and maps each supported integration
// kind to the credential record (id, name) it will reference. Integrations
// without a configured credential are DROPPED from the result — the system
// prompt and validation both rely on this so the model only sees what can
// actually run.
let _integCache = null;
let _integCacheExp = 0;
const getIntegrations = async () => {
  if (_integCache && Date.now() < _integCacheExp) return _integCache;
  let list = [];
  try {
    const r = await n8nApi('/credentials');
    list = r.data || r || [];
  } catch { /* n8n unreachable — fall through with empty list */ }
  const byType = {};
  for (const c of list) if (!byType[c.type]) byType[c.type] = c;
  const out = {};
  for (const [kind, integ] of Object.entries(N8N_INTEGRATIONS)) {
    const cred = byType[integ.credType];
    if (cred) out[kind] = { ...integ, cred: { id: cred.id, name: cred.name } };
  }
  _integCache = out;
  _integCacheExp = Date.now() + 5 * 60 * 1000;
  return _integCache;
};
const invalidateIntegCache = () => { _integCache = null; _integCacheExp = 0; };

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
  if (name === 'n8n_run_workflow') {
    // n8n's CLI requires an "Execute Workflow Trigger" node. Add one
    // temporarily, run, then clean it up. Works regardless of the workflow's
    // real trigger type (schedule/webhook/manual). Port override avoids
    // colliding with the running n8n's task broker on 5679.
    const id = args.id;
    if (!id) throw new Error('id required');
    const TEMP_ID = '__test_runner__';
    const wf = await n8nApi(`/workflows/${id}`);
    if (wf.nodes.find(n => n.id === TEMP_ID)) {
      // Stale trigger from a prior crash — strip it before re-adding
      wf.nodes = wf.nodes.filter(n => n.id !== TEMP_ID);
      delete wf.connections[TEMP_ID];
    }
    // Find the node downstream of the original trigger so we can connect to it
    const realTrigger = wf.nodes.find(n => /Trigger$|webhook$/i.test(n.type) || n.type.endsWith('manualTrigger'));
    const firstStep = realTrigger && wf.connections[realTrigger.name]
      && wf.connections[realTrigger.name].main && wf.connections[realTrigger.name].main[0]
      && wf.connections[realTrigger.name].main[0][0] && wf.connections[realTrigger.name].main[0][0].node;
    if (!firstStep) {
      throw new Error('Workflow has no downstream node from its trigger to test');
    }
    const tempNode = {
      id: TEMP_ID, name: TEMP_ID,
      type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1,
      position: [50, 100], parameters: {},
    };
    wf.nodes.push(tempNode);
    wf.connections[TEMP_ID] = { main: [[{ node: firstStep, type: 'main', index: 0 }]] };
    const putBody = (w) => JSON.stringify({
      name: w.name, nodes: w.nodes, connections: w.connections,
      settings: w.settings || { executionOrder: 'v1' },
    });
    await n8nApi(`/workflows/${id}`, { method: 'PUT', body: putBody(wf) });

    // Run via CLI
    const runCli = () => new Promise((resolve) => {
      const child = spawn('docker', ['exec',
        '-e', 'N8N_RUNNERS_BROKER_PORT=5689',
        'n8n', 'n8n', 'execute', '--id', id], { timeout: 120000 });
      let out = '', err = '';
      child.stdout.on('data', d => out += d.toString());
      child.stderr.on('data', d => err += d.toString());
      child.on('close', code => resolve({ code, out, err }));
      child.on('error', e => resolve({ code: -1, out: '', err: e.message }));
    });
    let r;
    try {
      r = await runCli();
    } finally {
      // Always clean up the temp trigger
      try {
        const wf2 = await n8nApi(`/workflows/${id}`);
        wf2.nodes = wf2.nodes.filter(n => n.id !== TEMP_ID);
        delete wf2.connections[TEMP_ID];
        await n8nApi(`/workflows/${id}`, { method: 'PUT', body: putBody(wf2) });
      } catch {}
    }
    // Summarize the latest execution
    let latest = null;
    try {
      const exr = await n8nApi(`/executions?workflowId=${id}&limit=1&includeData=true`);
      const list = exr.data || exr || [];
      if (list.length) {
        const ex = list[0];
        const rd = ex.data && ex.data.resultData;
        const errMsg = rd && rd.error ? String(rd.error.message || rd.error).slice(0, 400) : null;
        const errNode = rd && rd.error && rd.error.node ? rd.error.node.name : null;
        latest = { id: ex.id, status: ex.status, finished: ex.finished, mode: ex.mode,
                   stoppedAt: ex.stoppedAt, error: errMsg, error_node: errNode };
      }
    } catch {}
    return {
      cli_exit: r.code,
      cli_output: ((r.out || '') + (r.err ? '\n' + r.err : '')).slice(-1200),
      latest_execution: latest,
    };
  }
  if (name === 'n8n_list_executions') {
    if (!args.workflow_id) throw new Error('workflow_id required');
    const limit = args.limit || 10;
    const r = await n8nApi(`/executions?workflowId=${encodeURIComponent(args.workflow_id)}&limit=${limit}`);
    const list = r.data || r || [];
    return list.map(e => ({
      id: e.id, status: e.status, finished: e.finished, mode: e.mode,
      startedAt: e.startedAt, stoppedAt: e.stoppedAt,
    }));
  }
  if (name === 'n8n_get_execution') {
    if (!args.id) throw new Error('id required');
    const ex = await n8nApi(`/executions/${args.id}?includeData=true`);
    const rd = ex.data && ex.data.resultData;
    const out = {
      id: ex.id, status: ex.status, finished: ex.finished, mode: ex.mode,
      startedAt: ex.startedAt, stoppedAt: ex.stoppedAt,
      workflowId: ex.workflowId,
      error: null, error_node: null,
      nodes: {},
    };
    if (rd && rd.error) {
      out.error = String(rd.error.message || rd.error).slice(0, 500);
      out.error_node = rd.error.node && rd.error.node.name;
    }
    if (rd && rd.runData) {
      for (const [name, runs] of Object.entries(rd.runData)) {
        const run = runs[0];
        if (!run) continue;
        const node = { error: null, output_sample: null };
        if (run.error) node.error = String(run.error.message || run.error).slice(0, 400);
        const items = run.data && run.data.main && run.data.main[0];
        if (items && items.length) {
          const sample = items[0].json !== undefined ? items[0].json : items[0];
          try { node.output_sample = JSON.stringify(sample).slice(0, 500); } catch {}
        }
        out.nodes[name] = node;
      }
    }
    return out;
  }
  if (name === 'n8n_patch_node') {
    if (!args.workflow_id || !args.node || !args.parameters) {
      throw new Error('workflow_id, node, and parameters are required');
    }
    const wf = await n8nApi(`/workflows/${args.workflow_id}`);
    const target = String(args.node);
    const node = wf.nodes.find(n => n.id === target || n.name === target);
    if (!node) {
      throw new Error(`node "${args.node}" not found. Available: ${wf.nodes.map(n => `${n.id} (${n.name})`).join(', ')}`);
    }
    node.parameters = { ...(node.parameters || {}), ...args.parameters };
    const body = {
      name: wf.name, nodes: wf.nodes, connections: wf.connections,
      settings: wf.settings || { executionOrder: 'v1' },
    };
    await n8nApi(`/workflows/${args.workflow_id}`, { method: 'PUT', body: JSON.stringify(body) });
    return { ok: true, patched_node: { id: node.id, name: node.name }, parameters: node.parameters };
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
    // Preflight: are required fields per integration step actually filled?
    // Returning a structured tool result lets the model ask the user instead
    // of building a workflow that will fail at runtime.
    const missing = validateSteps(args.steps);
    if (missing.length) {
      const lines = missing.map(m => `  • step ${m.stepIndex} (${m.kind}) — "${m.field}": ${m.hint}`).join('\n');
      return {
        status: 'MISSING_INFO',
        missing,
        message: `Cannot build workflow "${args.name || 'untitled'}" yet. The following required fields are missing:\n${lines}\n\nAsk the user to provide these, then call n8n_quick_workflow again with the same args plus the new values. Do NOT invent placeholder IDs.`,
      };
    }
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
      // Priority: at_time > cron > every_minutes > every_hours
      let interval;
      if (args.at_time) {
        const m = String(args.at_time).match(/^(\d{1,2}):(\d{2})$/);
        if (!m) throw new Error(`at_time must be "HH:MM" 24-hour format (e.g. "02:55"), got "${args.at_time}"`);
        const hour = parseInt(m[1], 10), minute = parseInt(m[2], 10);
        if (hour > 23 || minute > 59) throw new Error(`at_time "${args.at_time}" is out of range`);
        interval = { field: 'cronExpression', expression: `${minute} ${hour} * * *` };
      } else if (args.cron) {
        interval = { field: 'cronExpression', expression: String(args.cron) };
      } else if (args.every_minutes) {
        interval = { field: 'minutes', minutesInterval: args.every_minutes };
      } else {
        interval = { field: 'hours', hoursInterval: args.every_hours || 1 };
      }
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
    const steps = args.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const id = `s${i + 1}`;
      if (s.kind === 'http') {
        const params = { method: s.method || 'GET', url: expr(s.url), options: {} };
        if (s.body) { params.sendBody = true; params.contentType = 'json'; params.jsonBody = expr(s.body); }
        addNode({ id, name: `HTTP ${i + 1}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: params });
      } else if (s.kind === 'llm') {
        // The prompt may contain {{$json.x}} expressions that must be
        // resolved when n8n builds the request body, not at template time.
        // We pass jsonBody as an n8n expression so it resolves per-execution.
        const promptExpr = expr(s.prompt || '');
        const isExprPrompt = typeof promptExpr === 'string' && promptExpr.startsWith('=');
        const jsonBody = isExprPrompt
          ? `={{ JSON.stringify({ model: ${JSON.stringify(s.model || 'llama3.1:8b')}, prompt: ${promptExpr.slice(1)}, stream: false }) }}`
          : JSON.stringify({ model: s.model || 'llama3.1:8b', prompt: s.prompt || '', stream: false });
        addNode({ id, name: `LLM ${i + 1}`, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
          parameters: {
            method: 'POST', url: 'http://host.docker.internal:11434/api/generate', options: {},
            sendBody: true, contentType: 'json', jsonBody,
          } });
      } else if (s.kind === 'set') {
        addNode({ id, name: `Set ${i + 1}`, type: 'n8n-nodes-base.set', typeVersion: 3.4,
          parameters: { assignments: { assignments: [{ id: `a${i}`, name: s.field, value: expr(s.value), type: 'string' }] } } });
      } else if (N8N_INTEGRATIONS[s.kind]) {
        const integs = await getIntegrations();
        const integ = integs[s.kind];
        if (!integ) {
          const spec = N8N_INTEGRATIONS[s.kind];
          throw new Error(
            `Step kind "${s.kind}" needs a "${spec.credType}" credential in n8n, but none is configured. ` +
            `Either add that credential in n8n Settings, or pick a different step kind. ` +
            `Available kinds right now: ${Object.keys(integs).join(', ') || '(none configured)'}.`
          );
        }
        const node = {
          id,
          name: `${integ.label} ${i + 1}`,
          type: integ.type,
          typeVersion: integ.version,
          parameters: integ.params(s),
          credentials: { [integ.credType]: { id: integ.cred.id, name: integ.cred.name } },
        };
        addNode(node);
      } else if (s.kind === 'email') {
        addNode({ id, name: `Email ${i + 1}`, type: 'n8n-nodes-base.emailSend', typeVersion: 2.1,
          parameters: { toEmail: expr(s.to), subject: expr(s.subject), text: expr(s.text), options: {} } });
      } else {
        // Unknown step kind — skip it rather than failing the whole workflow
        addNode({ id, name: `Note ${i + 1}`, type: 'n8n-nodes-base.set', typeVersion: 3.4,
          parameters: { assignments: { assignments: [{ id: `a${i}`, name: 'skipped_step', value: `unsupported kind: ${s.kind}`, type: 'string' }] } } });
      }
    }
    const r = await n8nApi('/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: args.name, nodes, connections,
        settings: {
          executionOrder: 'v1',
          ...(args.timezone ? { timezone: String(args.timezone) } : {}),
        },
      })
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

// ─── System prompt ─────────────────────────────────────────────────────
// Built per-request from the live set of configured n8n credentials so the
// model only advertises integrations it can actually run. Recipes are full
// worked JSON so small local models can pattern-match.
// Each recipe lists fields as [REQ] (must come from the user; the server
// will reject the call with MISSING_INFO if absent) or [OPT] (server has a
// sensible default). Local models pattern-match best when the required vs
// optional contract is explicit.
const INTEG_RECIPES = {
  discord: `- discord — post to Discord via webhook (SIMPLEST default for Discord):
    { kind: "discord", message: "Hello" }
  Required: message [REQ] (text or n8n expression like "{{$json.current.temperature_2m}}°C")
  The webhook URL is in the credential — never ask the user for it.`,
  discord_bot: `- discord_bot — post via Discord bot:
    { kind: "discord_bot", guild: "SERVER_ID", channel: "CHANNEL_ID", message: "..." }
  Required: guild [REQ], channel [REQ] (Discord IDs — long numbers, get via right-click → Copy ID with Developer Mode on), message [REQ]`,
  slack: `- slack — post to a Slack channel:
    { kind: "slack", channel: "general", message: "Deploy finished" }
  Required: message [REQ]   Optional: channel [OPT, default "general", no "#" prefix; can be channel name or ID starting with "C"]`,
  notion: `- notion — create a page in a Notion database:
    { kind: "notion", database: "DATABASE_UUID", title: "Page title", content: "Body" }
  Required: database [REQ] (32-char UUID from DB URL — DB must be SHARED with the Notion integration via DB → Connections), title [REQ]
  Optional: content [OPT]`,
  github: `- github — create an issue (default):
    { kind: "github", owner: "0J33", repo: "agent.ojee.net", title: "Bug X", content: "Repro..." }
  Required: owner [REQ], repo [REQ], title [REQ]
  Optional: content [OPT, becomes issue body], operation [OPT, default "create"], resource [OPT, default "issue"]`,
  clickup: `- clickup — create a task:
    { kind: "clickup", list: "LIST_ID", title: "Task name", content: "Description" }
  Required: list [REQ] (numeric list ID from list URL), title [REQ]
  Optional: content [OPT, becomes task description]`,
  trello: `- trello — create a card:
    { kind: "trello", list: "LIST_ID", title: "Card name", content: "Description" }
  Required: list [REQ] (Trello list ID), title [REQ]
  Optional: content [OPT, card description]`,
  sheets: `- sheets — append a row to a Google Sheet (auto-maps previous step fields to columns):
    { kind: "sheets", document: "SPREADSHEET_ID", tab: "Sheet1" }
  Required: document [REQ] (long ID between /d/ and /edit in sheet URL)
  Optional: tab [OPT, default "Sheet1"], operation [OPT, default "append"]`,
  calendar: `- calendar — create a Google Calendar event:
    { kind: "calendar", start: "2026-04-20T10:00:00Z", end: "2026-04-20T11:00:00Z", title: "Meeting", content: "Agenda" }
  Required: start [REQ] (ISO 8601 datetime), title [REQ]
  Optional: end [OPT, defaults to start], calendar [OPT, default "primary"], content [OPT, becomes description]`,
  docs: `- docs — create a Google Doc:
    { kind: "docs", title: "Weekly notes", content: "# Monday..." }
  Required: title [REQ]   Optional: content [OPT], folder [OPT, default "root"]`,
  drive: `- drive — create/upload a file:
    { kind: "drive", title: "report.txt" }
  Required: title [REQ] (with extension)   Optional: folder [OPT, default "root"]`,
  outlook: `- outlook — send an email via Outlook:
    { kind: "outlook", to: "user@example.com", subject: "Subject", body: "<p>HTML body</p>" }
  Required: to [REQ], subject [REQ], body [REQ]`,
};

const INTEG_SUMMARY = {
  discord: 'Discord (webhook)', discord_bot: 'Discord (bot)', slack: 'Slack',
  notion: 'Notion', github: 'GitHub', clickup: 'ClickUp', trello: 'Trello',
  sheets: 'Google Sheets', calendar: 'Google Calendar', docs: 'Google Docs',
  drive: 'Google Drive', outlook: 'Outlook (email)',
};

const buildSystemPrompt = async () => {
  let integs = {};
  try { integs = await getIntegrations(); } catch {}
  const availKinds = Object.keys(integs);
  const availList = availKinds.length
    ? availKinds.map(k => `${k} (${INTEG_SUMMARY[k] || k})`).join(', ')
    : '(none — n8n has no credentials configured)';
  const availRecipes = availKinds.map(k => INTEG_RECIPES[k]).filter(Boolean).join('\n\n');
  const missingKinds = Object.keys(INTEG_RECIPES).filter(k => !integs[k]);
  const missingList = missingKinds.length ? missingKinds.join(', ') : '(none)';

  return `You are an assistant on the user's self-hosted server (agent.ojee.net). You HAVE tools. You HAVE internet via web_search. Use them.

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
- n8n_run_workflow / n8n_list_executions / n8n_get_execution / n8n_patch_node — TEST and DEBUG and EDIT workflows. After building or modifying a workflow, you can verify it works without asking the user to click anything in n8n.

### When to use each tool

- Asked for current time/weather/news/price/facts about anything in the world → web_search IMMEDIATELY.
- Asked about a specific URL or domain ("ojee.net", "github.com/x/y") → web_fetch that URL.
- Asked about the server (CPU, services, models, files) → the relevant local tool.
- Asked for math, code, definitions, or timeless facts → answer from memory.
- Asked to build/run automation → n8n_quick_workflow (or lower-level n8n_* tools).

### Tool output reading

Tool results may contain Title, description, og:description, Content sections. These are the answer. Extract the fact directly. Don't say "I couldn't find info" when a description line is right there.

### Preferred free no-auth APIs (use web_fetch — and use these same URLs inside http steps in workflows)

For the common asks below, skip web_search and hit these endpoints directly — they return clean JSON, require no keys, work from Egypt, and are great building blocks inside n8n http steps.

Weather & places
- Weather / forecast: https://api.open-meteo.com/v1/forecast?latitude=X&longitude=Y&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto
- City → lat/lon: https://geocoding-api.open-meteo.com/v1/search?name=CITY&count=1
- Country info: https://restcountries.com/v3.1/name/NAME
- IP → location/ISP: https://ipapi.co/IP/json  (or https://ipapi.co/json/ for the caller's IP)
- Public IP: https://api.ipify.org?format=json

Time & money
- Current time in any zone: https://timeapi.io/api/Time/current/zone?timeZone=IANA/Zone
- World clock / convert: https://timeapi.io/api/Conversion/ConvertTimeZone
- Currency rates: https://api.exchangerate-api.com/v4/latest/USD  (replace USD with any base)
- Crypto prices: https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd
- Public holidays: https://date.nager.at/api/v3/PublicHolidays/2026/US  (change year and country code)

Knowledge & reference
- Wikipedia summary: https://en.wikipedia.org/api/rest_v1/page/summary/TITLE  (URL-encode)
- Dictionary / definitions: https://api.dictionaryapi.dev/api/v2/entries/en/WORD
- GitHub public info: https://api.github.com/repos/OWNER/REPO  (or /releases/latest, /issues, /contributors)
- HN top stories: https://hacker-news.firebaseio.com/v0/topstories.json  (then /item/<id>.json)
- Reddit (JSON): https://www.reddit.com/r/SUB/hot.json?limit=10
- xkcd: https://xkcd.com/info.0.json (latest) or https://xkcd.com/NUM/info.0.json

Fun / content
- Random joke: https://official-joke-api.appspot.com/random_joke
- Dad joke (Accept: application/json): https://icanhazdadjoke.com
- Chuck Norris: https://api.chucknorris.io/jokes/random
- Random useless fact: https://uselessfacts.jsph.pl/api/v2/facts/random
- Advice: https://api.adviceslip.com/advice
- Activity idea when bored: https://bored-api.appbrewery.com/random
- Random quote: https://zenquotes.io/api/random
- Trivia (amount 1-50): https://opentdb.com/api.php?amount=5&type=multiple
- Cat fact: https://catfact.ninja/fact   ·   Cat image: https://api.thecatapi.com/v1/images/search
- Dog image: https://dog.ceo/api/breeds/image/random
- Random user profile: https://randomuser.me/api/
- Pokémon: https://pokeapi.co/api/v2/pokemon/NAME_OR_ID
- Meal recipe (random): https://www.themealdb.com/api/json/v1/1/random.php   ·   Cocktail: https://www.thecocktaildb.com/api/json/v1/1/random.php

Science & space
- People in space right now: http://api.open-notify.org/astros.json
- ISS location: http://api.open-notify.org/iss-now.json
- NASA APOD: https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY  (DEMO_KEY is rate-limited but works)
- SpaceX latest launch: https://api.spacexdata.com/v5/launches/latest

Name inference (fun demos)
- Guess age from name: https://api.agify.io/?name=NAME
- Guess gender: https://api.genderize.io/?name=NAME
- Guess nationality: https://api.nationalize.io/?name=NAME

For anything NOT on this list but factual, fall back to web_search. These endpoints are the go-to building blocks for http steps in workflows — chain them with discord/slack/sheets/notion to build useful automations without any key setup.

### n8n workflows — how to build them

ONLY call n8n_* tools when the user EXPLICITLY asks to build, create, list, activate, or modify a workflow. Words like "workflow", "automation", "cron job", "webhook", "schedule", "n8n", "build me", "set up" with an automation verb. Greetings, questions, chat = do NOT call n8n_quick_workflow.

When the user DOES ask for a workflow:
- CALL n8n_quick_workflow directly. Do NOT describe steps, do NOT write a tutorial, do NOT show example JSON in text — the tool call IS the answer.
- Credentials are ALREADY attached by the server. NEVER ask the user for API keys, webhook URLs, bot tokens, OAuth logins, or IDs that aren't specific to their task.
- If the user doesn't specify details ("make a basic workflow"), pick sensible defaults (trigger "manual", one "set" step with a demo value) and build it — do NOT ask for clarification.
- After building, TEST THE WORKFLOW (see "Test + debug" below) before reporting it as done.
- Report the URL: https://agent.ojee.net/flow/workflow/<id> — and ask before activating.

### Test + debug + fix loop (REQUIRED after building or modifying a workflow)

1. Run it: n8n_run_workflow({ id }) — executes once via the n8n CLI regardless of trigger type. Returns latest_execution with status (success|error) plus an error summary if it failed.
2. If status is "error": n8n_get_execution({ id: latest_execution.id }) to see node-by-node errors and a sample of each node's output. Read the failing node's error message and look at upstream nodes' output_sample to understand what data was actually flowing.
3. Fix the bad node: n8n_patch_node({ workflow_id, node, parameters }) — pass ONLY the changed parameter keys; they get merged into the existing node parameters. Identify the node by its id (e.g. "s1") or its name (e.g. "HTTP 1") from n8n_get_workflow.
4. Re-run with n8n_run_workflow. Repeat steps 2-4 (max ~3 iterations) until status is "success".
5. Then tell the user the workflow works and give them the URL.

Common failures and fixes:
- HTTP 404 / "resource you are requesting could not be found" → the URL is wrong. Use the open-meteo/dictionary/etc. URLs from the free-APIs section. NEVER use weather.com/openweathermap.com — both return HTML (or are paid). Open-meteo is the only correct free weather source.
- Discord/Slack message shows "{{$json.body}}" literally → you used the wrong field path. Check the http step's output_sample to find the real field (e.g. {{$json.current.temperature_2m}} for open-meteo).
- "Cannot read properties of undefined" → the upstream step didn't produce that field. Look at output_sample to see what fields exist.

### Triggers

- schedule — runs on a cron / interval. Pick ONE of these (in priority order):
    • at_time: "HH:MM"  →  daily at that wall-clock time. PREFER for "at 2:55 AM", "every day at 9", "morning at 7".
    • cron: "min hr dom mon dow"  →  any cron pattern. Use for weekdays-only ("0 9 * * 1-5") or non-daily.
    • every_minutes: N  →  fires every N minutes from activation. Use ONLY for true intervals like "every 15 minutes".
    • every_hours: N    →  fires every N hours from activation. Use ONLY for true intervals like "every 4 hours".
  ALWAYS set timezone (IANA name like "Africa/Cairo", "America/New_York") whenever the user mentions a city or country, otherwise the schedule fires in UTC.
- webhook — fires on HTTP request to /webhook/<path>. Fields: webhook_path, webhook_method.
- manual — user clicks "Execute Workflow" in n8n (great for testing).

Schedule examples:
- "remind me at 2:55 AM Cairo time daily" → trigger:"schedule", at_time:"02:55", timezone:"Africa/Cairo"
- "every weekday at 9 AM in NYC" → trigger:"schedule", cron:"0 9 * * 1-5", timezone:"America/New_York"
- "ping a URL every 15 minutes" → trigger:"schedule", every_minutes:15  (no time-of-day, no timezone needed)

### Always-available step kinds (no credentials needed)

- http — call any URL. { kind: "http", url: "https://...", method: "GET"|"POST", body: "{...}" }
- llm — run a local Ollama model. { kind: "llm", prompt: "...", model: "llama3.1:8b" }
- set — assign a field. { kind: "set", field: "note", value: "hello" }
- email — send via the stack's default SMTP. { kind: "email", to: "...", subject: "...", text: "..." }

### Configured n8n integrations — USE ONLY THESE integration kinds

Available right now: ${availList}
NOT available (do not use, their credential isn't set up): ${missingList}

${availRecipes || '(No integrations currently configured. Use http/llm/set/email only, or tell the user to add credentials in n8n.)'}

### Integration rules

- NEVER use an integration kind that isn't in the "Available right now" list. If the user asks for one that isn't available, say so and offer http as a fallback.
- NEVER put a webhook URL, API key, or bot token in a step's fields. Those live in the credential — the server attaches them automatically.
- NEVER invent a placeholder ID (e.g. "DATABASE_UUID", "LIST_ID", "SPREADSHEET_ID", "0", "abc123"). If the user did NOT give you a real ID for a [REQ] field, ASK before calling the tool.
- Use n8n expressions to chain steps: {{$json.fieldName}} references the previous step's output. For weather, http to open-meteo produces {{$json.current.temperature_2m}}.
- For Discord, prefer "discord" (webhook) unless the user specifically says "via the bot".

### Asking for missing info

Before calling n8n_quick_workflow, scan each step against its recipe. If any [REQ] field for an integration step isn't supplied by the user (and you don't have a default), ASK the user one consolidated question listing everything you need:

  "Before I build this, I need: 1) the Notion database ID, 2) the page title — what should I use?"

If you skip the check and call the tool with missing fields, the server returns:
  { status: "MISSING_INFO", missing: [{stepIndex, kind, field, hint}, ...], message: "..." }

When you receive that, do NOT retry with placeholders. Read the missing list, ask the user for those exact fields in plain words (use the hints), and retry only after they answer.

### Full worked examples (follow this shape exactly)

Q: "ping google every 10 min"
→ n8n_quick_workflow({
    name: "Ping Google",
    trigger: "schedule", every_minutes: 10,
    steps: [{ kind: "http", url: "https://google.com" }]
  })

Q: "send me a discord message with Cairo's weather every day"
→ n8n_quick_workflow({
    name: "Daily Cairo Weather",
    trigger: "schedule", every_hours: 24,
    steps: [
      { kind: "http", url: "https://api.open-meteo.com/v1/forecast?latitude=30.03&longitude=31.24&current=temperature_2m,weather_code&timezone=auto" },
      { kind: "discord", message: "Cairo today: {{$json.current.temperature_2m}}°C, code {{$json.current.weather_code}}" }
    ]
  })

Q: "notify slack #deploys when a webhook fires"
→ n8n_quick_workflow({
    name: "Deploy Ping → Slack",
    trigger: "webhook", webhook_path: "deploy-ping",
    steps: [{ kind: "slack", channel: "deploys", message: "Deploy webhook received: {{$json.body.ref}}" }]
  })

Q: "log every webhook hit to a google sheet"
→ n8n_quick_workflow({
    name: "Webhook → Sheet Log",
    trigger: "webhook", webhook_path: "log",
    steps: [{ kind: "sheets", document: "SHEET_ID_HERE", tab: "Log" }]
  })

Q: "create a notion page summarizing daily news"
→ n8n_quick_workflow({
    name: "Daily News → Notion",
    trigger: "schedule", every_hours: 24,
    steps: [
      { kind: "http", url: "https://hacker-news.firebaseio.com/v0/topstories.json" },
      { kind: "llm", prompt: "Summarize these HN IDs in 3 bullets: {{$json}}" },
      { kind: "notion", database: "DB_UUID_HERE", title: "News {{$now}}", content: "{{$json.response}}" }
    ]
  })

### Examples of non-workflow behavior

Q: "what's the time in Alberta"
→ web_search({query:"current time Alberta Canada"}) → extract time → "It's 6:15 PM MDT in Alberta."

Q: "what's 42 squared"
→ "1764" directly, no tool.`;
};

const processChatJob = async (job, model, messages, ollamaUrl = OLLAMA, opts = {}) => {
  // opts.systemPrompt — override the default ~5K-token system prompt.
  // opts.noTools       — skip tool injection and text-based tool detection.
  // Loq runs on CPU (GPU isn't accessible to Ollama).  The full system
  // prompt takes ~40 min of prompt-eval on CPU, so Loq passes a tiny
  // prompt and noTools:true for fast responses.
  const numCtx = opts.numCtx || 16384;
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
  const sysContent = opts.systemPrompt != null ? opts.systemPrompt : await buildSystemPrompt();
  const conv = sysContent
    ? [{ role: 'system', content: sysContent }, ...messages]
    : [...messages];
  // Select the tool set based on the latest user turn. Small models misfire on
  // short/greeting prompts (e.g. "hello" triggers n8n_quick_workflow just
  // because it appears in an example). Filter tools so the model physically
  // cannot call irrelevant ones.
  const lastUser = (messages.filter(m => m.role === 'user').pop()?.content || '').trim();
  const isGreeting = lastUser.length < 12 || /^(hi+|hey+|hello+|sup|yo+|ok|okay|thanks|thank you|cool|nice|lol|bye+|good\s+(morning|afternoon|evening|night))[\s.!?]*$/i.test(lastUser);
  // Check the ENTIRE conversation for n8n context, not just the last message.
  // Follow-ups like "Activate it" or "Fix it" don't contain n8n keywords
  // but the conversation is clearly about n8n workflows.
  const n8nRe = /\b(workflow|automation|automate|cron|n8n|webhook|schedule[rd]?|pipeline)\b/i;
  const n8nActionRe = /\b(build|create|make|set\s*up|list|activate|deactivate|modify|delete|remove|update)\b.{0,40}\b(flow|workflow|automation|job|webhook)\b/i;
  const allText = messages.map(m => m.content || '').join(' ');
  const wantsN8n = n8nRe.test(lastUser) || n8nActionRe.test(lastUser) || n8nRe.test(allText);
  const pickTools = () => {
    if (opts.noTools) return [];
    if (isGreeting) return [];
    let pool = wantsN8n ? TOOLS : TOOLS.filter(t => !t.function.name.startsWith('n8n_'));
    if (opts.allowedTools) pool = pool.filter(t => opts.allowedTools.includes(t.function.name));
    return pool;
  };
  const MAX_ITER = 6;
  const OLLAMA_TIMEOUT = opts.timeoutMs || 180_000; // 3 min per Ollama turn
  try {
    for (let i = 0; i < MAX_ITER; i++) {
      const toolsForTurn = pickTools();
      const ac = AbortController && new AbortController();
      const timer = ac && setTimeout(() => ac.abort(), OLLAMA_TIMEOUT);
      let textOut = '';
      let toolCalls = [];
      try {
        const r = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, messages: conv, tools: toolsForTurn, stream: true,
            options: {
              num_ctx: numCtx,
              ...(opts.numGpu != null ? { num_gpu: opts.numGpu } : {}),
              ...(opts.numBatch != null ? { num_batch: opts.numBatch } : {}),
            },
          }),
          ...(ac ? { signal: ac.signal } : {}),
        });
        // Parse Ollama NDJSON stream — emit content in real-time so the user
        // sees tokens as they arrive instead of waiting for the full response.
        let buf = '';
        for await (const chunk of r.body) {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const d = JSON.parse(line);
              if (d.message?.content) {
                emit({ message: { content: d.message.content } });
                textOut += d.message.content;
              }
              if (d.message?.tool_calls?.length) toolCalls = d.message.tool_calls;
            } catch {}
          }
        }
        if (buf.trim()) {
          try {
            const d = JSON.parse(buf);
            if (d.message?.content) {
              emit({ message: { content: d.message.content } });
              textOut += d.message.content;
            }
            if (d.message?.tool_calls?.length) toolCalls = d.message.tool_calls;
          } catch {}
        }
      } finally { clearTimeout(timer); }
      if (!opts.noTools && !toolCalls.length && textOut) {
        // Limit the text-based detector to a whitelist when provided.
        // Without this, a small model that hallucinates an n8n_* call
        // would trigger silent server-side execution even when the
        // system prompt never taught it those tools.
        const toolNames = opts.textToolAllow
          ? opts.textToolAllow
          : TOOLS.map(t => t.function.name);
        // Repair common JSON issues from model output
        const repairJson = (s) => {
          s = s.replace(/:\s*([A-Z_][A-Z0-9_]{2,})\s*([,}\]])/gi, ':"$1"$2'); // unquoted values
          s = s.replace(/,\s*([}\]])/g, '$1'); // trailing commas
          return s;
        };
        const tryParse = (s) => {
          try { return JSON.parse(s); } catch {}
          try { return JSON.parse(repairJson(s)); } catch {}
          // Coerce JS syntax (unquoted keys, single-quoted values)
          try {
            return JSON.parse(s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":').replace(/:\s*'([^']*)'/g, ':"$1"'));
          } catch {}
          return null;
        };
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
            const args = tryParse(block);
            if (args) toolCalls = [{ function: { name: fnMatch[1].toLowerCase(), arguments: args } }];
          }
        }
        // Strategy 2: look for {"name":"toolName", ...} JSON pattern
        if (!toolCalls.length && textOut.includes('"name"')) {
          // Deduplicate: model sometimes outputs same JSON block twice concatenated
          const half = Math.floor(textOut.length / 2);
          if (textOut.length > 40 && textOut.slice(0, half) === textOut.slice(half)) {
            textOut = textOut.slice(0, half);
          }
          let cursor = 0;
          while (cursor < textOut.length) {
            const start = textOut.indexOf('{', cursor);
            if (start < 0) break;
            let block = extractJsonAt(textOut, start);
            // Repair: if extractJsonAt returns null, the model likely forgot
            // closing braces.  Try appending up to 3 '}' to close the object.
            if (!block) {
              const tail = textOut.slice(start);
              for (let extra = 1; extra <= 3; extra++) {
                const attempt = tail + '}'.repeat(extra);
                if (tryParse(attempt)) { block = attempt; break; }
              }
              if (!block) break;
            }
            const parsed = tryParse(block);
            if (parsed && parsed.name && toolNames.includes(parsed.name)) {
              const fnArgs = parsed.arguments || parsed.parameters || parsed.args || {};
              toolCalls = [{ function: { name: parsed.name, arguments: fnArgs } }];
              break;
            }
            cursor = start + block.length;
          }
        }
        // Strategy 3: regex fallback — model mentioned a tool name but JSON extraction failed
        if (!toolCalls.length) {
          const nameRe = new RegExp(`["']?(${toolNames.join('|')})["']?`, 'i');
          const nm = nameRe.exec(textOut);
          if (nm) {
            const afterName = textOut.slice(nm.index);
            const braceIdx = afterName.indexOf('{');
            if (braceIdx !== -1) {
              let tail = afterName.slice(braceIdx);
              // Count open braces and close them
              let open = 0;
              for (const ch of tail) { if (ch === '{') open++; if (ch === '}') open--; }
              if (open > 0) tail += '}'.repeat(open);
              const args = tryParse(tail);
              if (args) {
                // The parsed block might be {name, parameters:{...}} or just the args
                const fnArgs = args.arguments || args.parameters || args.args || args;
                toolCalls = [{ function: { name: nm[1].toLowerCase(), arguments: fnArgs } }];
              }
            }
          }
        }
      }
      const convText = toolCalls.length ? '' : textOut;
      conv.push({ role: 'assistant', content: convText, tool_calls: toolCalls.length ? toolCalls : undefined });
      // Content already emitted token-by-token during streaming.  When a
      // text-based tool call is detected after streaming, the raw syntax
      // ("web_search({...})") has already reached the client — tell the UI
      // to wipe it before we stream the post-tool answer.
      if (!toolCalls.length) { finish(); return; }
      emit({ clear_message: true });
      for (const tc of toolCalls) {
        const name = tc.function?.name;
        let args = tc.function?.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
        emit({ tool_call: { name, args } });
        let result;
        try { result = await runTool(name, args); }
        catch (e) { result = `error: ${e.message}`; }
        let resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        emit({ tool_result: { name, preview: resultStr.slice(0, 400) } });
        if (opts.maxToolResultLen) resultStr = resultStr.slice(0, opts.maxToolResultLen);
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

// ─── Loq laptop chat (second Ollama on tailnet) ──────────────────────────
// Same chat machinery + same tools + same system prompt, but the upstream
// is the loq laptop's Ollama. Status probes confirm reachability before the
// UI shows the "Loq" mode toggle. start/stop call a tiny control service
// that lives on loq (LOQ_CONTROL_URL).
const loqProbe = async (path = '/api/tags', timeoutMs = 2000) => {
  if (!LOQ_OLLAMA) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${LOQ_OLLAMA}${path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch { clearTimeout(timer); return null; }
};
const loqControl = async (path, method = 'POST', body = null) => {
  if (!LOQ_CONTROL) throw new Error('LOQ_CONTROL_URL not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(`${LOQ_CONTROL}${path}`, {
      method, signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(LOQ_CONTROL_TOKEN ? { Authorization: `Bearer ${LOQ_CONTROL_TOKEN}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    clearTimeout(timer);
    let data; try { data = await r.json(); } catch { data = { ok: r.ok }; }
    return { status: r.status, ok: r.ok, data };
  } catch (e) { clearTimeout(timer); return { status: 0, ok: false, data: { error: String(e.message || e) } }; }
};

app.get('/api/loq/status', auth, async (req, res) => {
  // Probe both Ollama and the control service in parallel so the dashboard
  // can distinguish "loq is off" (neither reachable) from "Ollama stopped
  // but control is up" (show Start button, panel visible).
  const [tags, ctl] = await Promise.all([
    loqProbe('/api/tags', 1500),
    LOQ_CONTROL ? loqControl('/status', 'GET').catch(() => null) : Promise.resolve(null),
  ]);
  const reachable = !!tags;
  const controlReachable = !!(ctl && ctl.ok);
  const models = (tags && tags.models) ? tags.models.map(m => ({ name: m.name, size: m.size })) : [];
  res.json({
    reachable, controlReachable,
    models,
    daemon: controlReachable ? ctl.data : null,
    ollama_url: LOQ_OLLAMA, control_url: LOQ_CONTROL || null,
  });
});

app.post('/api/loq/start', auth, async (req, res) => {
  const r = await loqControl('/start', 'POST');
  res.status(r.ok ? 200 : 502).json(r.data);
});
app.post('/api/loq/stop', auth, async (req, res) => {
  const r = await loqControl('/stop', 'POST');
  res.status(r.ok ? 200 : 502).json(r.data);
});

app.post('/api/loq/chat', auth, async (req, res) => {
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
  // Loq now runs on GPU (RTX 5060 8GB, CUDA 13, sm_120) — ~40 tok/s gen
  // for 12-14B models with full GPU offload.  Bigger models (32B+) don't
  // fit in 8GB VRAM with num_gpu=99 forced, so let Ollama auto-decide
  // partial offload for those.  Heuristic: any model named *.b where
  // *>=20 drops the forced offload.
  const sizeMatch = (model || '').match(/(\d+)b/i);
  const modelSizeB = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
  const tooBigForFullGpu = modelSizeB >= 20;
  processChatJob(job, model, messages, LOQ_OLLAMA, {
    numCtx: 2048, ...(tooBigForFullGpu ? {} : { numGpu: 99 }), numBatch: 128, timeoutMs: 120_000,
    allowedTools: [], maxToolResultLen: 3000,
    textToolAllow: ['web_search', 'web_fetch', 'get_stats', 'get_services', 'list_models', 'list_dir', 'read_file'],
    systemPrompt: `You are an assistant on the user's self-hosted server (agent.ojee.net).

### HARD RULES
1. You HAVE web_fetch and web_search. Call them for current time, weather, prices, news, scores, or anything that could have changed.
2. NEVER invent or guess numbers, dates, times, temperatures, prices, or URLs.  If the tool result doesn't clearly contain the fact, call a tool AGAIN with a better URL/query.
3. Base your answer ONLY on what the tool result says.  Quote specific numbers/times verbatim.  If a data point isn't in the result, don't include it.
4. For a multi-part question, call ONE tool per turn.  After getting the first result and answering that part, call the next tool for the next part.
5. NEVER refuse a topic (medical, legal, etc). Give the best answer + one-line disclaimer.
6. NEVER ask permission to use a tool. Just call it.
7. Keep replies 1-3 sentences, conversational, no headers/bullets unless listing.

### Tool syntax — output EXACTLY one of these, nothing else on the turn:
web_fetch({"url":"https://..."})
web_search({"query":"..."})
get_stats({})                  — CPU %, memory, disk, temperature, GPU
get_services({})               — docker compose services and their state
list_models({})                — Ollama models installed on this server
list_dir({"path":"/abs/path"}) — directory listing (stack is at /home/ojee/stack)
read_file({"path":"/abs/path"}) — read a text file (never read .env)

### PREFERRED URLs for web_fetch (return clean JSON — use these over web_search):
- Current time: https://timeapi.io/api/Time/current/zone?timeZone=<IANA zone, e.g. America/Los_Angeles, Africa/Cairo, Asia/Tokyo>
- City → lat/lon: https://geocoding-api.open-meteo.com/v1/search?name=<CITY>&count=1
- Weather (needs lat/lon first): https://api.open-meteo.com/v1/forecast?latitude=<LAT>&longitude=<LON>&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto

Example flow for "time in Cairo":
Turn 1 output: web_fetch({"url":"https://timeapi.io/api/Time/current/zone?timeZone=Africa/Cairo"})
Then read the "time" field from the JSON result and answer.

For math, code, definitions, or timeless facts — answer from memory.`,
  });
});

// loq jobs share the same chatJobs registry — same reconnect endpoint works
app.get('/api/loq/jobs/:id', auth, (req, res) => {
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
