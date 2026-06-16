"""Audio analysis: BPM, key, beat grid, energy curve, structure segments."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import librosa
import numpy as np

from .camelot import to_camelot

# Analysis sample rate — 22050 Hz is the librosa default; sufficient for DJ metadata.
SR = 22050


@dataclass
class BeatGrid:
    bpm: float
    downbeats: list[float]      # times in seconds of detected bar downbeats
    beat_times: list[float]     # times in seconds of every beat


@dataclass
class EnergySegment:
    label: str          # "intro" | "buildup" | "drop" | "breakdown" | "outro" | "body"
    start_s: float
    end_s: float


@dataclass
class TrackAnalysis:
    source_id: str
    file_path: str
    duration_s: float
    bpm: float
    key: str                    # e.g. "A minor"
    camelot: str | None         # e.g. "8A", or None if key unmappable
    beat_grid: BeatGrid
    energy_curve: list[float]   # RMS energy, one value per ~0.5 s window
    segments: list[EnergySegment]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def analyze(file_path: Path, source_id: str) -> TrackAnalysis:
    """Full analysis pass on a downloaded audio file. CPU-bound, run in executor."""
    y, sr = librosa.load(str(file_path), sr=SR, mono=True)
    duration = librosa.get_duration(y=y, sr=sr)

    # BPM + beat grid
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    bpm = float(np.round(float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo), 2))
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()

    # Downbeats: group beats into bars of 4 (simple heuristic)
    downbeats = beat_times[::4]

    # Key detection via chroma + key estimator
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key_idx, _ = librosa.core.estimate_tuning(y=y, sr=sr), None
    # Use tonnetz-weighted chroma sum for key
    chroma_mean = np.mean(chroma, axis=1)
    key_number, scale = _estimate_key(chroma_mean)
    key_str = f"{_NOTE_NAMES[key_number]} {scale}"
    cam = to_camelot(key_str)
    camelot_str = f"{cam[0]}{cam[1]}" if cam else None

    # Energy curve (RMS, ~0.5 s hop)
    hop = int(SR * 0.5)
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
    energy_curve = (rms / (rms.max() + 1e-9)).tolist()   # normalised 0–1

    # Structure segmentation from energy envelope
    segments = _segment_structure(energy_curve, hop, sr, duration)

    return TrackAnalysis(
        source_id=source_id,
        file_path=str(file_path),
        duration_s=round(duration, 2),
        bpm=bpm,
        key=key_str,
        camelot=camelot_str,
        beat_grid=BeatGrid(
            bpm=bpm,
            downbeats=[round(t, 3) for t in downbeats],
            beat_times=[round(t, 3) for t in beat_times],
        ),
        energy_curve=[round(float(e), 4) for e in energy_curve],
        segments=segments,
    )


_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                            2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                            2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _estimate_key(chroma_mean: np.ndarray) -> tuple[int, str]:
    best_score, best_key, best_scale = -np.inf, 0, "major"
    for i in range(12):
        shifted = np.roll(chroma_mean, -i)
        maj = float(np.corrcoef(shifted, _MAJOR_PROFILE)[0, 1])
        min_ = float(np.corrcoef(shifted, _MINOR_PROFILE)[0, 1])
        if maj > best_score:
            best_score, best_key, best_scale = maj, i, "major"
        if min_ > best_score:
            best_score, best_key, best_scale = min_, i, "minor"
    return best_key, best_scale


def _segment_structure(
    energy: list[float], hop: int, sr: int, duration: float
) -> list[EnergySegment]:
    """Heuristic structure: label low-energy head/tail as intro/outro, peak as drop."""
    arr = np.array(energy)
    n = len(arr)
    if n < 8:
        return [EnergySegment("body", 0.0, round(duration, 2))]

    frame_dur = hop / sr
    threshold_hi = float(np.percentile(arr, 75))
    threshold_lo = float(np.percentile(arr, 35))

    def t(idx: int) -> float:
        return round(min(idx * frame_dur, duration), 2)

    # Find first frame above hi threshold (intro ends here)
    intro_end = next((i for i, e in enumerate(arr) if e >= threshold_hi), n // 4)
    # Find last frame above hi threshold (outro starts here)
    outro_start = next(
        (i for i in range(n - 1, -1, -1) if arr[i] >= threshold_hi), 3 * n // 4
    )

    segments: list[EnergySegment] = []
    if intro_end > 0:
        segments.append(EnergySegment("intro", 0.0, t(intro_end)))
    if outro_start < n - 1:
        segments.append(EnergySegment("body", t(intro_end), t(outro_start)))
        segments.append(EnergySegment("outro", t(outro_start), round(duration, 2)))
    else:
        segments.append(EnergySegment("body", t(intro_end), round(duration, 2)))

    return segments
