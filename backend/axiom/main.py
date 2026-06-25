import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .brain.client import BrainClient
from .orchestrator import Orchestrator
from .sources.audius import AudiusAdapter
from .store import Store

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent.parent / "data"
DB_PATH  = DATA_DIR / "axiom.db"


@asynccontextmanager
async def lifespan(app: FastAPI):
    store  = Store(DB_PATH)
    brain  = BrainClient()
    audius = AudiusAdapter()
    app.state.store       = store
    app.state.orchestrator = Orchestrator(store, brain, audius, DATA_DIR)
    yield
    store.close()


app = FastAPI(title="AXIOM", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "axiom"}


@app.get("/library")
async def library(request: Request):
    store: Store = request.app.state.store
    rows = store.all_analyses()
    result = []
    for r in rows:
        result.append({
            "source_id":    r["source_id"],
            "title":        r["title"],
            "artist":       r["artist"],
            "genre":        r["genre"],
            "bpm":          r["bpm"],
            "key":          r["key"],
            "camelot":      r["camelot"],
            "duration_s":   r["duration_s"],
            "beat_grid":    json.loads(r["beat_grid_json"]),
            "energy_curve": json.loads(r["energy_json"]),
            "segments":     json.loads(r["segments_json"]),
        })
    return result


@app.get("/audio/{source_id}")
async def audio(source_id: str):
    audio_dir = DATA_DIR / "audio"
    for ext in (".mp3", ".ogg", ".flac", ".wav"):
        path = audio_dir / f"{source_id}{ext}"
        if path.exists():
            return FileResponse(str(path), media_type=f"audio/{ext.lstrip('.')}")
    raise HTTPException(status_code=404, detail=f"Audio not found: {source_id}")


class RequestBody(BaseModel):
    query: str
    requester: str | None = None


@app.get("/session")
async def session(request: Request):
    orch: Orchestrator = request.app.state.orchestrator
    return orch.public_queue()


@app.post("/requests")
async def submit_request(body: RequestBody, request: Request):
    orch: Orchestrator = request.app.state.orchestrator
    return await orch.submit_request(body.query.strip(), body.requester)


@app.get("/requests")
async def list_requests(request: Request):
    store: Store = request.app.state.store
    return [dict(r) for r in store.all_requests()]


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    orch: Orchestrator = websocket.app.state.orchestrator
    await orch.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            await orch.handle_command(data)
    except WebSocketDisconnect:
        await orch.disconnect(websocket)
    except Exception as e:
        log.exception("WebSocket error: %s", e)
        await orch.disconnect(websocket)
