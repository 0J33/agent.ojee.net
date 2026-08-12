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
from .keyfetch import KeyFetcher, KeyFetchError
from .presence import Presence
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
        self.keys = KeyFetcher(SETTINGS.account.username, SETTINGS.account.password,
                               SETTINGS.account.region)
        self.presence = Presence(self.store)

        for cfg in SETTINGS.acs:
            driver: Driver
            if SETTINGS.demo or not cfg.local_key:
                driver = DemoAC(cfg.id, cfg.name, cfg.room)
            else:
                driver = HaierAC(cfg)
            self.devices[driver.id] = driver
            self._locks[driver.id] = asyncio.Lock()

        self._apply_device_meta()
        self._apply_stored_keys()

    # ---- local keys -----------------------------------------------------
    def _apply_stored_keys(self) -> None:
        """Prefer a key this hub fetched over the one in the environment.

        The env value is the seed; once a rotation has been healed, the fetched key is the
        current one and the env value is stale. But an operator who edits AC_LOCAL_KEY by hand
        must still win — so the env value in force when we stored is recorded alongside, and a
        change to it hands control back to the environment.
        """
        stored = self.store.get("local_keys") or {}
        for device_id, driver in self.devices.items():
            entry = stored.get(device_id)
            if not entry or not isinstance(driver, HaierAC):
                continue
            if entry.get("seeded_from") != driver.local_key:
                continue        # AC_LOCAL_KEY was edited since — the environment wins
            driver.local_key = entry["key"]
            driver.localkey_version = entry.get("version")

    async def _heal_key(self, device_id: str) -> bool:
        """Fetch a fresh localKey for a device whose stored one no longer decrypts.

        Returns True only when a genuinely different key was obtained, so a caller can retry
        exactly once and not loop on an unchanged one.
        """
        driver = self.devices.get(device_id)
        if not isinstance(driver, HaierAC):
            return False
        try:
            key, version = await self.keys.fetch(driver.device_id)
        except KeyFetchError as exc:
            # Backoff is expected and self-resolving; logging it every poll would bury the
            # real failures under identical "rate-limited" rows.
            if not exc.transient:
                self.store.log("error", f"Could not refresh {driver.name}'s key", str(exc),
                               SETTINGS.activity_limit)
            return False
        if key == driver.local_key:
            return False
        stored = self.store.get("local_keys") or {}
        stored[device_id] = {"key": key, "version": version,
                             "seeded_from": stored.get(device_id, {}).get("seeded_from")
                             or driver.local_key}
        self.store.set("local_keys", stored)
        driver.local_key = key
        driver.localkey_version = version
        self.store.log("key", f"{driver.name}: fetched a fresh local key (v{version})", "",
                       SETTINGS.activity_limit)
        self.bus.publish("activity", self.store.get("activity")[:1])
        return True

    # ---- naming ---------------------------------------------------------
    def _apply_device_meta(self) -> None:
        """Overlay user-chosen names/rooms onto the drivers. Kept in the store rather than
        the env so a rename survives a redeploy without editing compose."""
        meta = self.store.get("device_meta") or {}
        for device_id, driver in self.devices.items():
            entry = meta.get(device_id) or {}
            if entry.get("name"):
                driver.name = entry["name"]
            if entry.get("room") is not None:
                driver.room = entry["room"]

    def rename(self, device_id: str, name: str | None, room: str | None) -> dict[str, Any]:
        if device_id not in self.devices:
            raise KeyError(device_id)
        meta = self.store.get("device_meta") or {}
        entry = dict(meta.get(device_id) or {})
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("name cannot be empty")
            entry["name"] = cleaned[:40]
        if room is not None:
            entry["room"] = room.strip()[:40]
        meta[device_id] = entry
        self.store.set("device_meta", meta)
        self._apply_device_meta()
        device = self.devices[device_id]
        self.store.log("rename", f"Renamed to '{device.name}'"
                                 + (f" ({device.room})" if device.room else ""),
                       "", SETTINGS.activity_limit)
        payload = device.describe()
        self.bus.publish("device", payload)
        return payload

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
            # A rotated key is not a fault — fetch a new one and read again in the same slot,
            # so an app-triggered rotation heals within one poll instead of waiting for a human.
            if device.status == "key_rotated" and await self._heal_key(device_id):
                await device.refresh()
        if previous != (device.available, dict(device.state)):
            self.bus.publish("device", device.describe())

    async def command(self, device_id: str, command: dict[str, Any]) -> dict[str, Any]:
        if device_id not in self.devices:
            raise KeyError(device_id)
        device = self.devices[device_id]
        async with self._locks[device_id]:
            try:
                await device.apply(command)
            except Exception:
                # A stale key surfaces here as "the AC did not push a status baseline" — the
                # write goes out but nothing decrypts. Heal and retry once so pressing On from
                # the website works straight after a rotation instead of erroring.
                if not await self._heal_key(device_id):
                    raise
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

    # ---- presence -------------------------------------------------------
    async def ingest_location(self, payload: dict[str, Any]) -> dict[str, Any]:
        """One report from the phone. Presence changes fire their automations immediately
        rather than waiting for the next poll — arriving home should not take 45 seconds."""
        previous, current = self.presence.ingest(payload)
        snapshot = self.presence.describe()
        self.bus.publish("presence", snapshot)
        if current is None:
            return snapshot
        self.store.log("presence", f"Phone: {previous or 'unknown'} \u2192 {current}", "",
                       SETTINGS.activity_limit)
        self.bus.publish("activity", self.store.get("activity")[:1])
        await self._run_presence_automations(previous, current)
        return snapshot

    async def _run_presence_automations(self, previous: str | None, current: str) -> None:
        for rule in self.store.get("automations") or []:
            if not rule.get("enabled"):
                continue
            trigger = rule.get("trigger") or {}
            if trigger.get("type") != "presence":
                continue
            zone = trigger.get("zone") or "home"
            event = trigger.get("event") or "enter"
            hit = (event == "enter" and current == zone) or (event == "leave" and previous == zone
                                                             and current != zone)
            if not hit:
                continue
            merged: dict[str, dict[str, Any]] = {}
            for action in rule.get("actions", []):
                merged.setdefault(action["device"], {}).update(action.get("command", {}))
            for device_id, command in merged.items():
                if device_id in self.devices:
                    try:
                        await self.command(device_id, command)
                    except Exception as exc:  # noqa: BLE001
                        self.store.log("error", f"Automation '{rule['name']}' failed", str(exc),
                                       SETTINGS.activity_limit)
            self.store.log("automation", f"Automation '{rule['name']}' ran (presence)", "",
                           SETTINGS.activity_limit)
            self.bus.publish("activity", self.store.get("activity")[:1])

    # ---- snapshot ------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return {
            "devices": [d.describe() for d in self.devices.values()],
            "scenes": self.store.get("scenes"),
            "automations": self.store.get("automations"),
            "activity": (self.store.get("activity") or [])[:60],
            "presence": self.presence.describe(),
            "hub": {
                "uptime": time.time() - self.started_at,
                "timezone": SETTINGS.timezone,
                "poll_seconds": SETTINGS.poll_seconds,
                "demo": SETTINGS.demo,
                "now": datetime.now(self._tz).isoformat(timespec="seconds"),
            },
        }


HUB = Hub()
