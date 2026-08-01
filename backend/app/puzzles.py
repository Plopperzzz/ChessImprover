"""Puzzles, from your own mistakes and from the Lichess database.

Two sources, one trainer. They answer different questions and neither
replaces the other:

* **Your own games.** Every position where you gave something away, as a
  puzzle. You faced it, you got it wrong, here it is again. Nothing else can
  give you this, and it is the reason the feature exists.
* **The Lichess database.** Several million positions with difficulty
  measured against real solvers (see `app/lichess_puzzles.py`). Your own
  blunders run out, they cluster in whatever you happen to play, and they
  carry no calibrated difficulty. This fills all three gaps.

They share a theme vocabulary, a picker and a rating, which is what makes
them one feature rather than two tabs.

Four choices shape the module:

* **Generating an own-game puzzle needs no engine.** The position and the
  move played come from replaying the stored PGN, so a rescan of a thousand
  analysed games is a few seconds of parsing. What needs an engine is the
  *answer*, computed the first time a puzzle is attempted and then stored --
  a library with 4000 blunders in it must not cost 4000 searches for the
  dozen you look at.
* **Being right is not "you found Stockfish's move".** For an own-game
  puzzle, an attempt is graded by evaluating it and comparing win probability
  with the best move, so anything within a small margin is accepted. A
  Lichess puzzle is graded against its recorded line instead -- that line is
  the puzzle -- with mate accepted by any move that mates.
* **The rating is Glicko-2**, the system Lichess rates puzzles with, and only
  the first attempt at a puzzle counts. See `app/puzzle_ratings.py`.
* **A puzzle is only rated when its difficulty is actually known.** Lichess
  puzzles carry a measured one. Own-game puzzles get an estimate derived from
  the imported database, handed to Glicko-2 with a wide deviation so it moves
  your rating gently; with no database imported there is no honest estimate,
  and they simply go unrated rather than inventing a number.

Positions that were already lost before the move are skipped when building
from your games. "You were down a rook and this made it worse" is not a
lesson, and it is the largest source of junk in a naive generator.
"""

import io

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import (
    lichess_puzzles, puzzle_difficulty, puzzle_ratings, puzzle_solve, puzzle_themes,
)
from .analysis import open_stockfish
from .auth import require_user
from .classify import eval_to_cp, win_prob
from .db import db_cursor
from .engine_manager import evaluate_position
from .engine_settings import get_effective_settings
from .jobqueue import pool, slots_for

router = APIRouter(prefix="/api/puzzles", tags=["puzzles"])

# Moves worth practising. These are the classifier's own labels: mistake and
# blunder gave up >=10% and >=20% win probability, and a miss is one of those
# two that threw away a won position -- the most instructive of the three, so
# splitting it out of the pair must not drop it out of the puzzle set.
PUZZLE_CLASSIFICATIONS = ("mistake", "blunder", "miss")

# Below this win probability the game was already gone, and "find the best
# move in a lost position" is a different exercise from the one this is for.
MIN_WIN_PROB_BEFORE = 0.15

# How much win probability an answer may give up against the engine's best and
# still count. Equal-looking moves really are equal; insisting on the top move
# would fail people for finding the other winning rook.
ACCEPT_WP_MARGIN = 0.03

# How sure we are of a Lichess puzzle's difficulty when the row doesn't say.
# The published deviations cluster around 75.
DEFAULT_LICHESS_RD = 75.0

# ...and how sure we are of an own-game puzzle's, which is a theme-matched
# estimate rather than a measurement. Deliberately much wider: Glicko-2 reads
# this as "don't move the solver's rating much on the strength of it", which
# is exactly right for a number this app inferred.
OWN_PUZZLE_RD = 250.0

# The band around your rating that puzzles are drawn from. Wide enough that
# the set doesn't feel repetitive, narrow enough that they're worth solving --
# a puzzle 500 points below you teaches nothing and moves the rating by
# nothing.
RATING_WINDOW_BELOW = 150
RATING_WINDOW_ABOVE = 250

# What a brand-new solver is shown before there's a rating worth aiming at.
# Below the 1500 start, because the first puzzle should be solvable.
UNRATED_BAND = (800, 1500)

# The two kinds of exercise a position from your own games can be, and the
# thresholds that tell them apart.
#
# A **tactic** is "there is something here, find it". A **blunder check** is
# "you were fine and you threw it away, find the move that holds" -- the same
# position, a different question, and the reason they are worth separating is
# that they train different things. Working through tactics teaches you to see
# the win; working through blunder checks teaches you to stop giving games
# away, which at most ratings is worth considerably more.
#
# The test is on the evaluations the analysis pass already stored, so it costs
# no engine time and every puzzle has a kind the moment it is built -- which
# matters, because it is a filter and a filter that needed a search per row
# could not be one.
KINDS = ("tactic", "blunder_check")

# You were at least this well off before the move...
BLUNDER_CHECK_WP_BEFORE = 0.35
# ...and this badly off after it. Together: a position you were holding and
# then were not. Note the gap between the two -- a move that goes from 0.36 to
# 0.24 is a blunder check and one that goes from 0.36 to 0.30 is not, because
# the second is a position you are still in.
BLUNDER_CHECK_WP_AFTER = 0.25


def classify_kind(cp_before: float | None, cp_after: float | None) -> str:
    """Which kind of exercise this position is.

    `cp_before` is from your side of the board; `cp_after` is the evaluation
    of the position your move left behind, which is scored for the *opponent*
    because they are to move in it (see `classify.classify_moves`). Getting
    that flip wrong reads every blunder as a brilliancy, so it is done here
    once and nowhere else.
    """
    if cp_before is None or cp_after is None:
        return "tactic"
    wp_before = win_prob(cp_before)
    wp_after = 1.0 - win_prob(cp_after)
    if wp_before >= BLUNDER_CHECK_WP_BEFORE and wp_after <= BLUNDER_CHECK_WP_AFTER:
        return "blunder_check"
    return "tactic"


def _side_to_move(ply: int) -> str:
    return "w" if ply % 2 == 1 else "b"


# ---------------------------------------------------------------------------
# Building puzzles from your own games
# ---------------------------------------------------------------------------


