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

from . import classify, elo_sweep, maia_policy
from .analysis import AnalysisJob, jobs
from .auth import SESSION_COOKIE, _user_for_token, require_user
from .db import db_cursor
from .engine_manager import EngineProcess, pick_option, read_uci_options
from .engine_settings import get_effective_settings
from .jobqueue import pool, slots_for
from .maia import resolve_binary as resolve_maia_binary
from .maia_accuracy import for_model as accuracy_for_model, model_size_from_note
from .runs import save_analysis
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


# One character per grid point, so a 1000-game batch stays a sane row count.
# '1' is Maia's own first choice, '2' its second, and so on; '0' means the
# move you played was nowhere in its top MultiPV. Crucially this is the same
# encoding the old top-1-only sweeps used ('1' matched, '0' didn't), so
# everything already stored keeps its meaning with no migration.
MAX_RANK = 9


# Non-standard `info` fields that carry a *policy* probability, in the order
# they are looked for. UCI has no field for this, so builds that report it at
# all have each invented a spelling.
#
# `wdl` and `score cp` are deliberately absent, and that is the whole point of
# this list existing rather than the parser taking any number that looks like a
# probability. Maia3's UCI wrapper emits both, and both come from its *value*
# head -- they are its guess at the result of the game after the candidate
# move, not the probability it would play it. They are frequently identical
# across every candidate in the list (a value head barely distinguishes
# early-middlegame moves), so scoring a likelihood with them would silently
# produce a flat curve. Section 9 of the spec calls this out by name: confirm
# the semantics of the field before trusting it.
POLICY_FIELDS = ("policy", "policypermille", "p", "prior")


def _policy_from_info(parts: list[str]) -> float | None:
    """Policy probability from one `info` line, or None if it carries none.

    Accepts a fraction in 0..1 or a permille integer, told apart by magnitude:
    a policy of exactly 1.0 is the only ambiguous value and means the same
    thing read either way.
    """
    for field in POLICY_FIELDS:
        if field not in parts:
            continue
        try:
            raw = float(parts[parts.index(field) + 1])
        except (ValueError, IndexError):
            continue
        if raw < 0:
            continue
        value = raw / 1000.0 if raw > 1.0 else raw
        if 0.0 <= value <= 1.0:
            return value
    return None


async def _ranked_moves(engine: EngineProcess, fen: str,
                        multipv: int) -> tuple[list[str], dict[str, float]]:
    """Maia's move ordering for a position, best first, and the policy
    probability per move when the engine reports one.

    At `go nodes 1` a policy net does one forward pass, so asking for several
    ranked moves instead of one costs nothing extra -- the ordering is already
    computed. That is the whole appeal: strictly more information per position
    for the same engine time.

    Falls back to a single-move list when the engine reports no `multipv`
    info lines, which is what a build without MultiPV support does. The
    probability map is empty for the builds that report no policy, which is
    every stock Maia3 today.
    """
    await engine.send_line(f"position fen {fen}")
    await engine.send_line(MAIA_GO_COMMAND)
    ranked: dict[int, str] = {}
    policies: dict[str, float] = {}
    best: str | None = None
    while True:
        line = await engine.readline()
        if line is None:
            raise RuntimeError("Maia exited during the sweep")
        if line.startswith("info") and " pv " in line:
            parts = line.split()
            try:
                rank = int(parts[parts.index("multipv") + 1]) if "multipv" in parts else 1
                move = parts[parts.index("pv") + 1]
            except (ValueError, IndexError):
                continue
            if 1 <= rank <= multipv:
                ranked[rank] = move
                policy = _policy_from_info(parts)
                if policy is not None:
                    policies[move] = policy
        if line.startswith("bestmove"):
            parts = line.split()
            best = parts[1] if len(parts) >= 2 else None
            break
    if ranked:
        return [ranked[r] for r in sorted(ranked) if ranked.get(r)], policies
    return ([best] if best else []), policies


def rank_of(played: str, ranked: list[str]) -> int:
    """1-based rank of the played move in Maia's ordering, or 0 if it isn't
    in the list at all."""
    for i, move in enumerate(ranked[:MAX_RANK], start=1):
        if move == played:
            return i
    return 0


