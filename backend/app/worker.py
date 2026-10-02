"""Background worker.

Postgres doubles as the job queue: a job is a `recordings` row with
status='queued'. The worker claims one with SELECT ... FOR UPDATE SKIP LOCKED,
which lets any number of workers poll the same table without two of them ever
taking the same row, then hands it to the pipeline.

Run it next to the API, from the backend/ folder:
    python -m app.worker
"""

from __future__ import annotations

import logging
import signal
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from app import audio, gnani, pipeline, storage, summarizer
from app.db import SessionLocal
from app.models import Recording, Status

log = logging.getLogger("worker")

POLL_SECONDS = 2.0                    # idle wait between queue checks
ERROR_BACKOFF_SECONDS = 10.0          # wait when the database itself misbehaves
SWEEP_EVERY_SECONDS = 60.0            # how often to look for abandoned jobs
STALE_AFTER = timedelta(minutes=15)   # no heartbeat for this long = worker died
MAX_ATTEMPTS = 3                      # stop retrying jobs that keep killing workers

# Exceptions whose message was written for the user. Anything else is a bug
# or an outage: the user gets a generic line and the traceback goes to the log.
KNOWN_ERRORS = (audio.AudioError, gnani.GnaniError, summarizer.SummaryError, pipeline.NoSpeechError)

_running = True


def claim_next_job() -> str | None:
    """Atomically move the oldest queued recording to 'converting' and return its id.

    The row lock only lives inside this short transaction. Once the status
    leaves 'queued' and we commit, no other worker's query can match the row.
    """
    with SessionLocal() as db:
        stmt = (
            select(Recording)
            .where(Recording.status == Status.QUEUED)
            .order_by(Recording.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        rec = db.scalars(stmt).first()
        if rec is None:
            return None
        rec.status = Status.CONVERTING
        rec.stage_detail = "Picked up by worker"
        rec.attempts += 1
        rec.heartbeat_at = _now()
        db.commit()
        return rec.id


def recover_stale_jobs() -> None:
    """Requeue jobs whose worker died mid-run (crash, redeploy, or the host
    putting the instance to sleep). Saved chunks are kept, so a requeued job
    resumes rather than restarts. A job that keeps dying is failed instead,
    so one bad file can't loop forever."""
    cutoff = _now() - STALE_AFTER
    with SessionLocal() as db:
        stmt = (
            select(Recording)
            .where(Recording.status.in_(Status.ACTIVE))
            .where(or_(Recording.heartbeat_at.is_(None), Recording.heartbeat_at < cutoff))
            .with_for_update(skip_locked=True)
        )
        for rec in db.scalars(stmt).all():
            if rec.attempts >= MAX_ATTEMPTS:
                rec.status = Status.FAILED
                rec.stage_detail = "Failed"
                rec.error_message = (
                    f"Processing was interrupted {rec.attempts} times, so it was stopped. "
                    "The file may be too large or unusual to process."
                )
                rec.finished_at = _now()
                log.warning("gave up on %s after %d attempts", rec.id, rec.attempts)
            else:
                rec.status = Status.QUEUED
                rec.stage_detail = "Requeued after an interrupted run"
                log.warning("requeued stale job %s", rec.id)
        db.commit()


def user_message(exc: Exception) -> str:
    if isinstance(exc, KNOWN_ERRORS):
        return str(exc)
    if isinstance(exc, storage.StorageError):
        return "Couldn't read the uploaded file back from storage. Please retry."
    return "Something went wrong on the server while processing. Please retry."


def mark_failed(recording_id: str, message: str) -> None:
    try:
        with SessionLocal() as db:
            rec = db.get(Recording, recording_id)
            if rec is None:
                return
            rec.status = Status.FAILED
            rec.stage_detail = "Failed"
            rec.error_message = message
            rec.finished_at = _now()
            db.commit()
    except Exception:
        # The database is unreachable too. The job stays 'active' with an
        # ageing heartbeat, so the stale sweep will pick it up later.
        log.exception("could not record failure for %s", recording_id)


def run_forever() -> None:
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    log.info("worker started, polling every %.0fs", POLL_SECONDS)

    last_sweep = 0.0
    while _running:
        try:
            if time.monotonic() - last_sweep >= SWEEP_EVERY_SECONDS:
                recover_stale_jobs()
                last_sweep = time.monotonic()
            job_id = claim_next_job()
        except Exception:
            log.exception("queue check failed; retrying in %.0fs", ERROR_BACKOFF_SECONDS)
            time.sleep(ERROR_BACKOFF_SECONDS)
            continue

        if job_id is None:
            time.sleep(POLL_SECONDS)
            continue

        log.info("job %s: started", job_id)
        started = time.monotonic()
        try:
            pipeline.process(job_id)
            log.info("job %s: completed in %.1fs", job_id, time.monotonic() - started)
        except Exception as exc:
            if isinstance(exc, KNOWN_ERRORS):
                log.warning("job %s: failed: %s", job_id, exc)
            else:
                log.exception("job %s: crashed", job_id)
            mark_failed(job_id, user_message(exc))

    log.info("worker stopped")


def _request_stop(signum, frame) -> None:
    """First Ctrl+C: finish the current job, then exit. Second: exit now."""
    global _running
    if not _running:
        raise KeyboardInterrupt
    _running = False
    log.info("stop requested; finishing the current job first (Ctrl+C again to force)")


def _now() -> datetime:
    return datetime.now(timezone.utc)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-8s %(name)s | %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    # The SDK warns about automatic function calling on every call; we use no tools.
    logging.getLogger("google_genai.models").setLevel(logging.ERROR)
    try:
        run_forever()
    except KeyboardInterrupt:
        log.info("worker force-stopped")