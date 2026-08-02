"""Would a player at your own calibrated strength have played this?

Extends the blunder-Elo correlation in spec section 8 -- "find the lowest
swept Elo whose Maia top-1 choice equals the move actually played" -- into a
direct answer at *your* strength specifically, rather than a threshold search
across the whole grid. For every Mistake, Blunder or Miss in a game, this
reads the probability Maia's policy (or the rank surrogate, when the engine
reported no policy -- see `policy_likelihood`) assigns the move actually
played, interpolated to the Elo your own recorded rating in that game
converts to on Maia's scale.

That conversion is the same calibration `/api/strength` already computes:
Maia's SelfElo sits a few hundred points above Chess.com or FIDE at club
level, measured from the gap between what the sweep estimates for your
opponents and what their PGN headers say they were actually rated. Reversed,
it turns your header Elo into the Maia-scale Elo to read the sweep at --
`target = header_elo + offset`, since `strength._calibrate` computes the
offset the other way (`your_calibrated = maia_estimate - offset`).

Nothing here runs an engine. Every full analysis already swept the position
before and after the move at every grid point and stored the played move's
rank (and, when the engine reports one, its raw policy probability) at each
-- this is a read of `sweep_positions` plus one interpolation, the same
"no engine work, only a re-fit" property `/api/strength` and `/api/trend`
already have.
"""

import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from . import elo_sweep, policy_likelihood, strength
from .auth import require_user
from .db import db_cursor
from .games import LibraryFilter, game_database

router = APIRouter(prefix="/api/games", tags=["games"])

# Great and Brilliant are the *good* surprises; this is the mirror question,
# so it only ever looks at the moves that gave something away. Miss is
# included alongside Mistake and Blunder -- it is a blunder that happened to
# be classified separately because it threw away a won position, not a
# different kind of move.
BAD_CLASSIFICATIONS = ("mistake", "blunder", "miss")


def probability_at_elo(grid: list[int], scores: str, policies: str | None,
                       target_elo: float) -> dict:
    """What Maia's policy gives the move actually played, at `target_elo`.

    Exact when the sweep recorded a policy for this position; otherwise the
    same rank-to-probability surrogate `policy_likelihood` uses to let a
    ranks-only sweep re-fit under the likelihood objective, so a game swept
    before any build reported a policy still gets a real number here.

    Interpolated linearly in log-probability between the two grid points
    `target_elo` falls between (or clamped to the nearest end, outside the
    swept range) -- the same way `policy_likelihood.curve` reads the fitted
    curve at points between the ones the engine actually produced.
    """
    ranks = elo_sweep.decode_scores(scores)
    logp_row = elo_sweep.decode_policies(policies) if policies else []
    exact = bool(logp_row) and len(logp_row) == len(grid)
    if not exact:
        table = policy_likelihood.rank_log_probabilities()
        idx = np.clip(np.rint(ranks), 0, len(table) - 1).astype(int)
        logp_row = [float(table[i]) for i in idx]

    logp_at_target = float(np.interp(target_elo, grid, logp_row))
    nearest = min(range(len(grid)), key=lambda i: abs(grid[i] - target_elo))
    return {
        "probability": float(np.exp(logp_at_target)),
        "log_probability": round(logp_at_target, 3),
        "exact_policy": exact,
        "maia_rank_at_nearest_grid_elo": int(ranks[nearest]) if ranks else None,
        "nearest_grid_elo": grid[nearest],
        # Outside the swept range, this is Maia's opinion at the edge of what
        # was actually tried rather than a real read at your rating -- worth
        # knowing, not worth hiding.
        "clamped": target_elo < grid[0] or target_elo > grid[-1],
    }


@router.get("/{game_id}/mistake-check")
def mistake_check(game_id: int, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        game = conn.execute(
            "SELECT * FROM games WHERE id = ? AND user_id = ?", (game_id, user["id"])
        ).fetchone()
        if not game:
            raise HTTPException(404, "no such game")
        if game["your_color"] not in ("w", "b"):
            return {"available": False,
                   "reason": "this game isn't assigned to a colour, so there's no side to check"}

        run_game = conn.execute(
            """SELECT id, grid_json FROM run_games
               WHERE game_id = ? AND user_id = ? AND mode IN ('full', 'sweep')
               ORDER BY (mode = 'full') DESC, analyzed_at DESC LIMIT 1""",
            (game_id, user["id"]),
        ).fetchone()
        if not run_game:
            return {"available": False,
                   "reason": "this game hasn't had a Full analysis (Elo sweep) run on it yet"}
        try:
            grid = json.loads(run_game["grid_json"] or "null")
        except ValueError:
            grid = None
        if not grid or len(grid) < 2:
            return {"available": False, "reason": "no swept Elo grid was stored for this game"}

        header_elo = strength._header_elo(game["headers_json"], game["your_color"])
        if header_elo is None:
            return {"available": False,
                   "reason": "no recorded Elo for you in this game's PGN headers -- "
                             "a played-vs-Maia game has none, and neither does an export "
                             "missing WhiteElo/BlackElo"}

        bad_moves = conn.execute(
            """SELECT ply, san, classification, wp_drop FROM analysis_moves
               WHERE run_game_id = ? AND classification IN (?, ?, ?)
               ORDER BY ply""",
            (run_game["id"], *BAD_CLASSIFICATIONS),
        ).fetchall()
        sweep_rows = {
            row["ply"]: (row["scores"], row["policies"])
            for row in conn.execute(
                "SELECT ply, scores, policies FROM sweep_positions "
                "WHERE run_game_id = ? AND side = ?",
                (run_game["id"], game["your_color"]),
            )
        }

    # Calibrated against opponents from the same database this game is in --
    # a chess.com game against the offset measured from chess.com opponents,
    # not diluted by played-vs-Maia games that carry no header Elo to
    # calibrate with in the first place.
    database = game_database(game["source_name"])
    calibration = strength.build(user["id"], library=LibraryFilter(database=database))[
        "calibration"
    ]
    if not calibration.get("available"):
        return {"available": False,
               "reason": f"can't calibrate your rating onto Maia's scale: {calibration.get('reason')}",
               "header_elo": header_elo}

    offset = calibration["offset"]
    target_elo = header_elo + offset

    moves = []
    for move in bad_moves:
        row = sweep_rows.get(move["ply"])
        # A ply with no sweep row belongs to the opponent (sweep_rows is
        # already filtered to your own side), or is one the sweep skipped --
        # a checkmate/stalemate final position never reaches the engine.
        if not row:
            continue
        scores, policies = row
        if not scores or len(scores) != len(grid):
            continue
        result = probability_at_elo(grid, scores, policies, target_elo)
        moves.append({
            "ply": move["ply"],
            "san": move["san"],
            "classification": move["classification"],
            "wp_drop": move["wp_drop"],
            **result,
        })

    return {
        "available": True,
        "header_elo": header_elo,
        "offset": round(offset, 1),
        "target_elo": round(target_elo),
        "database": database,
        "moves": moves,
    }
