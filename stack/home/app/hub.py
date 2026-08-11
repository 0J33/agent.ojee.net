"""The hub: device registry, poll coordinator, scenes, automations and the event bus.

One coordinator owns every device. Commands and polls both go through a per-device lock
because the AC tolerates exactly one local session at a time — without that serialisation
a scene that touches one unit twice would race itself and half the writes would vanish
into a refused handshake.
"""
from __future__ import annotations

import asyncio
import contextlib
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .config import SETTINGS
from .drivers.base import Driver
from .drivers.demo import DemoAC
from .drivers.haier_ac import HaierAC
from .store import Store


class EventBus:
    """Fan-out for Server-Sent Events. Slow consumers get dropped rather than allowed to
    back-pressure the poll loop."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: str, payload: Any) -> None:
        message = {"event": event, "data": payload, "ts": time.time()}
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                self._subscribers.discard(queue)


class Hub:
    def __init__(self) -> None:
        self.store = Store(f"{SETTINGS.data_dir}/hub.json")
        self.bus = EventBus()
        self.devices: dict[str, Driver] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._task: asyncio.Task | None = None
        self._settle_until: float = 0.0
        self.started_at = time.time()
        self._tz = ZoneInfo(SETTINGS.timezone)
        self._fired: dict[str, str] = {}   # automation id -> last fired minute/edge marker

        for cfg in SETTINGS.acs:
            driver: Driver
            if SETTINGS.demo or not cfg.local_key:
                driver = DemoAC(cfg.id, cfg.name, cfg.room)
            else:
                driver = HaierAC(cfg)
            self.devices[driver.id] = driver
            self._locks[driver.id] = asyncio.Lock()

    # ---- lifecycle -----------------------------------------------------
    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _loop(self) -> None:
        while True:
            try:
                await self.refresh_all()
                await self._run_automations()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the loop must outlive any single failure
                self.store.log("error", "Poll cycle failed", f"{type(exc).__name__}: {exc}",
                               SETTINGS.activity_limit)
            # Poll faster for a few seconds after a write so the UI confirms quickly.
            interval = 2 if time.time() < self._settle_until else SETTINGS.poll_seconds
            await asyncio.sleep(interval)

    # ---- devices -------------------------------------------------------
    async def refresh_all(self) -> None:
        for device_id in list(self.devices):
            await self.refresh(device_id)

    async def refresh(self, device_id: str) -> None:
        device = self.devices[device_id]
        previous = (device.available, dict(device.state))
        async with self._locks[device_id]:
            await device.refresh()
        if previous != (device.available, dict(device.state)):
            self.bus.publish("device", device.describe())

    async def command(self, device_id: str, command: dict[str, Any]) -> dict[str, Any]:
        if device_id not in self.devices:
            raise KeyError(device_id)
        device = self.devices[device_id]
        async with self._locks[device_id]:
            await device.apply(command)
        self._settle_until = time.time() + SETTINGS.settle_seconds
        summary = ", ".join(f"{k}={v}" for k, v in command.items())
        self.store.log("command", f"{device.name}: {summary}", "", SETTINGS.activity_limit)
        payload = device.describe()
        self.bus.publish("device", payload)
        self.bus.publish("activity", self.store.get("activity")[:1])
        return payload

    # ---- scenes --------------------------------------------------------
    async def activate_scene(self, scene_id: str) -> dict[str, Any]:
        scenes = self.store.get("scenes") or []
        scene = next((s for s in scenes if s["id"] == scene_id), None)
        if scene is None:
            raise KeyError(scene_id)
        errors: list[str] = []
        # Merge per-device so a scene that sets four attributes on one AC becomes one
        # write, not four sessions.
        merged: dict[str, dict[str, Any]] = {}
        for action in scene.get("actions", []):
            merged.setdefault(action["device"], {}).update(action.get("command", {}))
        for device_id, command in merged.items():
            if device_id not in self.devices:
                errors.append(f"{device_id}: unknown device")
                continue
            try:
                await self.command(device_id, command)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{device_id}: {exc}")
        self.store.log(
            "scene" if not errors else "error",
            f"Scene '{scene['name']}' {'activated' if not errors else 'failed'}",
            "; ".join(errors), SETTINGS.activity_limit,
        )
        self.bus.publish("activity", self.store.get("activity")[:1])
        return {"scene": scene_id, "errors": errors}

    # ---- automations ---------------------------------------------------
    async def _run_automations(self) -> None:
        now = datetime.now(self._tz)
        minute = now.strftime("%H:%M")
        for rule in self.store.get("automations") or []:
            if not rule.get("enabled"):
                continue
            trigger = rule.get("trigger") or {}
            should_fire = False
            marker = ""

            if trigger.get("type") == "time":
                marker = f"{now:%Y-%m-%d} {minute}"
                should_fire = trigger.get("at") == minute

            elif trigger.get("type") == "state":
                device = self.devices.get(trigger.get("device", ""))
                if device is not None:
                    value = device.state.get(trigger.get("attribute", ""))
                    if isinstance(value, (int, float)):
                        above, below = trigger.get("above"), trigger.get("below")
                        active = ((above is not None and value > above)
                                  or (below is not None and value < below))
                        # Edge-triggered: fire on the crossing, not on every poll while true.
                        marker = "active" if active else "clear"
                        should_fire = active and self._fired.get(rule["id"]) != "active"

            if not should_fire or (marker and self._fired.get(rule["id"]) == marker):
                if marker:
                    self._fired[rule["id"]] = marker
                continue

            self._fired[rule["id"]] = marker
            merged: dict[str, dict[str, Any]] = {}
            for action in rule.get("actions", []):
                merged.setdefault(action["device"], {}).update(action.get("command", {}))
            for device_id, command in merged.items():
                if device_id in self.devices:
                    try:
                        await self.command(device_id, command)
                    except Exception as exc:  # noqa: BLE001
                        self.store.log("error", f"Automation '{rule['name']}' failed",
                                       str(exc), SETTINGS.activity_limit)
            self.store.log("automation", f"Automation '{rule['name']}' ran", "",
                           SETTINGS.activity_limit)
            self.bus.publish("activity", self.store.get("activity")[:1])

    # ---- snapshot ------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return {
            "devices": [d.describe() for d in self.devices.values()],
            "scenes": self.store.get("scenes"),
            "automations": self.store.get("automations"),
            "activity": (self.store.get("activity") or [])[:60],
            "hub": {
                "uptime": time.time() - self.started_at,
                "timezone": SETTINGS.timezone,
                "poll_seconds": SETTINGS.poll_seconds,
                "demo": SETTINGS.demo,
                "now": datetime.now(self._tz).isoformat(timespec="seconds"),
            },
        }


HUB = Hub()
