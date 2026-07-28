"""Quick-mode analysis (spec sections 8 and 12): a Stockfish-only pass over a
saved game's mainline, streamed to the client as a background job so the
board can animate through positions as they're evaluated (section 6).

Each job gets its own short-lived Stockfish process for the run's duration
-- separate from, and never contending unmanaged with, the persistent
live-eval session for the same user (section 3). Before it opens that
process it takes a lease from the bounded worker pool (section 10, see
`jobqueue`), so two people analysing at once share the machine's cores
instead of oversubscribing them.
"""

import asyncio
import io
import time
import uuid

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .auth import SESSION_COOKIE, _user_for_token, require_user
from .classify import apply_book, classify_moves, eval_to_cp
from .db import db_cursor
from .engine_manager import engine_options_from_settings, evaluate_position, start_configured_engine
from .engine_settings import get_effective_settings
from .jobqueue import pool, slots_for
from .openings import book_lookup
from .runs import load_for_game, save_analysis

router = APIRouter(prefix="/api/analysis", tags=["analysis"])
ws_router = APIRouter()  # unprefixed -- /ws/analysis/{job_id}, matching live_eval_ws.py's pattern

MAX_RETAINED_JOBS = 50

# Two lines from every search in the analysis pass. The second one is what
# says whether the best move was the *only* move, which is what Great and
# Brilliant are now awarded for -- and getting it during the pass that has to
# visit every position anyway beats a second pass over the game. MultiPV
# costs search speed (Stockfish can prune less), so this stays at the one
# extra line the classification needs and no more.
ANALYSIS_MULTIPV = 2

# Event types a reconnecting client only needs the *most recent* of. The
# backlog is replayed on every reconnect, and a phone that locks its screen
# mid-batch reconnects a lot: replaying a thousand `game_start`s would walk the
# board through every game of the run again, which reads as the batch having
# restarted from the beginning. Keeping one of each also stops the log growing
# without bound -- a full batch emits a `progress` event per position per game.
COALESCED_EVENTS = ("progress", "game_start", "game_done", "queued", "started")

# Failures are per-game and each one is a distinct thing to report, so they
# aren't coalesced -- just capped, since a run where thousands fail has a
# problem no list is going to explain.
MAX_RETAINED_FAILURES = 50


class AnalysisJob:
    def __init__(self, job_id: str, user_id: int, game_id: int,
                 kind: str = "quick", total: int = 1):
        self.job_id = job_id
        self.user_id = user_id
        self.game_id = game_id
        self.kind = kind          # 'quick' | 'full' | 'sweep' | 'batch'
        self.total = total        # games in the run; 1 for everything but batch
        self.run_id: int | None = None
        self.cancelled = False
        self.events: list[dict] = []
        self.subscribers: set[WebSocket] = set()
        self.task: asyncio.Task | None = None
        self.started_at = time.time()

    def _record(self, event: dict):
        """Keeps the replay log to a summary of where the job is now rather
        than a transcript of how it got there."""
        kind = event["type"]
        if kind in COALESCED_EVENTS:
            for i in range(len(self.events) - 1, -1, -1):
                if self.events[i]["type"] == kind:
                    self.events.pop(i)
                    break
        self.events.append(event)
        if kind == "game_failed":
            failures = [i for i, e in enumerate(self.events) if e["type"] == "game_failed"]
            for i in reversed(failures[:-MAX_RETAINED_FAILURES]):
                self.events.pop(i)

    async def emit(self, event: dict):
        self._record(event)
        dead = []
        for ws in list(self.subscribers):
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.subscribers.discard(ws)

    def summary(self) -> dict:
        """Enough for a browser that has just loaded to find a job it started
        before and pick it back up. Switching apps on a phone can tear the page
        down; the job itself lives in this process and carries on regardless,
        so 'what is still running for me' has to be answerable from the server.
        """
        latest: dict[str, dict] = {}
        for event in self.events:
            latest[event["type"]] = event
        progress, done = latest.get("progress", {}), latest.get("game_done", {})
        fraction = progress.get("fraction")
        if done and self.total:
            fraction = max(fraction or 0.0, (done.get("index", 0) + 1) / self.total)
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "game_id": self.game_id,
            "run_id": self.run_id,
            "total": self.total,
            "finished": job_finished(self),
            "cancelled": self.cancelled,
            "completed": done.get("completed", 0),
            "failed": done.get("failed", 0),
            "fraction": fraction,
            "running_s": round(time.time() - self.started_at, 1),
        }


