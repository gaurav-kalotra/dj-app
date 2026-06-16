"""Claude API wrapper: structured JSON decisions with retry and deterministic fallback."""
from __future__ import annotations

import json
import logging
import os
from typing import TypeVar, Type

from anthropic import AsyncAnthropic, APIError
from pydantic import BaseModel, ValidationError

from .prompts import TRACK_SELECTION_V1, REQUEST_VERDICT_V1
from .schemas import TrackSelection, RequestVerdict

log = logging.getLogger(__name__)

MODEL = "claude-sonnet-4-6"
TEMPERATURE = 0.3   # low — creativity lives in the candidate pool, not randomness
MAX_TOKENS = 1024

T = TypeVar("T", bound=BaseModel)


class BrainClient:
    def __init__(self, api_key: str | None = None) -> None:
        self._client = AsyncAnthropic(api_key=api_key or os.environ["ANTHROPIC_API_KEY"])

    async def _call(
        self,
        system: str,
        user_content: str,
        schema: Type[T],
        *,
        retries: int = 1,
    ) -> T:
        last_err: Exception | None = None
        for attempt in range(retries + 1):
            try:
                msg = await self._client.messages.create(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    temperature=TEMPERATURE,
                    system=system,
                    messages=[{"role": "user", "content": user_content}],
                )
                raw = msg.content[0].text.strip()
                # Strip accidental markdown fences
                if raw.startswith("```"):
                    raw = raw.split("```")[1]
                    if raw.startswith("json"):
                        raw = raw[4:]
                return schema.model_validate_json(raw)
            except (ValidationError, json.JSONDecodeError, APIError) as e:
                last_err = e
                if attempt < retries:
                    log.warning("Brain attempt %d failed (%s), retrying with error appended", attempt + 1, e)
                    user_content += f"\n\nYour previous response was invalid: {e}\nPlease return valid JSON only."
        raise last_err  # type: ignore[misc]

    async def select_track(self, user_content: str) -> TrackSelection:
        return await self._call(TRACK_SELECTION_V1, user_content, TrackSelection)

    async def verdict_request(self, user_content: str) -> RequestVerdict:
        return await self._call(REQUEST_VERDICT_V1, user_content, RequestVerdict)
