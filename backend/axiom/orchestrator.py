"""AXIOM Orchestrator — autonomous DJ state machine.

Invariant: while track N plays, track N+1 is fully downloaded, analyzed, and
cued on the idle deck, and the brain is already shortlisting N+2.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .analysis.analyzer import analyze
from .analysis.camelot import camelot_distance
from .brain.client import BrainClient
from .mixplan import compute_mixplan, MixPlan
from .rules import check_transition, reachable_bpm_window
from .sources.audius import AudiusAdapter
from .store import Store

log = logging.getLogger(__name__)

SUGGESTION_TIMEOUT_S  = 10
PIPELINE_BUDGET_S     = 90   # max seconds to wait for N+1 pipeline at transition time
TIMING_REPORT_WAIT_S  = 3    # seconds to wait for frontend transition_timing ack


@dataclass
class LiveDeck:
    track: dict | None = None
    playing: bool = False
    play_started_at: float = 0.0  # monotonic time when this deck started playing from position 0


class Orchestrator:
    def __init__(
        self,
        store: Store,
        brain: BrainClient,
        audius: AudiusAdapter,
        data_dir: Path,
    ) -> None:
        self._store    = store
        self._brain    = brain
        self._audius   = audius
        self._audio_dir = data_dir / "audio"
        self._audio_dir.mkdir(parents=True, exist_ok=True)

        self._clients: list[Any] = []
        self._state: str = "idle"
        self._deck_a   = LiveDeck()
        self._deck_b   = LiveDeck()
        self._outgoing: str = "A"
        self._history:  list[str] = []
        self._narrative: str = ""
        self._next_track: dict | None = None

        self._loop_task:     asyncio.Task | None = None
        self._pipeline_task: asyncio.Task | None = None

        self._timing_event: asyncio.Event = asyncio.Event()
        self._timing_data:  dict | None   = None

        self._request_queue: list[dict] = []  # [{req_id, track}]

        # accepted request queue — [{req_id, track, slot_hint}]
        self._request_queue: list[dict] = []

    # ── WebSocket management ──────────────────────────────────────────────────

    async def connect(self, ws: Any) -> None:
        await ws.accept()
        self._clients.append(ws)
        await self._send(ws, self._snapshot())

    async def disconnect(self, ws: Any) -> None:
        self._clients = [c for c in self._clients if c is not ws]

    async def _broadcast(self, event: dict) -> None:
        dead = []
        for ws in self._clients:
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for d in dead:
            self._clients.remove(d)

    async def _send(self, ws: Any, event: dict) -> None:
        try:
            await ws.send_json(event)
        except Exception:
            pass

    def _snapshot(self) -> dict:
        return {
            "event":         "session_state",
            "state":         self._state,
            "outgoing_deck": self._outgoing,
            "deck_a":        self._deck_a.track,
            "deck_b":        self._deck_b.track,
            "narrative":     self._narrative,
        }

    async def _feed(self, msg: str) -> None:
        log.info("[AGENT] %s", msg)
        await self._broadcast({"event": "agent_feed", "message": msg, "ts": time.time()})

    # ── Command router ────────────────────────────────────────────────────────

    async def handle_command(self, data: dict) -> None:
        cmd = data.get("cmd")
        if cmd == "seed":
            await self._cmd_seed(data)
        elif cmd == "start":
            await self._cmd_start()
        elif cmd == "stop":
            await self._cmd_stop()
        elif cmd == "select_suggestion":
            await self._cmd_select_suggestion(data)
        elif cmd == "transition_timing":
            self._timing_data = data
            self._timing_event.set()

    # ── Commands ──────────────────────────────────────────────────────────────

    async def _cmd_seed(self, data: dict) -> None:
        deck_id   = (data.get("deck") or "A").upper()
        source_id = data.get("source_id")
        if not source_id:
            return
        track = self._get_track(source_id)
        if not track:
            await self._broadcast({"event": "error", "message": f"Track not in library: {source_id}"})
            return
        if deck_id == "A":
            self._deck_a.track = track
        else:
            self._deck_b.track = track
        await self._broadcast({"event": "track_queued", "deck": deck_id, "track": track, "autoplay": False})
        await self._broadcast(self._snapshot())

    async def _cmd_start(self) -> None:
        if self._state not in ("idle", "stopped"):
            return
        if not self._deck_a.track:
            await self._broadcast({"event": "error", "message": "Seed Deck A first"})
            return
        self._state = "suggesting"
        await self._broadcast(self._snapshot())
        await self._feed("Asking brain for Deck B suggestions…")
        suggestions = await self._get_suggestions(self._deck_a.track)
        await self._broadcast({
            "event":        "suggestions",
            "tracks":       suggestions,
            "auto_pick_ms": int(SUGGESTION_TIMEOUT_S * 1000),
        })
        self._loop_task = asyncio.create_task(self._suggestion_wait(suggestions))

    async def _suggestion_wait(self, suggestions: list[dict]) -> None:
        await asyncio.sleep(SUGGESTION_TIMEOUT_S)
        if self._state == "suggesting" and suggestions:
            top = suggestions[0]
            await self._feed(f"Auto-picking Deck B: {top['artist']} — {top['title']}")
            await self._begin_session(top)

    async def _cmd_select_suggestion(self, data: dict) -> None:
        if self._state != "suggesting":
            return
        source_id = data.get("source_id")
        track = self._get_track(source_id) if source_id else None
        if not track:
            return
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
        await self._begin_session(track)

    async def _cmd_stop(self) -> None:
        self._state = "stopped"
        for task in (self._loop_task, self._pipeline_task):
            if task and not task.done():
                task.cancel()
        await self._broadcast({"event": "session_stopped"})
        await self._broadcast(self._snapshot())
        await self._feed("Session stopped.")

    # ── Session start ─────────────────────────────────────────────────────────

    async def _begin_session(self, deck_b_track: dict) -> None:
        self._deck_b.track = deck_b_track
        self._state        = "playing"
        self._outgoing     = "A"
        self._deck_a.playing        = True
        self._deck_a.play_started_at = time.monotonic()
        self._history = [self._deck_a.track["source_id"]]

        await self._broadcast({"event": "track_queued", "deck": "A", "track": self._deck_a.track, "autoplay": True})
        await self._broadcast({"event": "track_queued", "deck": "B", "track": deck_b_track, "autoplay": False})
        await self._broadcast(self._snapshot())
        await self._feed(f"▶ Playing: {self._deck_a.track['artist']} — {self._deck_a.track['title']}")
        await self._feed(f"⏸ Cued:    {deck_b_track['artist']} — {deck_b_track['title']}")

        self._loop_task = asyncio.create_task(self._run_loop())

    # ── Autonomous loop ───────────────────────────────────────────────────────

    async def _run_loop(self) -> None:
        while self._state == "playing":
            out_id   = self._outgoing
            inc_id   = "B" if out_id == "A" else "A"
            out_deck = self._deck(out_id)
            inc_deck = self._deck(inc_id)

            if not out_deck.track or not inc_deck.track:
                log.error("Deck missing track — halting loop")
                break

            plan = compute_mixplan(out_deck.track, inc_deck.track, "long_blend")

            # Start N+2 pipeline immediately (runs while outgoing track plays)
            self._next_track = None
            if self._pipeline_task and not self._pipeline_task.done():
                self._pipeline_task.cancel()
            self._pipeline_task = asyncio.create_task(
                self._pipeline_next(inc_deck.track)
            )

            # Sleep until the transition point
            now     = time.monotonic()
            sleep_s = (out_deck.play_started_at + plan.outgoing_start_s) - now
            if sleep_s > 0:
                mins = int(sleep_s // 60)
                secs = int(sleep_s % 60)
                await self._feed(
                    f"⏳ Next transition in {mins}m{secs:02d}s  "
                    f"({out_deck.track['title'][:24]} → {inc_deck.track['title'][:24]})"
                )
                await asyncio.sleep(sleep_s)

            if self._state != "playing":
                break

            # Ensure pipeline is done (or wait up to PIPELINE_BUDGET_S)
            if not self._pipeline_task.done():
                await self._feed("⏳ Waiting for next-track pipeline…")
                try:
                    await asyncio.wait_for(
                        asyncio.shield(self._pipeline_task), timeout=PIPELINE_BUDGET_S
                    )
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    await self._feed("⚠ Pipeline timed out — using cached fallback")
                    self._pipeline_task.cancel()
                    if not self._next_track:
                        self._next_track = self._pick_cached_fallback(inc_deck.track)

            # Fire the transition
            transition_sent_at = time.monotonic()
            self._timing_event.clear()
            self._timing_data = None
            await self._broadcast({
                "event":    "transition_start",
                "outgoing": out_id,
                "incoming": inc_id,
            })
            await self._feed(f"🎛  Transition: Deck {out_id} → Deck {inc_id}")

            # Wait for frontend to report timing (with estimate fallback)
            delay_s, blend_s = await self._await_timing(plan)
            await asyncio.sleep(delay_s + blend_s)

            if self._state != "playing":
                break

            # Flip roles — N+1 started playing from position 0 at transition_sent_at
            self._outgoing             = inc_id
            inc_deck.play_started_at   = transition_sent_at
            inc_deck.playing           = True
            out_deck.playing           = False
            self._history = (self._history + [inc_deck.track["source_id"]])[-5:]

            # Load N+2 onto the now-idle deck
            n2 = self._next_track
            self._next_track = None
            if n2:
                if out_id == "A":
                    self._deck_a.track = n2
                else:
                    self._deck_b.track = n2
                await self._broadcast({"event": "track_queued", "deck": out_id, "track": n2, "autoplay": False})
                await self._feed(f"⏸ Loaded on Deck {out_id}: {n2['artist']} — {n2['title']}")
            else:
                await self._feed("⚠ No next track ready — will retry on next cycle")

            await self._broadcast(self._snapshot())

    async def _await_timing(self, plan: MixPlan) -> tuple[float, float]:
        """Wait for frontend transition_timing ack; fall back to estimate."""
        try:
            await asyncio.wait_for(self._timing_event.wait(), timeout=TIMING_REPORT_WAIT_S)
            d = self._timing_data or {}
            return d.get("delay_ms", 0) / 1000, d.get("duration_ms", plan.blend_duration_s * 1000) / 1000
        except asyncio.TimeoutError:
            bpm = (self._deck(self._outgoing).track or {}).get("bpm") or 120.0
            delay_estimate = 8 * 4 * (60.0 / bpm)  # 8 bars
            return delay_estimate, plan.blend_duration_s

    # ── N+1 pipeline ─────────────────────────────────────────────────────────

    async def _pipeline_next(self, anchor: dict) -> None:
        """Select and prepare N+2. Sets self._next_track on success."""
        # Priority: fulfilled requests first
        if self._request_queue:
            entry = self._request_queue.pop(0)
            self._store.mark_request_played(entry["req_id"])
            self._next_track = entry["track"]
            await self._feed(f"🎤 Playing request: {entry['track']['artist']} — {entry['track']['title']}")
            return

        # Re-evaluate deferred requests against current anchor
        await self._promote_deferred(anchor)
        if self._request_queue:
            entry = self._request_queue.pop(0)
            self._store.mark_request_played(entry["req_id"])
            self._next_track = entry["track"]
            await self._feed(f"🎤 Playing deferred request: {entry['track']['artist']} — {entry['track']['title']}")
            return

        await self._feed("🧠 Brain selecting next track…")
        library = self._library_snapshot()
        if not library:
            return

        context = self._build_context(anchor, library)
        try:
            selection = await self._brain.select_track(context)
            self._narrative = selection.set_narrative
            await self._feed(f"📖 {self._narrative}")
        except Exception as e:
            await self._feed(f"⚠ Brain error: {e} — using rules fallback")
            self._next_track = self._rules_fallback(anchor)
            return

        for candidate in selection.candidates:
            track = self._get_track(candidate.source_id)
            if not track:
                track = await self._acquire(candidate.source_id, anchor.get("genre"))
                if not track:
                    await self._feed(f"  ✗ {candidate.source_id}: not acquirable")
                    continue

            result = check_transition(
                anchor["bpm"],  anchor.get("key", ""),
                track["bpm"],   track.get("key", ""),
                candidate.transition_type,
            )
            if not result.ok:
                await self._feed(f"  ✗ {track['title'][:24]}: {result.violations[0]}")
                continue

            await self._feed(
                f"  ✓ {track['artist']} — {track['title']} "
                f"[{candidate.transition_type}, conf={candidate.confidence:.2f}]"
            )
            self._next_track = track
            return

        await self._feed("⚠ All brain candidates failed — rules fallback")
        self._next_track = self._rules_fallback(anchor)

    async def _acquire(self, source_id: str, genre: str | None) -> dict | None:
        """Download + analyze a track not yet in local cache."""
        if self._store.is_analyzed(source_id):
            return self._get_track(source_id)

        query = genre or "electronic"
        try:
            results = await self._audius.search(query, limit=50)
        except Exception as e:
            await self._feed(f"⚠ Audius search failed: {e}")
            return None

        meta = next((r for r in results if r.source_id == source_id), None)
        if not meta:
            return None

        await self._feed(f"⬇  Downloading: {meta.title}…")
        try:
            file_path = await self._audius.download(meta, self._audio_dir)
        except Exception as e:
            await self._feed(f"⚠ Download failed for {source_id}: {e}")
            return None

        await self._feed(f"🔬 Analyzing: {meta.title}…")
        try:
            loop = asyncio.get_running_loop()
            analysis = await loop.run_in_executor(None, analyze, file_path, source_id)
        except Exception as e:
            await self._feed(f"⚠ Analysis failed for {source_id}: {e}")
            return None

        self._store.upsert_track(meta)
        self._store.upsert_analysis(analysis)
        return self._get_track(source_id)

    # ── Library helpers ───────────────────────────────────────────────────────

    def _library_snapshot(self) -> list[dict]:
        rows = self._store.all_analyses()
        result = []
        for r in rows:
            tr = self._store.get_track(r["source_id"])
            result.append({
                "source_id":    r["source_id"],
                "title":        tr["title"]  if tr else "",
                "artist":       tr["artist"] if tr else "",
                "genre":        tr["genre"]  if tr else None,
                "bpm":          r["bpm"],
                "key":          r["key"],
                "camelot":      r["camelot"],
                "duration_s":   r["duration_s"],
                "beat_grid":    json.loads(r["beat_grid_json"]),
                "energy_curve": json.loads(r["energy_json"]),
                "segments":     json.loads(r["segments_json"]),
            })
        return result

    def _get_track(self, source_id: str | None) -> dict | None:
        if not source_id:
            return None
        row = self._store.get_analysis(source_id)
        if not row:
            return None
        tr = self._store.get_track(source_id)
        return {
            "source_id":    source_id,
            "title":        tr["title"]  if tr else "",
            "artist":       tr["artist"] if tr else "",
            "genre":        tr["genre"]  if tr else None,
            "bpm":          row["bpm"],
            "key":          row["key"],
            "camelot":      row["camelot"],
            "duration_s":   row["duration_s"],
            "beat_grid":    json.loads(row["beat_grid_json"]),
            "energy_curve": json.loads(row["energy_json"]),
            "segments":     json.loads(row["segments_json"]),
        }

    def _build_context(self, anchor: dict, library: list[dict]) -> str:
        bpm_lo, bpm_hi = reachable_bpm_window(anchor["bpm"])
        candidates = []
        for t in library:
            if t["source_id"] in self._history:
                continue
            if t["source_id"] == anchor["source_id"]:
                continue
            if not (bpm_lo <= t["bpm"] <= bpm_hi):
                continue
            dist = camelot_distance(anchor.get("key", ""), t.get("key", ""))
            slim = {k: v for k, v in t.items() if k not in ("beat_grid", "energy_curve")}
            candidates.append({**slim, "camelot_distance_from_now_playing": dist})

        history_titles = []
        for sid in self._history[-5:]:
            t = self._get_track(sid)
            history_titles.append(t["title"] if t else sid)

        return (
            f"NOW PLAYING: {anchor['artist']} — {anchor['title']} "
            f"({anchor['bpm']} BPM, {anchor.get('camelot', '?')})\n"
            f"RECENT HISTORY: {', '.join(history_titles) or 'none'}\n"
            f"CURRENT NARRATIVE: {self._narrative or 'Session just started.'}\n"
            f"REACHABLE BPM WINDOW: {bpm_lo:.1f}–{bpm_hi:.1f}\n"
            f"CANDIDATE LIBRARY:\n{json.dumps(candidates, indent=2)}"
        )

    def _rules_fallback(self, anchor: dict) -> dict | None:
        library = self._library_snapshot()
        bpm_lo, bpm_hi = reachable_bpm_window(anchor["bpm"])
        best, best_dist = None, 999
        for t in library:
            if t["source_id"] in self._history or t["source_id"] == anchor["source_id"]:
                continue
            if not (bpm_lo <= t["bpm"] <= bpm_hi):
                continue
            dist = camelot_distance(anchor.get("key", ""), t.get("key", "")) or 999
            if dist < best_dist:
                best, best_dist = t, dist
        return best

    def _pick_cached_fallback(self, exclude: dict) -> dict | None:
        library = self._library_snapshot()
        ex_ids = set(self._history) | {exclude.get("source_id", "")}
        return next((t for t in library if t["source_id"] not in ex_ids), None)

    # ── Public queue state (for dashboard) ───────────────────────────────────

    def public_queue(self) -> dict:
        out_deck = self._deck(self._outgoing)
        inc_id   = "B" if self._outgoing == "A" else "A"
        inc_deck = self._deck(inc_id)
        return {
            "state":         self._state,
            "now_playing":   out_deck.track,
            "cued":          inc_deck.track,
            "narrative":     self._narrative,
            "request_queue": [e["track"] for e in self._request_queue],
        }

    # ── Request handling ──────────────────────────────────────────────────────

    async def submit_request(self, query: str, requester: str | None) -> dict:
        req_id = f"r_{int(time.time())}_{random.randint(100, 999)}"
        self._store.submit_request(req_id, query, requester)

        match = self._search_library(query)

        if not match:
            reason = (
                "That track isn't in my current library — I only have access to "
                "the CC-licensed catalog I've analyzed. Try another."
            )
            self._store.update_request_verdict(req_id, "declined", None, reason)
            await self._broadcast_verdict(req_id, query, None, "declined", None, reason)
            await self._feed(f"❌ Request declined (not found): \"{query}\"")
            return {"id": req_id, "verdict": "declined", "public_reason": reason}

        if self._state != "playing":
            reason = f"Added to queue — {match['artist']} — {match['title']} will play when the session starts."
            self._store.update_request_verdict(
                req_id, "accepted", "next", reason,
                match["source_id"], match["title"], match["artist"],
            )
            self._request_queue.append({"req_id": req_id, "track": match})
            await self._broadcast_verdict(req_id, query, match, "accepted", "next", reason)
            return {"id": req_id, "verdict": "accepted", "slot_hint": "next", "public_reason": reason}

        anchor = self._deck(self._outgoing).track
        context = self._build_verdict_context(req_id, query, match, anchor)

        try:
            v = await self._brain.verdict_request(context)
            verdict, slot_hint, reason = v.verdict, v.slot_hint, v.public_reason
        except Exception as e:
            log.warning("Brain verdict failed: %s", e)
            dist   = camelot_distance(anchor.get("key", ""), match.get("key", "")) if anchor else 99
            bpm_lo, bpm_hi = reachable_bpm_window(anchor["bpm"]) if anchor else (0, 999)
            if anchor and bpm_lo <= match["bpm"] <= bpm_hi and dist <= 2:
                verdict, slot_hint = "accepted", "after_next"
                reason = f"{match['artist']} — {match['title']} fits the current key and BPM — queuing it up."
            else:
                verdict, slot_hint = "deferred", None
                reason = f"Holding {match['title']} for later — energy and BPM path need to shift first."

        expires_at = None
        if verdict == "deferred":
            expires_at = (datetime.utcnow() + timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S")

        self._store.update_request_verdict(
            req_id, verdict, slot_hint, reason,
            match["source_id"], match["title"], match["artist"],
            expires_at,
        )
        if verdict == "accepted":
            self._request_queue.append({"req_id": req_id, "track": match})
            await self._feed(f"✅ Request accepted: {match['artist']} — {match['title']} ({slot_hint})")
        elif verdict == "deferred":
            await self._feed(f"⏸ Request deferred: {match['title']}")
        else:
            await self._feed(f"❌ Request declined: {match['title']}")

        await self._broadcast_verdict(req_id, query, match, verdict, slot_hint, reason)
        return {"id": req_id, "verdict": verdict, "slot_hint": slot_hint, "public_reason": reason}

    def _search_library(self, query: str) -> dict | None:
        q = query.lower()
        library = self._library_snapshot()
        matches = [t for t in library if q in t["title"].lower() or q in t["artist"].lower()]
        if not matches:
            words = [w for w in q.split() if len(w) >= 3]
            matches = [
                t for t in library
                if any(w in t["title"].lower() or w in t["artist"].lower() for w in words)
            ]
        if not matches:
            return None
        anchor = self._deck(self._outgoing).track if self._state == "playing" else None
        if anchor:
            now_id = anchor.get("source_id")
            matches = [t for t in matches if t.get("source_id") != now_id]
            if not matches:
                return None
            matches.sort(key=lambda t: camelot_distance(anchor.get("key", ""), t.get("key", "")) or 0)
        return matches[0]

    def _build_verdict_context(self, req_id: str, query: str, match: dict, anchor: dict | None) -> str:
        lines = [
            f'REQUEST ID: {req_id}',
            f'REQUEST: "{query}"',
            f"MATCHED TRACK: {match['artist']} — {match['title']} ({match['bpm']} BPM, {match['camelot']})",
        ]
        if anchor:
            dist   = camelot_distance(anchor.get("key", ""), match.get("key", "")) or 0
            bpm_lo, bpm_hi = reachable_bpm_window(anchor["bpm"])
            delta  = abs(match["bpm"] - anchor["bpm"]) / anchor["bpm"] * 100
            lines += [
                f"CAMELOT DISTANCE TO CURRENT: {dist}",
                f"BPM DELTA: {delta:.1f}%",
                "",
                f"NOW PLAYING: {anchor['artist']} — {anchor['title']} ({anchor['bpm']} BPM, {anchor.get('camelot','?')})",
                f"CURRENT NARRATIVE: {self._narrative or 'Session just started.'}",
                f"REACHABLE BPM WINDOW: {bpm_lo:.1f}–{bpm_hi:.1f}",
            ]
        else:
            lines.append("Session not currently active.")
        return "\n".join(lines)

    async def _broadcast_verdict(
        self,
        req_id: str,
        query: str,
        match: dict | None,
        verdict: str,
        slot_hint: str | None,
        public_reason: str,
    ) -> None:
        await self._broadcast({
            "event":        "request_verdict",
            "request_id":   req_id,
            "query":        query,
            "matched":      {"title": match["title"], "artist": match["artist"]} if match else None,
            "verdict":      verdict,
            "slot_hint":    slot_hint,
            "public_reason": public_reason,
            "ts":           time.time(),
        })

    async def _promote_deferred(self, anchor: dict) -> None:
        if not anchor:
            return
        bpm_lo, bpm_hi = reachable_bpm_window(anchor["bpm"])
        for row in self._store.get_deferred_requests():
            if not row["matched_id"]:
                continue
            track = self._get_track(row["matched_id"])
            if not track:
                continue
            dist = camelot_distance(anchor.get("key", ""), track.get("key", "")) or 99
            if bpm_lo <= track["bpm"] <= bpm_hi and dist <= 2:
                reason = f"The BPM path reached {track['title']} — weaving it in now."
                self._store.update_request_verdict(
                    row["id"], "accepted", "next", reason,
                    track["source_id"], track["title"], track["artist"],
                )
                self._request_queue.append({"req_id": row["id"], "track": track})
                await self._feed(f"⏫ Deferred request promoted: {track['artist']} — {track['title']}")
                await self._broadcast_verdict(row["id"], row["query"], track, "accepted", "next", reason)

    async def _get_suggestions(self, seed: dict) -> list[dict]:
        library = self._library_snapshot()
        context = self._build_context(seed, library)
        try:
            selection = await self._brain.select_track(context)
            self._narrative = selection.set_narrative
            suggestions = [self._get_track(c.source_id) for c in selection.candidates]
            suggestions = [s for s in suggestions if s]
            if suggestions:
                return suggestions
        except Exception as e:
            await self._feed(f"⚠ Brain suggestion failed: {e}")

        bpm_lo, bpm_hi = reachable_bpm_window(seed["bpm"])
        return [
            t for t in library
            if bpm_lo <= t["bpm"] <= bpm_hi and t["source_id"] != seed["source_id"]
        ][:3]

    def _deck(self, deck_id: str) -> LiveDeck:
        return self._deck_a if deck_id == "A" else self._deck_b
