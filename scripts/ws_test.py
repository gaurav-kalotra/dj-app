"""Quick WS smoke test: connect, seed, start, collect events for 15s."""
import asyncio, json, httpx, websockets

WS_URL  = "ws://localhost:8888/ws"
API_URL = "http://localhost:8888"

async def main():
    lib = httpx.get(f"{API_URL}/library").json()
    seed = lib[0]
    print(f"Seed track: {seed['artist']} — {seed['title']} ({seed['bpm']} BPM {seed['camelot']})")

    async with websockets.connect(WS_URL) as ws:
        # initial state
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        print(f"[{msg['event']}] state={msg.get('state')}")

        # seed Deck A
        await ws.send(json.dumps({"cmd": "seed", "deck": "A", "source_id": seed["source_id"]}))
        for _ in range(3):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
                track = msg.get("track", {})
                print(f"[{msg['event']}] deck={msg.get('deck')} track={track.get('title', '')[:30]} state={msg.get('state', '')}")
            except asyncio.TimeoutError:
                break

        # start session
        print("\n--- sending start ---")
        await ws.send(json.dumps({"cmd": "start"}))

        # collect events for 20 seconds
        deadline = asyncio.get_event_loop().time() + 20
        while asyncio.get_event_loop().time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=2)
                msg = json.loads(raw)
                ev = msg.get("event", "?")
                if ev == "agent_feed":
                    print(f"  AGENT: {msg['message']}")
                elif ev == "suggestions":
                    tracks = msg.get("tracks", [])
                    print(f"[{ev}] {len(tracks)} suggestions:")
                    for t in tracks:
                        print(f"    • {t['artist']} — {t['title']}")
                    # auto-pick first
                    if tracks:
                        print("  -> picking first suggestion")
                        await ws.send(json.dumps({"cmd": "select_suggestion", "source_id": tracks[0]["source_id"]}))
                elif ev == "track_queued":
                    t = msg.get("track", {})
                    print(f"[{ev}] deck={msg.get('deck')} autoplay={msg.get('autoplay')} track={t.get('title','')[:30]}")
                elif ev == "session_state":
                    print(f"[{ev}] state={msg.get('state')} outgoing={msg.get('outgoing_deck')}")
                else:
                    print(f"[{ev}]")
            except asyncio.TimeoutError:
                pass

        print("\nWS test complete — 20s elapsed")

asyncio.run(main())
