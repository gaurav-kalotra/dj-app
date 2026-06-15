"""Phase 0 gate: verify Audius and Claude API connectivity."""
import asyncio
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")


async def test_audius() -> bool:
    print("── Audius API ──")
    api_key = os.getenv("AUDIUS_API_KEY", "")
    headers = {"X-API-KEY": api_key} if api_key else {}
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://api.audius.co/v1/tracks/search",
            params={"query": "deep house", "limit": 1},
            headers=headers,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        track = data["data"][0]
        print(f"  OK — {track['title']} by {track['user']['name']}")
    return True


async def test_claude() -> bool:
    print("── Claude API ──")
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        print("  SKIP — ANTHROPIC_API_KEY not set in .env")
        return False
    from anthropic import AsyncAnthropic

    client = AsyncAnthropic(api_key=api_key)
    msg = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=32,
        messages=[{"role": "user", "content": "Reply with exactly: AXIOM online."}],
    )
    print(f"  OK — {msg.content[0].text.strip()}")
    return True


async def main() -> None:
    print("AXIOM — Phase 0 smoke test\n")
    results = await asyncio.gather(test_audius(), test_claude(), return_exceptions=True)
    for r in results:
        if isinstance(r, Exception):
            print(f"  ERROR — {r}")
    passed = all(r is True for r in results)
    print(f"\n{'✓ PASS' if passed else '✗ FAIL'} — Phase 0 gate")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    asyncio.run(main())
