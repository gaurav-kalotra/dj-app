# AXIOM — Build Log

A running record of what got done and when. Updated as work progresses.

---

## 2026-06-15

### Phase 0 — Foundations

- Scaffolded `backend/` Python package (`axiom`) with FastAPI skeleton, `pyproject.toml`, venv-based install
- Scaffolded `frontend/` React + Vite + TypeScript; `App.tsx` pings backend WebSocket on load
- Added `.env.example` (`ANTHROPIC_API_KEY`, `AUDIUS_API_KEY`), `.gitignore`, `Makefile`
- Added `scripts/smoke_test.py` — Phase 0 gate runner (Audius search + Claude API ping)
- **Gate passed 2026-06-15:** `make smoke` — Audius search OK, Claude API OK (`AXIOM online.`)

### Phase 1 — Acquisition + Analysis pipeline

- Added `sources/base.py` — `SourceAdapter` ABC + `TrackMeta` dataclass
- Added `sources/audius.py` — search (download-permitted only) + stream downloader
- Added `analysis/camelot.py` — Krumhansl-Schmuckler key profiles, Camelot wheel mapping, distance/compatibility
- Added `analysis/analyzer.py` — librosa: BPM, key, beat grid, energy curve, structure segmentation
- Added `store.py` — SQLite: `tracks` + `analyses` tables, upsert/query helpers
- Added `scripts/ingest.py` — CLI gate runner (`--genre`, `--count`, `--out`)
- **Gate passed 2026-06-15:** 3/3 tracks downloaded + analyzed (BPM, key, Camelot, beat grid, segments); 0 failures
- Note: Audius download-permitted catalog skews toward DJ sets (long duration); duration filter needed before Phase 2 selection

### Phase 2 — Agent Brain v1

- Added `brain/schemas.py` — `Candidate` (with `transition_type`), `TrackSelection`, `RequestVerdict` pydantic models
- Added `brain/prompts.py` — versioned system prompts for TrackSelection and RequestVerdict
- Added `brain/client.py` — Claude API wrapper (sonnet-4-6, temp=0.3, retry on validation failure)
- Added `rules.py` — musical rules engine: BPM stretch cap (±8%), Camelot distance enforcement per transition type
- Added `scripts/brain_harness.py` — CLI gate runner (seed track + library → ranked candidates + rules check)
- Key fix: precompute Camelot distances in context so brain reads rather than recalculates (cross-ring distance was a consistent brain error)
- **Gate passed 2026-06-15:** 10/10 runs schema-valid, rules-compliant, coherent DJ narratives

---

## 2026-06-11

- Created repo `dj-app` on GitHub
- Added `ROADMAP.md` — full project spec, architecture, phases, and musical rules
- Added `README.md` — project overview, architecture diagram, setup instructions, build status
