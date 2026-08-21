"""Runtime configuration, read from the environment with sane local defaults.

Everything here is overridable from docker-compose so the same image runs against a real
AC, a second AC, or nothing at all (demo mode) without a rebuild.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class ACConfig:
    """One Haier air conditioner reachable over the LAN."""

    id: str = "ac-living"
    name: str = _env("AC_NAME", "Living Room AC")
    room: str = _env("AC_ROOM", "Living Room")
    host: str = _env("AC_HOST", "192.168.1.36")
    # Wi-Fi module MAC, no separators. Also used to re-find the unit when DHCP moves it.
    device_id: str = _env("AC_DEVICE_ID", "94224C108338")
    # Per-device 32-hex localKey. Empty -> the driver reports "unconfigured" instead of failing,
    # and the hub falls back to a simulated device so the UI stays fully usable.
    local_key: str = _env("AC_LOCAL_KEY", "")
    # Optional product code selecting a per-model attribute profile. Empty = Haier-wide defaults.
    type_id: str = _env("AC_TYPE_ID", "")
    # Subnet swept when the AC is not answering on its last known address.
    subnet: str = _env("AC_SUBNET", "192.168.1.0/24")
    # Setpoint limits. The attribute profile advertises the protocol-wide 16..30, but a
    # given unit's own remote may allow less — this one is 20..28. Blank keeps the profile's
    # range, so a second AC is not forced into this one's limits.
    temp_min: str = _env("AC_TEMP_MIN", "")
    temp_max: str = _env("AC_TEMP_MAX", "")


@dataclass(frozen=True)
class HaierAccount:
    """Credentials used ONLY to re-fetch a rotated localKey. Kept in the environment (so in
    the gitignored stack/.env), never in the repo and never written to the hub's data file."""

    username: str = _env("HAIER_USERNAME", "")
    password: str = _env("HAIER_PASSWORD", "")
    # Dialling code of the country the ACCOUNT was registered in, not where the AC hangs.
    region: str = _env("HAIER_REGION", "20")


@dataclass(frozen=True)
class Settings:
    host: str = _env("HUB_BIND", "0.0.0.0")
    port: int = _env_int("HUB_PORT", 8110)
    data_dir: str = _env("HUB_DATA_DIR", "/data")
    # The standalone shell (index.html + ojee-ui + chrome.js). A mounted
    # console never asks for these; it supplies its own chrome.
    web_dir: str = _env("HUB_WEB_DIR", "/app/public")
    # The module itself: the UI entry point the console imports.
    ui_dir: str = _env("HUB_UI_DIR", "/app/ui")
    timezone: str = _env("TIMEZONE", "Africa/Cairo")

    # How often the coordinator opens a session to refresh device state. The AC caps a
    # session at ~17s and accepts only one at a time, so this is an open/close cycle, not
    # a persistent connection. Too low and the app fights the phone app for the socket.
    poll_seconds: int = _env_int("HUB_POLL_SECONDS", 45)
    # Seconds after a write during which we poll faster, to confirm the change landed.
    settle_seconds: int = _env_int("HUB_SETTLE_SECONDS", 6)
    # Keep this many entries in the activity log.
    activity_limit: int = _env_int("HUB_ACTIVITY_LIMIT", 300)

    # Set to "1" to force the simulated driver even when a localKey is present. Useful for
    # UI work without touching real hardware.
    demo: bool = _env("HUB_DEMO", "0") == "1"

    # Shared secret for the phone's location posts. The hub is already tailnet-only, so this
    # is a second lock rather than the only one; blank disables the check.
    location_token: str = _env("HOME_LOCATION_TOKEN", "")

    acs: tuple[ACConfig, ...] = field(default_factory=lambda: (ACConfig(),))
    account: HaierAccount = field(default_factory=HaierAccount)


SETTINGS = Settings()
