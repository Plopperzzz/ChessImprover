"""Batch analysis across many games (spec section 12).

Aimed at runs on the order of a thousand games, which drives three choices:

* Engine processes are opened once for the whole batch, not per game. At a
  thousand games the process startup and UCI handshake would otherwise be
  a meaningful share of the wall clock.
* Each game is saved the moment it finishes, so a cancelled or crashed run
  keeps everything completed so far instead of losing the lot.
* The sweep uses a separate, coarser Elo step in batch mode -- a fine grid is
  affordable for one game and not for a thousand (section 9).

This still runs games sequentially within a batch. The bounded worker pool
that lets two users' batches share the machine is section 10, the next step.
"""

import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import classify, elo_sweep
from .analysis import AnalysisJob, jobs, open_stockfish, stockfish_pass
from .auth import require_user
from .db import db_cursor
from .engine_manager import register_job_engine, unregister_job_engine
from .engine_settings import get_effective_settings
from .runs import save_analysis
from .sweep_job import _rows_by_ply, _store_matrices, _sweep_core, build_grid, open_maia

router = APIRouter(prefix="/api/batch", tags=["batch"])


def _select_games(user_id: int, scope: str, mode: str) -> list[dict]:
    """Which games the batch will cover. 'unanalyzed' skips games that already
    have a result for this mode, so a re-run after a cancel picks up where it
    left off rather than redoing everything."""
    with db_cursor() as conn:
        if scope == "unanalyzed":
            rows = conn.execute(
                """SELECT g.id, g.white, g.black, g.result, g.utc_date_header,
                          g.your_color, g.pgn_text
                   FROM games g
                   WHERE g.user_id = ?
                     AND NOT EXISTS (
                       SELECT 1 FROM run_games rg
                       WHERE rg.game_id = g.id AND rg.user_id = g.user_id AND rg.mode = ?
                     )
                   ORDER BY g.id""",
                (user_id, mode),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, white, black, result, utc_date_header, your_color, pgn_text
                   FROM games WHERE user_id = ? ORDER BY id""",
                (user_id,),
            ).fetchall()
    return [dict(r) for r in rows]


async def run_batch(job: AnalysisJob, games: list[dict], mode: str, settings: dict):
    total = len(games)
    completed, failed = 0, 0
    sf_engine = None
    maia = None
    try:
        sf_engine = await open_stockfish(settings)
        register_job_engine(job.job_id, job.user_id, "batch-stockfish", sf_engine)
        batch_grid = None
        if mode == "full":
            maia = await open_maia(settings)
            register_job_engine(job.job_id, job.user_id, "batch-maia", maia["engine"])
            # Coarser by default in batch: a fine grid is affordable for one
            # game and not for a thousand (section 9).
            batch_grid = build_grid(
                settings.get("maia_elo_min", 1100),
                settings.get("maia_elo_max", 1900),
                settings.get("maia_elo_step_batch") or settings.get("maia_elo_step", 100),
            )

        for index, game in enumerate(games):
            if job.cancelled:
                break
            await job.emit({
                "type": "game_start",
                "index": index, "total": total,
                "game_id": game["id"],
                "white": game["white"], "black": game["black"],
                "pgn": game["pgn_text"],
            })
            try:
                # Per-game progress is scaled into this game's slice of the
                # overall bar, so a 1000-game run still shows smooth movement.
                base = index / total
                span = 1.0 / total
                sf_share = span * (0.25 if mode == "full" else 1.0)
                moves = await stockfish_pass(
                    job, game["pgn_text"], settings,
                    progress_scale=sf_share, progress_base=base, engine=sf_engine,
                )
                payload = {"moves": moves}

                if mode == "full":
                    sweep = await _sweep_core(
                        job, game["pgn_text"], settings,
                        progress_scale=span * 0.75, progress_base=base + sf_share,
                        maia=maia, grid=batch_grid,
                    )
                    grid, by_player, matrices = sweep["grid"], sweep["by_player"], sweep["matrices"]
                    results = {
                        side: elo_sweep.estimate(grid, matrix)
                        for side, matrix in matrices.items() if matrix.shape[0]
                    }
                    fens = {r["ply"]: r["fen"] for rows in by_player.values() for r in rows}
                    ucis = {r["ply"]: r["uci"] for rows in by_player.values() for r in rows}
                    for side, matrix in matrices.items():
                        if not matrix.shape[0]:
                            continue
                        rows = _rows_by_ply(by_player[side], matrix)
                        classify.apply_great_brilliant(
                            moves, sweep_rows=rows, grid=grid,
                            estimated_elo=results[side].get("estimate"),
                            fens_before=fens, ucis=ucis,
                            max_drop=settings.get("great_max_drop", classify.DEFAULT_GREAT_MAX_DROP),
                            max_match_rate=settings.get("great_max_match_rate",
                                                       classify.DEFAULT_GREAT_MAX_MATCH_RATE),
                            brilliant_enabled=bool(settings.get("brilliant_enabled", 1)),
                        )
                        classify.blunder_elo_correlation(moves, sweep_rows=rows, grid=grid)
                    _store_matrices(job, grid, by_player, matrices)
                    payload.update({
                        "grid": grid, "results": results,
                        "model_note": sweep["note"], "sweep_cache": job.sweep_cache,
                    })

                # Saved per game, so cancelling keeps everything done so far.
                save_analysis(job.user_id, game["id"], mode, payload, run_id=job.run_id)
                completed += 1
                await job.emit({
                    "type": "game_done",
                    "index": index, "total": total, "game_id": game["id"],
                    "completed": completed, "failed": failed,
                })
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # One unparseable or otherwise broken game shouldn't sink a
                # thousand-game run; record it and carry on.
                failed += 1
                await job.emit({
                    "type": "game_failed",
                    "index": index, "total": total, "game_id": game["id"],
                    "message": str(e), "completed": completed, "failed": failed,
                })

        await job.emit({
            "type": "done", "mode": "batch", "analysis_mode": mode,
            "total": total, "completed": completed, "failed": failed,
            "cancelled": job.cancelled,
        })
    except asyncio.CancelledError:
        await job.emit({
            "type": "done", "mode": "batch", "analysis_mode": mode,
            "total": total, "completed": completed, "failed": failed, "cancelled": True,
        })
    except Exception as e:
        await job.emit({"type": "error", "message": str(e)})
    finally:
        for kind, engine in (("batch-stockfish", sf_engine),
                             ("batch-maia", maia["engine"] if maia else None)):
            unregister_job_engine(job.job_id, kind)
            if engine:
                engine.terminate()
                await engine.wait_closed()


class BatchIn(BaseModel):
    mode: str = "quick"          # 'quick' | 'full'
    scope: str = "unanalyzed"    # 'unanalyzed' | 'all'
    run_id: int | None = None


@router.post("")
async def start_batch(body: BatchIn, user: dict = Depends(require_user)):
    if body.mode not in ("quick", "full"):
        raise HTTPException(400, "mode must be 'quick' or 'full'")
    games = _select_games(user["id"], body.scope, body.mode)
    if not games:
        raise HTTPException(400, "no games to analyse for that selection")
    settings = get_effective_settings(user["id"])

    job_id = uuid.uuid4().hex
    job = AnalysisJob(job_id, user["id"], games[0]["id"])
    job.run_id = body.run_id
    jobs[job_id] = job
    job.task = asyncio.create_task(run_batch(job, games, body.mode, settings))
    return {"job_id": job_id, "total": len(games)}


@router.get("/preview")
def preview_batch(mode: str = "quick", scope: str = "unanalyzed", user: dict = Depends(require_user)):
    """How many games a batch would cover, so the button can say so before
    committing to a long run."""
    return {"count": len(_select_games(user["id"], scope, mode))}


@router.post("/{job_id}/cancel")
def cancel_batch(job_id: str, user: dict = Depends(require_user)):
    """Stops after the game in flight. Everything already finished stays
    saved -- a long run is never all-or-nothing."""
    job = jobs.get(job_id)
    if not job or job.user_id != user["id"]:
        raise HTTPException(404, "no such job")
    job.cancelled = True
    return {"ok": True}
