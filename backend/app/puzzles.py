"""Puzzles built from your own mistakes and blunders.

The premise: the app already knows every position where you gave something
away, because that is what the analysis pass computed. Turning those into
puzzles closes the loop from "here is what you did wrong" to "do it right this
time", against positions you have actually reached rather than composed ones.

Two choices shape the module:

* **Generating a puzzle needs no engine.** The position and the move you
  played come from replaying the stored PGN to that ply, so a rescan of a
  thousand analysed games is a few seconds of parsing. What needs an engine is
  the *answer*, and that is computed the first time a puzzle is attempted and
  then stored -- a library with 4000 blunders in it must not cost 4000
  searches for the dozen you look at.
* **Being right is not "you found Stockfish's move".** Several moves are often
  equally good, and a puzzle that rejects an equal alternative teaches
  nothing. An attempt is graded by evaluating it and comparing win probability
  with the best move, so anything within a small margin is accepted -- and the
  margin, not the move, is what the feedback talks about.

Positions that were already lost before the move are skipped. "You were down a
rook and this made it worse" is not a lesson, and it is the largest source of
junk in a naive generator.
"""

import io

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .analysis import open_stockfish
from .auth import require_user
from .classify import eval_to_cp, win_prob
from .db import db_cursor
from .engine_manager import evaluate_position
from .engine_settings import get_effective_settings
from .jobqueue import pool, slots_for

router = APIRouter(prefix="/api/puzzles", tags=["puzzles"])

# Moves worth practising. 'mistake' and 'blunder' are the classifier's own
# labels (>=10% and >=20% win probability given up).
PUZZLE_CLASSIFICATIONS = ("mistake", "blunder")

# Below this win probability the game was already gone, and "find the best
# move in a lost position" is a different exercise from the one this is for.
MIN_WIN_PROB_BEFORE = 0.15

# How much win probability an answer may give up against the engine's best and
# still count. Equal-looking moves really are equal; insisting on the top move
# would fail people for finding the other winning rook.
ACCEPT_WP_MARGIN = 0.03


def _side_to_move(ply: int) -> str:
    return "w" if ply % 2 == 1 else "b"


