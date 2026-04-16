# Agent Stack

Self-hosted AI agent + automation stack on the server, accessible over tailnet at `https://agent.ojee.net`.

## Quick Access

| URL | What |
|---|---|
| `https://agent.ojee.net/` | Custom dashboard (stats + chat + service controls) |
| `https://agent.ojee.net/chat/` | Open WebUI (full-featured chat UI with RAG, history, model management) |
| `https://agent.ojee.net/flow/` | n8n (visual workflow automation) |

All routes are **tailnet-only**. Devices not on your tailnet cannot resolve or connect. Valid Let's Encrypt cert (auto-renews).

---

## Setup on a New Device

1. Install Tailscale from https://tailscale.com/download
2. Sign in to the same tailnet
3. Open `https://agent.ojee.net`

No VPN, no port forwarding, no cert warnings.

---

## First-Run Accounts

| Service | Steps |
|---|---|
| Dashboard | Set `DASHBOARD_PASSWORD` in `.env` (copy `.env.example` first). To change later: edit `~/stack/.env`, then `docker compose up -d dashboard` |
| Open WebUI | First signup becomes admin. Subsequent signups need admin approval |
| n8n | First signup becomes owner. Use email + strong password |

---

## What Each Service Does

### Dashboard (`/`)
- Real-time system stats: CPU, RAM, swap, disk, temps, network
- Live status of containers, Ollama, wifi watchdog
- One-click actions: restart services, pull images, compose up/down
- Native chat panel (direct to Ollama)
- Quick links to Open WebUI + n8n

### Open WebUI (`/chat/`)
- Full chat interface with conversation history
- Model switching, custom system prompts
- **RAG** over uploaded documents (PDFs, text, etc.)
- Conversation branching
- Multiple users (admin-managed)

### n8n (`/flow/`) — the automation engine
Visual workflow editor. Useful patterns:

| Trigger | Example |
|---|---|
| **Cron** | Daily at 8am → call Ollama → email summary |
| **Webhook** | HTTP POST → Ollama → return response (build your own API) |
| **IMAP** | New email → LLM summarize → forward to Slack |
| **File watch** | New file in folder → LLM extract → write structured output |
| **RSS** | New article → LLM summarize → push to Telegram |

Full template library: `/flow/` → Templates.

---

## Talking to Ollama Directly

```bash
# From server shell or any tailnet device:
curl -s http://100.117.98.52:11434/api/generate \
  -d '{"model":"qwen2.5-coder:7b","prompt":"Explain X","stream":false}'
```

Open WebUI and the dashboard chat both use this API under the hood.

---

## CLI on the server (aliases already set in `~/.bashrc`)

```bash
stackstatus                         # overall stack health
stackps                             # list containers
stacklogs                           # tail all compose logs
stackrestart                        # restart whole stack
stackupdate                         # pull latest images + restart

~/stack/ops.sh pull qwen2.5:3b      # pull new model
~/stack/ops.sh rm qwen2.5:3b        # remove model
~/stack/ops.sh models               # list installed models
~/stack/ops.sh throttle 5 2         # cap network to 5 Mbps down / 2 up
~/stack/ops.sh throttle off         # remove cap
~/stack/ops.sh backup               # run backup now
~/stack/ops.sh tailnet              # tailscale status
```

---

## Trust & Security Model

| Layer | Protection |
|---|---|
| **Network** | Tailscale-only. Not reachable from public internet. Caddy bound to tailnet IP `100.117.98.52`, not `0.0.0.0` |
| **TLS** | Let's Encrypt cert via DNS-01 (Cloudflare). Auto-renews |
| **Dashboard auth** | Password → 30-day JWT |
| **Docker power** | Dashboard has mounted `docker.sock` = effectively root on the host for whitelisted actions in `server.js` |
| **Container isolation** | All services in Docker; can only do what their env/mounts allow |
| **Updates** | `unattended-upgrades` handles Zorin security patches automatically |

**Implication:** Anyone with your dashboard password can restart/stop services on the host. Use a strong password.

---

## File Locations

