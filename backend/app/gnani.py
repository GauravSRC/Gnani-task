"""Client for Gnani's speech-to-text REST endpoint (POST /stt/v3).

One call transcribes one chunk. The interesting part is the failure policy:

- 429, 5xx, timeouts and connection errors are transient: retry with
  exponential backoff (2 s, 4 s, 8 s), honouring Retry-After on 429.
- 400, 401, 403 and other 4xx mean the request itself is wrong (bad audio,
  bad key, no credits). Retrying cannot fix that, so fail immediately.
"""

from __future__ import annotations

import logging
import random
import threading
import time

import httpx

from app.config import settings

log = logging.getLogger("gnani")

# Inverse Text Normalisation (numbers, currency, dates written as digits) is
# only supported for these two languages; the rest get verbatim output.
ITN_LANGUAGES = {"en-IN", "hi-IN"}

RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MAX_ATTEMPTS = 4
BACKOFF_BASE_SECONDS = 2.0
MAX_BACKOFF_SECONDS = 30.0

# One client for the whole process, so TCP/TLS connections are reused across
# chunks. The read timeout is generous for a 30 s clip; the connect timeout is
# short so an unreachable host fails fast.
_client = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))
# Requests are spaced out rather than fired as fast as chunks are ready.
# Sending two back to back returns 429, and recovering from that costs more
# than the wait would have. The lock keeps the gap correct if the worker is
# ever run with more than one thread.
_pace_lock = threading.Lock()
_last_request_at = 0.0


def _wait_for_slot() -> None:
    global _last_request_at
    with _pace_lock:
        gap = time.monotonic() - _last_request_at
        if gap < settings.gnani_min_gap_seconds:
            time.sleep(settings.gnani_min_gap_seconds - gap)
        _last_request_at = time.monotonic()


class GnaniError(Exception):
    """Transcription failure. The message is written to be shown to the user."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def transcribe(audio_bytes: bytes, language_code: str, filename: str = "chunk.wav") -> str:
    """Send one WAV chunk and return its transcript ('' if no speech was heard)."""
    if not settings.gnani_api_key:
        raise GnaniError("the server has no Gnani API key configured")

    form = {
        "language_code": language_code,
        "format": "transcribe" if language_code in ITN_LANGUAGES else "verbatim",
    }

    problem = "unknown error"
    for attempt in range(1, MAX_ATTEMPTS + 1):
        wait: float | None = None
        _wait_for_slot()
        try:
            resp = _client.post(
                settings.gnani_stt_url,
                headers={"X-API-Key-ID": settings.gnani_api_key},
                data=form,
                files={"audio_file": (filename, audio_bytes, "audio/wav")},
            )
        except httpx.TimeoutException:
            problem = "the speech service timed out"
        except httpx.TransportError as exc:
            problem = f"could not reach the speech service ({type(exc).__name__})"
        else:
            if resp.status_code == 200:
                return _read_transcript(resp)
            problem = _describe_failure(resp)
            if resp.status_code not in RETRYABLE_STATUS:
                raise GnaniError(problem, resp.status_code)
            wait = _retry_after(resp)

        if attempt < MAX_ATTEMPTS:
            delay = wait if wait is not None else BACKOFF_BASE_SECONDS * 2 ** (attempt - 1)
            delay = min(delay, MAX_BACKOFF_SECONDS) + random.uniform(0, 0.5)
            log.warning(
                "attempt %d/%d failed (%s); retrying in %.1fs",
                attempt, MAX_ATTEMPTS, problem, delay,
            )
            time.sleep(delay)

    raise GnaniError(f"{problem} (gave up after {MAX_ATTEMPTS} attempts)")


def _read_transcript(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError as exc:
        raise GnaniError("the speech service returned a response that isn't JSON") from exc
    if body.get("success") is False:
        raise GnaniError(f"the speech service reported a failure: {_error_text(body)}")
    # request_id is what Gnani support asks for when debugging a call.
    log.info("chunk transcribed (request_id=%s)", body.get("request_id"))
    return (body.get("transcript") or "").strip()


def _describe_failure(resp: httpx.Response) -> str:
    code = resp.status_code
    if code in (401, 403):
        return f"Gnani rejected the API key or the account is out of credits ({code})"
    if code == 429:
        return "Gnani's rate limit was hit (429)"
    if code >= 500:
        return f"the speech service had a temporary error ({code})"
    try:
        detail = _error_text(resp.json())
    except ValueError:
        detail = resp.text[:200] or "no details given"
    return f"Gnani rejected the audio ({code}): {detail}"


def _error_text(body: object) -> str:
    """Gnani's error bodies come in a few shapes; dig out the readable part."""
    if isinstance(body, dict):
        for key in ("error", "detail"):
            value = body.get(key)
            if isinstance(value, dict) and value.get("message"):
                return str(value["message"])
        if body.get("message"):
            return str(body["message"])
        for key in ("error", "detail"):
            if isinstance(body.get(key), str):
                return body[key]
    return "no details given"


def _retry_after(resp: httpx.Response) -> float | None:
    """Honour a Retry-After header (seconds form) when the server sends one."""
    try:
        return float(resp.headers["Retry-After"])
    except (KeyError, ValueError):
        return None