def build(user_id: int) -> dict:
    """Scans analysed games for your mistakes and blunders and stores one
    puzzle per bad move. Idempotent: re-running adds only what's new."""
    with db_cursor() as conn:
        rows = conn.execute(
            """SELECT DISTINCT g.id AS game_id, g.pgn_text, g.your_color,
                      m.ply, m.classification, m.wp_drop, m.cp_before
               FROM analysis_moves m
               JOIN run_games rg ON rg.id = m.run_game_id
               JOIN games g ON g.id = rg.game_id
               WHERE rg.user_id = ?
                 AND m.classification IN (?, ?)
                 AND g.your_color IN ('w', 'b')
               ORDER BY g.id, m.ply""",
            (user_id, *PUZZLE_CLASSIFICATIONS),
        ).fetchall()

    considered = len(rows)
    skipped_already_lost = 0
    by_game: dict[int, list] = {}
    for row in rows:
        # Only your own moves: the opponent's blunders are not your lesson.
        if _side_to_move(row["ply"]) != row["your_color"]:
            continue
        # cp_before is from the mover's perspective -- yours, on your own ply.
        if row["cp_before"] is not None and win_prob(row["cp_before"]) < MIN_WIN_PROB_BEFORE:
            skipped_already_lost += 1
            continue
        by_game.setdefault(row["game_id"], []).append(row)

    made = []
    for game_id, moves in by_game.items():
        # One parse per game, however many of its moves qualify.
        game = chess.pgn.read_game(io.StringIO(moves[0]["pgn_text"]))
        if game is None:
            continue
        wanted = {m["ply"]: m for m in moves}
        board = game.board()
        ply = 0
        for move in game.mainline_moves():
            ply += 1
            row = wanted.get(ply)
            if row is not None:
                made.append((
                    row["game_id"], ply, board.fen(), move.uci(), board.san(move),
                    row["your_color"], row["classification"], row["wp_drop"], row["cp_before"],
                ))
            board.push(move)

    with db_cursor() as conn:
        before = conn.execute(
            "SELECT COUNT(*) AS n FROM puzzles WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        conn.executemany(
            """INSERT OR IGNORE INTO puzzles
                 (user_id, game_id, ply, fen, played_uci, played_san, your_color,
                  classification, wp_drop, cp_before)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(user_id, *m) for m in made],
        )
        after = conn.execute(
            "SELECT COUNT(*) AS n FROM puzzles WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
    return {
        "added": after - before,
        "total": after,
        "considered": considered,
        "skipped_already_lost": skipped_already_lost,
    }


def _stats(conn, user_id: int) -> dict:
    row = conn.execute(
        """SELECT COUNT(*) AS total,
                  SUM(solved) AS solved,
                  SUM(classification = 'blunder') AS blunders,
                  SUM(attempts > 0) AS attempted
           FROM puzzles WHERE user_id = ?""",
        (user_id,),
    ).fetchone()
    return {
        "total": row["total"] or 0,
        "solved": row["solved"] or 0,
        "attempted": row["attempted"] or 0,
        "blunders": row["blunders"] or 0,
        "unsolved": (row["total"] or 0) - (row["solved"] or 0),
    }


def _public(row) -> dict:
    """What the browser is allowed to know before an attempt. The move you
    played is deliberately withheld: knowing it turns "find the move" into
    "find the other move", and the reveal is the lesson."""
    return {
        "id": row["id"],
        "game_id": row["game_id"],
        "ply": row["ply"],
        "fen": row["fen"],
        "your_color": row["your_color"],
        "classification": row["classification"],
        "wp_drop": row["wp_drop"],
        "move_number": (row["ply"] + 1) // 2,
        "white": row["white"],
        "black": row["black"],
        "date": row["utc_date_header"] or row["date_header"],
        "attempts": row["attempts"],
        "solved": bool(row["solved"]),
    }


async def _evaluate(user_id: int, fen: str, attempt_uci: str | None) -> dict:
    """The engine half: the position's best move, and (when given) what the
    attempted move is actually worth. One process, one lease, both answers."""
    settings = get_effective_settings(user_id)
    limit_type = settings.get("sf_limit_type", "depth")
    limit_value = settings.get("sf_limit_value", 18)

    async with pool.lease(user_id=user_id, slots=slots_for(settings, "quick"), label="puzzle"):
        try:
            engine = await open_stockfish(settings)
        except Exception as e:
            # Almost always "no Stockfish selected". Checking an answer is the
            # only thing here that needs one, so say which thing is missing
            # rather than returning a 500 to a click on a chess board.
            raise HTTPException(503, f"can't check that without an engine: {e}")
        try:
            info = await evaluate_position(engine, fen, limit_type, limit_value)
            best_uci = (info.get("pv") or [None])[0]
            best_cp = eval_to_cp(info)

            attempt_cp = None
            if attempt_uci:
                board = chess.Board(fen)
                board.push(chess.Move.from_uci(attempt_uci))
                if board.is_checkmate():
                    # Mate delivered: no search needed, and asking the engine
                    # about a finished game gets a score with no move in it.
                    attempt_cp = 10000.0
                elif board.is_stalemate() or board.is_insufficient_material():
                    attempt_cp = 0.0
                else:
                    after = await evaluate_position(engine, board.fen(), limit_type, limit_value)
                    # Scored for the opponent, who is now to move.
                    attempt_cp = -eval_to_cp(after)
        finally:
            engine.terminate()
            await engine.wait_closed()
    return {"best_uci": best_uci, "best_cp": best_cp, "attempt_cp": attempt_cp}


def _san(fen: str, uci: str | None) -> str | None:
    if not uci:
        return None
    board = chess.Board(fen)
    try:
        return board.san(chess.Move.from_uci(uci))
    except (ValueError, AssertionError):
        return None


def _load(user_id: int, puzzle_id: int):
    with db_cursor() as conn:
        row = conn.execute(
            """SELECT p.*, g.white, g.black, g.utc_date_header, g.date_header
               FROM puzzles p JOIN games g ON g.id = p.game_id
               WHERE p.id = ? AND p.user_id = ?""",
            (puzzle_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "no such puzzle")
    return row


async def _ensure_solution(user_id: int, row) -> tuple[str | None, str | None, float | None]:
    """The stored answer, computing it once if this is the first time anyone
    has asked."""
    if row["solution_uci"]:
        return row["solution_uci"], row["solution_san"], row["solution_cp"]
    result = await _evaluate(user_id, row["fen"], None)
    san = _san(row["fen"], result["best_uci"])
    with db_cursor() as conn:
        conn.execute(
            """UPDATE puzzles SET solution_uci = ?, solution_san = ?, solution_cp = ?,
                                  solved_at = datetime('now')
               WHERE id = ?""",
            (result["best_uci"], san, result["best_cp"], row["id"]),
        )
    return result["best_uci"], san, result["best_cp"]


@router.get("/stats")
def stats(user: dict = Depends(require_user)):
    with db_cursor() as conn:
        return _stats(conn, user["id"])


@router.post("/rebuild")
def rebuild(user: dict = Depends(require_user)):
    """Rescans analysed games for new material. Cheap -- no engine runs."""
    result = build(user["id"])
    with db_cursor() as conn:
        result.update(_stats(conn, user["id"]))
    return result


@router.get("/next")
def next_puzzle(scope: str = "blunder", order: str = "random",
                exclude: int | None = None, user: dict = Depends(require_user)):
    """One puzzle to solve. Unsolved ones first; once they're all done it
    starts offering solved ones again rather than saying there's nothing left.
    """
    if scope not in ("blunder", "all"):
        raise HTTPException(400, "scope must be 'blunder' or 'all'")
    where = ["p.user_id = ?"]
    params: list = [user["id"]]
    if scope == "blunder":
        where.append("p.classification = 'blunder'")
    if exclude is not None:
        where.append("p.id != ?")
        params.append(exclude)
    # Worst-first is by how much the move actually cost; random keeps a long
    # session from being the same handful of positions every time.
    ordering = "p.solved ASC, p.wp_drop DESC" if order == "worst" else "p.solved ASC, RANDOM()"

    with db_cursor() as conn:
        row = conn.execute(
            f"""SELECT p.*, g.white, g.black, g.utc_date_header, g.date_header
                FROM puzzles p JOIN games g ON g.id = p.game_id
                WHERE {' AND '.join(where)}
                ORDER BY {ordering} LIMIT 1""",
            params,
        ).fetchone()
        if not row:
            raise HTTPException(404, "no puzzles yet -- analyse some games and rescan")
        conn.execute("UPDATE puzzles SET last_seen_at = datetime('now') WHERE id = ?", (row["id"],))
        return {"puzzle": _public(row), **_stats(conn, user["id"])}


class AttemptIn(BaseModel):
    uci: str


@router.post("/{puzzle_id}/attempt")
async def attempt(puzzle_id: int, body: AttemptIn, user: dict = Depends(require_user)):
    """Grades a move. Anything within a small win-probability margin of the
    engine's best counts -- several moves are often equally good, and failing
    someone for finding the other winning rook teaches nothing."""
    row = _load(user["id"], puzzle_id)
    board = chess.Board(row["fen"])
    try:
        move = chess.Move.from_uci(body.uci)
    except ValueError:
        raise HTTPException(400, "not a move")
    if move not in board.legal_moves:
        raise HTTPException(400, "not a legal move in this position")

    result = await _evaluate(user["id"], row["fen"], body.uci)
    best_uci = row["solution_uci"] or result["best_uci"]
    best_cp = row["solution_cp"] if row["solution_uci"] else result["best_cp"]
    best_san = row["solution_san"] or _san(row["fen"], best_uci)

    given_up = max(0.0, win_prob(best_cp) - win_prob(result["attempt_cp"]))
    correct = body.uci == best_uci or given_up <= ACCEPT_WP_MARGIN

    with db_cursor() as conn:
        if not row["solution_uci"] and best_uci:
            conn.execute(
                """UPDATE puzzles SET solution_uci = ?, solution_san = ?, solution_cp = ?,
                                      solved_at = datetime('now') WHERE id = ?""",
                (best_uci, best_san, best_cp, puzzle_id),
            )
        conn.execute(
            """UPDATE puzzles SET attempts = attempts + 1, solved = MAX(solved, ?),
                                  last_seen_at = datetime('now')
               WHERE id = ?""",
            (1 if correct else 0, puzzle_id),
        )
        counts = _stats(conn, user["id"])

    return {
        "correct": correct,
        "attempt": {"uci": body.uci, "san": board.san(move),
                    "cp": result["attempt_cp"], "win_prob": win_prob(result["attempt_cp"])},
        "best": {"uci": best_uci, "san": best_san,
                 "cp": best_cp, "win_prob": win_prob(best_cp)},
        # Revealed now rather than up front: knowing the move you played turns
        # "find the move" into "find the other move".
        "played": {"uci": row["played_uci"], "san": row["played_san"]},
        "given_up": round(given_up, 4),
        "same_as_played": body.uci == row["played_uci"],
        **counts,
    }


@router.post("/{puzzle_id}/reveal")
async def reveal(puzzle_id: int, user: dict = Depends(require_user)):
    """Gives up on a puzzle. It stays unsolved -- a revealed answer isn't one
    you found, and it should come round again."""
    row = _load(user["id"], puzzle_id)
    best_uci, best_san, best_cp = await _ensure_solution(user["id"], row)
    with db_cursor() as conn:
        conn.execute(
            "UPDATE puzzles SET revealed = 1, last_seen_at = datetime('now') WHERE id = ?",
            (puzzle_id,),
        )
        counts = _stats(conn, user["id"])
    return {
        "best": {"uci": best_uci, "san": best_san, "cp": best_cp,
                 "win_prob": win_prob(best_cp) if best_cp is not None else None},
        "played": {"uci": row["played_uci"], "san": row["played_san"]},
        **counts,
    }


@router.post("/reset")
def reset(user: dict = Depends(require_user)):
    """Clears your record against the puzzles, keeping the puzzles (and the
    engine answers already worked out) so a second pass costs nothing."""
    with db_cursor() as conn:
        conn.execute(
            "UPDATE puzzles SET attempts = 0, solved = 0, revealed = 0 WHERE user_id = ?",
            (user["id"],),
        )
        return _stats(conn, user["id"])
