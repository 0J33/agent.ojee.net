"""Tiny JSON-file persistence for scenes, automations and the activity log.

No database on purpose: the whole point of this hub is that it survives on its own. A
single JSON file is inspectable, backup-able with the rest of the stack, and cannot get
into a migration state that needs a human.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Any

_LOCK = threading.Lock()

DEFAULT_STATE: dict[str, Any] = {
    "scenes": [
        {
            "id": "scene-sleep",
            "name": "Sleep",
            "code": "SC-01",
            "description": "Quiet, 24 degrees, low fan.",
            "actions": [
                {"device": "ac-living", "command": {"power": True, "mode": "cool",
                                                    "target_temperature": 24, "fan": "low",
                                                    "quiet": True}},
            ],
        },
        {
            "id": "scene-away",
            "name": "Away",
            "code": "SC-02",
            "description": "Everything off.",
            "actions": [{"device": "ac-living", "command": {"power": False}}],
        },
        {
            "id": "scene-chill",
            "name": "Chill",
            "code": "SC-03",
            "description": "Cool hard, high fan, swing on.",
            "actions": [
                {"device": "ac-living", "command": {"power": True, "mode": "cool",
                                                    "target_temperature": 20, "fan": "high",
                                                    "swing_vertical": True}},
            ],
        },
    ],
    "automations": [
        {
            "id": "auto-night",
            "name": "Night step-up",
            "enabled": False,
            "description": "Raise the setpoint overnight so it does not run cold until morning.",
            "trigger": {"type": "time", "at": "01:30"},
            "actions": [{"device": "ac-living", "command": {"target_temperature": 25}}],
        },
        {
            "id": "auto-hot",
            "name": "Too warm",
            "enabled": False,
            "description": "If the room reads above 30 degrees, start cooling.",
            "trigger": {"type": "state", "device": "ac-living",
                        "attribute": "indoor_temperature", "above": 30},
            "actions": [
                {"device": "ac-living", "command": {"power": True, "mode": "cool",
                                                    "target_temperature": 23}},
            ],
        },
    ],
    "activity": [],
    "device_meta": {},
}


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        self._data: dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        try:
            with open(self.path, encoding="utf-8") as fh:
                self._data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            self._data = {}
        # Fill in anything a older file predates, without clobbering what is there.
        for key, value in DEFAULT_STATE.items():
            self._data.setdefault(key, json.loads(json.dumps(value)))

    def _flush(self) -> None:
        """Atomic write — a half-written config file would be worse than a stale one."""
        directory = os.path.dirname(self.path) or "."
        fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self._data, fh, indent=2)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def get(self, key: str) -> Any:
        with _LOCK:
            return json.loads(json.dumps(self._data.get(key)))

    def set(self, key: str, value: Any) -> None:
        with _LOCK:
            self._data[key] = value
            self._flush()

    def log(self, kind: str, message: str, detail: str = "", limit: int = 300) -> dict[str, Any]:
        entry = {"ts": time.time(), "kind": kind, "message": message, "detail": detail}
        with _LOCK:
            log = self._data.setdefault("activity", [])
            log.insert(0, entry)
            del log[limit:]
            self._flush()
        return entry