def build(user_id: int) -> dict:
    """Scans analysed games for your mistakes and blunders and stores one
    puzzle per bad move. Idempotent: re-running adds only what's new."""
    # Built from the tuple rather than written out, because writing it out is
    # exactly how this came to bind three values into two placeholders and 500
    # on every rescan once 'miss' was split out of mistake/blunder.
    wanted_classes = ", ".join("?" * len(PUZZLE_CLASSIFICATIONS))
    with db_cursor() as conn:
        # No pgn_text here. The old version selected it alongside every
        # matching move and leaned on DISTINCT, which made SQLite sort a copy
        # of the full game text per bad move -- on a real library that is tens
        # of megabytes of sorting to find a few thousand ply numbers. The text
        # is fetched below, once per game, and only for games that need it.
        rows = conn.execute(
            f"""SELECT DISTINCT g.id AS game_id, g.your_color,
                       m.ply, m.classification, m.wp_drop, m.cp_before, m.cp_after
                FROM analysis_moves m
                JOIN run_games rg ON rg.id = m.run_game_id
                JOIN games g ON g.id = rg.game_id
                WHERE rg.user_id = ?
                  AND m.classification IN ({wanted_classes})
                  AND g.your_color IN ('w', 'b')
                ORDER BY g.id, m.ply""",
            (user_id, *PUZZLE_CLASSIFICATIONS),
        ).fetchall()
        # What's already been built, so a rescan doesn't re-parse the whole
        # library to rediscover puzzles it made last time. This is the
        # difference between a rescan costing a minute and costing a second,
        # and a rescan is something you press after every analysis.
        existing = {
            (row["game_id"], row["ply"]) for row in conn.execute(
                "SELECT game_id, ply FROM puzzles WHERE user_id = ?", (user_id,)
            )
        }

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
        if (row["game_id"], row["ply"]) in existing:
            continue
        by_game.setdefault(row["game_id"], []).append(row)

    made = []
    if by_game:
        with db_cursor() as conn:
            ids = list(by_game)
            texts = {}
            # Chunked because SQLite caps the number of bound parameters
            # (999 on older builds), and a first scan can want thousands.
            for start in range(0, len(ids), 500):
                batch = ids[start:start + 500]
                texts.update({
                    row["id"]: row["pgn_text"] for row in conn.execute(
                        "SELECT id, pgn_text FROM games WHERE id IN "
                        f"({', '.join('?' * len(batch))})", batch
                    )
                })

        for game_id, moves in by_game.items():
            pgn_text = texts.get(game_id)
            if not pgn_text:
                continue
            # One parse per game, however many of its moves qualify.
            game = chess.pgn.read_game(io.StringIO(pgn_text))
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
                        row["your_color"], row["classification"], row["wp_drop"],
                        row["cp_before"], row["cp_after"],
                        classify_kind(row["cp_before"], row["cp_after"]),
                    ))
                board.push(move)

    with db_cursor() as conn:
        before = conn.execute(
            "SELECT COUNT(*) AS n FROM puzzles WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        conn.executemany(
            """INSERT OR IGNORE INTO puzzles
                 (user_id, game_id, ply, fen, played_uci, played_san, your_color,
                  classification, wp_drop, cp_before, cp_after, kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(user_id, *m) for m in made],
        )
        _backfill_kinds(conn, user_id)
        after = conn.execute(
            "SELECT COUNT(*) AS n FROM puzzles WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
        tagged = _tag_positions(conn, user_id)
    return {
        "added": after - before,
        "total": after,
        "considered": considered,
        "skipped_already_lost": skipped_already_lost,
        "phase_tagged": tagged,
    }


def _backfill_kinds(conn, user_id: int) -> int:
    """Give a kind to puzzles built before there were kinds.

    In Python rather than in the UPDATE because the test needs `exp`, and
    SQLite only has it where the build was compiled with the math functions --
    which is not something a home server's SQLite can be assumed to have. Only
    ever touches rows still sitting on the column default, so a second rescan
    costs one indexed scan and no writes.
    """
    rows = conn.execute(
        """SELECT id, cp_before, cp_after FROM puzzles
           WHERE user_id = ? AND kind = 'tactic'
             AND cp_before IS NOT NULL AND cp_after IS NOT NULL""",
        (user_id,),
    ).fetchall()
    changed = [
        (row["id"],) for row in rows
        if classify_kind(row["cp_before"], row["cp_after"]) == "blunder_check"
    ]
    if changed:
        conn.executemany("UPDATE puzzles SET kind = 'blunder_check' WHERE id = ?", changed)
    return len(changed)


def _tag_positions(conn, user_id: int) -> int:
    """Give every untagged puzzle the themes readable off its position.

    The motif themes need the solution move and so wait for an engine, but
    the phase ones don't, and tagging them now means the theme picker works
    on a freshly built library instead of only on the puzzles you've already
    attempted. Cheap: no engine, one pass, and only over rows with no themes.
    """
    rows = conn.execute(
        """SELECT p.id, p.fen FROM puzzles p
           WHERE p.user_id = ? AND p.themes_tagged = 0
             AND NOT EXISTS (SELECT 1 FROM puzzle_themes t WHERE t.puzzle_id = p.id)""",
        (user_id,),
    ).fetchall()
    pairs = [
        (row["id"], theme)
        for row in rows
        for theme in puzzle_themes.position_themes(row["fen"])
    ]
    if pairs:
        conn.executemany(
            "INSERT OR IGNORE INTO puzzle_themes (puzzle_id, theme) VALUES (?, ?)", pairs
        )
    return len(rows)


def own_puzzle_rating(conn, themes: list[str]) -> int | None:
    """A difficulty for a puzzle from your own games, or None.

    There is no honest way to rate one of these from first principles -- what
    makes a position hard is not something the position tells you. So the
    estimate is borrowed: a home-grown puzzle tagged `fork middlegame
    crushing` is taken to be about as hard as the imported Lichess puzzles
    carrying those same themes, whose difficulty *is* measured. That claim is
    modest, checkable, and better than the alternatives (a fixed 1500, or
    something derived from `wp_drop`, which measures how bad your move was
    rather than how hard the good one was to find).

    Returns None when there is no database to calibrate against, and the
    caller then leaves the puzzle unrated rather than guessing.
    """
    return lichess_puzzles.rating_for_themes(conn, puzzle_ratings.rateable_themes(themes))


def _tag_solution(conn, puzzle_id: int, fen: str, line: list[str],
                  cp_before: float | None, line_cp: float | None) -> list[str]:
    """Themes and an estimated difficulty, now that the answer is known.

    Runs once per puzzle, at the moment an engine first works the line out --
    which is also the moment there is anything to tag. The whole line is
    tagged, not just its first move: see `puzzle_themes.derive_line_themes`.

    The rating written here is the theme-matched estimate, which needs no
    engine and is available immediately. A Maia measurement, when one can be
    made, overwrites it (`_rate_with_maia`) -- so a puzzle is never left
    unrated while waiting for the better number.
    """
    if not line:
        return []
    themes = puzzle_themes.derive_line_themes(
        fen, line, cp_before=cp_before, line_cp=line_cp
    )
    if themes:
        conn.executemany(
            "INSERT OR IGNORE INTO puzzle_themes (puzzle_id, theme) VALUES (?, ?)",
            [(puzzle_id, theme) for theme in themes],
        )
    rating = own_puzzle_rating(conn, themes)
    conn.execute(
        """UPDATE puzzles SET themes_tagged = 1, rating = ?, rating_rd = ?,
                              rating_source = ?
           WHERE id = ?""",
        (rating, int(OWN_PUZZLE_RD) if rating is not None else None,
         "themes" if rating is not None else None, puzzle_id),
    )
    return themes


def _own_themes(conn, puzzle_id: int) -> list[str]:
    return [
        row["theme"] for row in conn.execute(
            "SELECT theme FROM puzzle_themes WHERE puzzle_id = ? ORDER BY theme",
            (puzzle_id,),
        )
    ]


# ---------------------------------------------------------------------------
# Stats and serialisation
# ---------------------------------------------------------------------------


def _own_stats(conn, user_id: int) -> dict:
    row = conn.execute(
        """SELECT COUNT(*) AS total,
                  COALESCE(SUM(solved), 0) AS solved,
                  COALESCE(SUM(classification = 'blunder'), 0) AS blunders,
                  COALESCE(SUM(attempts > 0), 0) AS attempted,
                  COALESCE(SUM(rating IS NOT NULL), 0) AS rated,
                  COALESCE(SUM(rating_source = 'maia'), 0) AS maia_rated,
                  COALESCE(SUM(kind = 'tactic'), 0) AS tactics,
                  COALESCE(SUM(kind = 'blunder_check'), 0) AS blunder_checks,
                  COALESCE(SUM(moves_required > 1), 0) AS multi_move
           FROM puzzles WHERE user_id = ?""",
        (user_id,),
    ).fetchone()
    total = row["total"] or 0
    return {
        "total": total,
        "solved": row["solved"] or 0,
        "attempted": row["attempted"] or 0,
        "blunders": row["blunders"] or 0,
        "rated": row["rated"] or 0,
        "maia_rated": row["maia_rated"] or 0,
        "unsolved": total - (row["solved"] or 0),
        # Per kind, so the two toggles can say how much is behind each of them
        # rather than offering a filter that might be empty.
        "by_kind": {
            "tactic": row["tactics"] or 0,
            "blunder_check": row["blunder_checks"] or 0,
        },
        "multi_move": row["multi_move"] or 0,
    }


def _own_public(row, themes: list[str]) -> dict:
    """What the browser is allowed to know before an attempt. The move you
    played is deliberately withheld: knowing it turns "find the move" into
    "find the other move", and the reveal is the lesson."""
    return {
        "key": f"own:{row['id']}",
        "source": "own",
        "id": row["id"],
        "game_id": row["game_id"],
        "ply": row["ply"],
        "fen": row["fen"],
        "setup": None,
        "your_color": row["your_color"],
        "kind": row["kind"],
        "classification": row["classification"],
        "wp_drop": row["wp_drop"],
        "move_number": (row["ply"] + 1) // 2,
        "white": row["white"],
        "black": row["black"],
        "date": row["utc_date_header"] or row["date_header"],
        "attempts": row["attempts"],
        "solved": bool(row["solved"]),
        "themes": themes,
        "rating": row["rating"],
        "rating_rd": row["rating_rd"],
        "rating_source": row["rating_source"],
        # How many of your moves the answer is. 0 while the line has never
        # been worked out, which the browser reads as "unknown yet" rather
        # than as "one" -- claiming one and then asking for a second move is
        # the version of this that makes a solver think they got it wrong.
        "moves_required": row["moves_required"] if row["solution_line"] else 0,
    }


def _lichess_public(row) -> dict | None:
    """A Lichess puzzle, as the solver sees it.

    The stored FEN is the position *before* the opponent's move, and the
    first move of the line is theirs. That move is played here and both
    positions are sent: the browser shows the 'before' briefly, animates the
    opponent's move, and leaves you looking at the position to solve. It
    reads as a real moment from a game rather than a diagram appearing.

    The rest of the line is not sent. It is the answer, and the browser has
    no business holding it -- moves are checked one at a time against the
    server (see `attempt_lichess`).

    Returns None for a row whose position and line don't agree. That should
    never happen with the published data, but 'never' across five million
    imported rows is worth one try/except: the caller moves on to the next
    candidate, where the alternative is a 500 on a click.
    """
    try:
        moves = row["moves"].split()
        board = chess.Board(row["fen"])
        setup = chess.Move.from_uci(moves[0])
        if setup not in board.legal_moves:
            return None
        setup_san = board.san(setup)
        board.push(setup)
    except (ValueError, IndexError, AssertionError):
        return None
    themes = puzzle_themes.parse(row["themes"])
    return {
        "key": f"lichess:{row['puzzle_id']}",
        "source": "lichess",
        "id": row["puzzle_id"],
        "fen": board.fen(),
        # The position before the opponent moved, plus their move, so the
        # board can play it in.
        "setup": {"fen": row["fen"], "uci": moves[0], "san": setup_san},
        "your_color": "w" if board.turn == chess.WHITE else "b",
        "themes": themes,
        "rating": row["rating"],
        "rating_rd": row["rating_deviation"] or int(DEFAULT_LICHESS_RD),
        "popularity": row["popularity"],
        "nb_plays": row["nb_plays"],
        "game_url": row["game_url"],
        "opening_tags": (row["opening_tags"] or "").replace("_", " ") or None,
        # How many moves you have to find. Sent because "mate in two" is
        # already public via the themes, and a solver needs to know whether
        # the puzzle is over.
        "moves_required": len(moves) // 2,
        "attempts": 0,
        "solved": False,
    }


# ---------------------------------------------------------------------------
# The engine half (own-game puzzles only)
# ---------------------------------------------------------------------------


async def _evaluate(user_id: int, fen: str, attempt_uci: str | None) -> dict:
    """The position's best move, and (when given) what the attempted move is
    actually worth. One process, one lease, both answers."""
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


async def _solve(user_id: int, fen: str) -> dict:
    """The whole answer to a position: the line, how unique its first move
    was, and what the position is worth played correctly.

    One engine, one lease, however many searches the line takes. See
    `app/puzzle_solve.py` for how long a line is allowed to be and why.
    """
    settings = get_effective_settings(user_id)
    limit_type = settings.get("sf_limit_type", "depth")
    limit_value = settings.get("sf_limit_value", 18)

    async with pool.lease(user_id=user_id, slots=slots_for(settings, "quick"), label="puzzle"):
        try:
            engine = await open_stockfish(settings)
        except Exception as e:
            raise HTTPException(503, f"can't work that out without an engine: {e}")
        try:
            return await puzzle_solve.solve_line(engine, fen, limit_type, limit_value)
        finally:
            engine.terminate()
            await engine.wait_closed()


async def _ensure_line(user_id: int, row) -> dict:
    """The stored answer, working it out once if this is the first time anyone
    has asked -- and tagging and rating the puzzle while it is in hand.

    Returns `{'line', 'moves_required', 'best_cp', ...}` whether it was stored
    or just computed, so callers never care which happened.
    """
    if row["solution_line"]:
        line = row["solution_line"].split()
        return {
            "line": line,
            "moves_required": row["moves_required"] or (len(line) + 1) // 2,
            "best_cp": row["solution_cp"],
            "line_cp": row["line_cp"],
            "unique_margin": row["unique_margin"],
        }

    result = await _solve(user_id, row["fen"])
    line = result["line"]
    first = line[0] if line else None
    san = _san(row["fen"], first)
    with db_cursor() as conn:
        conn.execute(
            """UPDATE puzzles SET solution_uci = ?, solution_san = ?, solution_cp = ?,
                                  solution_line = ?, moves_required = ?, line_cp = ?,
                                  unique_margin = ?, solved_at = datetime('now')
               WHERE id = ?""",
            (first, san, result["best_cp"], " ".join(line),
             result["moves_required"], result["line_cp"], result["unique_margin"],
             row["id"]),
        )
        _tag_solution(conn, row["id"], row["fen"], line,
                      row["cp_before"], result["line_cp"])
    return result


async def _rate_with_maia(user_id: int, puzzle_id: int, fen: str, line: list[str]) -> dict:
    """Measure the puzzle's difficulty with Maia and store it.

    Best-effort by construction: with no Maia configured, or a build that
    can't be swept, this leaves the theme-matched estimate in place and says
    why. See `app/puzzle_difficulty.py` for what the number means.
    """
    settings = get_effective_settings(user_id)
    positions = puzzle_solve.line_positions(fen, line)
    result = await puzzle_difficulty.measure(settings, positions, user_id=user_id)
    if result.get("rating") is None:
        return result
    with db_cursor() as conn:
        conn.execute(
            """UPDATE puzzles SET maia_elo = ?, maia_rd = ?, rating = ?, rating_rd = ?,
                                  rating_source = 'maia'
               WHERE id = ?""",
            (result["elo"], result["rd"], result["rating"], int(result["rd"]), puzzle_id),
        )
    return result


# ---------------------------------------------------------------------------
# Picking the next puzzle
# ---------------------------------------------------------------------------


def _rating_band(conn, user_id: int) -> tuple[int, int]:
    """The rating range to draw Lichess puzzles from."""
    rating = puzzle_ratings.get(conn, user_id)
    if rating.provisional and rating.rd >= 300:
        # No real evidence yet. Start low and let the rating find its level
        # rather than opening with a 1500 that may be far too hard.
        return UNRATED_BAND
    return (int(rating.rating) - RATING_WINDOW_BELOW,
            int(rating.rating) + RATING_WINDOW_ABOVE)


def _parse_themes(raw: str | None) -> list[str]:
    if not raw:
        return []
    themes = [t.strip() for t in raw.split(",") if t.strip()]
    unknown = [t for t in themes if t not in puzzle_themes.THEME_LABELS]
    if unknown:
        raise HTTPException(400, f"unknown theme: {', '.join(unknown)}")
    return themes


def _next_own(conn, user_id: int, scope: str, order: str, themes: list[str],
              exclude: int | None, kinds: list[str]) -> dict:
    where = ["p.user_id = ?"]
    params: list = [user_id]
    if scope == "blunder":
        where.append("p.classification = 'blunder'")
    # Kinds and themes are independent filters and intersect, which is the
    # whole point: "blunder checks, but only the forks" is a sensible thing to
    # practise and needs no special case to express.
    where.append(f"p.kind IN ({', '.join('?' * len(kinds))})")
    params += kinds
    if exclude is not None:
        where.append("p.id != ?")
        params.append(exclude)

    join = ""
    if themes:
        join = "JOIN puzzle_themes pt ON pt.puzzle_id = p.id"
        where.append(f"pt.theme IN ({', '.join('?' * len(themes))})")
        params += themes

    # Worst-first is by how much the move actually cost; random keeps a long
    # session from being the same handful of positions every time.
    ordering = "p.solved ASC, p.wp_drop DESC" if order == "worst" else "p.solved ASC, RANDOM()"
    row = conn.execute(
        f"""SELECT DISTINCT p.*, g.white, g.black, g.utc_date_header, g.date_header
            FROM puzzles p
            JOIN games g ON g.id = p.game_id
            {join}
            WHERE {' AND '.join(where)}
            ORDER BY {ordering} LIMIT 1""",
        params,
    ).fetchone()
    if not row:
        only_blunder_checks = kinds == ["blunder_check"]
        if themes:
            raise HTTPException(
                404,
                "no puzzles from your games match those themes yet. Motifs are "
                "tagged when an engine works a puzzle's answer out, so a "
                "freshly built set only has its phases tagged.",
            )
        if only_blunder_checks:
            raise HTTPException(
                404,
                "no blunder checks yet -- these are positions you were holding "
                "and then weren't, so they only appear once a game with one in "
                "it has been analysed.",
            )
        raise HTTPException(404, "no puzzles yet -- analyse some games and rescan")
    conn.execute("UPDATE puzzles SET last_seen_at = datetime('now') WHERE id = ?", (row["id"],))
    return _own_public(row, _own_themes(conn, row["id"]))


def _next_lichess(conn, user_id: int, themes: list[str], exclude: str | None) -> dict:
    if not conn.execute("SELECT 1 FROM lichess_puzzles LIMIT 1").fetchone():
        raise HTTPException(
            404,
            "the Lichess puzzle database hasn't been imported yet -- "
            "import it from the Puzzles tab",
        )
    low, high = _rating_band(conn, user_id)
    excluded = [exclude] if exclude else []
    # A handful rather than one, so a row that turns out not to replay costs
    # a retry from this list rather than another trip to the database.
    rows = lichess_puzzles.pick(
        conn, themes=themes, min_rating=low, max_rating=high,
        exclude_keys=excluded, user_id=user_id, limit=5,
    )
    if not rows:
        # Out of unseen puzzles in the band. Widening beats reporting nothing:
        # the alternative is a trainer that stops working once you've done the
        # puzzles near your level, which is precisely when you were improving.
        rows = lichess_puzzles.pick(
            conn, themes=themes, min_rating=0, max_rating=4000,
            exclude_keys=excluded, user_id=user_id, limit=5,
        )
    for row in rows:
        if (puzzle := _lichess_public(row)) is not None:
            return puzzle
    raise HTTPException(
        404,
        "you've solved every imported puzzle matching that selection -- "
        "widen the themes, or import more of the database",
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/stats")
def stats(user: dict = Depends(require_user)):
    """Counts for your own-game puzzles, plus your rating and per-theme record."""
    with db_cursor() as conn:
        return {
            **_own_stats(conn, user["id"]),
            "progress": puzzle_ratings.summary(conn, user["id"]),
            "lichess": lichess_puzzles.import_status(conn),
        }


@router.get("/themes")
def themes(source: str = "own", kinds: str | None = None,
           user: dict = Depends(require_user)):
    """The theme catalog, with how many puzzles carry each theme in the
    chosen source and how you're doing at it.

    Counts are per source because they differ enormously -- the Lichess set
    has a hundred thousand forks and your own games have nine -- and a picker
    that showed one source's counts while filtering the other would be
    actively misleading.
    """
    if source not in ("own", "lichess"):
        raise HTTPException(400, "source must be 'own' or 'lichess'")
    # Counted within the kinds being practised, so a chip never offers a motif
    # that the kind filter has already taken every puzzle out of.
    wanted_kinds = _parse_kinds(kinds)
    with db_cursor() as conn:
        if source == "lichess":
            counts = lichess_puzzles.theme_counts(conn)
        else:
            counts = {
                row["theme"]: row["n"] for row in conn.execute(
                    f"""SELECT t.theme AS theme, COUNT(*) AS n
                        FROM puzzle_themes t JOIN puzzles p ON p.id = t.puzzle_id
                        WHERE p.user_id = ?
                          AND p.kind IN ({', '.join('?' * len(wanted_kinds))})
                        GROUP BY t.theme""",
                    (user["id"], *wanted_kinds),
                )
            }
        progress = {
            entry["theme"]: entry for entry in puzzle_ratings.by_theme(conn, user["id"])
        }

    # Only themes with puzzles behind them. The catalog has sixty-odd entries
    # and most sources carry a fraction of them; listing the rest greyed out
    # would bury the usable ones, and a filter that can only return nothing is
    # worse than no filter.
    groups = []
    for group in puzzle_themes.catalog():
        entries = [
            {**theme, "count": counts[theme["key"]],
             "progress": progress.get(theme["key"])}
            for theme in group["themes"]
            if counts.get(theme["key"], 0) > 0
        ]
        if entries:
            groups.append({**group, "themes": entries})
    return {"source": source, "groups": groups}


@router.post("/rebuild")
def rebuild(user: dict = Depends(require_user)):
    """Rescans analysed games for new material. Cheap -- no engine runs."""
    result = build(user["id"])
    with db_cursor() as conn:
        result.update(_own_stats(conn, user["id"]))
    return result


def _parse_kinds(raw: str | None) -> list[str]:
    """Which kinds of exercise to draw from, defaulting to all of them.

    Sent as a list rather than as a "blunder check on/off" flag because that
    is what it is: with both on they mix, with one on you get only that one,
    and neither is a special case of the other in the query.
    """
    if raw is None or not raw.strip():
        return list(KINDS)
    kinds = [k.strip() for k in raw.split(",") if k.strip()]
    unknown = [k for k in kinds if k not in KINDS]
    if unknown:
        raise HTTPException(400, f"unknown puzzle kind: {', '.join(unknown)}")
    if not kinds:
        raise HTTPException(400, "pick at least one kind of puzzle")
    return kinds


@router.get("/next")
def next_puzzle(source: str = "own", scope: str = "blunder", order: str = "random",
                themes: str | None = None, exclude: str | None = None,
                kinds: str | None = None,
                user: dict = Depends(require_user)):
    """One puzzle to solve.

    For your own games, unsolved ones come first; once they're all done it
    starts offering solved ones again rather than saying there's nothing left.
    For Lichess, puzzles are drawn from a band around your rating and one you
    have already attempted never comes back.
    """
    if source not in ("own", "lichess"):
        raise HTTPException(400, "source must be 'own' or 'lichess'")
    if scope not in ("blunder", "all"):
        raise HTTPException(400, "scope must be 'blunder' or 'all'")
    wanted = _parse_themes(themes)
    wanted_kinds = _parse_kinds(kinds)

    with db_cursor() as conn:
        if source == "lichess":
            puzzle = _next_lichess(conn, user["id"], wanted, exclude)
        else:
            # The own-game ids are integers; anything else means the caller
            # switched source and is excluding a Lichess id, which simply
            # doesn't apply here.
            exclude_id = None
            if exclude and exclude.isdigit():
                exclude_id = int(exclude)
            puzzle = _next_own(conn, user["id"], scope, order, wanted, exclude_id,
                               wanted_kinds)
        return {
            "puzzle": puzzle,
            **_own_stats(conn, user["id"]),
            "progress": puzzle_ratings.summary(conn, user["id"]),
        }


class AttemptIn(BaseModel):
    """What you have played at this puzzle so far.

    `moves` is the whole line from the start, newest last -- the same shape
    the Lichess grader takes, and for the same reason: the server holds no
    per-solver state and re-checks the prefix each time, so nothing can be
    skipped by lying about where you are.

    `uci` is the one-move form the classic UI sends. It is read as a line of
    one, which grades the first move and nothing else.
    """

    moves: list[str] | None = None
    uci: str | None = None

    def line(self) -> list[str]:
        played = self.moves if self.moves is not None else ([self.uci] if self.uci else [])
        return [m.strip() for m in played if m and m.strip()]


def _record_own_attempt(conn, user_id: int, puzzle_id: int, row, *, correct: bool,
                        done: bool, themes: list[str]) -> dict | None:
    """File the attempt and, when the puzzle is over, rate it.

    Rated only on `done`, which is what keeps a multi-move puzzle from being
    scored on its first move by a client that only ever sends one -- the
    classic UI does exactly that. Under-reporting a result is recoverable;
    crediting a solve nobody finished is not.
    """
    conn.execute(
        """UPDATE puzzles SET attempts = attempts + 1, solved = MAX(solved, ?),
                              last_seen_at = datetime('now')
           WHERE id = ?""",
        (1 if (correct and done) else 0, puzzle_id),
    )
    if not done:
        return None
    # A revealed answer isn't one you found, so it isn't rated either --
    # otherwise "show me, then play it" would be free rating.
    if row["revealed"]:
        return None
    current = conn.execute(
        "SELECT rating, rating_rd FROM puzzles WHERE id = ?", (puzzle_id,)
    ).fetchone()
    return puzzle_ratings.record(
        conn, user_id, source="own", puzzle_key=f"own:{puzzle_id}",
        solved=correct, puzzle_rating=current["rating"],
        puzzle_rd=float(current["rating_rd"] or OWN_PUZZLE_RD), themes=themes,
    )


@router.post("/{puzzle_id}/attempt")
async def attempt(puzzle_id: int, body: AttemptIn, user: dict = Depends(require_user)):
    """Grades a line against one of your own games.

    Two rules, and they are different on purpose.

    **The first move is graded by evaluation.** Anything within a small
    win-probability margin of the engine's best counts, because several moves
    are often equally good and failing someone for finding the other winning
    rook teaches nothing. This is what an own-game puzzle has always done and
    it is the thing that makes them fair.

    **The rest of the line is graded against the line.** Once you are inside a
    combination, accepting a different-but-equal move would mean re-deriving
    the whole continuation from wherever you went -- several searches, in the
    middle of a click. Lichess has the same rule for the same reason. An
    equally good *first* move is instead accepted and ends the puzzle there:
    you found an answer, it just isn't the one whose continuation is stored.
    """
    row = _load(user["id"], puzzle_id)
    played = body.line()
    if not played:
        raise HTTPException(400, "no move given")

    solution = await _ensure_line(user["id"], row)
    line = solution["line"]
    if not line:
        raise HTTPException(503, "the engine couldn't work this position out")
    expected_all = line[0::2]
    if len(played) > len(expected_all):
        raise HTTPException(400, "that's more moves than the puzzle has")

    with db_cursor() as conn:
        themes = _own_themes(conn, puzzle_id)
    best_uci, best_cp = line[0], solution["best_cp"]
    best_san = _san(row["fen"], best_uci)

    board = chess.Board(row["fen"])
    for index, uci in enumerate(played):
        fen_here = board.fen()
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            raise HTTPException(400, "not a move")
        if move not in board.legal_moves:
            raise HTTPException(400, "not a legal move in this position")
        expected = expected_all[index]

        if uci != expected:
            # Off the line. On the first move that may still be a right
            # answer; after it, it is not.
            if index == 0:
                result = await _evaluate(user["id"], row["fen"], uci)
                given_up = max(0.0, win_prob(best_cp) - win_prob(result["attempt_cp"]))
                if given_up <= ACCEPT_WP_MARGIN:
                    with db_cursor() as conn:
                        rating = _record_own_attempt(
                            conn, user["id"], puzzle_id, row,
                            correct=True, done=True, themes=themes)
                        counts = _own_stats(conn, user["id"])
                        progress = puzzle_ratings.summary(conn, user["id"])
                    return {
                        "correct": True, "done": True, "equal_move": True,
                        "attempt": {"uci": uci, "san": board.san(move),
                                    "cp": result["attempt_cp"]},
                        "best": {"uci": best_uci, "san": best_san, "cp": best_cp},
                        "line": _line_detail(row["fen"], line),
                        "played": {"uci": row["played_uci"], "san": row["played_san"]},
                        "themes": themes, "rating": rating, "progress": progress,
                        **counts,
                    }
                wrong_cp, wrong_given_up = result["attempt_cp"], given_up
            else:
                wrong_cp, wrong_given_up = None, None

            with db_cursor() as conn:
                rating = _record_own_attempt(
                    conn, user["id"], puzzle_id, row,
                    correct=False, done=True, themes=themes)
                counts = _own_stats(conn, user["id"])
                progress = puzzle_ratings.summary(conn, user["id"])
            return {
                "correct": False, "done": True,
                "attempt": {"uci": uci, "san": _san(fen_here, uci), "cp": wrong_cp},
                "expected": {"uci": expected, "san": _san(fen_here, expected)},
                "best": {"uci": best_uci, "san": best_san, "cp": best_cp},
                "given_up": None if wrong_given_up is None else round(wrong_given_up, 4),
                "same_as_played": index == 0 and uci == row["played_uci"],
                "played": {"uci": row["played_uci"], "san": row["played_san"]},
                "moves_played": index,
                "themes": themes, "rating": rating, "progress": progress,
                **counts,
            }

        board.push(move)
        # Their reply, pushed on every move of the prefix rather than only the
        # newest: the client re-sends the whole line, and skipping the
        # intermediate replies would leave this board a move behind.
        reply_index = 2 * index + 1
        if reply_index < len(line):
            reply = chess.Move.from_uci(line[reply_index])
            reply_san = board.san(reply)
            board.push(reply)
            if index == len(played) - 1:
                with db_cursor() as conn:
                    _record_own_attempt(conn, user["id"], puzzle_id, row,
                                        correct=True, done=False, themes=themes)
                return {
                    "correct": True, "done": False,
                    "attempt": {"uci": uci, "san": _san(fen_here, uci)},
                    "reply": {"uci": line[reply_index], "san": reply_san},
                    "fen": board.fen(),
                    "moves_played": index + 1,
                    "moves_required": len(expected_all),
                }

    # Every move matched and the line has run out: solved.
    with db_cursor() as conn:
        rating = _record_own_attempt(
            conn, user["id"], puzzle_id, row, correct=True, done=True, themes=themes)
        counts = _own_stats(conn, user["id"])
        progress = puzzle_ratings.summary(conn, user["id"])
    return {
        "correct": True, "done": True,
        "attempt": {"uci": played[-1], "san": None},
        "best": {"uci": best_uci, "san": best_san, "cp": best_cp},
        "line": _line_detail(row["fen"], line),
        # Revealed now rather than up front: knowing the move you played turns
        # "find the move" into "find the other move".
        "played": {"uci": row["played_uci"], "san": row["played_san"]},
        "moves_played": len(played),
        "themes": themes, "rating": rating, "progress": progress,
        **counts,
    }


def _line_detail(fen: str, line: list[str]) -> list[dict]:
    """The answer spelled out in SAN, marked with whose move each one is."""
    board = chess.Board(fen)
    out = []
    for index, uci in enumerate(line):
        move = chess.Move.from_uci(uci)
        out.append({"uci": uci, "san": board.san(move), "yours": index % 2 == 0})
        board.push(move)
    return out


class LichessAttemptIn(BaseModel):
    """Every move the solver has played so far, this one last.

    The whole prefix rather than just the newest move, so the server can
    validate the entire line without holding per-solver state. The client
    cannot skip ahead by lying about which move it is on, because each one is
    checked against the recorded line in order.
    """

    moves: list[str]


def _mates(fen: str, uci: str) -> bool:
    board = chess.Board(fen)
    try:
        move = chess.Move.from_uci(uci)
    except ValueError:
        return False
    if move not in board.legal_moves:
        return False
    board.push(move)
    return board.is_checkmate()


@router.post("/lichess/{puzzle_id}/attempt")
def attempt_lichess(puzzle_id: str, body: LichessAttemptIn,
                    user: dict = Depends(require_user)):
    """Grades a move against a Lichess puzzle's recorded line.

    No engine: the line *is* the answer, measured against millions of solvers,
    and second-guessing it with a local search would be both slower and worse.

    The one liberty taken is mate. If the recorded move is mate and yours is
    a different mate, yours counts -- being made to find the specific mate in
    one when you found another is the same "you played the other winning
    rook" complaint the own-game grader already avoids.
    """
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT * FROM lichess_puzzles WHERE puzzle_id = ?", (puzzle_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "no such puzzle")

        line = row["moves"].split()
        played = [m.strip() for m in body.moves if m and m.strip()]
        if not played:
            raise HTTPException(400, "no move given")
        # Your moves are the odd-indexed ones: the line opens with the
        # opponent's setup move and alternates from there.
        expected_all = line[1::2]
        if len(played) > len(expected_all):
            raise HTTPException(400, "that's more moves than the puzzle has")

        board = chess.Board(row["fen"])
        board.push(chess.Move.from_uci(line[0]))

        themes = puzzle_themes.parse(row["themes"])
        key = f"lichess:{puzzle_id}"

        # Replay the prefix, checking each move as it goes.
        for index, uci in enumerate(played):
            expected = expected_all[index]
            fen_here = board.fen()
            # An illegal move is a broken request, not a wrong answer. Grading
            # it would cost the solver rating for something they cannot have
            # done on the board.
            try:
                candidate = chess.Move.from_uci(uci)
            except ValueError:
                raise HTTPException(400, "not a move")
            if candidate not in board.legal_moves:
                raise HTTPException(400, "not a legal move in this position")

            if uci != expected and not (_mates(fen_here, expected) and _mates(fen_here, uci)):
                wrong_san = _san(fen_here, uci)
                result = puzzle_ratings.record(
                    conn, user["id"], source="lichess", puzzle_key=key, solved=False,
                    puzzle_rating=row["rating"],
                    puzzle_rd=float(row["rating_deviation"] or DEFAULT_LICHESS_RD),
                    themes=themes,
                )
                return {
                    "correct": False,
                    "done": True,
                    "solved": False,
                    "attempt": {"uci": uci, "san": wrong_san},
                    "expected": {"uci": expected, "san": _san(fen_here, expected)},
                    "moves_played": index,
                    "themes": themes,
                    "rating": result,
                    "progress": puzzle_ratings.summary(conn, user["id"]),
                }
            board.push(candidate)

            # The opponent's reply. Pushed on *every* move of the prefix, not
            # just the newest one: the client re-sends the whole line each
            # time, and skipping the intermediate replies would leave this
            # board a move behind and reject the solver's next correct move
            # as illegal.
            reply_index = 2 * (index + 1)
            if reply_index < len(line):
                reply_uci = line[reply_index]
                reply_move = chess.Move.from_uci(reply_uci)
                reply_san = board.san(reply_move)
                board.push(reply_move)
                if index == len(played) - 1:
                    return {
                        "correct": True,
                        "done": False,
                        "solved": False,
                        "attempt": {"uci": uci, "san": _san(fen_here, uci)},
                        "reply": {"uci": reply_uci, "san": reply_san},
                        "fen": board.fen(),
                        "moves_played": index + 1,
                        "moves_required": len(expected_all),
                    }

        # Every move matched and there was no reply left: solved.
        result = puzzle_ratings.record(
            conn, user["id"], source="lichess", puzzle_key=key, solved=True,
            puzzle_rating=row["rating"],
            puzzle_rd=float(row["rating_deviation"] or DEFAULT_LICHESS_RD),
            themes=themes,
        )
        return {
            "correct": True,
            "done": True,
            "solved": True,
            "moves_played": len(played),
            "themes": themes,
            "game_url": row["game_url"],
            "rating": result,
            "progress": puzzle_ratings.summary(conn, user["id"]),
        }


@router.post("/lichess/{puzzle_id}/reveal")
def reveal_lichess(puzzle_id: str, user: dict = Depends(require_user)):
    """Gives up on a Lichess puzzle and shows the line.

    Counts as a failure, once, and only if you hadn't already attempted it.
    Giving up is a result; letting it be free would make the rating a measure
    of patience.
    """
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT * FROM lichess_puzzles WHERE puzzle_id = ?", (puzzle_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "no such puzzle")

        line = row["moves"].split()
        board = chess.Board(row["fen"])
        board.push(chess.Move.from_uci(line[0]))
        moves = []
        for uci in line[1:]:
            move = chess.Move.from_uci(uci)
            moves.append({"uci": uci, "san": board.san(move),
                          "yours": len(moves) % 2 == 0})
            board.push(move)

        themes = puzzle_themes.parse(row["themes"])
        result = puzzle_ratings.record(
            conn, user["id"], source="lichess", puzzle_key=f"lichess:{puzzle_id}",
            solved=False, puzzle_rating=row["rating"],
            puzzle_rd=float(row["rating_deviation"] or DEFAULT_LICHESS_RD),
            themes=themes,
        )
        return {
            "line": moves,
            "themes": themes,
            "game_url": row["game_url"],
            "rating": result,
            "progress": puzzle_ratings.summary(conn, user["id"]),
        }


@router.post("/{puzzle_id}/reveal")
async def reveal(puzzle_id: int, user: dict = Depends(require_user)):
    """Gives up on a puzzle from your games. It stays unsolved -- a revealed
    answer isn't one you found, and it should come round again.

    It also counts as a miss against your rating, once, exactly as giving up
    on a Lichess puzzle does. Anything else makes 'Show me' the cheapest way
    to avoid a result, and the two sources have to agree about that or the
    single rating spanning them means nothing.
    """
    row = _load(user["id"], puzzle_id)
    # Working the answer out is also what tags the puzzle and gives it an
    # estimated difficulty, so this has to happen before the rating is read.
    solution = await _ensure_line(user["id"], row)
    line = solution["line"]
    best_uci = line[0] if line else None
    best_san = _san(row["fen"], best_uci)
    best_cp = solution["best_cp"]
    with db_cursor() as conn:
        conn.execute(
            "UPDATE puzzles SET revealed = 1, last_seen_at = datetime('now') WHERE id = ?",
            (puzzle_id,),
        )
        themes = _own_themes(conn, puzzle_id)
        current = conn.execute(
            "SELECT rating, rating_rd FROM puzzles WHERE id = ?", (puzzle_id,)
        ).fetchone()
        rating = puzzle_ratings.record(
            conn, user["id"], source="own", puzzle_key=f"own:{puzzle_id}",
            solved=False, puzzle_rating=current["rating"],
            puzzle_rd=float(current["rating_rd"] or OWN_PUZZLE_RD), themes=themes,
        )
        counts = _own_stats(conn, user["id"])
        progress = puzzle_ratings.summary(conn, user["id"])
    return {
        "best": {"uci": best_uci, "san": best_san, "cp": best_cp,
                 "win_prob": win_prob(best_cp) if best_cp is not None else None},
        # The whole answer, not just its first move: a two-move idea shown as
        # one move is the reveal failing to explain the thing it gave away.
        "line": _line_detail(row["fen"], line),
        "moves_required": solution["moves_required"],
        "played": {"uci": row["played_uci"], "san": row["played_san"]},
        "themes": themes,
        "rating": rating,
        "progress": progress,
        **counts,
    }


@router.post("/{puzzle_id}/difficulty")
async def difficulty(puzzle_id: int, user: dict = Depends(require_user)):
    """Measure this puzzle's difficulty with Maia and store it.

    Deliberately its own call rather than part of solving one. The
    measurement is a sweep -- Maia at every Elo on the grid, over every
    position in the line -- and putting it in the path of a click would mean
    waiting seconds for a verdict on a move you already played. The browser
    asks for it *after* a puzzle is over, so the number is there for the next
    person to meet it. See `app/puzzle_difficulty.py`.
    """
    row = _load(user["id"], puzzle_id)
    if not row["solution_line"]:
        raise HTTPException(409, "the answer hasn't been worked out yet")
    if row["rating_source"] == "maia":
        return {"elo": row["maia_elo"], "rd": row["maia_rd"], "rating": row["rating"],
                "cached": True}
    result = await _rate_with_maia(user["id"], puzzle_id, row["fen"],
                                   row["solution_line"].split())
    return {**result, "cached": False}


@router.post("/reset")
def reset(user: dict = Depends(require_user)):
    """Clears your record against your own puzzles, keeping the puzzles (and
    the engine answers already worked out) so a second pass costs nothing.
    Your rating is left alone -- see /rating/reset."""
    with db_cursor() as conn:
        conn.execute(
            "UPDATE puzzles SET attempts = 0, solved = 0, revealed = 0 WHERE user_id = ?",
            (user["id"],),
        )
        return _own_stats(conn, user["id"])


@router.post("/rating/reset")
def reset_rating(user: dict = Depends(require_user)):
    """Starts the rating over, and forgets which Lichess puzzles you've seen.

    Both together on purpose: a rating reset that kept the seen list would
    leave you re-rating from 1500 against only the puzzles you hadn't got to.
    """
    with db_cursor() as conn:
        puzzle_ratings.reset(conn, user["id"])
        return puzzle_ratings.summary(conn, user["id"])


# ---------------------------------------------------------------------------
# Importing the Lichess database
# ---------------------------------------------------------------------------


class ImportIn(BaseModel):
    min_rating: int | None = None
    max_rating: int | None = None
    themes: list[str] = []
    max_puzzles: int | None = None
    # A path to an already-downloaded lichess_db_puzzle.csv.zst, for anyone
    # who would rather not pull several hundred megabytes through the app.
    source_path: str | None = None
    # Clear what's there first. Off by default: a second import with a wider
    # band should add to the set, not replace it.
    replace: bool = False


@router.get("/lichess/status")
def lichess_status(user: dict = Depends(require_user)):
    with db_cursor() as conn:
        return lichess_puzzles.import_status(conn)


@router.post("/lichess/import")
def lichess_import(body: ImportIn, user: dict = Depends(require_user)):
    """Starts importing the Lichess puzzle database, and returns immediately.

    Deliberately *not* run inside the request. A full import is minutes of
    work behind a few hundred megabytes of download, and the first version of
    this held the HTTP request open for all of it -- so the browser gave up
    and reported "Failed to fetch" on an import that was running perfectly
    well, and the progress poll it was supposed to be feeding couldn't be
    answered either, because the same request had the event loop.

    Now it hands the work to a thread and the browser polls /lichess/status.
    """
    filters = lichess_puzzles.ImportFilters(
        min_rating=body.min_rating,
        max_rating=body.max_rating,
        themes=body.themes or [],
        max_puzzles=body.max_puzzles,
    )
    try:
        return lichess_puzzles.start(
            filters, source_path=body.source_path, replace=body.replace
        )
    except lichess_puzzles.PuzzleImportError as e:
        raise HTTPException(400, str(e))


@router.post("/lichess/cancel")
def lichess_cancel(user: dict = Depends(require_user)):
    """Stops a running import at the next batch. What it already wrote stays."""
    return {"stopping": lichess_puzzles.cancel_running()}
