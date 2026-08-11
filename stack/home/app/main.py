"""HTTP surface for the home hub — REST for actions, SSE for live state."""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Body, FastAPI, HTTPException
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


# ---- static app ----------------------------------------------------------
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(f"{SETTINGS.web_dir}/index.html")


app.mount("/", StaticFiles(directory=SETTINGS.web_dir, html=True), name="web")