```
/home/ojee/stack/
├── docker-compose.yml
├── .env                          # DASHBOARD_PASSWORD, JWT_SECRET, CLOUDFLARE_API_TOKEN
├── nginx.conf                    # (currently unused)
├── caddy/
│   ├── Caddyfile                 # routing + TLS config
│   └── Dockerfile                # Caddy + Cloudflare DNS plugin
├── dashboard/
│   ├── Dockerfile
│   ├── server.js                 # backend (Express)
│   ├── package.json
│   └── public/                   # frontend (vanilla JS)
├── ops.sh                        # CLI helper
├── backup.sh                     # backup script (hourly cron)
├── install-nvidia.sh             # run ONCE after model pull finishes
└── backup.log                    # last backup output

/media/ojee/NVME/backups/stack/      # backup destination (keeps last 14)
/tmp/ollama-pull.log                 # live model pull progress
/tmp/compose-up.log                  # last compose up output
/usr/local/bin/net-throttle          # throttle helper (called by ops.sh)
/usr/local/bin/wifi-watchdog.sh      # runs every 30s via systemd timer
/etc/NetworkManager/conf.d/default-wifi-powersave-on.conf
/etc/modprobe.d/iwlwifi.conf         # disables iwlwifi power saving
/etc/systemd/system/ollama.service
/etc/systemd/system/wifi-watchdog.{service,timer}
/etc/logrotate.d/agent
```

---

## Common Tasks

### Change the dashboard password

```bash
vim ~/stack/.env           # edit DASHBOARD_PASSWORD
docker compose -f ~/stack/docker-compose.yml restart dashboard
```

### Pull a new Ollama model

```bash
~/stack/ops.sh pull llama3.2:3b
```

Or, with throttle during slow internet:

```bash
~/stack/ops.sh throttle 5 2
~/stack/ops.sh pull llama3.2:3b
~/stack/ops.sh throttle off
```

### View live logs

```bash
stacklogs             # all services
docker compose logs -f caddy
docker compose logs -f dashboard
docker compose logs -f openwebui
docker compose logs -f n8n
journalctl -u ollama -f
```

### Restore from backup

```bash
# openwebui
docker run --rm -v stack_openwebui_data:/dst -v /media/ojee/NVME/backups/stack:/src alpine \
  sh -c "cd /dst && tar xzf /src/stack_openwebui_data-YYYYMMDD-HHMM.tar.gz"

# n8n
docker run --rm -v stack_n8n_data:/dst -v /media/ojee/NVME/backups/stack:/src alpine \
  sh -c "cd /dst && tar xzf /src/stack_n8n_data-YYYYMMDD-HHMM.tar.gz"
```

### Enable the NVIDIA GPU (one-time)

Wait until the active Ollama model pull is done, then:

```bash
~/stack/install-nvidia.sh
sudo reboot
```

Expected speedup: 3–5× for Qwen2.5-Coder 7B on the MX250 (4GB VRAM, partial offload).

### Open a temp public URL (single file / demo)

```bash
sudo tailscale funnel 443    # exposes 443 publicly; run again with `off` to disable
```

Use sparingly — this removes the tailnet-only protection.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `agent.ojee.net` won't resolve | Tailscale connected? `tailscale ip -4` should return a 100.x address |
| Cert warning in browser | Caddy logs: `docker compose logs caddy`. Check DNS-01 is working |
| `/chat/` shows 502 | `docker compose ps` → is openwebui healthy? `docker compose logs openwebui` |
| `/flow/` redirects wrong | n8n needs `N8N_PATH=/flow/` env — already set |
| Chat says "no model" | `ollama list` — did the pull finish? `tail /tmp/ollama-pull.log` |
| Chat is slow | Run `install-nvidia.sh` + reboot |
| Wifi dropped but services still up | Wifi watchdog reconnects every 30s automatically |
| Whole server rebooted | All services auto-start (restart: unless-stopped + systemd enable) |
| Can't SSH in | Check wifi; if dead, physical access needed |

---

## Updating the Stack

```bash
cd ~/stack
git pull     # if version-controlled
docker compose pull
docker compose up -d --build
```

Dashboard source lives in `~/stack/dashboard/` — rebuild triggers on compose up with `--build`.

---

## Rotating Secrets

The initial Cloudflare API token passed through AI conversation history. To rotate:

1. Delete the old token: https://dash.cloudflare.com/profile/api-tokens → delete
2. Create a new one (same "Edit zone DNS" template, scoped to `ojee.net`)
3. Edit `~/stack/.env` → update `CLOUDFLARE_API_TOKEN=...`
4. `docker compose restart caddy`

---

## Architecture

```
                            Internet
                               │
                     (no inbound, Caddy not exposed)
                               │
Tailnet device ──wireguard──► server (100.117.98.52)
                               │
                       ┌───────┴───────┐
                       │   Caddy :443  │   (LE cert for agent.ojee.net)
                       │   auto-routes │
                       └───────┬───────┘
              ┌────────────────┼────────────────┐
              │                │                │
       dashboard:8080    openwebui:8080     n8n:5678
              │                │                │
              └────────┬───────┴────────────────┘
                       │
              Ollama on host (port 11434)
              Model: qwen2.5-coder:7b
```

Nginx is currently unused (was the tailnet-serve path). Safe to remove from compose later.
