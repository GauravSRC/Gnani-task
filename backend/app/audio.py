"""Audio preparation for transcription.

Gnani's REST endpoint accepts at most 60 s per request (30 s is the documented
ideal, and one place in their spec lists 30 s as the maximum), so long uploads
are handled in two steps:

1. Decode whatever the user uploaded into one canonical format: 16 kHz, mono,
   16-bit PCM WAV. That is what Gnani resamples to internally anyway, and a
   single known format makes the splitting code simple.
2. Cut that WAV into consecutive chunks no longer than the limit.
"""

from __future__ import annotations

import logging
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import imageio_ffmpeg
import numpy as np

log = logging.getLogger("audio")

SAMPLE_RATE = 16_000
CHANNELS = 1

MIN_AUDIO_SECONDS = 0.5        # anything shorter can't contain a word
MAX_AUDIO_SECONDS = 3 * 3600   # protects API credits on a public, unauthenticated URL
MIN_TAIL_SECONDS = 2.0         # never leave a sub-word sliver as the last chunk
FFMPEG_TIMEOUT_SECONDS = 600


class AudioError(Exception):
    """Raised with a message that is safe to show to the user."""


@dataclass(frozen=True)
class ChunkSpec:
    index: int
    start: float  # seconds from the start of the recording
    end: float
    path: Path

    @property
    def duration(self) -> float:
        return self.end - self.start


def to_wav(src: Path, dst: Path) -> float:
    """Decode `src` into 16 kHz mono 16-bit WAV at `dst` and return its duration.

    ffmpeg comes from the imageio-ffmpeg wheel, which bundles a static binary
    for Windows and Linux, so nothing has to be installed system-wide.
    """
    if not src.exists():
        log.error("source file missing: %s", src)
        raise AudioError("The audio file could not be read.")
    cmd = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(src),
        "-vn",                    # drop any video stream (mp4, webm)
        "-ac", str(CHANNELS),
        "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        str(dst),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise AudioError("Converting the audio took too long. The file may be damaged.") from exc

    if result.returncode != 0 or not dst.exists():
        stderr_tail = result.stderr.decode(errors="replace").strip()[-500:]
        log.warning("ffmpeg exited with %s: %s", result.returncode, stderr_tail)
        raise AudioError("Couldn't decode this file. It may be corrupted or not actually audio.")

    duration = wav_duration(dst)
    if duration < MIN_AUDIO_SECONDS:
        raise AudioError("The recording is too short or contains no audio.")
    if duration > MAX_AUDIO_SECONDS:
        raise AudioError(
            f"Recordings longer than {MAX_AUDIO_SECONDS // 3600} hours aren't supported."
        )
    log.info("decoded %s -> %.1fs of 16 kHz mono audio", src.name, duration)
    return duration


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / wf.getframerate()


def split_wav(wav_path: Path, out_dir: Path, max_seconds: float) -> list[ChunkSpec]:
    """Cut a 16 kHz mono WAV into consecutive chunks of at most `max_seconds`.

    Chunks are contiguous: each starts exactly where the previous one ended,
    so no audio is dropped or sent twice. Only one chunk is held in memory at a
    time, so memory stays flat however long the recording is.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    specs: list[ChunkSpec] = []

    with wave.open(str(wav_path), "rb") as src:
        rate = src.getframerate()
        total = src.getnframes()
        max_frames = int(max_seconds * rate)
        min_tail = int(MIN_TAIL_SECONDS * rate)

        start = 0
        while start < total:
            if total - start <= max_frames:
                end = total
            else:
                # The furthest this chunk may reach, pulled back when needed
                # so the remainder is never shorter than MIN_TAIL_SECONDS.
                limit = min(start + max_frames, total - min_tail)
                end = max(start + 1, _choose_cut(src, start, limit, rate))

            src.setpos(start)
            frames = src.readframes(end - start)
            path = out_dir / f"chunk_{len(specs):04d}.wav"
            with wave.open(str(path), "wb") as dst:
                dst.setnchannels(src.getnchannels())
                dst.setsampwidth(src.getsampwidth())
                dst.setframerate(rate)
                dst.writeframes(frames)

            specs.append(ChunkSpec(len(specs), round(start / rate, 3), round(end / rate, 3), path))
            start = end

    log.info("split %s into %d chunk(s)", wav_path.name, len(specs))
    return specs


# --------------------------------------------------------------------------- cut selection

# A chunk boundary should fall in a pause, not mid-word. Within the last
# SEARCH_SECONDS before the limit, measure loudness in short windows and cut
# in the quietest one. 100 ms windows favour real pauses (between phrases,
# breaths) over the brief silences inside words, such as the closure before "p".
SEARCH_SECONDS = 10.0
WINDOW_MS = 100


def _choose_cut(src: wave.Wave_read, start: int, limit: int, rate: int) -> int:
    """Return the frame where the current chunk should end: the middle of the
    quietest 100 ms window in the 10 s before `limit`.

    On ties (a long silence), the latest quiet window wins. That keeps chunks
    long, which means fewer API calls. It's a heuristic: if someone talks for
    10 s without pausing, it degrades to a cut no worse than a fixed one.
    """
    search_from = max(start + 1, limit - int(SEARCH_SECONDS * rate))
    src.setpos(search_from)
    samples = np.frombuffer(src.readframes(limit - search_from), dtype="<i2").astype(np.float32)

    hop = rate * WINDOW_MS // 1000
    windows = len(samples) // hop
    if windows == 0:
        return limit

    rms = np.sqrt(np.mean(samples[: windows * hop].reshape(windows, hop) ** 2, axis=1))
    quietest = windows - 1 - int(np.argmin(rms[::-1]))
    return search_from + quietest * hop + hop // 2