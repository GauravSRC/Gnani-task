"""Supabase Storage access over its REST API.

Calling the REST endpoints with httpx instead of the supabase-py SDK keeps the
dependency list short and makes every request visible in this file. The
service_role key is used, so these calls bypass row-level security and must
never run anywhere but the backend.
"""

import logging
import time

import httpx

from app.config import settings

log = logging.getLogger("storage")

_ROOT = f"{settings.supabase_url.rstrip('/')}/storage/v1"
_BUCKET = settings.supabase_bucket
_AUTH = {
    "Authorization": f"Bearer {settings.supabase_service_key}",
    "apikey": settings.supabase_service_key,
}


class StorageError(RuntimeError):
    """Raised when the bucket rejects or fails a request."""


def upload(path: str, data: bytes, content_type: str = "") -> None:
    """Put an object at `path` inside the bucket. Overwrites if it exists."""
    resp = httpx.post(
        f"{_ROOT}/object/{_BUCKET}/{path}",
        content=data,
        headers={
            **_AUTH,
            "Content-Type": content_type or "application/octet-stream",
            "x-upsert": "true",
        },
        timeout=httpx.Timeout(120.0, connect=15.0),
    )
    if resp.status_code >= 300:
        raise StorageError(f"upload failed [{resp.status_code}] {resp.text[:300]}")
    log.info("uploaded %s (%d bytes)", path, len(data))


def download(path: str) -> bytes:
    """Fetch an object's bytes. The worker uses this to get the original audio."""
    resp = httpx.get(
        f"{_ROOT}/object/{_BUCKET}/{path}",
        headers=_AUTH,
        timeout=httpx.Timeout(120.0, connect=15.0),
    )
    if resp.status_code >= 300:
        raise StorageError(f"download failed [{resp.status_code}] {resp.text[:300]}")
    return resp.content


# A signed URL is good for an hour, but the detail endpoint is polled every
# two seconds while a job runs. Caching them turns ~30 sign requests a minute
# into one an hour per recording.
_URL_CACHE: dict[str, tuple[str, float]] = {}
_URL_REUSE_SECONDS = 3000  # under the 3600 s expiry, with room to spare


def signed_url(path: str, expires_in: int = 3600) -> str | None:
    """Time-limited public link, so the browser can play private audio back
    without the frontend ever holding a Supabase key. Returns None on failure —
    a missing player is not worth failing the whole detail request over."""
    now = time.monotonic()
    cached = _URL_CACHE.get(path)
    if cached is not None and cached[1] > now:
        return cached[0]

    try:
        resp = httpx.post(
            f"{_ROOT}/object/sign/{_BUCKET}/{path}",
            json={"expiresIn": expires_in},
            headers=_AUTH,
            timeout=20.0,
        )
        if resp.status_code >= 300:
            log.warning("sign failed [%s] %s", resp.status_code, resp.text[:200])
            return None
        body = resp.json()
        # Key casing has differed across Supabase versions; accept both.
        relative = body.get("signedURL") or body.get("signedUrl")
        if not relative:
            return None
        url = f"{_ROOT}{relative}" if relative.startswith("/") else f"{_ROOT}/{relative}"
    except httpx.HTTPError as exc:
        log.warning("sign error: %s", exc)
        return None

    if len(_URL_CACHE) > 500:
        _URL_CACHE.clear()  # one process, one bounded cache; no eviction policy needed
    _URL_CACHE[path] = (url, now + _URL_REUSE_SECONDS)
    return url


def delete(path: str) -> None:
    """Best-effort cleanup; never raises into a request path."""
    _URL_CACHE.pop(path, None)
    try:
        httpx.delete(f"{_ROOT}/object/{_BUCKET}/{path}", headers=_AUTH, timeout=20.0)
    except httpx.HTTPError as exc:
        log.warning("delete error for %s: %s", path, exc)