async def open_maia(settings: dict):
    """A configured Maia process plus the Elo option it actually advertises.
    Batch mode opens one for the whole run instead of per game."""
    configured = settings.get("maia_binary")
    if not configured:
        raise RuntimeError("No Maia engine selected -- choose one in Settings")
    path, note = resolve_maia_binary(configured, settings.get("maia_model_size"))
    if not path:
        raise RuntimeError(note)

    # Ask for the engine's own policy first. The likelihood objective wants the
    # probability Maia gave the move you played, and Maia3 computes exactly that
    # and then declines to print it -- `maia_policy` runs the same engine under
    # the same interpreter with that one field added. It returns None whenever
    # it can't (any other engine, an interpreter it can't find or that can't
    # import maia3), and then this is an ordinary engine launch and the fit
    # falls back to scoring moves by rank.
    command = None
    if settings.get("maia_policy", True):
        command = await maia_policy.probe(path)
    if command:
        engine = EngineProcess(command[0], command[1:])
        note = ((note + " ") if note else "") + "reporting per-move policy"
    else:
        engine = EngineProcess(path)
    await engine.start()
    await engine.send_line("uci")
    engine.advertised_options = await read_uci_options(engine)

    elo_option = pick_option(engine.advertised_options, ELO_OPTION_CANDIDATES)
    if not elo_option:
        engine.terminate()
        await engine.wait_closed()
        raise RuntimeError(
            "this Maia build advertises no Elo option, so a sweep would score "
            "the same strength at every grid point"
        )
    limit_opt = pick_option(engine.advertised_options, LIMIT_STRENGTH_CANDIDATES)
    if limit_opt:
        await engine.send_line(f"setoption name {limit_opt} value true")

    # Ranked candidates cost nothing extra at `go nodes 1` -- the policy net
    # has already ordered every legal move -- so ask for several and record
    # where the played move landed. A build without MultiPV just keeps
    # answering with one move and everything downstream degrades to top-1.
    want_multipv = max(1, min(int(settings.get("maia_multipv") or 1), MAX_RANK))
    multipv_opt = pick_option(engine.advertised_options, ["MultiPV"])
    multipv = 1
    if want_multipv > 1 and multipv_opt:
        await engine.send_line(f"setoption name {multipv_opt} value {want_multipv}")
        multipv = want_multipv
    elif want_multipv > 1:
        note = ((note + " ") if note else "") + (
            "this build advertises no MultiPV option, so the sweep records "
            "top-1 matches only")
    for name, value in (settings.get("maia_options") or {}).items():
        real = pick_option(engine.advertised_options, [name])
        if real and str(value) != "":
            await engine.send_line(f"setoption name {real} value {value}")
    await engine.send_line("isready")
    await engine.wait_for("readyok")
    # Read back out of the note rather than taken from the setting: the note
    # records the binary that actually resolved, and a fallback to a different
    # one is exactly the case where the setting would lie.
    return {"engine": engine, "elo_option": elo_option, "note": note,
            "multipv": multipv, "model_size": model_size_from_note(note)}


async def _sweep_core(job, pgn_text: str, settings: dict,
                      progress_scale: float = 1.0, progress_base: float = 0.0,
                      maia=None, grid: list[int] | None = None) -> dict:
    """The engine half of a sweep: fills the (position x Elo) match matrix for
    both players. Shared by the standalone sweep, full mode and batch, so none
    of them can drift apart in how a position is scored.

    `maia` reuses a caller-owned process (the caller then owns closing it);
    `grid` overrides the Elo grid, which batch mode uses to sweep coarser.
    """
    owned = maia is None
    if owned:
        maia = await open_maia(settings)
    engine, elo_option, note = maia["engine"], maia["elo_option"], maia["note"]
    multipv = maia.get("multipv", 1)

    if grid is None:
        grid = build_grid(settings.get("maia_elo_min", 600),
                          settings.get("maia_elo_max", 2600),
                          settings.get("maia_elo_step", 100))
    by_player = positions_by_player(pgn_text)
    total_work = len(grid) * sum(len(v) for v in by_player.values())
    if total_work == 0:
        if owned:
            engine.terminate()
            await engine.wait_closed()
        raise RuntimeError("this game has no positions to sweep")

    matrices = {side: np.zeros((len(rows), len(grid))) for side, rows in by_player.items()}
    # The probability the engine gave the move actually played, when it reports
    # one. NaN means "not reported here", which is what every cell stays at
    # against a build with no policy output -- and `policy_seen` is what
    # decides whether the column is worth storing at all.
    policies = {side: np.full((len(rows), len(grid)), np.nan)
                for side, rows in by_player.items()}
    policy_seen = False
    done = 0
    try:
        # Elo outermost: one setoption per grid point rather than per position.
        for gi, elo in enumerate(grid):
            await engine.send_line(f"setoption name {elo_option} value {elo}")
            await engine.send_line("isready")
            await engine.wait_for("readyok")
            for side, rows in by_player.items():
                for pi, row in enumerate(rows):
                    if getattr(job, "cancelled", False):
                        raise asyncio.CancelledError()
                    ranked, policy = await _ranked_moves(engine, row["fen"], multipv)
                    # Stored as a rank, not a yes/no: 1 is Maia's own choice,
                    # 0 means the move wasn't among its candidates at all.
                    matrices[side][pi, gi] = rank_of(row["uci"], ranked)
                    if policy:
                        policy_seen = True
                        # A move the engine listed but didn't play gets the
                        # probability it reported; one it never listed gets the
                        # leftover mass, which is an upper bound on it and the
                        # honest reading of "below everything shown".
                        played = policy.get(row["uci"])
                        if played is None:
                            listed = sum(policy.values())
                            played = max(1.0 - listed, 0.0) / MAX_RANK
                        policies[side][pi, gi] = played
                    done += 1
                    if done % 10 == 0 or done == total_work:
                        await job.emit({"type": "progress", "done": done, "total": total_work,
                                        "elo": elo, "fen": row["fen"], "phase": "maia",
                                        "fraction": progress_base + progress_scale * (done / total_work)})
    finally:
        if owned:
            engine.terminate()
            await engine.wait_closed()

    if not policy_seen:
        note = ((note + " ") if note else "") + (
            "this build reports no per-move policy, so the fit scores your moves "
            "by where they ranked in Maia's ordering rather than by the "
            "probability it gave them")
    return {"grid": grid, "by_player": by_player, "matrices": matrices,
            "policies": policies if policy_seen else None,
            "note": note, "multipv": multipv, "model_size": maia.get("model_size")}


