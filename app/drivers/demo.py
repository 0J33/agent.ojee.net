"""A simulated air conditioner.

Stands in whenever no localKey is configured (or HUB_DEMO=1) so the whole app — devices,
scenes, automations, the live event stream — is exercisable without hardware. It shares the
real driver's capability builder and validator, so anything that renders or accepts one
renders and accepts the other, and swapping in a key changes nothing above this layer.
"""
from __future__ import annotations

import random
import time
from typing import Any

from .base import Capability, Driver
from .haier_ac import DEFAULT_SPEC, build_capabilities, validate_ac_command


class DemoAC(Driver):
    kind = "air_conditioner"
    simulated = True

    def __init__(self, device_id: str, name: str, room: str) -> None:
        super().__init__()
        self.id = device_id
        self.name = name
        self.room = room
        self.spec = DEFAULT_SPEC
        self.state = {
            "power": False, "mode": "cool", "target_temperature": 23, "fan": "auto",
            "swing_vertical": "fixed", "swing_horizontal": "fixed", "eco": "off",
            "quiet": False, "turbo": False, "sleep": False, "health": False, "display": True,
            "self_cleaning": False,
            "indoor_temperature": 29.0, "outdoor_temperature": 34.0,
            "error_code": 0, "last_changed_by": "network",
        }
        self._drift = time.time()

    def capabilities(self) -> list[Capability]:
        return build_capabilities(self.spec)

    async def refresh(self) -> None:
        # Drift the room temperature toward (or away from) the setpoint so readouts visibly
        # move — a frozen number reads as "broken" during UI review.
        now = time.time()
        elapsed = max(0.0, now - self._drift)
        self._drift = now
        indoor = float(self.state["indoor_temperature"])
        if self.state["power"]:
            target = float(self.state["target_temperature"])
            indoor += (target - indoor) * min(1.0, elapsed / 240.0)
        else:
            indoor += (34.0 - indoor) * min(1.0, elapsed / 900.0)
        self.state["indoor_temperature"] = round(indoor + random.uniform(-0.05, 0.05), 1)
        self.state["outdoor_temperature"] = round(34.0 + random.uniform(-0.6, 0.6), 1)
        self._mark_ok()
        self.status_detail = "simulated"

    async def apply(self, command: dict[str, Any]) -> None:
        cleaned = validate_ac_command(command, self.spec)
        if cleaned.pop("self_clean", None):
            self.state["self_cleaning"] = True
        self.state.update(cleaned)
        self._mark_ok()
        self.status_detail = "simulated"
