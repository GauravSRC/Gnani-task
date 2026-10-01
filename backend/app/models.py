"""Database tables.

Two tables. `recordings` is one row per upload and carries the job state the
worker advances. `chunks` is one row per audio slice, which is what makes
partial progress and resume-after-failure possible.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Status:
    """Job lifecycle. Stored as plain strings, not a Postgres enum type, so
    adding a stage later is a code change rather than a schema migration."""

    QUEUED = "queued"
    CONVERTING = "converting"
    TRANSCRIBING = "transcribing"
    SUMMARIZING = "summarizing"
    COMPLETED = "completed"
    FAILED = "failed"

    ACTIVE = (CONVERTING, TRANSCRIBING, SUMMARIZING)
    TERMINAL = (COMPLETED, FAILED)


# Gnani REST supports these ten. Anything else is rejected at upload.
SUPPORTED_LANGUAGES: dict[str, str] = {
    "en-IN": "English (India)",
    "hi-IN": "Hindi",
    "bn-IN": "Bengali",
    "gu-IN": "Gujarati",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "mr-IN": "Marathi",
    "pa-IN": "Punjabi",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
}


def new_id() -> str:
    return uuid.uuid4().hex


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)

    # What the user gave us
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100), default="")
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    language_code: Mapped[str] = mapped_column(String(10), default="en-IN")

    # Where the original lives in the bucket
    storage_path: Mapped[str] = mapped_column(String(500))
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Job state
    status: Mapped[str] = mapped_column(String(20), default=Status.QUEUED, index=True)
    stage_detail: Mapped[str] = mapped_column(String(200), default="")
    chunks_total: Mapped[int] = mapped_column(Integer, default=0)
    chunks_done: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)

    # Results
    transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Timestamps. heartbeat_at lets a restarted worker spot jobs that were
    # left mid-flight by a crashed one and requeue them.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    chunks: Mapped[list["Chunk"]] = relationship(
        back_populates="recording",
        cascade="all, delete-orphan",
        order_by="Chunk.chunk_index",
    )

    @property
    def progress_percent(self) -> int:
        if self.status == Status.COMPLETED:
            return 100
        if self.status == Status.QUEUED:
            return 0
        if self.chunks_total <= 0:
            return 5
        # Transcription is the long part, so it owns 10-85% of the bar.
        return 10 + int(75 * self.chunks_done / self.chunks_total)


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (
        UniqueConstraint("recording_id", "chunk_index", name="uq_chunk_position"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )

    chunk_index: Mapped[int] = mapped_column(Integer)
    start_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    end_seconds: Mapped[float] = mapped_column(Float, default=0.0)

    text: Mapped[str] = mapped_column(Text, default="")
    is_done: Mapped[bool] = mapped_column(default=False)

    recording: Mapped[Recording] = relationship(back_populates="chunks")