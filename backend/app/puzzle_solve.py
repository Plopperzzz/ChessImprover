"""Working out a puzzle's whole answer, not just its first move.

A puzzle built from your own games used to be one move deep: the position you
faced, and the single move Stockfish likes best. That is the right answer to
"what should I have played" and the wrong shape for a puzzle, because plenty of
the ideas in your own games are two or three moves long -- the sacrifice is
move one and the point of it is move three. Stopping at move one asks you to
guess a move whose justification you are never shown, and grades you on it.

So the answer is a *line*: your move, their best reply, your move, and so on,
in the same shape a Lichess row carries (`app/lichess_puzzles.py`), which means
one grader walks either source.

Two questions decide how long the line is, and they are different questions:

* **Is this a puzzle at all?** Answered once, at the starting position, by how
  much better the best move is than the second best (`unique_margin`). When
  three moves are equally fine there is nothing to find, and the position is a
  bad puzzle however good the move is. Recorded rather than acted on here --
  the picker is what decides to prefer the sharp ones, because "your own
  mistakes" is a set you cannot afford to throw much away from.
* **Is the puzzle over?** Answered before every *later* move of the line, by
  the same margin. The line continues only while your next move is again the
  only good one. The moment several moves hold the advantage, the idea has
  landed and there is nothing further to find -- carrying on would be asking
  you to guess which of four winning moves the engine happened to prefer,
  which is the single most annoying thing a puzzle can do.

The line always ends on one of *your* moves. Ending on the opponent's would
leave the solver having played the last move they were asked for and still
looking at a board that wants something.
"""

import chess

from .classify import eval_to_cp
from .engine_manager import evaluate_position

# How many of your own moves a puzzle may ask for. Four is Lichess's
# `veryLong`, and past it the line stops being a puzzle and becomes an
# analysis: nobody calculates a fifth-move-deep continuation off a blunder in
# their own blitz game.
MAX_SOLVER_MOVES = 4

# How much better the next move has to be than the alternative for the line to
# continue, in centipawns.
#
# **In centipawns and not in win probability**, which is the whole reason
# puzzles used to stop after one move. Win probability saturates: at +900 it is
# 0.96 and at +700 it is 0.93, so in a position you are already winning the
# best move is *never* more than a few percent better than the second best,
# however forced it is. Measured that way, every line ended the moment it
# started working -- which is precisely when the interesting part of a
# combination begins.
#
# 200 is a piece-ish. The alternative has to be losing something real, not
# merely be second.
ONLY_MOVE_CP = 200

# A mate score, near enough. Stockfish reports mate as +-MATE_CP through
# `eval_to_cp`, and "this move mates and that one doesn't" is an only-move
# whatever the second move's number is.
MATE_ISH = 9000


async def _search(engine, fen: str, limit_type: str, limit_value: int, multipv: int):
    info = await evaluate_position(engine, fen, limit_type, limit_value, multipv=multipv)
    lines = info.get("lines") or [info]
    best_uci = (info.get("pv") or [None])[0]
    return info, lines, best_uci


def only_move(lines: list[dict]) -> bool:
    """Whether the best move is the *only* move worth playing here.

    True when the engine reported one line at MultiPV 2, which means there is
    one legal move: forced, and as unique as a move can be. Recaptures and
    moving out of check are most of what that catches, and a line that stopped
    short of the recapture would end on a position reading as unresolved.
    """
    if len(lines) < 2:
        return True
    best = eval_to_cp(lines[0])
    second = eval_to_cp(lines[1])
    if best >= MATE_ISH and second < MATE_ISH:
        return True
    return (best - second) >= ONLY_MOVE_CP


def move_gap(lines: list[dict]) -> float | None:
    """How much better the best move is than the second, in centipawns, or
    None when there was no second move to compare with.

    Stored per puzzle as `unique_margin`: it is what says whether a position
    is a puzzle at all, as against a position where four moves are fine and
    one of them happens to be the engine's favourite.
    """
    if len(lines) < 2:
        return None
    return max(0.0, min(eval_to_cp(lines[0]) - eval_to_cp(lines[1]), float(MATE_ISH)))


