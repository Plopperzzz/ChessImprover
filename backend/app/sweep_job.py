"""Running the Maia Elo sweep over a game (spec section 9).

For each position where a player moved, Maia is asked for its choice at every
Elo on the grid. The resulting (position x Elo) match matrix is cached, so
re-fitting with a different objective -- or the trend view later -- never
re-runs the engine.

The engine work is ordered Elo-outermost: `setoption` for an Elo, then walk
every position at that setting. Re-setting the Elo once per grid point
instead of once per position keeps the option churn to len(grid) rather than
len(grid) * len(positions).
"""

import asyncio
import io
import json
import uuid

import chess
import chess.pgn
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from . import elo_sweep
from .analysis import AnalysisJob, jobs
from .auth import SESSION_COOKIE, _user_for_token, require_user
from .db import db_cursor
from .engine_manager import EngineProcess, pick_option, read_uci_options
from .engine_settings import get_effective_settings
from .maia import resolve_binary as resolve_maia_binary
from .play import ELO_OPTION_CANDIDATES, LIMIT_STRENGTH_CANDIDATES, MAIA_GO_COMMAND

router = APIRouter(prefix="/api/sweep", tags=["sweep"])


def build_grid(elo_min: int, elo_max: int, step: int) -> list[int]:
    if step <= 0:
        step = 100
    if elo_max < elo_min:
        elo_min, elo_max = elo_max, elo_min
    grid = list(range(int(elo_min), int(elo_max) + 1, int(step)))
    if grid and grid[-1] != elo_max:
        grid.append(int(elo_max))
    return grid


def positions_by_player(pgn_text: str) -> dict[str, list[dict]]:
    """{'w': [...], 'b': [...]} of {fen, uci, san, ply} -- the position before
    each move and the move actually played there."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    board = game.board()
    out: dict[str, list[dict]] = {"w": [], "b": []}
    for ply, move in enumerate(game.mainline_moves(), start=1):
        side = "w" if board.turn == chess.WHITE else "b"
        out[side].append({
            "fen": board.fen(en_passant="fen"),
            "uci": move.uci(),
            "san": board.san(move),
            "ply": ply,
        })
        board.push(move)
    return out


async def _bestmove(engine: EngineProcess, fen: str) -> str | None:
    await engine.send_line(f"position fen {fen}")
    await engine.send_line(MAIA_GO_COMMAND)
    while True:
        line = await engine.readline()
        if line is None:
            raise RuntimeError("Maia exited during the sweep")
        if line.startswith("bestmove"):
            parts = line.split()
            return parts[1] if len(parts) >= 2 else None


async def run_sweep(job: AnalysisJob, pgn_text: str, settings: dict, your_color: str):
    """Fills the score matrix for both players and emits the fitted estimate."""
    try:
        configured = settings.get("maia_binary")
        if not configured:
            raise RuntimeError("No Maia engine selected -- choose one in Settings")
        path, note = resolve_maia_binary(configured, settings.get("maia_model_size"))
        if not path:
            raise RuntimeError(note)

        grid = build_grid(settings.get("maia_elo_min", 1100),
                          settings.get("maia_elo_max", 1900),
                          settings.get("maia_elo_step", 100))
        by_player = positions_by_player(pgn_text)
        total_work = len(grid) * sum(len(v) for v in by_player.values())
        if total_work == 0:
            raise RuntimeError("this game has no positions to sweep")

        engine = EngineProcess(path)
        await engine.start()
        await engine.send_line("uci")
        engine.advertised_options = await read_uci_options(engine)

        elo_option = pick_option(engine.advertised_options, ELO_OPTION_CANDIDATES)
        if not elo_option:
            raise RuntimeError(
                "this Maia build advertises no Elo option, so a sweep would score "
                "the same strength at every grid point"
            )
        limit_opt = pick_option(engine.advertised_options, LIMIT_STRENGTH_CANDIDATES)
        if limit_opt:
            await engine.send_line(f"setoption name {limit_opt} value true")
        for name, value in (settings.get("maia_options") or {}).items():
            real = pick_option(engine.advertised_options, [name])
            if real and str(value) != "":
                await engine.send_line(f"setoption name {real} value {value}")
        await engine.send_line("isready")
        await engine.wait_for("readyok")

        matrices = {side: np.zeros((len(rows), len(grid))) for side, rows in by_player.items()}
        done = 0
        try:
            # Elo outermost: one setoption per grid point rather than per position.
            for gi, elo in enumerate(grid):
                await engine.send_line(f"setoption name {elo_option} value {elo}")
                await engine.send_line("isready")
                await engine.wait_for("readyok")
                for side, rows in by_player.items():
                    for pi, row in enumerate(rows):
                        best = await _bestmove(engine, row["fen"])
                        matrices[side][pi, gi] = 1.0 if best == row["uci"] else 0.0
                        done += 1
                        if done % 10 == 0 or done == total_work:
                            await job.emit({"type": "progress", "done": done, "total": total_work,
                                            "elo": elo, "fen": row["fen"]})
        finally:
            engine.terminate()
            await engine.wait_closed()

        results = {}
        for side, matrix in matrices.items():
            if matrix.shape[0] == 0:
                continue
            results[side] = elo_sweep.estimate(grid, matrix)

        payload = {
            "type": "done",
            "grid": grid,
            "your_color": your_color,
            "results": results,
            "model_note": note,
        }
        _store_matrices(job, grid, by_player, matrices)
        await job.emit(payload)
    except Exception as e:
        await job.emit({"type": "error", "message": str(e)})


def _store_matrices(job, grid, by_player, matrices):
    """Keep the raw per-(position, Elo) scores so a re-fit -- a different
    objective, or the trend view -- never re-runs the engine (section 9)."""
    job.sweep_cache = {
        "grid": grid,
        "players": {
            side: {
                "positions": by_player[side],
                "matrix": matrices[side].tolist(),
            }
            for side in matrices
        },
    }


class SweepIn(BaseModel):
    game_id: int


@router.post("")
async def start_sweep(body: SweepIn, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT pgn_text, your_color FROM games WHERE id = ? AND user_id = ?",
            (body.game_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(404, "no such game")
    settings = get_effective_settings(user["id"])

    job_id = uuid.uuid4().hex
    job = AnalysisJob(job_id, user["id"], body.game_id)
    jobs[job_id] = job
    job.task = asyncio.create_task(run_sweep(job, row["pgn_text"], settings, row["your_color"]))
    return {"job_id": job_id}


@router.get("/{job_id}/matrix")
def get_matrix(job_id: str, user: dict = Depends(require_user)):
    """The cached score matrix, for re-fitting without touching the engine."""
    job = jobs.get(job_id)
    if not job or job.user_id != user["id"]:
        raise HTTPException(404, "no such job")
    cache = getattr(job, "sweep_cache", None)
    if not cache:
        raise HTTPException(409, "this sweep hasn't finished yet")
    return cache
