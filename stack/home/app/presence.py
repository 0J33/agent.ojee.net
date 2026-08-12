"""Phone presence, from the phone itself — no Apple Shortcuts, no third-party cloud.

The phone runs OwnTracks (free, open source, iOS and Android) in HTTP mode, pointed at this
hub over Tailscale. Two kinds of report arrive:

* ``_type: transition`` — the phone crossed a geofence it is monitoring. iOS computes this in
  the OS region-monitoring service, so it costs almost no battery and fires even when the app
  is not running. This is the authoritative signal.
* ``_type: location`` — a periodic position fix. Used for the map readout, for "set this as
  home", and as a fallback when zones are configured with coordinates.

Zones are held here rather than on the phone so the hub can show them and evaluate them, but
a transition for a zone the hub has never heard of is still honoured — the phone knowing about
a region is enough.
"""
from __future__ import annotations

import math
import time
from typing import Any

#: A fix older than this is not evidence of where the phone is now.
STALE_AFTER_SECONDS = 3600.0
#: Reject wildly imprecise fixes rather than let them flip presence.
MAX_ACCURACY_METRES = 500.0
#: Leaving needs more distance than arriving did. Without this gap a fix hovering on the zone
#: edge — which is exactly what GPS does indoors — flips home/away repeatedly, and every flip
#: fires the automations. Entry stays at the zone radius; exit is this much further out.
EXIT_HYSTERESIS = 1.35


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    radius = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


class Presence:
    """Where the phone is, and which zone that means."""

    def __init__(self, store) -> None:
        self.store = store
        self.last_fix: dict[str, Any] | None = self.store.get("last_fix")
        self.current: str = self.store.get("presence") or "unknown"
        self._changed_at = 0.0

    # ---- zones ---------------------------------------------------------
    def zones(self) -> list[dict[str, Any]]:
        return self.store.get("zones") or []

    def set_zones(self, zones: list[dict[str, Any]]) -> list[dict[str, Any]]:
        cleaned = []
        for z in zones:
            name = str(z.get("name", "")).strip()[:40]
            if not name:
                continue
            entry = {"id": z.get("id") or name.lower().replace(" ", "-"), "name": name}
            for key in ("lat", "lon"):
                if z.get(key) is not None:
                    entry[key] = float(z[key])
            entry["radius"] = max(30.0, float(z.get("radius") or 150.0))
            cleaned.append(entry)
        self.store.set("zones", cleaned)
        return cleaned

    def zone_for(self, lat: float, lon: float) -> str | None:
        """The zone this point is in, nearest first.

        The zone we are currently in gets a wider boundary than the others, so stepping just
        over the line does not immediately count as leaving. Only a clear departure does.
        """
        candidates = []
        for z in self.zones():
            if z.get("lat") is None or z.get("lon") is None:
                continue
            distance = haversine_m(lat, lon, z["lat"], z["lon"])
            limit = z["radius"] * (EXIT_HYSTERESIS if z["id"] == self.current else 1.0)
            if distance <= limit:
                candidates.append((distance, z["id"]))
        candidates.sort()
        return candidates[0][1] if candidates else None

    # ---- ingest --------------------------------------------------------
    def ingest(self, payload: dict[str, Any]) -> tuple[str | None, str | None]:
        """Take one OwnTracks report. Returns (previous, current) when presence changed."""
        kind = payload.get("_type")
        now = time.time()

        if kind == "location":
            lat, lon = payload.get("lat"), payload.get("lon")
            if lat is None or lon is None:
                return (None, None)
            accuracy = float(payload.get("acc") or 0)
            self.last_fix = {
                "lat": float(lat), "lon": float(lon), "acc": accuracy,
                "battery": payload.get("batt"), "ts": float(payload.get("tst") or now),
                "trigger": payload.get("t"),
            }
            self.store.set("last_fix", self.last_fix)
            # A 2km-accurate fix says nothing useful about a 150m zone.
            if accuracy and accuracy > MAX_ACCURACY_METRES:
                return (None, None)
            if not any(z.get("lat") is not None for z in self.zones()):
                return (None, None)   # no coordinates configured; transitions only
            return self._apply(self.zone_for(float(lat), float(lon)) or "away")

        if kind == "transition":
            # The phone's own geofence crossing — authoritative, and cheap on battery.
            name = str(payload.get("desc") or "").strip()
            zone_id = next(
                (z["id"] for z in self.zones() if z["name"].lower() == name.lower()),
                name.lower().replace(" ", "-") or None,
            )
            if not zone_id:
                return (None, None)
            if payload.get("event") == "enter":
                return self._apply(zone_id)
            # Leaving a zone only means "away" if it is the one we thought we were in.
            return self._apply("away") if self.current == zone_id else (None, None)

        return (None, None)

    def _apply(self, zone_id: str) -> tuple[str | None, str | None]:
        """Record a zone change and report it so the automations can run.

        There is deliberately NO rate limit here. A first attempt debounced changes inside a
        20s window, which collapsed bursts — but it also silently swallowed a real departure
        that happened to follow another change closely, leaving presence correct while the
        "leave" automation never ran. Losing a real event is worse than the flapping it
        prevented, and the flapping's actual cause (a fix sitting on the zone edge) is handled
        properly by EXIT_HYSTERESIS above.
        """
        if zone_id == self.current:
            return (None, None)
        previous, self.current = self.current, zone_id
        self._changed_at = time.time()
        self.store.set("presence", zone_id)
        return (previous, zone_id)

    # ---- reporting -----------------------------------------------------
    def describe(self) -> dict[str, Any]:
        fix = self.last_fix
        fresh = bool(fix and (time.time() - fix.get("ts", 0)) < STALE_AFTER_SECONDS)
        zone = next((z for z in self.zones() if z["id"] == self.current), None)
        return {
            "zone": self.current,
            "zone_name": zone["name"] if zone else ("Away" if self.current == "away" else self.current),
            "home": self.current not in ("away", "unknown"),
            "fresh": fresh,
            "last_fix": fix,
            "zones": self.zones(),
        }
