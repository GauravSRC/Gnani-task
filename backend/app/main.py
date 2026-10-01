"""FastAPI application: HTTP surface for the audio notes platform."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import Base, engine
from app import models  # noqa: F401  -- registers tables on Base.metadata

from pathlib import Path

from fastapi import Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app import storage
from app.db import get_db
from app.models import Recording, Status, SUPPORTED_LANGUAGES
from app.schemas import UploadAccepted

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
)
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Two tables and no destructive changes planned, so create_all is enough.
    # A schema that actually evolved would want Alembic instead.
    Base.metadata.create_all(bind=engine)
    log.info("tables ready")
    yield


app = FastAPI(title="Audio Notes API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    """Cheap liveness probe. The frontend calls this on load to wake a
    cold-started Render instance before the user tries to upload."""
    return {"status": "ok"}


@app.get("/")
def root() -> dict:
    return {"service": "Audio Notes API", "docs": "/docs", "health": "/health"}


# ffmpeg normalises all of these, so the list is wider than what Gnani
# accepts directly. Anything outside it is rejected before we spend a
# bucket write on it.
ALLOWED_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".ogg",
    ".opus", ".flac", ".webm", ".mp4", ".amr",
}


@app.get("/api/languages")
def languages() -> dict:
    """Drives the language dropdown, so the list lives in one place."""
    return {"languages": [{"code": c, "label": n} for c, n in SUPPORTED_LANGUAGES.items()]}


@app.post("/api/recordings", response_model=UploadAccepted, status_code=202)
async def create_recording(
    file: UploadFile = File(...),
    language_code: str = Form("en-IN"),
    db: Session = Depends(get_db),
) -> UploadAccepted:
    """Accept an upload and queue it.

    Everything slow happens later. This handler only validates, writes the
    original to the bucket and inserts a queued row, so it returns in a
    couple of seconds no matter how long the audio is.
    """
    if language_code not in SUPPORTED_LANGUAGES:
        raise HTTPException(400, f"Unsupported language '{language_code}'.")

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise HTTPException(400, f"Unsupported file type '{suffix or 'unknown'}'. Allowed: {allowed}")

    # Read in 1 MB pieces and stop at the cap, rather than buffering a
    # 2 GB file into memory only to reject it afterwards.
    data = bytearray()
    while piece := await file.read(1024 * 1024):
        data.extend(piece)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(413, f"File is larger than {settings.max_upload_mb} MB.")

    if len(data) < 1024:
        raise HTTPException(400, "File is empty or too small to contain audio.")

    recording = Recording(
        filename=(file.filename or "recording")[:255],
        content_type=file.content_type or "",
        size_bytes=len(data),
        language_code=language_code,
        storage_path="",
        status=Status.QUEUED,
        stage_detail="Waiting for a worker",
    )

    path = f"{recording.id}/original{suffix}"
    try:
        # storage.* is blocking httpx; off the event loop it goes.
        await run_in_threadpool(storage.upload, path, bytes(data), file.content_type or "")
    except storage.StorageError as exc:
        log.error("storage upload failed: %s", exc)
        raise HTTPException(502, "Could not store the file. Please try again.") from exc

    recording.storage_path = path
    db.add(recording)
    db.commit()

    log.info("queued %s (%s, %d bytes)", recording.id, recording.filename, len(data))
    return UploadAccepted(id=recording.id, status=recording.status)