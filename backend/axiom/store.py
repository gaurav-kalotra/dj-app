"""SQLite library store: track metadata + analysis results + file cache."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from pathlib import Path

from .analysis.analyzer import TrackAnalysis
from .sources.base import TrackMeta

_SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id              TEXT PRIMARY KEY,
    query           TEXT NOT NULL,
    requester       TEXT,
    matched_id      TEXT,
    matched_title   TEXT,
    matched_artist  TEXT,
    verdict         TEXT NOT NULL DEFAULT 'pending',
    slot_hint       TEXT,
    public_reason   TEXT,
    played          INTEGER NOT NULL DEFAULT 0,
    submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
    adjudicated_at  TEXT,
    expires_at      TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
    source_id   TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL,
    duration_s  REAL,
    genre       TEXT,
    extra_json  TEXT,
    added_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analyses (
    source_id       TEXT PRIMARY KEY REFERENCES tracks(source_id),
    file_path       TEXT NOT NULL,
    duration_s      REAL,
    bpm             REAL,
    key             TEXT,
    camelot         TEXT,
    beat_grid_json  TEXT,
    energy_json     TEXT,
    segments_json   TEXT,
    analyzed_at     TEXT DEFAULT (datetime('now'))
);
"""


class Store:
    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # ── tracks ───────────────────────────────────────────────────────────────

    def upsert_track(self, meta: TrackMeta) -> None:
        self._conn.execute(
            """INSERT INTO tracks (source_id, title, artist, duration_s, genre, extra_json)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_id) DO UPDATE SET
                 title=excluded.title, artist=excluded.artist,
                 duration_s=excluded.duration_s, genre=excluded.genre,
                 extra_json=excluded.extra_json""",
            (
                meta.source_id, meta.title, meta.artist,
                meta.duration_s, meta.genre, json.dumps(meta.extra),
            ),
        )
        self._conn.commit()

    def get_track(self, source_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM tracks WHERE source_id = ?", (source_id,)
        ).fetchone()

    # ── analyses ─────────────────────────────────────────────────────────────

    def upsert_analysis(self, analysis: TrackAnalysis) -> None:
        from dataclasses import asdict
        d = asdict(analysis)
        self._conn.execute(
            """INSERT INTO analyses
               (source_id, file_path, duration_s, bpm, key, camelot,
                beat_grid_json, energy_json, segments_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source_id) DO UPDATE SET
                 file_path=excluded.file_path, duration_s=excluded.duration_s,
                 bpm=excluded.bpm, key=excluded.key, camelot=excluded.camelot,
                 beat_grid_json=excluded.beat_grid_json,
                 energy_json=excluded.energy_json,
                 segments_json=excluded.segments_json,
                 analyzed_at=datetime('now')""",
            (
                analysis.source_id, analysis.file_path, analysis.duration_s,
                analysis.bpm, analysis.key, analysis.camelot,
                json.dumps(d["beat_grid"]),
                json.dumps(d["energy_curve"]),
                json.dumps(d["segments"]),
            ),
        )
        self._conn.commit()

    def get_analysis(self, source_id: str) -> sqlite3.Row | None:
        return self._conn.execute(
            "SELECT * FROM analyses WHERE source_id = ?", (source_id,)
        ).fetchone()

    def is_analyzed(self, source_id: str) -> bool:
        return self.get_analysis(source_id) is not None

    def all_analyses(self) -> list[sqlite3.Row]:
        return self._conn.execute(
            "SELECT a.*, t.title, t.artist, t.genre FROM analyses a "
            "JOIN tracks t USING (source_id) ORDER BY a.analyzed_at DESC"
        ).fetchall()

    # ── requests ─────────────────────────────────────────────────────────────

    def submit_request(self, req_id: str, query: str, requester: str | None) -> None:
        self._conn.execute(
            "INSERT INTO requests (id, query, requester) VALUES (?, ?, ?)",
            (req_id, query, requester),
        )
        self._conn.commit()

    def update_request_verdict(
        self,
        req_id: str,
        verdict: str,
        slot_hint: str | None,
        public_reason: str,
        matched_id: str | None = None,
        matched_title: str | None = None,
        matched_artist: str | None = None,
        expires_at: str | None = None,
    ) -> None:
        self._conn.execute(
            """UPDATE requests SET
               verdict=?, slot_hint=?, public_reason=?,
               matched_id=?, matched_title=?, matched_artist=?,
               adjudicated_at=datetime('now'), expires_at=?
               WHERE id=?""",
            (verdict, slot_hint, public_reason,
             matched_id, matched_title, matched_artist,
             expires_at, req_id),
        )
        self._conn.commit()

    def mark_request_played(self, req_id: str) -> None:
        self._conn.execute("UPDATE requests SET played=1 WHERE id=?", (req_id,))
        self._conn.commit()

    def get_deferred_requests(self) -> list[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM requests WHERE verdict='deferred' AND played=0 "
            "AND (expires_at IS NULL OR expires_at > datetime('now')) "
            "ORDER BY submitted_at ASC"
        ).fetchall()

    def all_requests(self, limit: int = 40) -> list[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM requests ORDER BY submitted_at DESC LIMIT ?", (limit,)
        ).fetchall()

    def close(self) -> None:
        self._conn.close()
