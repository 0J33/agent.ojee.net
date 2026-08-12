# home.ojee.net — setup

Local device control and automation for the house. Runs on `ojee-hp-zorin`, served by the
stack's Caddy at `https://home.ojee.net` (tailnet only — the A record points at the
Tailscale IP `100.117.98.52`, which is not routable from the public internet).

## How it reaches the AC

The AC is on the **Gamal** network (`192.168.1.0/24`), the HP box's main link is on
**ojee-5G** (`192.168.8.0/24`). They are two different routers. A USB Wi-Fi adapter
(`RTL8188EUS`, in-kernel `rtl8xxxu`, 2.4GHz-only) bridges the gap:

| Interface | Network | Address | Route |
|---|---|---|---|
| `wlo1` | ojee-5G | `192.168.8.8` | **default** — internet + Tailscale |
| `wlx482254809603` | Gamal | `192.168.1.42` | `192.168.1.0/24` only, metric 700 |

The NetworkManager connection is `Gamal-usb` with `ipv4.never-default yes`. That flag is
load-bearing: without it the adapter grabs the default route and kills the box's internet
and the Tailscale session with it.

The container uses ordinary bridge networking and reaches `192.168.1.36:56800` through the
host's routing table. It does not need `network_mode: host`.

## Getting the local key

The hub speaks the AC's LAN protocol directly, but the payloads are AES-encrypted with a
per-device key that only the account can hand out. Fetch it once:

```bash
cd /home/ojee/agent.ojee.net/stack/home
./fetch-key.sh 94224C108338
```

It prompts for the account password on the terminal — it is never an argument, so it stays
out of your history and out of the repo.

If it reports **"account is not registered"**, that is usually the wrong `--region`, not a
wrong password. It wants the phone dialling code of the country the *account* was
registered in, not where the AC hangs on the wall. Override with `HAIER_REGION=xx`.

Then put the 32-hex key in `stack/.env`:

```ini
AC_LOCAL_KEY=<32 hex characters>
```

and restart: `docker compose up -d home`.

**Until that key is set the hub runs a simulated AC** rather than failing — the whole UI,
scenes and automations stay usable. It is labelled: the top bar reads `SIMULATED` and the
device's Link field reads `simulated`. Setting the key is the only change needed to make it
real; nothing else in the config or the UI changes.

## Automatic key refresh

Haier rotates the localKey server-side. The trigger is not documented — a scheduled auto-off
through the official app did it here, taking the unit from key version 3 to 4 — so the hub
does not try to predict *when*. It reacts to the fact: any read or command that fails to
decrypt triggers a cloud re-fetch and one retry. A rotation now heals inside a single poll,
whether it was the app, a schedule, or something else that caused it.

Set the account in `stack/.env` to enable it:

```ini
HAIER_USERNAME=you@example.com
HAIER_PASSWORD=...
HAIER_REGION=20
```

Leave them blank to keep the manual `./fetch-key.sh` flow instead.

The password is only ever read from the environment — it is never written to the hub's data
file and never leaves the box except to Haier's own login endpoint. The fetched *device* key
is persisted to `/data/hub.json` so a restart does not need another round trip; it records the
`AC_LOCAL_KEY` that seeded it, so editing that variable by hand still takes precedence.

Fetches are rate-limited to one per 5 minutes and stop after 3 consecutive failures, so a
wrong password cannot turn the poll loop into a login-attempt flood.

## Freezing the key

The key rotates server-side. To make it permanent, block the AC's outbound internet at the
Gamal router — it phones `43.156.75.60`. Archive the key first. After that the AC never
reaches Haier again and the stored key stays valid indefinitely.

## Configuration

