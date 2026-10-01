"""FastAPI application: HTTP surface for the audio notes platform."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import Base, engine
from app import models  # noqa: F401  -- registers tables on Base.metadata

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