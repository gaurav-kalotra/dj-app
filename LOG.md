# AXIOM — Build Log

A running record of what got done and when. Updated as work progresses.

---

## 2026-06-15

### Phase 0 — Foundations

- Scaffolded `backend/` Python package (`axiom`) with FastAPI skeleton, `pyproject.toml`, venv-based install
- Scaffolded `frontend/` React + Vite + TypeScript; `App.tsx` pings backend WebSocket on load
- Added `.env.example` (`ANTHROPIC_API_KEY`, `AUDIUS_API_KEY`), `.gitignore`, `Makefile`
- Added `scripts/smoke_test.py` — Phase 0 gate runner (Audius search + Claude API ping)
- **Next:** `make install`, fill in `.env`, run `make smoke` to pass Phase 0 gate

---

## 2026-06-11

- Created repo `dj-app` on GitHub
- Added `ROADMAP.md` — full project spec, architecture, phases, and musical rules
- Added `README.md` — project overview, architecture diagram, setup instructions, build status
