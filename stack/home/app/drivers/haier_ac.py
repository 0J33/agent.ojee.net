"""Haier air conditioner over the local uSS/HRDP protocol (TCP 56800).

Wraps `haismart_hrdp` so the rest of the hub never sees a byte of the wire format.

Beyond plain calls this layer is responsible for:

* **Serialising access.** The AC accepts exactly one local session at a time and caps it at
  ~17 seconds. Every entry point assumes the caller holds the hub's per-device lock.
* **Rediscovery.** DHCP moves the unit; a failed connect re-finds it by sweeping the subnet
  and confirming identity with a key-free handshake against the configured MAC.
* **Read-modify-write.** grSetDAC is a *group* set — sending one attribute sends all of
  them. Every write is seeded from the AC's own live status inside the same session, which
  is why commands batch into a single frame.
* **Capabilities from the device, not from a guess.** The temperature range, mode list and
  fan list come from the unit's own attribute profile, and heat is offered only when the
  unit reports `heat_capable`. On the reference unit here (HSU-12KCRIC(IN), AACDK1Z00) that
  flag is False — advertising a generic Heat button would have produced a control that
  always failed.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Any

import haismart_hrdp as h

from .base import Capability, Driver

PORT = 56800

MODE_LABELS = {"auto": "Auto", "cool": "Cool", "dry": "Dry", "heat": "Heat", "fan_only": "Fan"}
FAN_LABELS = {"auto": "Auto", "low": "Low", "medium": "Med", "high": "High"}
ECO_LABELS = {"off": "Off", "level1": "Eco 1", "level2": "Eco 2", "level3": "Eco 3"}

#: Order the UI should present them in, filtered to what the profile actually declares.
MODE_ORDER = ["auto", "cool", "dry", "heat", "fan_only"]
FAN_ORDER = ["auto", "low", "medium", "high"]
ECO_ORDER = ["off", "level1", "level2", "level3"]

#: our attribute name -> grSetDAC field, for the plain on/off controls
_BOOL_FIELDS = {
    "power": "onOffStatus",
    "quiet": "muteStatus",
    "turbo": "rapidMode",
    "health": "healthMode",
    "sleep": "silentSleepStatus",
    "display": "screenDisplayStatus",
}

#: our attribute name -> key in `parse_full_status` output. The library reports snake_case
#: semantic names, NOT the canonical camelCase wire names — reading the wire names silently
#: yields nothing, which is how the indoor/outdoor sensors first came back as null.
_READ_MAP = {
    "power": "power",
    "mode": "mode",
    "target_temperature": "target_temperature",
    "fan": "fan_mode",
    "swing_vertical": "swing_vertical",
    "swing_horizontal": "swing_horizontal",
    "turbo": "strong",
    "quiet": "quiet",
    "sleep": "sleep",
    "health": "health",
    "display": "lamp",
    "self_cleaning": "self_cleaning",
    "indoor_temperature": "current_temperature",
    "outdoor_temperature": "outdoor_temperature",
    "error_code": "error_code",
    "last_changed_by": "last_changed_by",
}


class CommandError(ValueError):
    """Raised for a command the device cannot accept — surfaced to the client as a 400."""


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "on", "true", "yes"}
    return False


def _as_float(value: Any) -> float | None:
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None


class Spec:
    """What this particular unit can be asked to do. Built from its attribute profile plus
    the live `heat_capable` flag, so the UI and the validator never disagree with hardware."""

    def __init__(self, modes: list[str], fans: list[str], eco: list[str],
                 tmin: float, tmax: float, step: float) -> None:
        self.modes, self.fans, self.eco = modes, fans, eco
        self.tmin, self.tmax, self.step = tmin, tmax, step

    @classmethod
    def from_profile(cls, profile, heat_capable: bool | None,
                     temp_min: float | None = None, temp_max: float | None = None) -> "Spec":
        declared = {str(v) for v in (profile.mode_values or {}).values()}
        modes = [m for m in MODE_ORDER if m in declared] or ["auto", "cool", "dry", "fan_only"]
        # heat_capable is the unit's own answer; only drop heat when it says False outright.
        if heat_capable is False and "heat" in modes:
            modes = [m for m in modes if m != "heat"]
        declared_fans = {str(v) for v in (profile.fan_values or {}).values()}
        fans = [f for f in FAN_ORDER if f in declared_fans] or FAN_ORDER
        # The profile's range is the protocol-wide 16..30; a specific unit's remote may be
        # narrower, so an explicit override wins. Clamped into the profile range so a typo
        # cannot ask the AC for a value the wire format refuses.
        low = float(profile.min_temp or 16)
        high = float(profile.max_temp or 30)
        if temp_min is not None:
            low = max(low, float(temp_min))
        if temp_max is not None:
            high = min(high, float(temp_max))
        if low > high:
            low, high = float(profile.min_temp or 16), float(profile.max_temp or 30)
        return cls(modes, fans, list(ECO_ORDER), low, high, float(profile.temp_step or 1))


DEFAULT_SPEC = Spec(list(MODE_ORDER), list(FAN_ORDER), list(ECO_ORDER), 16.0, 30.0, 1.0)


def build_capabilities(spec: Spec) -> list[Capability]:
    """The capability list the UI renders from. Generated, not hardcoded, so a unit without
    heat simply has no Heat button rather than a button that errors."""
    return [
        Capability("power", "Power", "switch", icon="power"),
        Capability(
            "mode", "Mode", "enum",
            options=[{"value": m, "label": MODE_LABELS[m]} for m in spec.modes],
            needs_power=True, icon="mode",
        ),
        Capability(
            "target_temperature", "Setpoint", "range",
            minimum=spec.tmin, maximum=spec.tmax, step=spec.step, unit="°C",
            needs_power=True, icon="temp",
        ),
        Capability(
            "fan", "Fan", "enum",
            options=[{"value": f, "label": FAN_LABELS[f]} for f in spec.fans],
            needs_power=True, icon="fan",
        ),
        Capability("swing_vertical", "Swing Vert", "switch", needs_power=True, icon="swing-v"),
        Capability("swing_horizontal", "Swing Horiz", "switch", needs_power=True, icon="swing-h"),
        Capability(
            "eco", "Eco", "enum",
            options=[{"value": e, "label": ECO_LABELS[e]} for e in spec.eco],
            needs_power=True, icon="eco",
            hint="Power limit. Each level caps the compressor current harder — higher saves "
                 "more, cools more slowly. 3 is the strictest.",
        ),
        Capability("turbo", "Turbo", "switch", needs_power=True, icon="turbo"),
        Capability("quiet", "Quiet", "switch", needs_power=True, icon="quiet"),
        Capability("sleep", "Sleep", "switch", needs_power=True, icon="sleep"),
        Capability("health", "Health", "switch", needs_power=True, icon="health"),
        Capability("display", "Display", "switch", icon="display"),
        # Start-only: the cycle runs to completion and there is no stop command, so this is
        # an action rather than a switch.
        Capability("self_clean", "Self-clean", "action", icon="clean",
                   hint="Freezes then thaws the coil to flush dust off it. Runs to completion "
                        "and cannot be stopped."),
        Capability("indoor_temperature", "Indoor", "readout", unit="°C", icon="indoor",
                   hint="Return-air sensor in the indoor unit."),
        # Deliberately NOT called "Outdoor": this is a thermistor on the outdoor unit, next to
        # the condenser coil — not a shaded ambient air sensor. With the compressor running it
        # reads well above the real outside temperature (observed 37 °C against an actual 28 °C
        # ambient), and it drifts up the longer the unit runs. The official app shows the same
        # byte with a slightly different offset (101-64=37 here vs 101-66=35 there), so neither
        # figure is the weather. Labelling it "Outdoor" invited exactly that misreading.
        Capability("outdoor_temperature", "Outdoor unit", "readout", unit="°C", icon="outdoor",
                   hint="Coil sensor on the outdoor unit, not outside air. Runs well above "
                        "ambient whenever the compressor is on."),
    ]


def validate_ac_command(command: dict[str, Any], spec: Spec = DEFAULT_SPEC) -> dict[str, Any]:
    """Check and normalise a command against what this unit accepts.

    Shared by the real driver and the simulator on purpose: if the two disagreed about what
    is acceptable, every test against the simulator would be testing the wrong thing.
    """
    cleaned: dict[str, Any] = {}
    for key, value in command.items():
        if key == "mode":
            if str(value) not in spec.modes:
                raise CommandError(f"mode must be one of {spec.modes} on this unit")
            cleaned[key] = str(value)
        elif key == "fan":
            if str(value) not in spec.fans:
                raise CommandError(f"fan must be one of {spec.fans}")
            cleaned[key] = str(value)
        elif key == "eco":
            if str(value) not in spec.eco:
                raise CommandError(f"eco must be one of {spec.eco}")
            cleaned[key] = str(value)
        elif key == "target_temperature":
            try:
                celsius = float(value)
            except (TypeError, ValueError) as exc:
                raise CommandError("target_temperature must be a number") from exc
            if not spec.tmin <= celsius <= spec.tmax:
                raise CommandError(f"target_temperature must be {spec.tmin:g}..{spec.tmax:g} °C")
            cleaned[key] = int(round(celsius))
        elif key == "self_clean":
            if not _as_bool(value):
                raise CommandError("self_clean can only be started, not stopped")
            cleaned[key] = True
        elif key in ("swing_vertical", "swing_horizontal") or key in _BOOL_FIELDS:
            cleaned[key] = _as_bool(value)
        else:
            raise KeyError(f"unknown attribute {key!r}")
    return cleaned


class HaierAC(Driver):
    kind = "air_conditioner"

    def __init__(self, cfg) -> None:  # cfg: app.config.ACConfig
        super().__init__()
        self.id = cfg.id
        self.name = cfg.name
        self.room = cfg.room
        self.host = cfg.host
        self.device_id = cfg.device_id.replace(":", "").replace("-", "").upper()
        self.local_key = cfg.local_key
        self.type_id = cfg.type_id or None
        self.subnet = cfg.subnet
        self.profile = h.profile_for(self.type_id)
        self.model: str = ""
        self.heat_capable: bool | None = None
        self.temp_min = float(cfg.temp_min) if str(cfg.temp_min).strip() else None
        self.temp_max = float(cfg.temp_max) if str(cfg.temp_max).strip() else None
        self.spec = Spec.from_profile(self.profile, None, self.temp_min, self.temp_max)
        self.localkey_version: int | None = None
        self._counter = 1
        self.state = {
            "power": False, "mode": "cool", "target_temperature": 24, "fan": "auto",
            "swing_vertical": False, "swing_horizontal": False, "eco": "off",
            "quiet": False, "turbo": False, "sleep": False, "health": False, "display": True,
            "self_cleaning": False,
            "indoor_temperature": None, "outdoor_temperature": None,
            "error_code": 0, "last_changed_by": None,
        }

    def capabilities(self) -> list[Capability]:
        return build_capabilities(self.spec)

    def describe(self) -> dict[str, Any]:
        data = super().describe()
        data["transport"] = {
            "host": self.host, "port": PORT, "device_id": self.device_id,
            "localkey_version": self.localkey_version,
            "key_configured": bool(self.local_key),
            "type_id": self.type_id or "generic",
            "heat_capable": self.heat_capable,
        }
        return data

    # ---- discovery -----------------------------------------------------
    def _port_open(self, ip: str, timeout: float = 0.6) -> bool:
        try:
            with socket.create_connection((ip, PORT), timeout=timeout):
                return True
        except OSError:
            return False

    def _rediscover(self) -> str | None:
        if self._port_open(self.host):
            return self.host
        try:
            network = ipaddress.ip_network(self.subnet, strict=False)
        except ValueError:
            return None
        for candidate in network.hosts():
            ip = str(candidate)
            if ip == self.host or not self._port_open(ip, timeout=0.25):
                continue
            try:
                self.localkey_version = h.probe_localkey_version(ip, self.device_id)
            except Exception:
                continue
            return ip
        return None

    # ---- read ----------------------------------------------------------
    def _read_blocking(self) -> dict[str, Any]:
        raw = h.read_status(self.host, self.device_id, self.local_key)
        blobs = [b for b in raw if h.derive_status_layout(b) is not None]
        if not blobs:
            version = h.probe_localkey_version(self.host, self.device_id)
            self.localkey_version = version
            if raw:
                raise RuntimeError(
                    f"decrypted {len(raw)} payload(s) but none is a recognised status report "
                    f"(lengths {sorted(len(b) for b in raw)}); the key is fine (v{version}) but "
                    "this model's report layout is not mapped"
                )
            raise RuntimeError(
                f"localKey did not decrypt — the AC is on localKey version {version}. "
                "Keys rotate server-side; re-run ./fetch-key.sh."
            )
        return h.parse_full_status(blobs[-1], self.profile)

    def _ingest(self, status: dict[str, Any]) -> None:
        for ours, theirs in _READ_MAP.items():
            if theirs not in status or status[theirs] is None:
                continue
            value = status[theirs]
            if ours in ("indoor_temperature", "outdoor_temperature"):
                self.state[ours] = _as_float(value)
            elif ours == "target_temperature":
                number = _as_float(value)
                if number is not None:
                    self.state[ours] = int(round(number))
            elif ours in ("mode", "fan", "last_changed_by"):
                self.state[ours] = str(value)
            elif ours == "error_code":
                self.state[ours] = int(value or 0)
            else:
                self.state[ours] = _as_bool(value)

        eco = status.get("eco")
        if eco is not None:
            self.state["eco"] = {0: "off", 5: "level1", 6: "level2", 7: "level3"}.get(
                int(eco) if not isinstance(eco, str) else -1, str(eco) if isinstance(eco, str) else "off"
            )

        # The unit tells us whether it can heat; regenerate the control surface from that so
        # the UI never offers a mode this hardware would refuse.
        heat = status.get("heat_capable")
        if heat is not None and heat != self.heat_capable:
            self.heat_capable = bool(heat)
            self.spec = Spec.from_profile(self.profile, self.heat_capable,
                                          self.temp_min, self.temp_max)

    async def refresh(self) -> None:
        if not self.local_key:
            self._mark_bad("unconfigured", "no localKey — run ./fetch-key.sh, see SETUP.md")
            return
        loop = asyncio.get_running_loop()
        try:
            status = await loop.run_in_executor(None, self._read_blocking)
        except (OSError, socket.timeout):
            found = await loop.run_in_executor(None, self._rediscover)
            if not found:
                self._mark_bad("unreachable",
                               f"no answer on {self.host}:{PORT} and none found on {self.subnet}")
                return
            self.host = found
            try:
                status = await loop.run_in_executor(None, self._read_blocking)
            except Exception as exc:  # noqa: BLE001 - surfaced to the UI, must not kill the loop
                self._mark_bad("error", f"{type(exc).__name__}: {exc}")
                return
        except Exception as exc:  # noqa: BLE001
            self._mark_bad("error", f"{type(exc).__name__}: {exc}")
            return
        self._ingest(status)
        self._mark_ok()

    # ---- write ---------------------------------------------------------
    def _encode(self, command: dict[str, Any]) -> list[tuple[str, int]]:
        pairs: list[tuple[str, int]] = []
        for key, value in validate_ac_command(command, self.spec).items():
            if key == "mode":
                pairs.append(("operationMode", h.GRSETDAC_ENUMS["operationMode"][value]))
            elif key == "fan":
                pairs.append(("windSpeed", h.GRSETDAC_ENUMS["windSpeed"][value]))
            elif key == "eco":
                pairs.append(("ecoMode", h.GRSETDAC_ENUMS["ecoMode"][value]))
            elif key == "target_temperature":
                pairs.append(("targetTemperature", value - 16))
            elif key == "swing_vertical":
                pairs.append(("windDirectionVertical", 0x0C if value else 0x00))
            elif key == "swing_horizontal":
                pairs.append(("windDirectionHorizontal", 0x07 if value else 0x00))
            elif key == "self_clean":
                pairs.append(("selfCleaningStatus", 1))
            else:
                pairs.append((_BOOL_FIELDS[key], 1 if value else 0))
        return pairs

    async def apply(self, command: dict[str, Any]) -> None:
        if not self.local_key:
            raise RuntimeError("no localKey configured — this AC is read-only until one is set")
        pairs = self._encode(command)
        if not pairs:
            return

        def build(status_blob: bytes | None) -> bytes:
            if status_blob is None:
                raise RuntimeError("the AC did not push a status baseline to seed the change")
            words = h.grsetdac_baseline_from_status(status_blob)
            for field, epp in pairs:
                words = h.set_grsetdac_field(words, field, epp)
            return h.grsetdac_op_frame(words)

        replies = await h.async_send_op(
            self.host, self.device_id, self.local_key, counter=self._counter, build_frame=build,
        )
        self._counter += 1
        confirmed = [b for b in replies if h.derive_status_layout(b) is not None]
        if confirmed:
            self._ingest(h.parse_full_status(confirmed[-1], self.profile))
            self._mark_ok()
        else:
            # The write went out but the unit did not echo a decodable status. Apply
            # optimistically; the next poll is the source of truth.
            for key, value in validate_ac_command(command, self.spec).items():
                if key != "self_clean":
                    self.state[key] = value
