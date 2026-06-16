"""Pydantic models for all brain decision contracts."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Candidate(BaseModel):
    source_id: str
    transition_type: Literal["long_blend", "quick_cut", "bass_swap", "breakdown_bridge"] = "long_blend"
    reason: str = Field(..., min_length=10)
    confidence: float = Field(..., ge=0.0, le=1.0)


class TrackSelection(BaseModel):
    candidates: list[Candidate] = Field(..., min_length=1, max_length=3)
    set_narrative: str = Field(..., min_length=10)


class RequestVerdict(BaseModel):
    request_id: str
    verdict: Literal["accepted", "deferred", "declined"]
    slot_hint: Literal["next", "after_next", "later", "never"] | None = None
    public_reason: str = Field(..., min_length=10)