All of these are optional overrides in `stack/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `HOME_DOMAIN` | `home.example.com` | public hostname Caddy serves |
| `AC_HOST` | `192.168.1.36` | AC's LAN address (rediscovered automatically if it moves) |
| `AC_DEVICE_ID` | — | Wi-Fi module MAC, no separators — `94224C108338` |
| `AC_LOCAL_KEY` | — | 32-hex local key; empty runs the simulator |
| `AC_SUBNET` | `192.168.1.0/24` | swept to re-find the AC after a DHCP move |
| `AC_TYPE_ID` | — | product code selecting a per-model profile; blank uses Haier-wide defaults |
| `AC_TEMP_MIN` / `AC_TEMP_MAX` | — | narrow the setpoint range; blank keeps the profile's |
| `HUB_POLL_SECONDS` | `45` | how often a session is opened to read state |
| `HUB_DEMO` | `0` | `1` forces the simulator even with a key set |

### Why polling, and why 45s

The AC accepts **one local session at a time** and caps each at about 17 seconds. So the
hub opens a session, reads, and closes — it cannot hold a socket open. Polling much faster
than this means fighting the phone app for the socket. After any write the hub polls every
2s for a few seconds to confirm the change landed, then drops back.

## Adding a device later

Write a `Driver` subclass in `app/drivers/`, declare its `capabilities()`, and register it
in `hub.py`. The REST API and the whole frontend are generic over the capability list —
`switch`, `enum`, `range`, `readout` — so a new device renders controls without any
frontend change.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | full snapshot: devices, scenes, automations, activity |
| `GET` | `/api/devices/{id}` | one device |
| `POST` | `/api/devices/{id}/command` | `{"power":true,"target_temperature":22}` |
| `POST` | `/api/devices/{id}/refresh` | force a read now |
| `GET` | `/api/events` | SSE stream of live changes |
| `GET`/`PUT` | `/api/scenes` | read / replace scenes |
| `POST` | `/api/scenes/{id}/activate` | run a scene |
| `GET`/`PUT` | `/api/automations` | read / replace automations |
| `POST` | `/api/automations/{id}/toggle` | enable / disable |
| `GET` | `/api/activity` | recent event log |
| `GET` | `/api/health` | liveness + device counts |

## What this unit actually supports

Capabilities are read from the device, not assumed. On the reference unit
(**HSU-12KCRIC(IN)**, product code `AACDK1Z00`):

- **Mode** — auto / cool / dry / fan. **No heat**: the unit reports `heat_capable: false`,
  so the mode is omitted from the UI and `mode=heat` is rejected with a 400.
- **Setpoint** — the model profile advertises the protocol-wide 16–30 °C, but this unit's
  own remote only allows **20–28**, set via `AC_TEMP_MIN`/`AC_TEMP_MAX`.
- **Fan** — auto / low / medium / high.
- **Swing** — full position control on both axes: vertical `fixed, 1-5, auto` and horizontal
  `fixed, 1-6, auto`. Every code was swept against this unit and echoed back, so all are
  hardware-confirmed — a superset of the six per axis the Haismart app exposes. Two traps:
  `set_grsetdac_field` needs `model_values` to accept anything beyond its observed 0/12 and
  0/7, and the `WriteField` word numbers are 1-based while the raw buffer is 0-based (reading
  it literally reports 0 for every code, including ones known to work).
- **Eco** — off / 1 / 2 / 3. Each level caps the compressor current harder: higher saves
  more power and cools more slowly.
- **Self-clean** — start-only (the cycle runs to completion, there is no stop command), so
  it is an action with a confirmation rather than a toggle.
- **Switches** — turbo, quiet, sleep, health, display.
- **Readouts** — indoor and outdoor temperature, error code, and which channel last changed
  the unit.

One trap worth recording: `parse_full_status` returns snake_case *semantic* names
(`current_temperature`, `strong`, `lamp`), not the canonical camelCase wire names. Reading
the wire names silently returns nothing — which is exactly how the temperature sensors first
came back as `null` while everything looked healthy.

## Credits

The LAN protocol implementation is [`haismart-hrdp`](https://github.com/enapt/haismart-local)
by [@enapt](https://github.com/enapt), vendored under `vendor/`. MIT licensed.
