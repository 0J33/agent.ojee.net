# Agent Stack

A self-hosted AI agent + automation stack: a custom dashboard that talks to a local **Ollama**, the full-featured **Open WebUI** chat, **n8n** for workflow automation, and an optional **CouchDB** for syncing an Obsidian vault. Everything runs in Docker behind **Caddy** with auto-renewing TLS.

Designed to live behind **Tailscale** (no public ports) but works fine on a regular VPS too — it's a matter of which IP you bind Caddy to.

## What you get

| Surface | What it is |
|---|---|
| `https://<DASHBOARD_DOMAIN>/` | Custom dashboard — live stats, container controls, a chat with full tool access (web search, file reads, n8n workflow CRUD, server stats) |
| `https://<OPENWEBUI_DOMAIN>/` | Open WebUI — full chat UI with RAG, history, model management |
| `https://<N8N_DOMAIN>/` | n8n — visual workflow automation |
| `https://<COUCHDB_DOMAIN>/` | CouchDB — backend for the [Obsidian Self-hosted LiveSync plugin](https://github.com/vrtmrz/obsidian-livesync) |

The dashboard's chat is the highlight: it has a system prompt that knows how to build n8n workflows, call free no-auth APIs (weather, time, currency, news, etc.), read files off the host, and pull live stats — all without leaving the chat box.

---

## Requirements

- A Linux host with Docker + Docker Compose
- An Ollama install on the host (`curl -fsSL https://ollama.com/install.sh | sh`) reachable at `host.docker.internal:11434`
- A domain you control on Cloudflare (for DNS-01 TLS)
- *Optional:* an NVIDIA GPU (the dashboard container uses `runtime: nvidia` for GPU-accelerated tool calls if available — comment those lines out if you don't have one)

---

## Setup

```bash
git clone https://github.com/0J33/agent.ojee.net.git ~/stack
cd ~/stack/stack
cp .env.example .env
vim .env            # fill in domains, ACME email, Cloudflare token, etc.
```

Then point your DNS at the host. Four `A`/`AAAA` (or `CNAME`) records — whatever you put in `*_DOMAIN`:

```
agent.example.com        → <BIND_IP>
chat.agent.example.com   → <BIND_IP>
flow.agent.example.com   → <BIND_IP>
sync.agent.example.com   → <BIND_IP>   (skip if you don't run CouchDB)
```

Bring it up:

```bash
docker compose up -d --build
```

First boot pulls images and runs the Caddy DNS-01 dance with Cloudflare — takes a minute. Watch with `docker compose logs -f caddy`. When the dashboard responds at `https://<DASHBOARD_DOMAIN>/`, set up first-run accounts:

| Service | First-run |
|---|---|
| Dashboard | Logs you in with `DASHBOARD_PASSWORD` from `.env` |
| Open WebUI | First signup becomes admin |
| n8n | First signup becomes owner |

CouchDB needs a one-time init for Obsidian's CORS/body-size requirements:

```bash
./couchdb/init.sh obsidian
```

---

## `.env` reference (full list in `.env.example`)

| Var | What |
|---|---|
| `BIND_IP` | IP Caddy listens on. Use your Tailscale IP for tailnet-only access, `0.0.0.0` for public, `127.0.0.1` for loopback. |
| `ACME_EMAIL` | Email Let's Encrypt registers your certs under. |
| `CLOUDFLARE_API_TOKEN` | Scoped to *Edit zone DNS* on your domain — needed because the stack uses DNS-01 (so it works even when port 80 isn't publicly reachable). |
| `DASHBOARD_DOMAIN` / `OPENWEBUI_DOMAIN` / `N8N_DOMAIN` / `COUCHDB_DOMAIN` | Subdomains for each service. Used by Caddy and by the dashboard's quick-links. |
| `DASHBOARD_BASE_URL` | Public URL the dashboard uses to reference itself in chat answers. Usually `https://$DASHBOARD_DOMAIN`. |
| `HOST_STACK_PATH` | Absolute host path to this `stack/` directory — mounted into the dashboard at `/host-stack` so the chat can read your `docker-compose.yml`. |
| `TIMEZONE` | IANA name. Picked up by n8n's scheduler and by the chat agent when interpreting "every day at 9am". |
| `DASHBOARD_PASSWORD` | Login. Wrap in single quotes if it contains `#`, `$`, or spaces. |
| `JWT_SECRET` | Signs the dashboard's session tokens. Rotate to invalidate sessions. |
| `N8N_API_KEY` | From n8n → Settings → n8n API. Lets the dashboard chat create/run/edit workflows. |
| `LOQ_*` | Optional second Ollama on another machine + a small control HTTP API to start/stop it. Surfaced as the "Loq" tab. |
| `CODE_AGENT_*` | Optional Claude Code integration. Surfaced as the "Code" tab. |
| `COUCHDB_USER` / `COUCHDB_PASSWORD` | Obsidian LiveSync auth. |

---

## Talking to Ollama directly

```bash
curl -s http://<BIND_IP>:11434/api/generate \
  -d '{"model":"qwen2.5-coder:7b","prompt":"Explain X","stream":false}'
```

Both the dashboard and Open WebUI use this API under the hood.

---

## Architecture

```
                  ┌────────────┐
client ───TLS───► │   Caddy    │  (DNS-01 cert from Let's Encrypt)
                  └─────┬──────┘
        ┌───────────────┼─────────────────┬──────────────┐
        ▼               ▼                 ▼              ▼
   dashboard:8080  openwebui:8080     n8n:5678      couchdb:5984
        │               │                 │
        └─────► Ollama on host (host.docker.internal:11434)
```

The dashboard has `docker.sock` mounted so it can act on containers and read host files. **That makes it effectively root for the actions whitelisted in `server.js`** — anyone with the dashboard password can restart the stack. Use a strong password and don't expose the dashboard publicly without thinking about it.

---

## Updating

```bash
cd ~/stack
git pull
docker compose pull
docker compose up -d --build
```

The dashboard frontend is plain HTML/JS in `dashboard/public/` and the backend is `dashboard/server.js` (Express) — `--build` picks them up.

---

## Common knobs

**Change the dashboard password.** Edit `.env`, then `docker compose up -d dashboard`.

**Bind Caddy to a different IP.** Edit `BIND_IP` in `.env` and `docker compose up -d caddy`.

**Disable a service** (e.g. you don't use Obsidian). Comment out its `service:` block in `docker-compose.yml` *and* its `{...}` site block in `caddy/Caddyfile`.

**Pull a new Ollama model.** `ollama pull <name>` on the host — it shows up in the dashboard + Open WebUI automatically.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Cert warning in browser | `docker compose logs caddy`. Cloudflare token wrong? Token not scoped to the right zone? |
| `502 Bad Gateway` on a subdomain | The upstream container isn't healthy. `docker compose ps`, then `docker compose logs <service>`. |
| Dashboard chat says "no model" | `ollama list` on the host — pull at least one model. |
| n8n workflow URLs in chat point to the wrong domain | Check `N8N_DOMAIN` and `DASHBOARD_BASE_URL` in `.env`. |
| CouchDB returns "unauthorized" from Obsidian | The plugin's username/password must match `.env`. |

---

## License

MIT.
