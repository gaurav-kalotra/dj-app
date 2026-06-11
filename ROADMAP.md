# AXIOM — Autonomous DJ Agent

> **This document is the source of truth.** Every architectural decision, phase gate, and scope call defers to this file. If reality and the roadmap diverge, we either follow the roadmap or amend it deliberately (see §10 — Amendments). No silent drift.

---

## 1. Locked Objective

An **autonomous two-deck DJ agent** for live, continuous mixing:

- The **user seeds** Deck A (and optionally Deck B) with a starting track, then presses **Start**.
- If Deck B is empty, the agent proposes 3 compatible tracks; the user may pick one within ~10s, otherwise the agent auto-picks the top suggestion. From this point the session is hands-off.
- The **agent continuously**: selects the next track → downloads it from a legal source → analyzes it (BPM, key, beat grid, energy, structure) → queues it on the idle deck → executes a **beatmatched, key-aware, EQ-blended live transition** at a musically correct phrase boundary → repeats, alternating decks indefinitely.
- An **audience dashboard** shows now-playing and the upcoming queue, and lets viewers **submit song requests**. The agent treats requests as *suggestions*: it evaluates fit (availability, BPM path, harmonic distance, energy arc) and decides **when and whether** to weave them in, surfacing its verdict and reasoning on the dashboard.
- The session runs until the user pauses or stops.

**Project type:** Personal learning project. Optimize for engineering depth and a great live experience, not commercial hardening.

**Explicit non-goals (v1):** mobile apps, user accounts/auth beyond a session token for the owner, monetization, multi-room audio, vocal-aware stem mixing, offline mix rendering (may return as a stretch goal).

---

## 2. Hard Constraints & Source-of-Music Decision

1. **Audio sources must permit autonomous programmatic download (or be user-owned).** Decisions (amended 2026-06-10, v1.1):
   - **Primary: Audius API** — free open API; electronic/DJ-heavy catalog; per-track `access.download` flag means the adapter only acquires tracks whose artists explicitly enabled downloading.
   - **Secondary: Internet Archive** (netlabels + audio collections) — fully downloadable, stable API; quality varies, used for genre depth.
   - **First-class: `LocalLibraryAdapter`** — a watched folder of user-owned music (Bandcamp/Beatport purchases, DJ record-pool downloads). The agent treats it as part of the unified library: full autonomous selection within the pool; restocking is the only manual act.
   - Ripping from YouTube/Spotify is out of scope — ToS/licensing violations are disqualifying.
2. **Acquisition is abstracted behind a `SourceAdapter` interface** (search, metadata, download). Audius is adapter #1, Internet Archive #2, LocalLibrary #3. The brain sees one merged library regardless of origin.
   - **Commercial-music path (post-v1, user-funded):** subscribe to a DJ record pool (BPM Supreme / DJcity / ZIPDJ-class) → periodically bulk-download crates → drop into the LocalLibrary watch folder. No API exists for autonomous commercial downloads at any consumer price point; this is the closest legal equivalent and requires zero code changes.
3. **Catalog metadata is for shortlisting only.** Ground truth (BPM, key, beat grid) always comes from our own local analysis post-download. The agent *picks* with fuzzy data; the engine *executes* with measured data.
4. **The agent brain is the Claude API.** All selection, request adjudication, and mix-plan strategy flows through it. Deterministic code handles execution; the LLM handles taste and judgment.

---

## 3. System Architecture

