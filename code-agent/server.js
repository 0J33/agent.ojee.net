// Code Agent — remote controller for Claude Code sessions.
// Runs on the Loq laptop. The dashboard (on the HP box) calls it via the
// tailnet so the user can start/resume/close Claude Code chats from any
// device (notably their phone).
//
// All tool calls run with --dangerously-skip-permissions because the phone
// can't handle interactive approvals. Auth is a shared bearer token.

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = parseInt(process.env.PORT || '7777', 10);
const BIND = process.env.BIND || '0.0.0.0';
const AUTH_TOKEN = process.env.CODE_AGENT_TOKEN;
const DEFAULT_CWD = process.env.DEFAULT_CWD || '/media/ojee/NVME/Code/[GIT]/Claude/';
const HOME = process.env.HOME;
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${HOME}/.local/bin/claude`;

if (!AUTH_TOKEN) {
  console.error('FATAL: CODE_AGENT_TOKEN must be set.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '512kb' }));

const auth = (req, res, next) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
};

// ─── In-memory session state ────────────────────────────────────────────
// { id, cwd, title, createdAt, lastActivityAt, initialized }
const sessions = new Map();

const safeExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// ─── Health ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, version: '0.1.0' }));

// ─── Directory browser ─────────────────────────────────────────────────
app.get('/api/dirs', auth, (req, res) => {
  const target = req.query.path || DEFAULT_CWD;
  try {
    const abs = path.resolve(target);
    if (!safeExists(abs)) return res.status(404).json({ error: 'not found', path: abs });
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(abs, e.name)
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: abs, parent: path.dirname(abs), entries });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ─── Sessions ──────────────────────────────────────────────────────────
app.post('/api/sessions', auth, (req, res) => {
  const cwd = path.resolve(req.body.cwd || DEFAULT_CWD);
  const title = (req.body.title || path.basename(cwd) || 'Session').toString().slice(0, 80);
  if (!safeExists(cwd) || !fs.statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: 'cwd must be an existing directory', cwd });
  }
  const id = randomUUID();
  const session = { id, cwd, title, createdAt: Date.now(), lastActivityAt: Date.now(), initialized: false };
  sessions.set(id, session);
  res.json(session);
});

app.get('/api/sessions', auth, (req, res) => {
  res.json({ active: Array.from(sessions.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt) });
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  const ok = sessions.delete(req.params.id);
  res.json({ ok });
});

// ─── Conversation history ──────────────────────────────────────────────
// Claude persists sessions at ~/.claude/projects/<cwd-encoded>/<session-id>.jsonl
// where the encoding replaces "/" and other chars with "-".
const encodeCwdForClaude = (cwd) => cwd.replace(/[/.\[\]]/g, '-');

app.get('/api/sessions/:id/history', auth, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const historyDir = path.join(HOME, '.claude', 'projects', encodeCwdForClaude(s.cwd));
  const file = path.join(historyDir, `${s.id}.jsonl`);
  if (!safeExists(file)) return res.json({ messages: [] });
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'user' && evt.message?.content) {
          const text = typeof evt.message.content === 'string' ? evt.message.content
            : Array.isArray(evt.message.content) ? evt.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          if (text) messages.push({ role: 'user', text });
        } else if (evt.type === 'assistant' && evt.message?.content) {
          const content = Array.isArray(evt.message.content) ? evt.message.content : [];
          for (const c of content) {
            if (c.type === 'text' && c.text) messages.push({ role: 'assistant', text: c.text });
            else if (c.type === 'tool_use') messages.push({ role: 'tool_use', tool: c.name, input: c.input });
          }
        }
      } catch {}
    }
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ─── Past conversation history (browse all projects) ────────────────────
app.get('/api/history', auth, (req, res) => {
  const claudeDir = path.join(HOME, '.claude', 'projects');
  if (!safeExists(claudeDir)) return res.json({ conversations: [] });
  try {
    const conversations = [];
    const projDirs = fs.readdirSync(claudeDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const proj of projDirs) {
      const projPath = path.join(claudeDir, proj.name);
      const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projPath, file);
        try {
          const stat = fs.statSync(filePath);
          const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
          let firstUserMsg = '';
          for (const line of lines) {
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'user' && evt.message?.content) {
                const text = typeof evt.message.content === 'string' ? evt.message.content
                  : Array.isArray(evt.message.content) ? evt.message.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '';
                if (text) { firstUserMsg = text.slice(0, 100); break; }
              }
            } catch {}
          }
          conversations.push({
            id: file.replace('.jsonl', ''),
            project: proj.name,
            title: firstUserMsg || file.replace('.jsonl', ''),
            modified: stat.mtimeMs,
            messageCount: lines.length,
          });
        } catch {}
      }
    }
    conversations.sort((a, b) => b.modified - a.modified);
    res.json({ conversations: conversations.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Delete a past conversation
app.delete('/api/history/:project/:id', auth, (req, res) => {
  const filePath = path.join(HOME, '.claude', 'projects', req.params.project, `${req.params.id}.jsonl`);
  if (!safeExists(filePath)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Load a specific past conversation by project + id
app.get('/api/history/:project/:id', auth, (req, res) => {
  const filePath = path.join(HOME, '.claude', 'projects', req.params.project, `${req.params.id}.jsonl`);
  if (!safeExists(filePath)) return res.status(404).json({ error: 'not found' });
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const messages = [];
    let cwd = null;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (!cwd && e.cwd && typeof e.cwd === 'string') cwd = e.cwd;
      } catch {}
    }
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'user' && evt.message?.content) {
          const text = typeof evt.message.content === 'string' ? evt.message.content
            : Array.isArray(evt.message.content) ? evt.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          if (text) messages.push({ role: 'user', text });
        } else if (evt.type === 'assistant' && evt.message?.content) {
          const content = Array.isArray(evt.message.content) ? evt.message.content : [];
          for (const c of content) {
            if (c.type === 'text' && c.text) messages.push({ role: 'assistant', text: c.text });
            else if (c.type === 'tool_use') messages.push({ role: 'tool_use', tool: c.name, input: c.input });
          }
        }
      } catch {}
    }
    res.json({ messages, cwd });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Resume an existing conversation by registering it in the active sessions map.
// Used by the dashboard to "continue" a past chat from the history browser.
app.post('/api/sessions/resume', auth, (req, res) => {
  const id = (req.body.id || '').toString();
  const cwd = req.body.cwd ? path.resolve(req.body.cwd) : null;
  const title = (req.body.title || (cwd ? path.basename(cwd) : 'Resumed')).toString().slice(0, 80);
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!cwd || !safeExists(cwd) || !fs.statSync(cwd).isDirectory()) {
    return res.status(400).json({ error: 'cwd must be an existing directory', cwd });
  }
  // If already registered, just refresh title and return it
  let session = sessions.get(id);
  if (!session) {
    session = { id, cwd, title, createdAt: Date.now(), lastActivityAt: Date.now(), initialized: true };
    sessions.set(id, session);
  } else {
    session.cwd = cwd;
    session.title = title;
    session.initialized = true;
  }
  res.json(session);
});

// ─── Send message → stream Claude's response as SSE ────────────────────
// Child process runs independently of the HTTP connection. If the client
// disconnects, the process keeps running and buffers events so the client
// can reconnect via GET /api/sessions/:id/stream.
const activeChildren = new Map(); // sessionId → { child, events[], done, listeners }

app.post('/api/sessions/:id/messages', auth, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const content = (req.body.content || '').toString();
  if (!content.trim()) return res.status(400).json({ error: 'empty message' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--dangerously-skip-permissions'
  ];
  if (s.initialized) args.push('--resume', s.id);
  else args.push('--session-id', s.id);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: s.cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  child.stdin.write(input);
  child.stdin.end();

  s.initialized = true;
  s.lastActivityAt = Date.now();

  // Background job state
  const job = { child, events: [], done: false, listeners: new Set() };
  activeChildren.set(s.id, job);

  const emit = (obj) => {
    job.events.push(obj);
    for (const listener of job.listeners) {
      try { listener.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    }
  };
  // Keep-alive ping — silent SSE comment every 10s so proxies/browsers
  // don't close the stream during long claude thinking / tool-use gaps.
  const ping = setInterval(() => {
    if (job.done) { clearInterval(ping); return; }
    for (const listener of job.listeners) { try { listener.write(': ping\n\n'); } catch {} }
  }, 10000);

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'system' && evt.subtype === 'init') {
          emit({ type: 'init', model: evt.model, tools: evt.tools });
        } else if (evt.type === 'assistant') {
          const content = evt.message?.content || [];
          for (const c of content) {
            if (c.type === 'text' && c.text) emit({ type: 'text', text: c.text });
            else if (c.type === 'tool_use') emit({ type: 'tool_use', tool: c.name, input: c.input });
          }
        } else if (evt.type === 'user' && evt.message?.content) {
          const content = Array.isArray(evt.message.content) ? evt.message.content : [];
          for (const c of content) {
            if (c.type === 'tool_result') emit({ type: 'tool_result', content: typeof c.content === 'string' ? c.content.slice(0, 500) : '' });
          }
        } else if (evt.type === 'result') {
          emit({ type: 'result', cost_usd: evt.total_cost_usd, duration_ms: evt.duration_ms, is_error: evt.is_error });
        }
      } catch {}
    }
  });

  child.stderr.on('data', (chunk) => {
    emit({ type: 'stderr', text: chunk.toString().slice(0, 500) });
  });

  child.on('close', (code) => {
    emit({ type: 'close', code });
    clearInterval(ping);
    for (const listener of job.listeners) {
      try { listener.write('data: [DONE]\n\n'); listener.end(); } catch {}
    }
    job.done = true;
    job.listeners.clear();
    // Clean up after 5 min
    setTimeout(() => { if (activeChildren.get(s.id) === job) activeChildren.delete(s.id); }, 300000);
  });

  // Register this response as a listener (do NOT kill child on disconnect)
  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));
});

// Reconnect to a running Claude Code session stream
app.get('/api/sessions/:id/stream', auth, (req, res) => {
  const job = activeChildren.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'no active stream' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  for (const evt of job.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  if (job.done) { res.write('data: [DONE]\n\n'); return res.end(); }
  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));
});

app.listen(PORT, BIND, () => {
  console.log(`code-agent listening on ${BIND}:${PORT}`);
  console.log(`default cwd: ${DEFAULT_CWD}`);
});
