"""HTTP surface for the home hub — REST for actions, SSE for live state."""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import SETTINGS
from .hub import HUB


@asynccontextmanager
async def lifespan(_: FastAPI):
    await HUB.refresh_all()
    await HUB.start()
    yield
    await HUB.stop()


app = FastAPI(title="ojee home", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def revalidate_assets(request, call_next):
    """Force the app shell to revalidate.

    Without this the browser serves a cached app.css/app.js after a redeploy and the new
    build is silently invisible — which cost a real debugging detour during development.
    ETags still make the revalidation a cheap 304.
    """
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".css", ".js", ".svg")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# ---- state ---------------------------------------------------------------
@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    return HUB.snapshot()


@app.get("/api/health")
async def health() -> dict[str, Any]:
    devices = HUB.snapshot()["devices"]
    return {
        "ok": True,
        "devices": len(devices),
        "online": sum(1 for d in devices if d["available"]),
        "uptime": time.time() - HUB.started_at,
    }


# ---- devices -------------------------------------------------------------
@app.get("/api/devices")
async def list_devices() -> list[dict[str, Any]]:
    return [d.describe() for d in HUB.devices.values()]


@app.get("/api/devices/{device_id}")
async def get_device(device_id: str) -> dict[str, Any]:
    device = HUB.devices.get(device_id)
    if device is None:
        raise HTTPException(404, f"no device {device_id!r}")
    return device.describe()


