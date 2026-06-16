"""Phase 1 gate: download and analyze tracks from a given genre.

Usage:
    python scripts/ingest.py --genre "deep house" --count 10
    python scripts/ingest.py --genre techno --count 5 --out data/cache
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import os
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

import argparse
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from axiom.analysis.analyzer import analyze
from axiom.sources.audius import AudiusAdapter
from axiom.store import Store

CACHE_DIR = Path(__file__).parent.parent / "data" / "audio"
DB_PATH   = Path(__file__).parent.parent / "data" / "axiom.db"


async def run(genre: str, count: int, out: Path, max_duration: float) -> None:
    store = Store(DB_PATH)
    adapter = AudiusAdapter()

    print(f"\nAXIOM ingest — genre: {genre!r}, target: {count} tracks, max dur: {max_duration:.0f}s\n")

    print("  Searching Audius for download-permitted tracks...")
    results = await adapter.search(genre, limit=count * 5)   # fetch extra; sets inflate the list

    if not results:
        print("  No downloadable tracks found for that genre on Audius.")
        return

    # Filter out DJ sets / long-form content before counting
    before = len(results)
    results = [r for r in results if 0 < r.duration_s <= max_duration]
    print(f"  Found {before} candidates → {len(results)} after duration filter (≤{max_duration:.0f}s)\n")

    ingested = 0
    failed   = 0

    for meta in results:
        if ingested >= count:
            break

        label = f"{meta.artist} — {meta.title}"

        if store.is_analyzed(meta.source_id):
            print(f"  [skip]  {label}  (already in library)")
            ingested += 1
            continue

        # Download
        print(f"  [dl]    {label} ...", end=" ", flush=True)
        try:
            audio_path = await adapter.download(meta, out)
            print(f"OK ({audio_path.stat().st_size // 1024} KB)")
        except Exception as exc:
            print(f"FAIL — {exc}")
            failed += 1
            continue

        # Analyze (CPU-bound — run in thread pool)
        print(f"  [anl]   {label} ...", end=" ", flush=True)
        try:
            loop = asyncio.get_running_loop()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                analysis = await loop.run_in_executor(
                    pool, analyze, audio_path, meta.source_id
                )
            print(
                f"OK  BPM={analysis.bpm:.1f}  key={analysis.key}  "
                f"camelot={analysis.camelot}  dur={analysis.duration_s:.0f}s"
            )
        except Exception as exc:
            print(f"FAIL — {exc}")
            failed += 1
            continue

        # Persist
        store.upsert_track(meta)
        store.upsert_analysis(analysis)
        ingested += 1

    store.close()

    print(f"\n{'─'*60}")
    print(f"  Ingested : {ingested}")
    print(f"  Failed   : {failed}")
    print(f"  DB       : {DB_PATH}")
    print(f"  Audio    : {out}")
    print(f"{'─'*60}\n")

    if ingested < count:
        print(f"  WARNING: only got {ingested}/{count} tracks — Audius may have "
              "limited downloadable tracks for this genre.")


def main() -> None:
    parser = argparse.ArgumentParser(description="AXIOM Phase 1 ingest")
    parser.add_argument("--genre",        default="deep house", help="Genre search query")
    parser.add_argument("--count",        type=int,   default=10,  help="Target track count")
    parser.add_argument("--out",          type=Path,  default=CACHE_DIR, help="Audio cache directory")
    parser.add_argument("--max-duration", type=float, default=None, help="Optional max track duration in seconds (omit to accept all lengths)")
    args = parser.parse_args()

    asyncio.run(run(args.genre, args.count, args.out, args.max_duration or float("inf")))


if __name__ == "__main__":
    main()
