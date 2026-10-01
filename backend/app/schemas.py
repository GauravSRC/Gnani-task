"""Response shapes. Defined separately from the ORM models so the API contract
and the database schema can change independently."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ChunkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    chunk_index: int
    start_seconds: float
    end_seconds: float
    text: str
    is_done: bool


class RecordingSummary(BaseModel):
    """List-view payload: no transcript, no chunks, so the list stays small."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    language_code: str
    size_bytes: int
    duration_seconds: float | None
    status: str
    progress_percent: int
    created_at: datetime


class RecordingDetail(RecordingSummary):
    stage_detail: str
    chunks_total: int
    chunks_done: int
    transcript: str | None
    summary: str | None
    error_message: str | None
    audio_url: str | None = None
    chunks: list[ChunkOut] = []


class UploadAccepted(BaseModel):
    id: str
    status: str