"""Connect and dump full session snapshot + live events."""
import sys, asyncio, json
import websockets

sys.stdout.reconfigure(encoding="utf-8")

async def main():
    async with websockets.connect("ws://localhost:8888/ws") as ws:
        # First message is always the full snapshot
        snap = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        print("=== SESSION SNAPSHOT ===")
        print(f"  state:    {snap.get('state')}")
        print(f"  outgoing: {snap.get('outgoing_deck')}")
        da = snap.get("deck_a") or {}
        db = snap.get("deck_b") or {}
        print(f"  deck A:   {da.get('artist','')} — {da.get('title','')} ({da.get('bpm')} BPM, dur={da.get('duration_s')})")
        print(f"  deck B:   {db.get('artist','')} — {db.get('title','')} ({db.get('bpm')} BPM, dur={db.get('duration_s')})")
        print(f"  narrative:{snap.get('narrative')}")
        print("========================\n")
        print("Listening for 180s (3 min)...")

        deadline = asyncio.get_event_loop().time() + 180
        while asyncio.get_event_loop().time() < deadline:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                ev = msg.get("event", "?")
                if ev == "agent_feed":
                    print(f"  AGENT: {msg['message']}")
                elif ev == "session_state":
                    print(f"[{ev}] state={msg.get('state')} outgoing={msg.get('outgoing_deck')}")
                elif ev == "track_queued":
                    t = msg.get("track", {})
                    print(f"[{ev}] deck={msg.get('deck')} autoplay={msg.get('autoplay')} | {t.get('artist','')} — {t.get('title','')[:30]}")
                elif ev == "transition_start":
                    out, inc = msg.get("outgoing"), msg.get("incoming")
                    print(f"*** [TRANSITION] {out} -> {inc} ***")
                    await ws.send(json.dumps({"cmd": "transition_timing", "delay_ms": 12000, "duration_ms": 14000}))
                    print("  (ack sent)")
                else:
                    print(f"[{ev}]")
                sys.stdout.flush()
            except asyncio.TimeoutError:
                pass
        print("--- 180s elapsed ---")

asyncio.run(main())
