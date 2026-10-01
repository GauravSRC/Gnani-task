"""Process one recording end to end:

    bucket -> 16 kHz WAV -> chunks of 30 s or less -> Gnani per chunk -> Gemini -> done

Every step commits before moving on. That gives the polling frontend live
progress, and it means a job that fails (or whose worker dies) resumes from
the last chunk that succeeded instead of re-transcribing, and re-paying for,
the whole file.
"""

from __future__ import annotations

import logging
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import audio, gnani, storage, summarizer
from app.config import settings
from app.db import SessionLocal
from app.models import SUPPORTED_LANGUAGES, Chunk, Recording, Status

log = logging.getLogger("pipeline")


class NoSpeechError(Exception):
    """Every chunk came back empty."""


def process(recording_id: str) -> None:
    """Run (or resume) the pipeline for one recording.

    Raises on failure. Recording the failure is the caller's job, so this
    function stays focused on the happy path.
    """
    with SessionLocal() as db:
        rec = db.get(Recording, recording_id)
        if rec is None:
            log.warning("recording %s no longer exists; skipping", recording_id)
            return

        chunks = _load_chunks(db, rec.id)
        if chunks and all(c.is_done for c in chunks):
            # Typical after a summary failure: no need to touch audio again.
            log.info("%s: all %d chunks already transcribed; going straight to the summary",
                     rec.id, len(chunks))
        else:
            _transcribe(db, rec)
            chunks = _load_chunks(db, rec.id)

        transcript = " ".join(c.text for c in chunks if c.text).strip()
        if not transcript:
            raise NoSpeechError("No speech was detected in this recording.")

        # Saved before summarising, so a summary failure still leaves the
        # user with a usable transcript.
        rec.transcript = transcript
        _save(db, rec, status=Status.SUMMARIZING, detail="Writing the summary")

        language = SUPPORTED_LANGUAGES.get(rec.language_code, rec.language_code)
        try:
            rec.summary = summarizer.summarize(transcript, language)
        except summarizer.SummaryError as exc:
            raise summarizer.SummaryError(
                f"The transcript is ready, but the summary failed: {exc}. "
                "Press Retry to try the summary again."
            ) from exc

        rec.error_message = None
        rec.finished_at = _now()
        _save(db, rec, status=Status.COMPLETED, detail="Done")


def _transcribe(db: Session, rec: Recording) -> None:
    # Scratch files live only for the duration of the job.
    with tempfile.TemporaryDirectory(prefix="audionotes_", ignore_cleanup_errors=True) as tmp:
        workdir = Path(tmp)

        _save(db, rec, status=Status.CONVERTING, detail="Downloading the upload")
        source = workdir / f"source{Path(rec.storage_path).suffix}"
        source.write_bytes(storage.download(rec.storage_path))

        _save(db, rec, detail="Converting to 16 kHz mono audio")
        wav = workdir / "full.wav"
        rec.duration_seconds = audio.to_wav(source, wav)

        _save(db, rec, detail="Splitting into chunks")
        specs = audio.split_wav(wav, workdir / "chunks", max_seconds=settings.chunk_seconds)
        rows = _sync_chunk_rows(db, rec, specs)

        total = len(specs)
        rec.chunks_total = total
        rec.chunks_done = sum(1 for row in rows if row.is_done)
        _save(db, rec, status=Status.TRANSCRIBING, detail=f"Transcribing {total} chunk(s)")

        for spec, row in zip(specs, rows):
            if row.is_done:
                continue  # transcribed on an earlier attempt
            _save(db, rec, detail=f"Transcribing chunk {spec.index + 1} of {total}")
            try:
                text = gnani.transcribe(
                    spec.path.read_bytes(),
                    rec.language_code,
                    filename=f"{rec.id}_{spec.index:04d}.wav",
                )
            except gnani.GnaniError as exc:
                raise gnani.GnaniError(
                    f"Transcription failed on chunk {spec.index + 1} of {total}: {exc}.",
                    exc.status_code,
                ) from exc

            row.text = text
            row.is_done = True
            rec.chunks_done += 1
            _save(db, rec)


def _sync_chunk_rows(db: Session, rec: Recording, specs: list[audio.ChunkSpec]) -> list[Chunk]:
    """Reuse saved chunk rows when they describe the same cut points (a retry);
    otherwise replace them (first run, or the chunking logic changed since)."""
    existing = _load_chunks(db, rec.id)
    same_layout = len(existing) == len(specs) and all(
        row.chunk_index == spec.index
        and abs(row.start_seconds - spec.start) < 0.01
        and abs(row.end_seconds - spec.end) < 0.01
        for row, spec in zip(existing, specs)
    )
    if same_layout:
        return existing

    if existing:
        log.info("%s: chunk layout changed; discarding %d saved chunk(s)", rec.id, len(existing))
    db.execute(delete(Chunk).where(Chunk.recording_id == rec.id))
    rows = [
        Chunk(
            recording_id=rec.id,
            chunk_index=spec.index,
            start_seconds=spec.start,
            end_seconds=spec.end,
            text="",
            is_done=False,
        )
        for spec in specs
    ]
    db.add_all(rows)
    db.commit()
    return rows


def _load_chunks(db: Session, recording_id: str) -> list[Chunk]:
    stmt = select(Chunk).where(Chunk.recording_id == recording_id).order_by(Chunk.chunk_index)
    return list(db.scalars(stmt))


def _save(db: Session, rec: Recording, *, status: str | None = None,
          detail: str | None = None) -> None:
    """Commit progress and refresh the heartbeat. The heartbeat is how the
    worker tells a slow job from a dead one."""
    if status is not None:
        rec.status = status
    if detail is not None:
        rec.stage_detail = detail
    rec.heartbeat_at = _now()
    db.commit()


def _now() -> datetime:
    return datetime.now(timezone.utc)


if __name__ == "__main__":
    # Debug helper: run one recording by hand, bypassing the queue.
    #   python -m app.pipeline <recording_id>
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)-8s %(name)s | %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.pipeline <recording_id>")
    process(sys.argv[1])