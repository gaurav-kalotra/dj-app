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

### Phase 3 — Playback Engine + Manual Console

- Added `frontend/src/engine/types.ts` — `TrackInfo`, `BeatGrid`, `Segment`, `DeckState`, `TransitionPlan` types
- Added `frontend/src/engine/AudioEngine.ts` — singleton `AudioContext` (resumes if suspended)
- Added `frontend/src/engine/Deck.ts` — signal chain: source → HPF → lowEQ → midEQ → highEQ → channelGain → faderGain → master; `load()`, `play()`, `pause()`, `stop()`, `setTempo()`, `setChannelGain()`, `setEQ()`
- Added `frontend/src/engine/Mixer.ts` — two-deck mixer; `setCrossfade()` (equal-power gain + bass kill + HPF sweep), `syncTempos()`, `transition()` (organic blend, see below)
- Added `frontend/src/console/DeckPanel.tsx` — track selector, transport, EQ sliders (realtime rAF readback from audio graph)
- Added `frontend/src/console/Console.tsx` — full console UI: crossfader with fader-override detection, side-strip gain controls (vertical slider + clickable preset labels with exact pixel alignment), level meters, NOW PLAYING bar
- Added `backend/axiom/main.py` `/library` endpoint + `/audio/{source_id}` file serve; `energy_curve` included in library response
- Updated `frontend/src/engine/types.ts` — added `energy_curve: number[]` to `TrackInfo`

**Transition engine** (`Mixer.transition()`):
- S-curve equal-power crossfade (ease-in-out shaping, no energy dip at midpoint)
- True bass swap: outgoing bass dead by 30% of blend, incoming bass delayed until 65%
- Energy-aware start: finds lowest-energy bar boundary in next 8–16 bars, or onto detected outro
- Blend duration 24–40 beats based on track average energy; ±1 beat jitter per transition
- Incoming track cued at its detected intro segment
- High EQ blend: outgoing fades -6 dB, incoming opens from -6 dB
- Mid EQ: incoming arrives at -3 dB, restores by 60% to reduce entry clash
- All EQ + HPF states reset to clean after blend completes

**UI details:**
- Crossfader is pure React state (never read back from audio graph) to prevent lag/conflict with automation
- `cancelScheduledValues` + value snapshot pattern instead of `cancelAndHoldAtCurrentValue` (experimental, was silently throwing)
- Fader moving toward idle deck auto-starts it; fader animation respects `TransitionTiming` delay + duration returned from `transition()`
- Gain label positions use `top = thumbR + (150 - val) / 150 * (H - 2 * thumbR)` for pixel-accurate alignment

---

## 2026-06-11

- Created repo `dj-app` on GitHub
- Added `ROADMAP.md` — full project spec, architecture, phases, and musical rules
- Added `README.md` — project overview, architecture diagram, setup instructions, build status
