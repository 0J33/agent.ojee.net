"""The device abstraction every driver implements.

The hub, the REST API and the UI only ever talk to this shape. Adding a light, a plug or
a sensor later means writing one more Driver subclass and registering it — no changes to
the API surface or the frontend's device rendering.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Capability:
    """One controllable or readable attribute, described well enough for the UI to render
    a control for it without knowing what a Haier AC is."""

    key: str
    label: str
    # switch | enum | range | readout | action
    kind: str
    options: list[dict[str, str]] = field(default_factory=list)
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    unit: str = ""
    icon: str = ""
    # One line explaining what the control actually does, shown under it. For anything whose
    # name does not carry its meaning — "Eco 1/2/3" tells you nothing on its own.
    hint: str = ""
    # Attributes the UI should grey out when the device is off.
    needs_power: bool = False


class Driver:
    """Base class. Subclasses implement `refresh` and `apply`."""

    #: stable identifier, used in URLs and scene/automation action targets
    id: str = "device"
    #: human name
    name: str = "Device"
    #: device class — drives the icon and grouping in the UI
    kind: str = "generic"
    room: str = ""
    #: True when this device is a stand-in rather than real hardware. Reported to the UI so
    #: the status strip cannot claim "live" while a simulator is answering — the hub-level
    #: demo flag is not enough, since a missing key substitutes a simulator on its own.
    simulated: bool = False

    def __init__(self) -> None:
        self.state: dict[str, Any] = {}
        self.available: bool = False
        self.status: str = "unknown"       # ok | unconfigured | unreachable | error
        self.status_detail: str = ""
        self.last_seen: float | None = None
        self.last_error: str = ""

    # ---- introspection -------------------------------------------------
    def capabilities(self) -> list[Capability]:
        return []

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "room": self.room,
            "simulated": self.simulated,
            "available": self.available,
            "status": self.status,
            "status_detail": self.status_detail,
            "last_seen": self.last_seen,
            "last_error": self.last_error,
            "state": self.state,
            "capabilities": [
                {
                    "key": c.key, "label": c.label, "kind": c.kind, "options": c.options,
                    "min": c.minimum, "max": c.maximum, "step": c.step, "unit": c.unit,
                    "icon": c.icon, "hint": c.hint, "needs_power": c.needs_power,
                }
                for c in self.capabilities()
            ],
        }

    # ---- lifecycle -----------------------------------------------------
    async def refresh(self) -> None:
        """Pull current state from the device. Must set `available`/`status` and never raise."""
        raise NotImplementedError

    async def apply(self, command: dict[str, Any]) -> None:
        """Push a command. May raise — the caller turns it into a 4xx/5xx and an activity entry."""
        raise NotImplementedError

    # ---- helpers -------------------------------------------------------
    def _mark_ok(self) -> None:
        self.available = True
        self.status = "ok"
        self.status_detail = ""
        self.last_error = ""
        self.last_seen = time.time()

    def _mark_bad(self, status: str, detail: str) -> None:
        self.available = False
        self.status = status
        self.status_detail = detail
        self.last_error = detail