async def run_sweep(job: AnalysisJob, pgn_text: str, settings: dict, your_color: str):
    """Sweep on its own: the Elo estimate without the Stockfish pass."""
    try:
        async with pool.lease(job=job, slots=slots_for(settings, "sweep"), label="sweep"):
            sweep = await _sweep_core(job, pgn_text, settings)
            grid, by_player, matrices = sweep["grid"], sweep["by_player"], sweep["matrices"]
            results = _estimates(sweep, settings)
            _store_matrices(job, grid, by_player, matrices, sweep.get("policies"))
            # Persisted like every other analysis. A sweep on its own used to
            # be the one kind of run that vanished the moment you selected
            # another game -- and it is the expensive one, so re-running it to
            # get the number back cost the whole sweep again.
            save_analysis(job.user_id, job.game_id, "sweep", {
                "grid": grid, "results": results,
                "model_note": sweep["note"], "maia_model_size": sweep["model_size"],
                "sweep_cache": job.sweep_cache,
            }, run_id=getattr(job, "run_id", None))
        await job.emit({
            "type": "done",
            "grid": grid,
            "your_color": your_color,
            "results": results,
            "model_note": sweep["note"],
        })
    except asyncio.CancelledError:
        await job.emit({"type": "error", "message": "cancelled"})
    except Exception as e:
        await job.emit({"type": "error", "message": str(e)})


def _store_matrices(job, grid, by_player, matrices, policies=None):
    """Keep the raw per-(position, Elo) scores so a re-fit -- a different
    objective, or the trend view -- never re-runs the engine (section 9).

    The policy block rides alongside the ranks rather than replacing them:
    ranks are what every stored sweep has and what the surrogate reads, and a
    sweep with real policy should still answer a top-1 question without being
    re-run.
    """
    job.sweep_cache = {
        "grid": grid,
        "players": {
            side: {
                "positions": by_player[side],
                "matrix": matrices[side].tolist(),
                **({"policy": policies[side].tolist()} if policies else {}),
            }
            for side in matrices
        },
    }


def _estimates(sweep, settings) -> dict:
    """Per-side estimate from a finished sweep, under the app's objective."""
    accuracy = accuracy_for_model(sweep["model_size"],
                                  settings.get("maia_accuracy_offset", 0.0) or 0.0)
    objective = settings.get("elo_objective") or elo_sweep.DEFAULT_OBJECTIVE
    policies = sweep.get("policies") or {}
    results = {}
    for side, matrix in sweep["matrices"].items():
        if matrix.shape[0] == 0:
            continue
        policy = policies.get(side)
        results[side] = elo_sweep.estimate_from_ranks(
            sweep["grid"], matrix, accuracy=accuracy, objective=objective,
            log_policies=_log_policy(policy),
        )
    return results


