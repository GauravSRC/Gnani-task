"""Tests for decoding and chunking. They run the real bundled ffmpeg on
synthetic signals, so they need no sample files and no network access."""

import wave
from pathlib import Path

import numpy as np
import pytest

from app import audio

RATE = 16_000


def _write_wav(path: Path, samples: np.ndarray, rate: int = RATE, channels: int = 1) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())


def _tone(seconds: float, rate: int = RATE) -> np.ndarray:
    """A steady loud tone, standing in for continuous speech."""
    t = np.arange(int(seconds * rate)) / rate
    return 0.5 * np.sin(2 * np.pi * 220 * t)


def _silence(seconds: float, rate: int = RATE) -> np.ndarray:
    return np.zeros(int(seconds * rate))


def test_to_wav_normalises_to_16k_mono(tmp_path):
    mono = _tone(3.0, rate=44_100)
    stereo = np.repeat(mono[:, None], 2, axis=1).ravel()  # interleave L/R
    src = tmp_path / "in.wav"
    _write_wav(src, stereo, rate=44_100, channels=2)

    dst = tmp_path / "out.wav"
    duration = audio.to_wav(src, dst)

    with wave.open(str(dst), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getframerate() == 16_000
        assert wf.getsampwidth() == 2
    assert duration == pytest.approx(3.0, abs=0.05)


def test_to_wav_rejects_non_audio(tmp_path):
    src = tmp_path / "fake.mp3"
    src.write_bytes(b"this is definitely not audio " * 100)
    with pytest.raises(audio.AudioError):
        audio.to_wav(src, tmp_path / "out.wav")


def test_to_wav_rejects_too_short(tmp_path):
    src = tmp_path / "blip.wav"
    _write_wav(src, _tone(0.2))
    with pytest.raises(audio.AudioError):
        audio.to_wav(src, tmp_path / "out.wav")


def test_short_recording_is_one_chunk(tmp_path):
    wav = tmp_path / "short.wav"
    _write_wav(wav, _tone(12.0))
    chunks = audio.split_wav(wav, tmp_path / "chunks", max_seconds=30)
    assert len(chunks) == 1
    assert chunks[0].start == 0
    assert chunks[0].end == pytest.approx(12.0)


def test_chunks_are_contiguous_bounded_and_never_end_in_a_sliver(tmp_path):
    wav = tmp_path / "long.wav"
    _write_wav(wav, _tone(61.0))
    chunks = audio.split_wav(wav, tmp_path / "chunks", max_seconds=30)

    assert chunks[0].start == 0
    assert chunks[-1].end == pytest.approx(61.0, abs=0.01)
    for a, b in zip(chunks, chunks[1:]):
        assert a.end == b.start          # nothing dropped, nothing sent twice
    assert all(c.duration <= 30.0 + 1e-6 for c in chunks)
    assert chunks[-1].duration >= audio.MIN_TAIL_SECONDS
    assert all(c.path.exists() for c in chunks)


def test_cuts_land_inside_pauses(tmp_path):
    # 25 s talk | 1 s pause | 25 s talk | 1 s pause | 20 s talk  (72 s total)
    signal = np.concatenate([_tone(25), _silence(1), _tone(25), _silence(1), _tone(20)])
    wav = tmp_path / "pauses.wav"
    _write_wav(wav, signal)

    chunks = audio.split_wav(wav, tmp_path / "chunks", max_seconds=30)
    cuts = [c.end for c in chunks[:-1]]

    assert len(cuts) == 2
    assert 25.0 <= cuts[0] <= 26.0
    assert 51.0 <= cuts[1] <= 52.0