jobs: dict[str, AnalysisJob] = {}


def job_finished(job: "AnalysisJob") -> bool:
    return bool(job.events) and job.events[-1]["type"] in ("done", "error")


def _evict_old_jobs(keep: int = MAX_RETAINED_JOBS):
    """Drops the oldest *finished* jobs. A queued or running job is never
    evicted -- its client is still watching it, and losing the record would
    orphan an engine the pool still has leased out."""
    for job_id in list(jobs.keys()):
        if len(jobs) <= keep:
            return
        if job_finished(jobs[job_id]):
            jobs.pop(job_id, None)


def _parse_game_positions(pgn_text: str):
    """Returns (fens, sans, ucis, final_board). fens has N+1 entries (fens[0]
    is the start position, fens[N] the final one) for a game of N moves; sans
    and ucis have N, describing the move played out of fens[i]."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    board = game.board()
    fens = [board.fen()]
    sans = []
    ucis = []
    for move in game.mainline_moves():
        sans.append(board.san(move))
        ucis.append(move.uci())
        board.push(move)
        fens.append(board.fen())
    return fens, sans, ucis, board


async def open_stockfish(engine_settings: dict):
    """A configured Stockfish process. Batch mode opens one for the whole run
    rather than paying process startup per game."""
    path = engine_settings.get("stockfish_binary")
    if not path:
        raise RuntimeError("No Stockfish engine selected -- choose one in Settings")
    return await start_configured_engine(path, engine_options_from_settings(engine_settings))


async def stockfish_pass(job: AnalysisJob, pgn_text: str, engine_settings: dict,
                         progress_scale: float = 1.0, progress_base: float = 0.0,
                         engine=None):
    """The N+1-eval Stockfish pass (section 8). Shared by quick, full and batch
    mode so all three classify identically. progress_scale/base fold this into
    a combined progress bar; `engine` reuses a caller-owned process, in which
    case the caller also owns closing it."""
    fens, sans, ucis, final_board = _parse_game_positions(pgn_text)
    total = len(fens) - 1
    cp_evals: list[float] = [0.0] * len(fens)
    # Per position: the move the engine preferred, and what the second-best
    # one was worth (None when there was only one legal move). Best/Excellent
    # and the only-move test behind Great and Brilliant are read off these.
    best_ucis: list[str | None] = [None] * len(fens)
    second_cp: list[float | None] = [None] * len(fens)

    owned = engine is None
    if owned:
        engine = await open_stockfish(engine_settings)
    else:
        # Fresh search state between games in a batch.
        await engine.send_line("ucinewgame")
        await engine.send_line("isready")
        await engine.wait_for("readyok")
    limit_type = engine_settings.get("sf_limit_type", "depth")
    limit_value = engine_settings.get("sf_limit_value", 18)

    try:
        for i, fen in enumerate(fens):
            # Checked per position, not per game: a batch cancel should land
            # within one evaluation, not wait out a 200-ply game.
            if getattr(job, "cancelled", False):
                raise asyncio.CancelledError()
            is_final = i == len(fens) - 1
            if is_final and final_board.is_checkmate():
                # the side to move at the final position is the one who got mated
                cp = -10000.0
            elif is_final and final_board.is_stalemate():
                cp = 0.0
            else:
                info = await evaluate_position(engine, fen, limit_type, limit_value,
                                               multipv=ANALYSIS_MULTIPV)
                cp = eval_to_cp(info)
                lines = info.get("lines") or []
                if lines and lines[0].get("pv"):
                    best_ucis[i] = lines[0]["pv"][0]
                if len(lines) > 1:
                    second_cp[i] = eval_to_cp(lines[1])
            cp_evals[i] = cp
            frac = progress_base + progress_scale * (i / max(1, total))
            await job.emit({"type": "progress", "ply": i, "total": total, "fen": fen,
                            "fraction": frac, "phase": "stockfish"})
    finally:
        if owned:
            engine.terminate()
            await engine.wait_closed()

    moves = classify_moves(cp_evals, played_ucis=ucis, best_ucis=best_ucis,
                           second_cp=second_cp)
    for m, san, uci in zip(moves, sans, ucis):
        m["san"] = san
        m["uci"] = uci
    apply_book(
        moves,
        fens_before={i + 1: fens[i] for i in range(total)},
        ucis={i + 1: ucis[i] for i in range(total)},
        lookup=book_lookup,
    )
    return moves


async def _run_quick_job(job: AnalysisJob, pgn_text: str, engine_settings: dict):
    try:
        # The lease is taken before the engine is opened, not after: a queued
        # job should be costing nothing at all while it waits (section 10).
        async with pool.lease(job=job, slots=slots_for(engine_settings, "quick"), label="quick"):
            moves = await stockfish_pass(job, pgn_text, engine_settings)
            # Persist before emitting, so a client that reloads the moment it
            # sees "done" already finds the saved copy.
            save_analysis(job.user_id, job.game_id, "quick", {"moves": moves}, run_id=job.run_id)
        await job.emit({"type": "done", "mode": "quick", "moves": moves})
    except asyncio.CancelledError:
        await job.emit({"type": "error", "message": "cancelled"})
    except Exception as e:
        await job.emit({"type": "error", "message": str(e)})


class QuickAnalysisIn(BaseModel):
    game_id: int
    run_id: int | None = None


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
    job = AnalysisJob(job_id, user["id"], body.game_id, kind="quick")
    job.run_id = body.run_id
    jobs[job_id] = job
    _evict_old_jobs()
    job.task = asyncio.create_task(_run_quick_job(job, row["pgn_text"], settings))
    return {"job_id": job_id}


@router.get("/saved/{game_id}")
def saved_analysis(game_id: int, user: dict = Depends(require_user)):
    """The stored analysis for a game, so selecting it in the picker restores
    what was already computed instead of starting from blank."""
    saved = load_for_game(user["id"], game_id)
    if not saved:
        raise HTTPException(404, "no saved analysis for this game")
    return saved


@router.get("/active")
def active_jobs(user: dict = Depends(require_user)):
    """Your jobs that are still going. A browser asks this on load so a run
    started before the page was closed (or discarded by the phone when you
    switched apps) is picked back up instead of being started again on top of
    itself -- the work never stopped, only the page watching it did."""
    return [j.summary() for j in jobs.values()
            if j.user_id == user["id"] and not job_finished(j)]


@router.get("/jobs")
def list_jobs(user: dict = Depends(require_user)):
    """Process/job accounting, mirroring the live-engine status endpoint."""
    return [
        {
            "job_id": j.job_id,
            "kind": j.kind,
            "game_id": j.game_id,
            "subscribers": len(j.subscribers),
            "events": len(j.events),
            "finished": job_finished(j),
        }
        for j in jobs.values()
        if j.user_id == user["id"]
    ]


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str, user: dict = Depends(require_user)):
    """Stops a quick/full/sweep job. Needed once jobs can queue: without it a
    job waiting behind someone else's work could only be abandoned, not
    withdrawn, and it would still run eventually."""
    job = jobs.get(job_id)
    if not job or job.user_id != user["id"]:
        raise HTTPException(404, "no such job")
    job.cancelled = True
    pool.cancel_job(job_id)
    return {"ok": True}


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
    # Catches a reconnecting client up on where the job is now. The log is
    # compacted (see COALESCED_EVENTS), so this is a handful of events even
    # halfway through a thousand-game batch -- replaying the real transcript
    # would re-animate the whole run and look like it had started over.
    for event in job.events:
        await websocket.send_json(event)
    job.subscribers.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        job.subscribers.discard(websocket)
