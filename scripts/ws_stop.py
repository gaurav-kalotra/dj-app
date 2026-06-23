import sys, asyncio, json
sys.stdout.reconfigure(encoding="utf-8")
import websockets

async def main():
    async with websockets.connect("ws://localhost:8888/ws") as ws:
        snap = json.loads(await asyncio.wait_for(ws.recv(), timeout=3))
        print(f"current state: {snap['state']}")
        await ws.send(json.dumps({"cmd": "stop"}))
        for _ in range(3):
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
                print(f"event: {msg['event']} state={msg.get('state','')}")
            except asyncio.TimeoutError:
                break
        print("stopped.")

asyncio.run(main())
