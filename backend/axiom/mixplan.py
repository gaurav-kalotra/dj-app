"""Deterministic MixPlan: timing parameters from measured track analysis."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class MixPlan:
    transition_type: str
    outgoing_start_s: float   # seconds from track start when backend fires transition_start
    blend_beats: int
    blend_duration_s: float   # blend_beats / bpm * 60


def compute_mixplan(outgoing: dict, incoming: dict, transition_type: str) -> MixPlan:
    bpm = float(outgoing.get("bpm") or 120.0)

    ec = outgoing.get("energy_curve") or []
    avg_e = sum(ec) / len(ec) if ec else 0.5
    blend_beats = int(round(24 + (1 - min(1.0, avg_e * 1.5)) * 16))  # 24–40
    blend_s = blend_beats * (60.0 / bpm)

    segments = outgoing.get("segments") or []
    outro = next((s for s in segments if s.get("label") == "outro"), None)
    if outro:
        outgoing_start_s = float(outro["start_s"])
    else:
        duration = float(outgoing.get("duration_s") or 180.0)
        # Start blend with enough lead time for a 2× blend window before track ends
        outgoing_start_s = max(0.0, duration - blend_s * 2.0)

    # Never transition before 32 beats have played
    min_play_s = 32.0 * (60.0 / bpm)
    outgoing_start_s = max(min_play_s, outgoing_start_s)

    return MixPlan(
        transition_type=transition_type,
        outgoing_start_s=round(outgoing_start_s, 2),
        blend_beats=blend_beats,
        blend_duration_s=round(blend_s, 2),
    )
