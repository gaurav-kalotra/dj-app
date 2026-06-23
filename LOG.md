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

## 2026-06-16

### Phase 3 continued — Bug fixes, UI polish, organic transitions

**Bug fixes:**
- Crossfader was silently broken: `cancelAndHoldAtCurrentValue` is experimental and was throwing without output, so no `setTargetAtTime` calls after it ever ran. Replaced with `cancelScheduledValues` + explicit value snapshot (`p.value → setValueAtTime(v, now)`)
- Idle deck stayed silent when fader moved toward it: deck was never started. Fixed in `handleFader` — if fader crosses 10% toward a deck that has a track but isn't playing, `deck.play()` is called automatically

**Gain control redesign:**
- Gain section removed from inside `DeckPanel` and moved to external side strip alongside the level meter
- Side strip: clickable tick labels (0, 25, 50, 75, 100, 125, 150%) + vertical slider + level meter
- Tick labels are sticky presets: clicking jumps to that exact value; nearest tick highlights dim green; active value shows bright green + underline
- Label positions use `top = THUMB_R + (150 - val) / 150 * (SLIDER_H - 2 * THUMB_R)` with `translateY(-50%)` — matches browser's internal thumb geometry exactly
- Tracks no longer auto-play on load; PLAY button required

**UI scale-up:**
- Deck panels widened 260 → 340px, fonts scaled throughout, EQ sliders taller (64 → 90px), all padding/gap values increased

**Organic transition engine (full rewrite of `Mixer.transition()`):**
- S-curve equal-power crossfade: ease-in-out applied before cos/sin equal-power curve — no energy dip, natural handoff feel
- True bass swap: outgoing bass dead by 30%, bass gap in the middle, incoming bass delayed until 65%
- Energy-aware timing: scans outgoing track's `energy_curve` for lowest-energy bar boundary in next 8–16 bars; prefers detected outro segment boundary if within 64 beats
- Blend duration 24–40 beats scaled by average track energy (high energy → punchy 24, low energy → slow 40)
- ±1 beat jitter so no two transitions land on the same grid position
- Incoming track cued at its detected intro segment
- High EQ blend: outgoing fades −6 dB (S-curve), incoming opens from −6 dB → 0
- Mid EQ: incoming arrives at −3 dB, restores to 0 by 60% of blend to reduce frequency clash at entry
- `transition()` returns `TransitionTiming { delayMs, durationMs }` so fader animation waits for the energy-aware delay before moving
- `energy_curve` added to `/library` API response; `TrackInfo` type updated accordingly

**Realtime EQ sliders:**
- `DeckPanel` rAF now reads `deck.lowEQ.gain.value`, `deck.midEQ.gain.value`, `deck.highEQ.gain.value` each frame
- Values snapped to 0.5 dB steps before state update; bails early if unchanged to avoid re-renders
- Sliders visually move during AUTO MIX showing live transition automation

---

## 2026-06-21

### Phase 4 — Orchestrator (autonomy)

**Backend:**
- Added `backend/axiom/mixplan.py` — deterministic `MixPlan` computation: reads outro segment (or falls back to `duration - 2×blend_window`) for transition timing; 24–40 beat blend duration scaled by average track energy
- Added `backend/axiom/orchestrator.py` — full autonomous state machine:
  - States: `idle → suggesting → playing → stopped`
  - `_begin_session()`: loads both decks via WS, starts the loop
  - `_run_loop()`: sleeps until transition point, fires `transition_start`, waits for frontend timing ack, flips deck roles, loads N+2 onto freed deck, repeats
  - `_pipeline_next()`: brain selects N+2 → rules-engine validation → optional Audius download + librosa analysis in thread executor → `_next_track` set
  - `_await_timing()`: waits up to 3s for frontend `transition_timing` ack; estimates from BPM if not received
  - Fallback chain: brain failure → rules-engine nearest-Camelot pick → cached random track
  - `_get_suggestions()`: brain picks 3 Deck B candidates on session start (BPM-compatible fallback if brain fails)
  - 10s auto-pick timer for Deck B suggestions
- Updated `backend/axiom/main.py`: lifespan context creates shared `Store`, `BrainClient`, `AudiusAdapter`, `Orchestrator`; `/ws` endpoint routes all commands through orchestrator; `/library` uses shared store

**Frontend:**
- Added `frontend/src/ws.ts` — singleton `WsClient` with reconnect (3s), per-event listeners, typed `send()` helper
- Updated `frontend/src/engine/types.ts` — added `WsSessionState`, `WsSuggestions`, `WsTrackQueued`, `WsTransitionStart`, `WsAgentFeed` event shape interfaces
- Updated `frontend/src/console/Console.tsx` — full AUTO mode alongside existing MANUAL mode:
  - Mode toggle in header (MANUAL / AUTO)
  - AUTO idle: seed picker (library dropdown) + START SESSION button
  - AUTO running: NOW PLAYING bar + narrative + STOP SESSION
  - `track_queued` event → `mixer.deck(id).load(track)` + optional autoplay
  - `transition_start` event → `mixer.transition()` → report timing back via `transition_timing` command → animate crossfader with S-curve easing
  - `suggestions` modal with 10s countdown; user click or backend auto-picks
  - Scrolling agent feed (last 60 messages, newest on top)
  - `crossfadeRef` pattern to avoid stale closure in WS callbacks
  - Manual mode unchanged

**WS event protocol:**
- Backend → frontend: `session_state`, `suggestions`, `track_queued`, `transition_start`, `agent_feed`, `session_stopped`, `error`
- Frontend → backend: `seed`, `start`, `stop`, `select_suggestion`, `transition_timing`

**Gate:** seed one track → START SESSION → agent auto-picks Deck B → 30 min unattended with zero dead air; survives injected download failures via ranked-candidate fallback chain

---

## 2026-06-11

- Created repo `dj-app` on GitHub
- Added `ROADMAP.md` — full project spec, architecture, phases, and musical rules
- Added `README.md` — project overview, architecture diagram, setup instructions, build status
