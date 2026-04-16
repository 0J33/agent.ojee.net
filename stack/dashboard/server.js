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
    const log = fs.readFileSync('/host-tmp/ollama-pull.log', 'utf8');
    const all = log.trim().split('\n');
    const dedup = [];
    let prev = '';
    for (const line of all) {
      // Strip leading timestamp and compare just the progress part
      const key = line.replace(/^\d{2}:\d{2}:\d{2}\s+/, '');
      if (key !== prev) { dedup.push(line); prev = key; }
    }
    res.json({ lines: dedup.slice(-8) });
  } catch {
    res.json({ lines: ['no active pull'] });
  }
});

app.post('/api/chat', auth, async (req, res) => {
  const { model, messages } = req.body;
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true })
    });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    r.body.on('data', chunk => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => {
        res.write(`data: ${line}\n\n`);
      });
    });
    r.body.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
    r.body.on('error', () => res.end());
  } catch (e) { res.status(500).json({ error: String(e) }); }
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
