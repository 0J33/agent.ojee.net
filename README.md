# ojee-home

Local device control and home automation. Speaks the device's LAN protocol **directly** — no
cloud, no vendor app, no account round-trip to turn on the air conditioning.

Runs standalone or as an [ojee-console](https://github.com/0J33/ojee-console) module.

> Formerly `agent.ojee.net`. That repo held both this hub and an agent dashboard; the dashboard
> now lives in [ojee-agent](https://github.com/0J33/ojee-agent) and the git history stayed here,
> with the protocol work.

---

## What it is

A small FastAPI hub that owns devices, scenes and automations, and pushes live state over SSE.

The reference driver is a **Haier air conditioner**, driven over its LAN protocol on tcp/56800
with AES-encrypted payloads. That is the interesting part: no cloud dependency at runtime, and
the hub heals itself when the vendor rotates the device key server-side.

**The UI is generic over capabilities.** A driver declares what it supports — `switch`, `enum`,
`range`, `readout` — and the frontend renders controls from that list. Adding a device means
writing a `Driver` subclass and registering it; no frontend change at all. That property is the
reason this is worth keeping, and it survived the module port intact.

---

## Run it

```bash
pip install -r requirements.txt
PYTHONPATH=.:vendor HUB_DEMO=1 uvicorn app.main:app --port 8110
```

`HUB_DEMO=1` runs a simulated device, so the whole UI, scenes and automations are usable with no
hardware. **Without a key it simulates rather than failing** — the top strip reads `SIMULATED`
and the device's Link field says so. Setting the key is the only change needed to go live.

Docker:

```bash
docker build -t ojee-home . && docker run -p 8110:8110 -v home_data:/data ojee-home
```

| Variable | Default | Meaning |
|---|---|---|
| `HUB_DEMO` | `0` | `1` forces the simulator even with a key set |
| `HUB_POLL_SECONDS` | `45` | see below — this number is not arbitrary |
| `AC_HOST` / `AC_DEVICE_ID` / `AC_LOCAL_KEY` | — | the unit; blank key ⇒ simulator |
| `AC_TEMP_MIN` / `AC_TEMP_MAX` | — | narrow the setpoint range to what the remote allows |
| `HAIER_USERNAME` / `HAIER_PASSWORD` / `HAIER_REGION` | — | used *only* to re-fetch a rotated key |
| `HOME_LOCATION_TOKEN` | — | shared secret for phone location posts |

Full device setup, the Wi-Fi bridging, key fetching and what this specific unit actually
supports: **[docs/haier-ac.md](docs/haier-ac.md)**.

---

## Why polling, and why 45 seconds

The AC accepts **one local session at a time** and caps each at about 17 seconds. So the hub
opens a session, reads, and closes — it cannot hold a socket open. Polling much faster means
fighting the phone app for the socket. After a write it polls every 2s for a few seconds to
confirm the change landed, then drops back.

## Key rotation heals itself

The vendor rotates the device key server-side and does not document when. Observed here: a
scheduled auto-off through the official app moved it from key version 3 to 4. So the hub does not
try to predict it — it *reacts*. Any read or command that fails to decrypt triggers a cloud
re-fetch and one retry, so a rotation heals inside a single poll.

Fetches are rate-limited to one per five minutes and stop after three consecutive failures, so a
wrong password cannot turn the poll loop into a login-attempt flood. The account password is read
only from the environment; it is never written to the data file and never leaves the machine
except to the vendor's own login endpoint.

---

## Presence

The phone reports its own position to the hub — no Apple Shortcuts, no third-party cloud. Point
OwnTracks at `/api/location?token=…` and automations gain an "I arrive / I leave" trigger.

A fix worse than 500 m accuracy is ignored rather than allowed to flip presence, and a fix older
than an hour is reported as stale rather than as current. Presence changes run their automations
immediately rather than waiting for the next poll, so arriving home does not take 45 seconds.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/module.json` | module manifest (what lets a console mount this) |
| `GET` | `/api/state` | full snapshot: devices, scenes, automations, activity |
| `GET` | `/api/events` | SSE stream of live changes |
| `POST` | `/api/devices/{id}/command` | `{"power":true,"target_temperature":22}` |
| `GET`/`PUT` | `/api/scenes`, `/api/automations` | read / replace |
| `POST` | `/api/scenes/{id}/activate` | run a scene |
| `GET` | `/api/health` | liveness + device counts |

---

## Adding a device

Write a `Driver` subclass in `app/drivers/`, declare its `capabilities()`, register it in
`hub.py`. The REST API and the entire frontend are generic over the capability list, so it
appears in the UI with no frontend change.

---

## Licence

MIT. The LAN protocol implementation is [`haismart-hrdp`](https://github.com/enapt/haismart-local)
by [@enapt](https://github.com/enapt), vendored under `vendor/`, MIT licensed.
