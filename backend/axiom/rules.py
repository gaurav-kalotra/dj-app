"""Musical rules engine — deterministic, not LLM.

These constraints are code, not vibes. The brain proposes; this rejects violations.
"""
from __future__ import annotations

from dataclasses import dataclass

from .analysis.camelot import camelot_distance

BPM_STRETCH_MAX = 0.08   # ±8% hard cap for time-stretching


@dataclass
class RulesResult:
    ok: bool
    violations: list[str]


def check_transition(
    outgoing_bpm: float,
    outgoing_key: str,
    incoming_bpm: float,
    incoming_key: str,
    transition_type: str,  # "long_blend" | "quick_cut" | "bass_swap" | "breakdown_bridge"
) -> RulesResult:
    violations: list[str] = []

    # BPM stretch check
    if outgoing_bpm > 0 and incoming_bpm > 0:
        ratio = incoming_bpm / outgoing_bpm
        if abs(ratio - 1.0) > BPM_STRETCH_MAX:
            violations.append(
                f"BPM stretch {ratio:.3f} exceeds ±{BPM_STRETCH_MAX*100:.0f}% cap "
                f"({outgoing_bpm:.1f} → {incoming_bpm:.1f})"
            )

    # Harmonic check — only enforced for long_blend
    if transition_type == "long_blend":
        dist = camelot_distance(outgoing_key, incoming_key)
        if dist is None:
            violations.append(
                f"Cannot compute Camelot distance for keys: {outgoing_key!r}, {incoming_key!r}"
            )
        elif dist > 1:
            violations.append(
                f"Camelot distance {dist} > 1 for long_blend "
                f"({outgoing_key} → {incoming_key})"
            )

    return RulesResult(ok=len(violations) == 0, violations=violations)


def reachable_bpm_window(current_bpm: float) -> tuple[float, float]:
    """BPM range the brain must stay within for time-stretch to be artifact-free."""
    return current_bpm * (1 - BPM_STRETCH_MAX), current_bpm * (1 + BPM_STRETCH_MAX)
