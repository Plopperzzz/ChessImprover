"""Checking the multi-move puzzle machinery: lines, kinds and difficulty.

Three separate things get driven here, because three separate things are easy
to get quietly wrong.

* **`puzzle_solve.solve_line`** builds a puzzle's whole answer with Stockfish.
  The shape matters as much as the moves: a line has to alternate legally from
  the position it starts in and it has to *end on one of yours*, because a line
  ending on the opponent's move leaves the solver having played everything they
  were asked for and still looking at a board that wants something. Needs an
  engine, and is skipped with a message when there isn't one --
  `STOCKFISH_PATH=/usr/games/stockfish python backend/sims/puzzle_lines_check.py`.

* **`puzzles.classify_kind`** decides whether a position is a tactic or a
  blunder check, off two evaluations stored in opposite perspectives. Getting
  that flip wrong reads every blunder as a brilliancy, and it would not be
  obvious from the UI -- it would just quietly file everything under one kind.

* **`puzzle_difficulty.fit`** turns a P(solve)-against-Elo curve into a
  difficulty. The cases that matter are the ones where it must *refuse*: a flat
  curve and a falling one have measured nothing, and inventing a number from
  them would feed the Glicko-2 rater noise it treats as evidence.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import chess  # noqa: E402

from app import puzzle_difficulty, puzzle_solve  # noqa: E402
from app.puzzle_themes import derive_line_themes  # noqa: E402
from app.puzzles import classify_kind  # noqa: E402

failures = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


# ---------------------------------------------------------------------------
# Which kind of exercise a position is
# ---------------------------------------------------------------------------

print("\nTactic or blunder check:")

# cp_before is yours; cp_after is scored for the opponent, who is to move in
# the position your move left behind. +600 for them is -600 for you.
check("a level position thrown away is a blunder check",
      classify_kind(20.0, 600.0) == "blunder_check")
check("a winning position kept is a tactic",
      classify_kind(300.0, -250.0) == "tactic")
check("small slip in a level position is not a blunder check",
      classify_kind(20.0, 60.0) == "tactic")
check("already lost before the move is not a blunder check",
      classify_kind(-500.0, 700.0) == "tactic",
      "you have to have had something to lose")
check("no evaluation means no claim", classify_kind(None, 600.0) == "tactic")


# ---------------------------------------------------------------------------
# Tagging a line rather than a move
# ---------------------------------------------------------------------------

print("\nThemes over a whole line:")

# Philidor's legacy, last two moves: Qg8+!! Rxg8, Nf7#. The point of the puzzle
# is the queen sacrifice on move one and the mate is on move two -- tagging only
# the first move finds a sacrifice and never says what it was for.
SAC_MATE = "5r1k/6pp/7N/8/8/1Q6/8/6K1 w - - 0 1"
themes = derive_line_themes(SAC_MATE, ["b3g8", "f8g8", "h6f7"])
check("a two-move mate is mateIn2, not mateIn1",
      "mateIn2" in themes and "mateIn1" not in themes, " ".join(themes))
check("...and 'short', by the number of moves you play", "short" in themes)
check("...and the mate pattern is found", "smotheredMate" in themes)
check("...and the sacrifice on move one is not lost", "sacrifice" in themes)

one = derive_line_themes(SAC_MATE, ["h6f7"])
check("a one-move line is still oneMove", "oneMove" in one and "mateIn1" not in one,
      " ".join(one))

check("a line that doesn't start legally is refused",
      derive_line_themes(SAC_MATE, ["a1a8"]) == [])


# ---------------------------------------------------------------------------
# Difficulty, from a solve-probability curve
# ---------------------------------------------------------------------------

print("\nFitting a difficulty:")


def curve(centre: float, slope: float = 0.004) -> dict[int, float]:
    """A logistic P(solve) crossing one half at `centre`."""
    import math
    return {elo: 1.0 / (1.0 + math.exp(-slope * (elo - centre)))
            for elo in range(600, 2601, 200)}


for wanted in (900, 1500, 2100):
    got = puzzle_difficulty.fit(curve(wanted))
    close = got["elo"] is not None and abs(got["elo"] - wanted) < 25
    check(f"a curve crossing at {wanted} is measured there", close,
          f"{got['elo']:.0f}" if got["elo"] is not None else str(got["reason"]))

flat = puzzle_difficulty.fit({elo: 0.3 for elo in range(600, 2601, 200)})
check("a flat curve measures nothing", flat["elo"] is None, str(flat["reason"]))

falling = puzzle_difficulty.fit(
    {elo: 0.9 - 0.0003 * (elo - 600) for elo in range(600, 2601, 200)})
check("a falling curve measures nothing", falling["elo"] is None, str(falling["reason"]))

check("two grid points are not a curve",
      puzzle_difficulty.fit({600: 0.1, 2600: 0.9})["elo"] is None)

# A crossing above the top of the grid was never seen, only extrapolated to.
off = puzzle_difficulty.fit(curve(4000))
check("a crossing off the end of the grid is unsure",
      off["elo"] is None or off["rd"] == puzzle_difficulty.OFF_GRID_RD,
      f"rd={off['rd']}")

# Every move has to be found, so a longer line is harder than its first move.
short_p = puzzle_difficulty.solve_probabilities({1500: [0.6]})
long_p = puzzle_difficulty.solve_probabilities({1500: [0.6, 0.6]})
check("a two-move line is harder than its first move alone",
      long_p[1500] < short_p[1500], f"{long_p[1500]:.2f} < {short_p[1500]:.2f}")


# ---------------------------------------------------------------------------
# Building a line with a real engine
# ---------------------------------------------------------------------------

ENGINE = os.environ.get("STOCKFISH_PATH")

# (name, fen, what the line has to show)
LINE_CASES = [
    # A forced mate several moves deep: a generator that stopped at move one
    # would hand over the sacrifice with none of the point.
    ("a forced mate runs to the mate",
     "r5k1/5ppp/8/8/8/8/4R1PP/4R1K1 w - - 0 1", {"min_solver_moves": 2, "mates": True}),
    ("a sacrifice is followed to its point",
     "5r1k/6pp/7N/8/8/1Q6/8/6K1 w - - 0 1", {"min_solver_moves": 2, "mates": True}),
    # Two moves win the queen and nothing is forced afterwards, so the line
    # has to stop rather than wander into "guess the engine's favourite quiet
    # move" -- which is what a puzzle that never ends feels like.
    ("nothing forced afterwards stops the line",
     "4k3/8/8/8/8/8/3q4/3RK3 w - - 0 1", {"max_solver_moves": 1}),
]

if not ENGINE or not os.path.isfile(ENGINE):
    print("\nBuilding lines with an engine: skipped (set STOCKFISH_PATH to run)")
else:
    print("\nBuilding lines with an engine:")

    async def run_cases():
        from app.engine_manager import EngineProcess, read_uci_options

        for name, fen, want in LINE_CASES:
            engine = EngineProcess(ENGINE)
            await engine.start()
            await engine.send_line("uci")
            await read_uci_options(engine)
            await engine.send_line("isready")
            await engine.wait_for("readyok")
            try:
                result = await puzzle_solve.solve_line(engine, fen, "depth", 14)
            finally:
                engine.terminate()
                await engine.wait_closed()

            line = result["line"]
            board = chess.Board(fen)
            legal = True
            for uci in line:
                move = chess.Move.from_uci(uci)
                if move not in board.legal_moves:
                    legal = False
                    break
                board.push(move)

            sans = []
            replay = chess.Board(fen)
            for uci in line:
                move = chess.Move.from_uci(uci)
                sans.append(replay.san(move))
                replay.push(move)
            detail = " ".join(sans) or "(none)"

            check(f"{name}: the line is legal", legal and bool(line), detail)
            check(f"{name}: it ends on one of yours", len(line) % 2 == 1, detail)
            check(f"{name}: moves_required matches the line",
                  result["moves_required"] == (len(line) + 1) // 2)
            if "min_solver_moves" in want:
                check(f"{name}: it is at least {want['min_solver_moves']} moves",
                      result["moves_required"] >= want["min_solver_moves"], detail)
            if "max_solver_moves" in want:
                check(f"{name}: it stops by {want['max_solver_moves']} moves",
                      result["moves_required"] <= want["max_solver_moves"], detail)
            if want.get("mates"):
                check(f"{name}: it ends in mate", board.is_checkmate(), detail)

            # The positions handed to the difficulty measurement are the ones
            # where it is your move, and the move asked for there is the line's.
            positions = puzzle_solve.line_positions(fen, line)
            check(f"{name}: one measured position per move of yours",
                  len(positions) == result["moves_required"])

    asyncio.run(run_cases())


print()
if failures:
    print(f"{len(failures)} check(s) failed:")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)
print("all checks passed")