@app.post("/api/devices/{device_id}/command")
async def send_command(device_id: str, command: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if device_id not in HUB.devices:
        raise HTTPException(404, f"no device {device_id!r}")
    if not isinstance(command, dict) or not command:
        raise HTTPException(400, "body must be a non-empty object of attribute -> value")
    try:
        return await HUB.command(device_id, command)
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - the device layer's failure is the user's answer
        raise HTTPException(502, f"{type(exc).__name__}: {exc}") from exc


@app.patch("/api/devices/{device_id}")
async def rename_device(device_id: str, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if device_id not in HUB.devices:
        raise HTTPException(404, f"no device {device_id!r}")
    name, room = body.get("name"), body.get("room")
    if name is None and room is None:
        raise HTTPException(400, "provide 'name' and/or 'room'")
    try:
        return HUB.rename(device_id, name, room)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/devices/{device_id}/refresh")
async def refresh_device(device_id: str) -> dict[str, Any]:
    if device_id not in HUB.devices:
        raise HTTPException(404, f"no device {device_id!r}")
    await HUB.refresh(device_id)
    return HUB.devices[device_id].describe()


# ---- scenes --------------------------------------------------------------
@app.get("/api/scenes")
async def list_scenes() -> Any:
    return HUB.store.get("scenes")


@app.put("/api/scenes")
async def put_scenes(scenes: list[dict[str, Any]] = Body(...)) -> Any:
    HUB.store.set("scenes", scenes)
    HUB.bus.publish("scenes", scenes)
    return scenes


@app.post("/api/scenes/{scene_id}/activate")
async def activate_scene(scene_id: str) -> dict[str, Any]:
    try:
        return await HUB.activate_scene(scene_id)
    except KeyError as exc:
        raise HTTPException(404, f"no scene {scene_id!r}") from exc


# ---- automations ---------------------------------------------------------
@app.get("/api/automations")
async def list_automations() -> Any:
    return HUB.store.get("automations")


@app.put("/api/automations")
async def put_automations(automations: list[dict[str, Any]] = Body(...)) -> Any:
    HUB.store.set("automations", automations)
    HUB.bus.publish("automations", automations)
    return automations


@app.post("/api/automations/{automation_id}/toggle")
async def toggle_automation(automation_id: str) -> Any:
    automations = HUB.store.get("automations") or []
    found = False
    for rule in automations:
        if rule["id"] == automation_id:
            rule["enabled"] = not rule.get("enabled", False)
            found = True
            break
    if not found:
        raise HTTPException(404, f"no automation {automation_id!r}")
    HUB.store.set("automations", automations)
    HUB.bus.publish("automations", automations)
    return automations


# ---- presence ------------------------------------------------------------
def _location_authorised(request) -> bool:
    """OwnTracks can send HTTP Basic or a bearer token; accept either, plus ?token= for a
    quick curl. Blank HOME_LOCATION_TOKEN disables the check — the hub is tailnet-only."""
    token = SETTINGS.location_token
    if not token:
        return True
    if request.query_params.get("token") == token:
        return True
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer ") and header[7:] == token:
        return True
    if header.startswith("Basic "):
        import base64
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            return False
        return decoded.split(":", 1)[-1] == token
    return False


@app.post("/api/location")
async def ingest_location(request: Request, payload: dict[str, Any] = Body(...)) -> Any:
    """OwnTracks HTTP endpoint. Returns a JSON array, which is what the app expects."""
    if not _location_authorised(request):
        raise HTTPException(401, "bad or missing location token")
    await HUB.ingest_location(payload)
    return []


@app.get("/api/presence")
async def get_presence() -> Any:
    return HUB.presence.describe()


@app.get("/api/location/recent")
async def recent_location_reports() -> Any:
    """What the phone has actually been sending — type, trigger and region. Use this to check
    whether the geofence is configured: a crossing shows type=transition (or trigger "c")."""
    return HUB.presence.recent()


@app.get("/api/zones")
async def get_zones() -> Any:
    return HUB.presence.zones()


@app.put("/api/zones")
async def put_zones(zones: list[dict[str, Any]] = Body(...)) -> Any:
    saved = HUB.presence.set_zones(zones)
    HUB.bus.publish("presence", HUB.presence.describe())
    return saved


@app.post("/api/zones/from-fix")
async def zone_from_fix(body: dict[str, Any] = Body(...)) -> Any:
    """Pin a zone to wherever the phone last reported. Saves anyone having to look up
    coordinates by hand — walk into the room, tap the button."""
    fix = HUB.presence.last_fix
    if not fix:
        raise HTTPException(409, "no position reported yet — send one location from the phone first")
    name = str(body.get("name") or "Home").strip() or "Home"
    zones = [z for z in HUB.presence.zones() if z["name"].lower() != name.lower()]
    zones.append({"id": name.lower().replace(" ", "-"), "name": name,
                  "lat": fix["lat"], "lon": fix["lon"],
                  "radius": float(body.get("radius") or 150)})
    saved = HUB.presence.set_zones(zones)
    HUB.bus.publish("presence", HUB.presence.describe())
    return saved


# ---- activity ------------------------------------------------------------
@app.get("/api/activity")
async def activity(limit: int = 60) -> Any:
    return (HUB.store.get("activity") or [])[: max(1, min(limit, SETTINGS.activity_limit))]


@app.delete("/api/activity")
async def clear_activity() -> dict[str, Any]:
    HUB.store.set("activity", [])
    HUB.bus.publish("activity_cleared", [])
    return {"cleared": True}


# ---- live stream ---------------------------------------------------------
@app.get("/api/events")
async def events() -> StreamingResponse:
    queue = HUB.bus.subscribe()

    async def stream():
        try:
            # Prime the connection so a client that missed the last publish is not blank.
            yield f"data: {json.dumps({'event': 'snapshot', 'data': HUB.snapshot()})}\n\n"
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"   # keeps proxies from closing an idle stream
                    continue
                yield f"data: {json.dumps(message, default=str)}\n\n"
        finally:
            HUB.bus.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ---- module contract -----------------------------------------------------
# What lets an ojee-console mount this hub. The console reads the manifest,
# builds nav from `views`, and dynamically imports `ui`. Served unauthenticated
# on purpose: the console has already authenticated the caller before it
# proxies here, and standalone the tailnet is the boundary.
@app.get("/module.json")
async def module_manifest() -> dict[str, Any]:
    return {
        "id": "home",
        "name": "Home",
        "version": app.version,
        "views": [
            {"id": "overview", "label": "Overview", "icon": "i-grid"},
            {"id": "devices", "label": "Devices", "icon": "i-ac"},
            {"id": "scenes", "label": "Scenes", "icon": "i-scene"},
            {"id": "automations", "label": "Automate", "icon": "i-auto"},
            {"id": "activity", "label": "Activity", "icon": "i-log"},
        ],
        "ui": "/ui/index.js",
        "health": "/api/health",
        "capabilities": ["sse", "commands"],
    }


# ---- static --------------------------------------------------------------
# /ui is the module: the entry point the console imports, plus its stylesheet
# and icon sprite. /public is the STANDALONE shell, which a mounted console
# never requests — it supplies its own chrome.
app.mount("/ui", StaticFiles(directory=SETTINGS.ui_dir), name="ui")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(f"{SETTINGS.web_dir}/index.html")


app.mount("/", StaticFiles(directory=SETTINGS.web_dir, html=True), name="web")
