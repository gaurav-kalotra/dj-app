from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class TrackMeta:
    source_id: str          # "<adapter>_<id>", e.g. "audius_abc123"
    title: str
    artist: str
    duration_s: float
    bpm_hint: float | None = None       # catalog value — unreliable, for shortlisting only
    key_hint: str | None = None         # catalog value — unreliable
    genre: str | None = None
    download_url: str | None = None     # direct audio URL if known at search time
    extra: dict = field(default_factory=dict)


class SourceAdapter(ABC):
    @abstractmethod
    async def search(self, query: str, *, limit: int = 20) -> list[TrackMeta]: ...

    @abstractmethod
    async def download(self, meta: TrackMeta, dest: Path) -> Path:
        """Download audio to dest directory. Returns path to the saved file."""
        ...

    @abstractmethod
    def adapter_name(self) -> str: ...
