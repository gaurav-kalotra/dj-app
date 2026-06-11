# AXIOM — Autonomous DJ Agent

An autonomous two-deck DJ agent for live, continuous mixing. Seed a track, press Start, and walk away — AXIOM selects the next track, downloads it, analyzes it, and executes beatmatched, key-aware, EQ-blended transitions indefinitely. An audience dashboard lets viewers submit song requests, which the agent evaluates and weaves in on its own terms.

**Personal learning project.** Optimized for engineering depth and a great live experience.

---

## How it works

1. **Seed** Deck A with a starting track (and optionally Deck B). Press **Start**.
2. If Deck B is empty, AXIOM proposes 3 compatible tracks — pick one within ~10s, or it auto-picks.
3. The agent continuously: selects the next track → downloads it → analyzes it (BPM, key, beat grid, energy, structure) → queues it on the idle deck → executes a phrase-boundary transition → repeats, alternating decks.
4. Audience members submit requests via the dashboard. The agent evaluates fit and decides when (and whether) to play them, surfacing its reasoning publicly.

---

## Architecture

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
│   ├── Analysis Service: librosa/essentia → BPM, key, beatgrid       │
│   ├── Library Store: SQLite + audio file cache                      │
│   └── Request Inbox: audience submissions → agent adjudication      │
└─────────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Choice |
|---|---|
| Backend | Python 3.11+, FastAPI, uvicorn |
| Analysis | librosa (primary), essentia (key detection fallback) |
| Brain | Anthropic API (Claude Sonnet) |
| Database | SQLite |
| Frontend | React + Vite, TypeScript |
| Audio engine | Web Audio API + SoundTouch AudioWorklet (pitch-preserving time-stretch) |
| Transport | WebSocket (JSON events) |

---

## Audio Sources

- **Audius API** (primary) — free open API, download-permitted tracks only
- **Internet Archive** (secondary) — netlabels + audio collections, fully downloadable
- **Local Library** — watched folder of user-owned music (Bandcamp, Beatport, DJ record pool downloads)

YouTube/Spotify ripping is explicitly out of scope.

---

## Musical Rules

These are enforced in code, not left to the LLM:

- **Harmonic compatibility:** Camelot wheel distance ≤ 1 step required for blended transitions
- **Tempo:** time-stretch hard-capped at ±8%; brain must select within the reachable BPM window
- **Phrase alignment:** transitions begin on 16- or 32-beat boundaries anchored to detected downbeats
- **Structure:** blends default to outgoing outro over incoming intro

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/gaurav-kalotra/dj-app
cd dj-app

# 2. Copy and fill in credentials
cp .env.example .env
# Add: ANTHROPIC_API_KEY, AUDIUS_API_KEY

# 3. Backend
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -e .
uvicorn axiom.main:app --reload --port 8888

# 4. Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

---

## Build Status

See [ROADMAP.md](ROADMAP.md) for the full phase-by-phase build plan and current status.

**Phases:** Foundations → Acquisition & Analysis → Agent Brain → Playback Engine → Orchestrator → Audience Dashboard → Polish
