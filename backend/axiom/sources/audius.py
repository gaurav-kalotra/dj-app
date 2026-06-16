"""Audius SourceAdapter — only exposes tracks with artist-enabled downloading."""
import os
from pathlib import Path

import httpx

from .base import SourceAdapter, TrackMeta

_BASE = "https://api.audius.co/v1"
_DISCOVERY_HOSTS = [
    "https://discoveryprovider.audius.co",
    "https://discoveryprovider2.audius.co",
    "https://discoveryprovider3.audius.co",
]


class AudiusAdapter(SourceAdapter):
    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.getenv("AUDIUS_API_KEY") or ""
        self._headers = {"X-API-KEY": self._api_key} if self._api_key else {}

    def adapter_name(self) -> str:
        return "audius"

    def _source_id(self, track_id: str) -> str:
        return f"audius_{track_id}"

    async def search(self, query: str, *, limit: int = 20) -> list[TrackMeta]:
        """Search Audius and return only download-permitted tracks."""
        async with httpx.AsyncClient(headers=self._headers, timeout=20) as client:
            resp = await client.get(
                f"{_BASE}/tracks/search",
                params={"query": query, "limit": min(limit * 3, 100)},
            )
            resp.raise_for_status()
            raw = resp.json().get("data", [])

        results: list[TrackMeta] = []
        for t in raw:
            access = t.get("access", {})
            if not access.get("download", False):
                continue
            results.append(TrackMeta(
                source_id=self._source_id(t["id"]),
                title=t.get("title", "Unknown"),
                artist=t.get("user", {}).get("name", "Unknown"),
                duration_s=float(t.get("duration", 0)),
                genre=t.get("genre"),
                extra={"audius_id": t["id"]},
            ))
            if len(results) >= limit:
                break
        return results

    async def download(self, meta: TrackMeta, dest: Path) -> Path:
        """Stream the track to dest/<source_id>.mp3 (or original extension)."""
        audius_id = meta.extra.get("audius_id") or meta.source_id.removeprefix("audius_")
        url = f"{_BASE}/tracks/{audius_id}/stream"

        dest.mkdir(parents=True, exist_ok=True)
        out_path = dest / f"{meta.source_id}.mp3"

        async with httpx.AsyncClient(
            headers=self._headers, timeout=120, follow_redirects=True
        ) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                # Detect actual extension from content-type
                ct = resp.headers.get("content-type", "")
                if "ogg" in ct:
                    out_path = dest / f"{meta.source_id}.ogg"
                elif "flac" in ct:
                    out_path = dest / f"{meta.source_id}.flac"
                with open(out_path, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=65536):
                        f.write(chunk)

        return out_path
