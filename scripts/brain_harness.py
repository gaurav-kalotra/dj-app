"""Phase 2 gate: offline brain harness.

Feeds a seed track + library snapshot to the brain and prints ranked candidates.
Run 10 times to validate schema consistency and rules compliance.

Usage:
    python scripts/brain_harness.py --seed <source_id> --runs 10
    python scripts/brain_harness.py --runs 1             # picks first track in DB as seed
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import argparse
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from axiom.analysis.camelot import camelot_distance
from axiom.brain.client import BrainClient
from axiom.rules import check_transition, reachable_bpm_window
from axiom.store import Store

DB_PATH = Path(__file__).parent.parent / "data" / "axiom.db"


def _build_user_content(seed_row, library: list, narrative: str) -> str:
    """Serialize the selection context as a JSON string for the brain."""
    bpm_lo, bpm_hi = reachable_bpm_window(seed_row["bpm"])
    context = {
        "now_playing": {
            "source_id": seed_row["source_id"],
            "title": seed_row["title"],
            "artist": seed_row["artist"],
            "bpm": seed_row["bpm"],
            "key": seed_row["key"],
            "camelot": seed_row["camelot"],
            "duration_s": seed_row["duration_s"],
        },
        "reachable_bpm_window": [round(bpm_lo, 1), round(bpm_hi, 1)],
        "previous_set_narrative": narrative or "Session just started.",
        "candidate_library": [
            {
                "source_id": r["source_id"],
                "title": r["title"],
                "artist": r["artist"],
                "bpm": r["bpm"],
                "key": r["key"],
                "camelot": r["camelot"],
                "camelot_distance_from_now_playing": camelot_distance(seed_row["key"], r["key"]),
                "duration_s": r["duration_s"],
                "genre": r["genre"],
            }
            for r in library
            if r["source_id"] != seed_row["source_id"]
        ],
    }
    return json.dumps(context, indent=2)


async def run(seed_id: str | None, runs: int) -> None:
    store = Store(DB_PATH)
    client = BrainClient()

    all_rows = store.all_analyses()
    if not all_rows:
        print("Library is empty — run scripts/ingest.py first.")
        return

    seed = next((r for r in all_rows if r["source_id"] == seed_id), None) if seed_id else all_rows[0]
    if seed is None:
        print(f"Seed {seed_id!r} not found in library.")
        return

    print(f"\nAXIOM brain harness — seed: {seed['artist']} — {seed['title']}")
    print(f"  BPM={seed['bpm']}  key={seed['key']}  camelot={seed['camelot']}\n")

    narrative = ""
    passed = 0
    failed = 0

    for i in range(1, runs + 1):
        print(f"── Run {i}/{runs} ", end="", flush=True)
        user_content = _build_user_content(seed, list(all_rows), narrative)

        try:
            selection = await client.select_track(user_content)
        except Exception as exc:
            print(f"FAIL — brain error: {exc}")
            failed += 1
            continue

        # Rules check every candidate
        run_ok = True
        for rank, c in enumerate(selection.candidates, 1):
            candidate_row = next((r for r in all_rows if r["source_id"] == c.source_id), None)
            if candidate_row is None:
                print(f"\n  [rank {rank}] FAIL — unknown source_id {c.source_id!r}")
                run_ok = False
                continue

            result = check_transition(
                seed["bpm"], seed["key"],
                candidate_row["bpm"], candidate_row["key"],
                transition_type=c.transition_type,
            )
            status = "OK " if result.ok else "VIOLATION"
            print(
                f"\n  [rank {rank}] {status}  {candidate_row['artist']} — {candidate_row['title']}"
                f"  BPM={candidate_row['bpm']}  camelot={candidate_row['camelot']}"
                f"  type={c.transition_type}  conf={c.confidence:.2f}"
            )
            print(f"           reason: {c.reason}")
            if not result.ok:
                for v in result.violations:
                    print(f"           VIOLATION: {v}")
                run_ok = False

        print(f"\n  narrative: {selection.set_narrative}")

        if run_ok:
            passed += 1
            print(f"  → PASS\n")
        else:
            failed += 1
            print(f"  → FAIL (rules violation)\n")

        # Carry narrative forward so brain stays coherent across runs
        narrative = selection.set_narrative
        # Advance seed to top candidate for next run
        top = next((r for r in all_rows if r["source_id"] == selection.candidates[0].source_id), seed)
        seed = top

    store.close()
    print(f"{'─'*60}")
    print(f"  Runs passed : {passed}/{runs}")
    print(f"  Runs failed : {failed}/{runs}")
    gate = passed == runs
    print(f"\n  {'PASS' if gate else 'FAIL'} — Phase 2 gate")
    print(f"{'─'*60}\n")
    sys.exit(0 if gate else 1)


def main() -> None:
    parser = argparse.ArgumentParser(description="AXIOM Phase 2 brain harness")
    parser.add_argument("--seed", default=None, help="source_id of the starting track")
    parser.add_argument("--runs", type=int, default=10, help="Number of consecutive selections")
    args = parser.parse_args()
    asyncio.run(run(args.seed, args.runs))


if __name__ == "__main__":
    main()
