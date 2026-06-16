import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .store import Store

load_dotenv()

app = FastAPI(title="AXIOM")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent.parent.parent / "data"
DB_PATH  = DATA_DIR / "axiom.db"


def _store() -> Store:
    return Store(DB_PATH)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "axiom"}


@app.get("/library")
async def library():
    store = _store()
    rows = store.all_analyses()
    store.close()
    result = []
    for r in rows:
        result.append({
            "source_id":  r["source_id"],
            "title":      r["title"],
            "artist":     r["artist"],
            "genre":      r["genre"],
            "bpm":        r["bpm"],
            "key":        r["key"],
            "camelot":    r["camelot"],
            "duration_s": r["duration_s"],
            "beat_grid":     json.loads(r["beat_grid_json"]),
            "energy_curve":  json.loads(r["energy_json"]),
            "segments":      json.loads(r["segments_json"]),
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


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({"event": "connected", "service": "axiom"})
    await websocket.close()