```
┌─────────────────────────────  BROWSER  ─────────────────────────────┐
│  DJ Console (owner)                    Audience Dashboard (public)  │
│  • Deck A / Deck B UI                  • Now playing + queue        │
│  • Waveforms, queue lists              • Request form               │
│  • Transport: start/pause/stop         • Request status + reasons   │
│  • Agent activity feed                                              │
│                                                                     │
│  ──────────────  Web Audio Mixing Engine (the "hands")  ─────────── │
│  2 × deck chain: source → time-stretch → 3-band EQ → gain → master  │
│  Executes MixPlans: beat-aligned starts, crossfade + EQ automation  │
└───────────────▲────────────── WebSocket ─────────────▲──────────────┘
                │                                      │
┌───────────────┴──────────  PYTHON BACKEND  ──────────┴──────────────┐
│  Orchestrator (state machine + lookahead pipeline)                  │
│   ├── Agent Brain (Claude API): selection, requests, strategy       │
│   ├── SourceAdapters: Audius · InternetArchive · LocalLibrary       │
│   ├── Analysis Service: librosa/essentia → BPM, key, beatgrid,      │
│   │     energy curve, structure (intro/outro/cue points)            │
│   ├── Library Store: SQLite + audio file cache                      │
│   └── Request Inbox: audience submissions → agent adjudication      │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.1 Tech stack (decided)

| Layer | Choice | Rationale |
|---|---|---|
| Backend | Python 3.11+, FastAPI, uvicorn | Async-native, WebSocket support, the analysis ecosystem is Python |
| Analysis | librosa (primary), essentia (key detection fallback) | Industry-standard, measured-not-guessed metadata |
| Brain | Anthropic API (Claude Sonnet) | Structured JSON decisions; Sonnet for cost/latency balance |
| DB | SQLite | Single-user scale; zero ops |
| Frontend | React + Vite, TypeScript | Industry-standard; component model fits the deck/queue UI |
| Audio engine | Web Audio API; SoundTouch AudioWorklet for time-stretch | True pitch-preserving tempo sync in-browser |
| Transport | WebSocket (single duplex channel, JSON events) | Live state sync: deck positions, queue changes, agent feed |
| Audio delivery | Backend serves analyzed files over HTTP; frontend fetches into AudioBuffers | Simple, cacheable, no streaming complexity |

### 3.2 The lookahead pipeline (the heartbeat)

Invariant: **while track N plays, track N+1 is fully downloaded, analyzed, and cued on the idle deck, and the brain is already shortlisting N+2.**

```
playing(N) ──► cued(N+1) ──► shortlisted(N+2..N+4)
```

- Selection for N+1 begins the moment N goes live.
- Budget: download + analysis must complete with ≥ 60s of N remaining. If at risk, the orchestrator triggers the fallback (next shortlist item that's already cached; loop-safe outro extension of N as a last resort).
- Every brain selection returns a **ranked list of 3 candidates**, not one — fallbacks are pre-approved, never improvised.

### 3.3 Decision contracts (JSON schemas, abridged)

The brain only ever speaks structured JSON. Three contracts:

**TrackSelection** (brain → orchestrator)
```json
{
  "candidates": [
    {"source_id": "jam_1482931", "reason": "Same 9A key, +2 BPM, rising energy fits the arc", "confidence": 0.86}
  ],
  "set_narrative": "Holding deep house plateau two more tracks, then begin techno climb"
}
```

**MixPlan** (computed by the deterministic planner from measured analysis; brain sets strategy params only)
```json
{
  "transition_type": "long_blend | quick_cut | bass_swap | breakdown_bridge",
  "outgoing": {"start_beat": 448, "bars": 16, "eq_automation": "[...]", "gain_curve": "equal_power"},
  "incoming": {"cue_beat": 0, "stretch_ratio": 1.016, "eq_automation": "[...]"},
  "aligned_phrase": 32
}
```

**RequestVerdict** (brain → dashboard)
```json
{
  "request_id": "r_019", "verdict": "accepted | deferred | declined",
  "slot_hint": "after_next",
  "public_reason": "Great fit — slotting it in once we reach 126 BPM, ~2 tracks away"
}
```

### 3.4 Musical rules engine (deterministic, not LLM)

These are code, not vibes:
- **Harmonic compatibility:** Camelot wheel distance ≤ 1 step (same, ±1 number, or letter swap) required for `long_blend`; wider allowed for `quick_cut`.
- **Tempo:** stretch ratio hard-capped at ±8% (artifact threshold). The brain must select within the reachable BPM window; the rules engine rejects violations.
- **Phrase alignment:** transitions begin on 16- or 32-beat boundaries derived from the measured beat grid, anchored to detected downbeats.
- **Structure:** default blend = outgoing track's outro region over incoming track's intro region, from the analysis service's structure segmentation.

The brain chooses *which* compatible track and *what* transition character; the rules engine guarantees the result is musically legal.

### 3.5 Request handling policy

1. Request arrives (free text or source link) → resolver searches the SourceAdapter.
2. Not found → auto-decline with reason and a brain-picked closest alternative ("not in the CC catalog — closest match I can play: …").
3. Found → brain adjudicates against the current arc: **accept** (insert into shortlist with slot hint), **defer** (park until the BPM/energy path reaches it; re-evaluated each cycle; expires after 30 min), or **decline** (with public reason).
4. Owner's own mid-session additions use the same pipeline but carry priority weight.

---

## 4. Repository Structure

```
axiom/
├── ROADMAP.md                  ← this file (the bible)
├── README.md                   ← architecture overview + quickstart
├── backend/
│   ├── pyproject.toml
│   ├── axiom/
│   │   ├── main.py             # FastAPI app + WebSocket endpoint
│   │   ├── orchestrator.py     # state machine + lookahead pipeline
│   │   ├── brain/
│   │   │   ├── client.py       # Claude API wrapper, retry/timeout
│   │   │   ├── prompts.py      # system prompts (versioned, tested)
│   │   │   └── schemas.py      # pydantic models for decision contracts
│   │   ├── sources/
│   │   │   ├── base.py         # SourceAdapter interface
│   │   │   ├── audius.py
│   │   │   ├── internet_archive.py
│   │   │   └── local_library.py    # watched folder of user-owned music
│   │   ├── analysis/
│   │   │   ├── analyzer.py     # BPM, key, beatgrid, energy, structure
│   │   │   └── camelot.py      # key → Camelot mapping + distance
│   │   ├── mixplan.py          # deterministic MixPlan computation
│   │   ├── rules.py            # musical rules engine (§3.4)
│   │   ├── requests_inbox.py
│   │   └── store.py            # SQLite + file cache
│   └── tests/
├── frontend/
│   ├── src/
│   │   ├── engine/             # Web Audio: decks, EQ, stretch worklet, scheduler
│   │   ├── console/            # owner DJ console
│   │   ├── dashboard/          # audience view + request form
│   │   └── ws.ts               # WebSocket client + event types
│   └── ...
└── scripts/                    # CLI harnesses used during phases 1–2
```

---

## 5. Phases

Each phase has a **gate**: concrete acceptance criteria. We do not start phase N+1 until phase N's gate passes. Gates are demos, not vibes.

### Phase 0 — Foundations (≈ half a day)
Repo scaffolding, Python/Node toolchains, Audius API key, Anthropic API key, `.env` handling, CI lint/test skeleton.
**Gate:** `make dev` boots backend + frontend hello-world; one Audius API call and one Claude API call succeed from code.

### Phase 1 — Acquisition + Analysis pipeline (CLI-first)
Build the Audius `SourceAdapter` (download-permitted tracks only), downloader with cache, and the Analysis Service. Output: per-track JSON (measured BPM, key + Camelot, beat grid, downbeats, energy curve, intro/outro segments) persisted in SQLite.
**Gate:** `python scripts/ingest.py --genre "deep house" --count 10` downloads and analyzes 10 tracks; spot-check ≥ 8/10 BPM values against an ear/tap test; beat grid overlays correctly on a waveform plot.
**Risk watched here:** key-detection accuracy. If librosa chroma < ~70% agreement on a 20-track hand-labeled set, switch to essentia's key extractor (decision point — log it in the changelog).

### Phase 2 — Agent Brain v1 (offline harness)
Prompts + pydantic schemas for `TrackSelection` and `RequestVerdict`. CLI harness: given a seed track + library snapshot, the brain returns ranked candidates with reasoning. Iterate on prompt quality here, cheaply, before anything is live.
**Gate:** 10 consecutive harness runs produce schema-valid JSON; selections respect the rules engine (no out-of-window BPM, no Camelot violations for blends); reasoning reads like a competent DJ.

### Phase 3 — Playback Engine (manual mode)
Two-deck Web Audio engine: buffer loading, SoundTouch worklet time-stretch, 3-band EQ per deck, master gain, beat-grid-aligned scheduling. Bare-bones console UI with manual controls.
**Gate:** load two analyzed tracks, press "transition" → a beatmatched, phrase-aligned, EQ-swapped blend that sounds clean by ear. **This gate is the project's heart — do not rush it.**

### Phase 4 — Orchestrator (autonomy)
The state machine + lookahead pipeline (§3.2). WebSocket event protocol. Seed flow, including the 3-suggestion/10s-timeout Deck B behavior. Auto transitions driven by MixPlans. Fallback handling (failed download, late analysis, bad-fit detection).
**Gate:** seed one track, press Start, walk away → **30 minutes of unattended, listenable mixing** with zero dead air, surviving at least one injected download failure.

### Phase 5 — Audience Dashboard + Requests
Public dashboard route: now playing, upcoming queue, agent activity feed. Request form → inbox → brain adjudication → public verdicts with reasons. Owner priority lane.
**Gate:** during a live session, submit 5 requests (1 unfindable, 1 wildly incompatible, 3 reasonable) → agent declines the first two with sensible public reasons and weaves at least 2 of the rest in at musically sensible moments.

### Phase 6 — Polish + Packaging
Visual design pass (the AXIOM brutalist-terminal aesthetic), session recording to file (stretch goal returns here: capture master bus → downloadable mix), README with architecture diagram + demo GIF/video, deploy story (single VPS, or local-first with a tunnel for live demos).
**Gate:** a stranger can clone, run, and seed a session in < 10 minutes using only the README; a 60-second demo video exists.

**Sequencing rationale:** analysis before brain (the brain needs real data to select against), brain before engine (cheap iteration offline), engine before autonomy (you can't automate a transition you can't perform manually), autonomy before audience (requests piggyback on a working loop).

---

## 6. The Brain: prompting principles

- One system prompt per decision type, versioned in `prompts.py` with a changelog comment block. Prompt changes are commits, reviewed like code.
- The brain receives: current arc summary, last 5 tracks played, **measured** metadata of candidates (never ask it to guess BPM when we have measurements), pending requests, and the set narrative it previously declared (continuity across calls).
- The brain returns **only JSON** (no prose preamble), validated by pydantic; on validation failure → one retry with the error appended → then deterministic fallback (rules-engine-only nearest-neighbor pick). The show never stops because of a parse error.
- Temperature low (≤ 0.4) for selection; the creativity lives in the candidate pool, not in randomness.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Audius download-permitted pool too thin for some genres | Medium | Genre coverage probe in Phase 1; Internet Archive adapter; LocalLibrary covers gaps with purchased/pool music |
| Key detection inaccurate | Medium | Phase 1 decision point: librosa → essentia; Camelot tolerance widened for `quick_cut` |
| Time-stretch artifacts | Medium | ±8% hard cap; brain instructed to prefer ≤ 4% moves; `quick_cut` as escape hatch |
| Claude latency stalls the loop | Low (lookahead absorbs it) | 60s budget invariant; pre-approved fallback candidates; deterministic fallback selector |
| Browser autoplay policy blocks audio | Certain (first interaction) | Start button = user gesture that unlocks AudioContext; documented |
| Download failures mid-session | Medium | Ranked candidate list; cached tracks as emergency pool; never < 1 cued fallback |
| API cost creep during dev | Low | Sonnet not Opus; harness uses cached library snapshots; log token spend per session |

---

## 8. Definition of Done (v1)

All six phase gates passed, plus: one real 45+ minute session, seeded with a single track, with at least 3 audience requests handled live, recorded and listenable end-to-end without embarrassment. That recording is the proof artifact.

---

## 9. Stretch Goals (explicitly out of v1 scope)

Offline mix rendering to MP3 · energy-arc visualization on the dashboard · "vibe steering" mid-session (owner nudges: "take it darker") · DJ text commentary on the dashboard between transitions · second SourceAdapter (FMA) · vocal-clash detection.

---

## 10. Amendments

Changes to this document require: (1) a dated entry in the changelog below stating what changed and why, (2) the change committed separately from code. The roadmap bends deliberately or not at all.

**Changelog**
- 2026-06-09 — v1.0 — Initial roadmap locked. Objective per §1; Deck-B seed behavior decided as suggest-3-with-10s-auto-pick.
- 2026-06-10 — v1.1 — Source amendment: Jamendo removed (catalog quality). Audius becomes primary SourceAdapter (download-permitted tracks only), Internet Archive secondary, LocalLibraryAdapter added as first-class user-owned source. Commercial-music path documented (§2): DJ record pool → local library, post-v1. Project reframed from portfolio to personal learning project.
