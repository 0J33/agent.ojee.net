"""Fetch a device's localKey from the Haier cloud, so a rotation heals itself.

Haier rotates the per-device key server-side. The trigger is not documented — a scheduled
auto-off did it once here — so rather than try to predict *when*, the hub reacts to the fact:
any read or command that fails to decrypt asks this module for a fresh key and retries.

The account password lives in the environment (and therefore in the gitignored `stack/.env`),
never in the repo and never in the hub's data file. Only the resulting device key is persisted.
"""
from __future__ import annotations

import asyncio
import logging
import time

LOGGER = logging.getLogger("home.keyfetch")

#: Never hammer the cloud. A rotation is rare; a broken password is not, and retrying that in a
#: poll loop would lock the account rather than fix anything.
MIN_INTERVAL_SECONDS = 300.0
#: Give up re-trying after this many consecutive failures until something changes.
MAX_CONSECUTIVE_FAILURES = 3


class KeyFetchError(RuntimeError):
    """A key fetch did not happen. `transient` marks the expected backoff cases (rate limit),
    which a caller should stay quiet about rather than log as a failure every poll."""

    def __init__(self, message: str, *, transient: bool = False) -> None:
        self.transient = transient
        super().__init__(message)


class KeyFetcher:
    """Rate-limited wrapper around the cloud sign-in + gateway key fetch."""

    def __init__(self, username: str, password: str, region: str) -> None:
        self.username = username
        self.password = password
        self.region = str(region).strip().lstrip("+")
        self._last_attempt = 0.0
        self._failures = 0
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.username and self.password)

    def _blocked(self) -> tuple[str | None, bool]:
        """(reason, is_transient). Transient means "expected, will resolve on its own"."""
        if not self.configured:
            return "no HAIER_USERNAME/HAIER_PASSWORD configured", True
        if self._failures >= MAX_CONSECUTIVE_FAILURES:
            return (f"gave up after {self._failures} consecutive failures — check the account "
                    "credentials, then restart the hub"), False
        waited = time.time() - self._last_attempt
        if waited < MIN_INTERVAL_SECONDS:
            return f"rate-limited, {int(MIN_INTERVAL_SECONDS - waited)}s to go", True
        return None, False

    async def fetch(self, device_id: str) -> tuple[str, int | None]:
        """Return (localKey, version) for `device_id`. Raises KeyFetchError."""
        async with self._lock:
            blocked, transient = self._blocked()
            if blocked:
                raise KeyFetchError(blocked, transient=transient)
            self._last_attempt = time.time()
            try:
                key, version = await self._fetch(device_id)
            except Exception as exc:  # noqa: BLE001 - every failure mode is reported the same way
                self._failures += 1
                raise KeyFetchError(f"{type(exc).__name__}: {exc}") from exc
            self._failures = 0
            return key, version

    async def _fetch(self, device_id: str) -> tuple[str, int | None]:
        # Imported here, not at module scope: the extractor pulls in httpx and is only needed
        # when a key actually has to be fetched. A hub with no credentials should not fail to
        # start because of it.
        from haismart_extractor import GatewayClient, GatewayCreds, HaierCloud, SEA_APP_CREDENTIALS

        client, result = await HaierCloud.login(
            SEA_APP_CREDENTIALS, self.username, self.password, zone_info=self.region,
        )
        wanted = "".join(c for c in device_id if c.isalnum()).upper()

        creds = GatewayCreds.derive(
            usdk_client_id=result.client_id, access_token=result.access_token,
        )
        # get_localkeys is blocking (MQTT over a socket), so keep it off the event loop.
        keys = await asyncio.to_thread(
            GatewayClient(creds).get_localkeys, [wanted], timeout=15.0,
        )
        entry = keys.get(wanted)
        if entry is None:
            # Signing in worked, so say so — the natural next move on a bare failure is to go
            # and re-check a password that has just been proven correct.
            raise KeyFetchError(
                f"signed in fine, but no key came back for {wanted}. An appliance that is "
                "offline, or cut off from Haier, cannot be issued one."
            )
        LOGGER.info("fetched localKey v%s for %s", entry.version, wanted)
        return entry.key, entry.version