async def solve_line(engine, fen: str, limit_type: str, limit_value: int, *,
                     max_solver_moves: int = MAX_SOLVER_MOVES) -> dict:
    """The answer to a position, as far as it is worth asking for.

    Returns the line in UCI (yours first, alternating), how many moves of it
    are yours, the evaluation at the end from *your* side of the board, and
    how unique the first move was.

    Runs on an engine the caller has already opened and leased; it makes
    roughly two searches per move of the line, which is why it happens once
    per puzzle and is then stored.
    """
    board = chess.Board(fen)
    solver = board.turn
    line: list[str] = []
    unique_margin: float | None = None
    line_cp: float | None = None
    best_cp: float | None = None

    for step in range(max_solver_moves):
        info, lines, best_uci = await _search(engine, board.fen(), limit_type, limit_value, 2)
        if step == 0:
            # What the position is worth when played correctly, from your side.
            # This is the number an attempt is graded against, so it is the one
            # thing here that has to be the *starting* position's evaluation.
            best_cp = eval_to_cp(info)
        if not best_uci:
            break
        try:
            move = chess.Move.from_uci(best_uci)
        except ValueError:
            break
        if move not in board.legal_moves:
            break

        if step == 0:
            unique_margin = move_gap(lines)
        elif not only_move(lines):
            # Several moves hold it now: the idea has landed, and the puzzle
            # ends on the previous move rather than asking you to guess which
            # of four winning moves the engine happened to prefer.
            break

        line.append(best_uci)
        board.push(move)
        # Mover-relative, and the mover was you -- so this is already from
        # your side of the board.
        line_cp = eval_to_cp(info)

        if board.is_game_over():
            break

        reply_info, _, reply_uci = await _search(engine, board.fen(), limit_type, limit_value, 1)
        if not reply_uci:
            break
        try:
            reply = chess.Move.from_uci(reply_uci)
        except ValueError:
            break
        if reply not in board.legal_moves:
            break
        line.append(reply_uci)
        board.push(reply)
        # Scored for them, who were to move; flip it back to your perspective
        # so `line_cp` means one thing all the way down.
        line_cp = -eval_to_cp(reply_info)
        if board.is_game_over():
            break

    # A line must end on one of yours. It ends on theirs whenever the loop
    # stopped after pushing a reply -- the margin check on the next move, or
    # the move cap -- and that trailing move is not part of the answer.
    if len(line) % 2 == 0 and line:
        line.pop()
        line_cp = None

    if not line:
        return {"line": [], "moves_required": 0, "unique_margin": unique_margin,
                "line_cp": None, "mate_in": None, "best_cp": best_cp}

    # Recomputing the end evaluation when the trailing reply was dropped costs
    # nothing: the position after your last move is where the puzzle finishes,
    # and that is the number worth storing.
    end = chess.Board(fen)
    for uci in line:
        end.push(chess.Move.from_uci(uci))
    if line_cp is None:
        info, _, _ = await _search(engine, end.fen(), limit_type, limit_value, 1)
        # It is their move in the final position, so flip it to your side.
        line_cp = -eval_to_cp(info) if not end.is_game_over() else None
    if end.is_checkmate() and end.turn != solver:
        line_cp = None  # mate: a centipawn number for it would be noise

    return {
        "line": line,
        "moves_required": (len(line) + 1) // 2,
        "unique_margin": unique_margin,
        "line_cp": line_cp,
        "mate_in": (len(line) + 1) // 2 if end.is_checkmate() else None,
        "best_cp": best_cp,
    }


def line_positions(fen: str, line: list[str]) -> list[dict]:
    """Every position in the line where it is *your* move, with the move you
    are expected to find there.

    This is what the difficulty measurement asks Maia about, and what a
    multi-move grader checks against.
    """
    board = chess.Board(fen)
    out = []
    for index, uci in enumerate(line):
        move = chess.Move.from_uci(uci)
        if index % 2 == 0:
            out.append({"fen": board.fen(), "uci": uci, "san": board.san(move)})
        board.push(move)
    return out


def replies(fen: str, line: list[str]) -> list[dict]:
    """The opponent's moves in the line, in order, with the position each
    leaves behind. The browser plays these in as they are earned."""
    board = chess.Board(fen)
    out = []
    for index, uci in enumerate(line):
        move = chess.Move.from_uci(uci)
        san = board.san(move)
        board.push(move)
        if index % 2 == 1:
            out.append({"uci": uci, "san": san, "fen": board.fen()})
    return out