def _log_policy(policy):
    """Probabilities -> log probabilities, or None when the sweep recorded
    none. A cell the engine never reported is left for the rank surrogate by
    returning nothing at all: a matrix that is right in most places and
    guessed in the rest would be worse than one that is honestly a surrogate
    throughout."""
    if policy is None:
        return None
    arr = np.asarray(policy, dtype=float)
    if arr.size == 0 or np.isnan(arr).any():
        return None
    return np.log(np.clip(arr, np.exp(elo_sweep.POLICY_LOG_FLOOR), 1.0))


class SweepIn(BaseModel):
    game_id: int
    run_id: int | None = None


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
    job = AnalysisJob(job_id, user["id"], body.game_id, kind="sweep")
    job.run_id = body.run_id
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


# ---------------------------------------------------------------------------
# Full mode (spec section 12): the Stockfish pass plus the Maia sweep, joined
# ---------------------------------------------------------------------------

def _rows_by_ply(positions: list[dict], matrix) -> dict[int, list[float]]:
    """Sweep matrix rows keyed by the ply they belong to, so a move's
    classification can look up its own Maia scores. Expects 0/1 hits, not
    ranks -- Great/Brilliant asks whether players at that Elo would have
    played exactly this move, which is the top-1 question."""
    return {row["ply"]: list(matrix[i]) for i, row in enumerate(positions)}


async def run_full(job, pgn_text: str, settings: dict, your_color: str):
    """Quick mode + Elo sweep + Great/Brilliant + blunder-Elo correlation."""
    try:
        from .analysis import stockfish_pass

        # One lease for both passes rather than swapping leases between them:
        # a job that had to re-queue halfway through could stall with a
        # half-finished analysis and an engine still open (section 10).
        async with pool.lease(job=job, slots=slots_for(settings, "full"), label="full"):
            # Stockfish first: the sweep is much the longer of the two, so the
            # combined progress bar gives it the larger share.
            moves = await stockfish_pass(job, pgn_text, settings, progress_scale=0.25, progress_base=0.0)

            sweep = await _sweep_core(job, pgn_text, settings,
                                      progress_scale=0.75, progress_base=0.25)
            grid = sweep["grid"]
            by_player = sweep["by_player"]
            matrices = sweep["matrices"]
            results = _estimates(sweep, settings)

            # Each side is judged against its *own* estimated strength, per
            # section 8 -- a move is Great because players of that player's
            # level wouldn't find it, not because of the opponent's level.
            fens_before = {r["ply"]: r["fen"] for rows in by_player.values() for r in rows}
            ucis = {r["ply"]: r["uci"] for rows in by_player.values() for r in rows}
            for side, matrix in matrices.items():
                if matrix.shape[0] == 0:
                    continue
                rows = _rows_by_ply(by_player[side], elo_sweep.hits(matrix, 1))
                classify.apply_great_brilliant(
                    moves,
                    sweep_rows=rows,
                    grid=grid,
                    estimated_elo=results[side].get("estimate"),
                    fens_before=fens_before,
                    ucis=ucis,
                    max_drop=settings.get("great_max_drop", classify.DEFAULT_GREAT_MAX_DROP),
                    max_match_rate=settings.get("great_max_match_rate", classify.DEFAULT_GREAT_MAX_MATCH_RATE),
                    min_only_move_gap=settings.get("great_min_only_move_gap",
                                                   classify.DEFAULT_ONLY_MOVE_GAP),
                    brilliant_enabled=bool(settings.get("brilliant_enabled", 1)),
                )
                classify.blunder_elo_correlation(moves, sweep_rows=rows, grid=grid)

            _store_matrices(job, grid, by_player, matrices, sweep.get("policies"))
            save_analysis(job.user_id, job.game_id, "full", {
                "moves": moves, "grid": grid, "results": results,
                "model_note": sweep["note"], "maia_model_size": sweep["model_size"],
                "sweep_cache": job.sweep_cache,
            }, run_id=job.run_id)
        await job.emit({
            "type": "done",
            "mode": "full",
            "moves": moves,
            "grid": grid,
            "your_color": your_color,
            "results": results,
            "model_note": sweep["note"],
        })
    except Exception as e:
        await job.emit({"type": "error", "message": str(e)})


class FullIn(BaseModel):
    game_id: int
    run_id: int | None = None


@router.post("/full")
async def start_full(body: FullIn, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT pgn_text, your_color FROM games WHERE id = ? AND user_id = ?",
            (body.game_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(404, "no such game")
    settings = get_effective_settings(user["id"])

    job_id = uuid.uuid4().hex
    job = AnalysisJob(job_id, user["id"], body.game_id, kind="full")
    job.run_id = body.run_id
    jobs[job_id] = job
    job.task = asyncio.create_task(run_full(job, row["pgn_text"], settings, row["your_color"]))
    return {"job_id": job_id}
