"""Quick-mode analysis (spec sections 8 and 12): a Stockfish-only pass over a
saved game's mainline, streamed to the client as a background job so the
board can animate through positions as they're evaluated (section 6).

Each job gets its own short-lived Stockfish process for the run's duration
-- separate from, and never contending unmanaged with, the persistent
live-eval session for the same user (section 3). This isn't yet running
through the bounded CPU-sized worker pool from section 10 (multi-instance
hardening is a later build-order step); each job is its own asyncio task for
now.
"""

import asyncio
import io
import uuid

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .auth import SESSION_COOKIE, _user_for_token, require_user
from .classify import classify_moves, eval_to_cp
from .db import db_cursor
from .engine_manager import engine_options_from_settings, evaluate_position, start_configured_engine
from .engine_settings import get_effective_settings

router = APIRouter(prefix="/api/analysis", tags=["analysis"])
ws_router = APIRouter()  # unprefixed -- /ws/analysis/{job_id}, matching live_eval_ws.py's pattern

MAX_RETAINED_JOBS = 50


class AnalysisJob:
    def __init__(self, job_id: str, user_id: int, game_id: int):
        self.job_id = job_id
        self.user_id = user_id
        self.game_id = game_id
        self.events: list[dict] = []
        self.subscribers: set[WebSocket] = set()
        self.task: asyncio.Task | None = None

    async def emit(self, event: dict):
        self.events.append(event)
        dead = []
        for ws in list(self.subscribers):
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.subscribers.discard(ws)


jobs: dict[str, AnalysisJob] = {}


def _evict_old_jobs(keep: int = MAX_RETAINED_JOBS):
    while len(jobs) > keep:
        jobs.pop(next(iter(jobs)), None)


def _parse_game_positions(pgn_text: str):
    """Returns (fens, sans, final_board). fens has N+1 entries (fens[0] is
    the start position, fens[N] the final one) for a game of N moves."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    board = game.board()
    fens = [board.fen()]
    sans = []
    for move in game.mainline_moves():
        sans.append(board.san(move))
        board.push(move)
        fens.append(board.fen())
    return fens, sans, board


async def _run_quick_job(job: AnalysisJob, pgn_text: str, engine_settings: dict):
    try:
        fens, sans, final_board = _parse_game_positions(pgn_text)
        total = len(fens) - 1  # number of moves
        cp_evals: list[float] = [0.0] * len(fens)

        path = engine_settings.get("stockfish_path")
        if not path:
            raise RuntimeError("Stockfish path is not configured -- set it in Settings first")

        engine = await start_configured_engine(path, engine_options_from_settings(engine_settings))
        limit_type = engine_settings.get("sf_limit_type", "depth")
        limit_value = engine_settings.get("sf_limit_value", 18)

        try:
            for i, fen in enumerate(fens):
                is_final = i == len(fens) - 1
                if is_final and final_board.is_checkmate():
                    # the side to move at the final position is the one who got mated
                    cp = -10000.0
                elif is_final and final_board.is_stalemate():
                    cp = 0.0
                else:
                    info = await evaluate_position(engine, fen, limit_type, limit_value)
                    cp = eval_to_cp(info)
                cp_evals[i] = cp
                await job.emit({"type": "progress", "ply": i, "total": total, "fen": fen})
        finally:
            engine.terminate()
            await engine.wait_closed()

        moves = classify_moves(cp_evals)
        for m, san in zip(moves, sans):
            m["san"] = san
        await job.emit({"type": "done", "moves": moves})
    except Exception as e:
        await job.emit({"type": "error", "message": str(e)})


class QuickAnalysisIn(BaseModel):
    game_id: int


@router.post("/quick")
async def start_quick_analysis(body: QuickAnalysisIn, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT pgn_text FROM games WHERE id = ? AND user_id = ?", (body.game_id, user["id"])
        ).fetchone()
    if not row:
        raise HTTPException(404, "no such game")
    settings = get_effective_settings(user["id"])

    job_id = uuid.uuid4().hex
    job = AnalysisJob(job_id, user["id"], body.game_id)
    jobs[job_id] = job
    _evict_old_jobs()
    job.task = asyncio.create_task(_run_quick_job(job, row["pgn_text"], settings))
    return {"job_id": job_id}


@router.get("/jobs")
def list_jobs(user: dict = Depends(require_user)):
    """Process/job accounting, mirroring the live-engine status endpoint."""
    return [
        {
            "job_id": j.job_id,
            "game_id": j.game_id,
            "subscribers": len(j.subscribers),
            "events": len(j.events),
            "finished": bool(j.events) and j.events[-1]["type"] in ("done", "error"),
        }
        for j in jobs.values()
        if j.user_id == user["id"]
    ]


@ws_router.websocket("/ws/analysis/{job_id}")
async def analysis_ws(websocket: WebSocket, job_id: str):
    token = websocket.cookies.get(SESSION_COOKIE)
    user = _user_for_token(token)
    if not user:
        await websocket.close(code=4401)
        return
    job = jobs.get(job_id)
    if not job or job.user_id != user["id"]:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    for event in job.events:  # catch a reconnecting client up on what it missed
        await websocket.send_json(event)
    job.subscribers.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        job.subscribers.discard(websocket)
