"""FastAPI application: HTTP surface for the audio notes platform."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
)

app = FastAPI(title="Audio Notes API", version="0.1.0")

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