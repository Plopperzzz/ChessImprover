"""Driving /api/move-quality over a real database, through the real app.

Uses FastAPI's TestClient against a temporary SQLite file with hand-written
analysis rows, so what is exercised is the actual routing and the actual SQL.
No engine runs -- the endpoint is a GROUP BY over rows an analysis wrote, which
is exactly what makes it checkable on a machine with no Stockfish on it.

Run it with `python backend/sims/move_quality_check.py`.

What matters most here, in order:

* **Whose moves are counted.** `analysis_moves` stores no side, so "your moves"
  is a parity test against `games.your_color`. Getting it wrong would count
  your opponent's blunders as yours, which is worse than not showing the number
  at all -- and it fails silently, because both counts look plausible.
* **One analysis per game.** A game analysed twice, or appended into a second
  run, must not have its moves counted twice. This is the same rule
  `strength.collect` follows, and the two have to agree or the pie describes a
  different set of games than the estimate beside it.
* **The library filter.** Spelled as the Games list spells it, so a filtered
  count and a filtered estimate cover the same games.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="move-quality-check-")
os.environ["CHESSIMPROVER_DB"] = os.path.join(SCRATCH, "check.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import db_cursor, init_db  # noqa: E402
from app.main import app  # noqa: E402

failures = []


def check(label: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}{(': ' + detail) if detail else ''}")


PGN = '[Event "Check"]\n[White "Checker"]\n[Black "Other"]\n\n1. e4 e5 *'


def add_game(user_id: int, *, your_color: str, speed: str = "blitz",
             time_control: str = "300") -> int:
    with db_cursor() as conn:
        upload = conn.execute(
            "INSERT INTO uploads (user_id, source_name, raw_text) VALUES (?, 'check.pgn', ?)",
            (user_id, PGN),
        ).lastrowid
        return conn.execute(
            """INSERT INTO games (user_id, upload_id, batch_index, source_name,
                                  game_index_in_source, white, black, result, date_header,
                                  year, month, your_color, pgn_text, headers_json,
                                  speed, time_control)
               VALUES (?, ?, 0, 'check.pgn', 0, 'Checker', 'Other', '1-0', '2026.05.01',
                       2026, 5, ?, ?, '{}', ?, ?)""",
            (user_id, upload, your_color, PGN, speed, time_control),
        ).lastrowid


def add_analysis(user_id: int, game_id: int, mode: str,
                 white_moves: list[str], black_moves: list[str]) -> int:
    """One analysis, with the two sides' classifications given separately.

    White plays the odd plies, so the two lists are interleaved on the way in --
    the same arrangement the endpoint has to undo.
    """
    with db_cursor() as conn:
        run = conn.execute(
            "SELECT id FROM analysis_runs WHERE user_id = ? ORDER BY id LIMIT 1", (user_id,)
        ).fetchone()
        run_id = run["id"] if run else conn.execute(
            "INSERT INTO analysis_runs (user_id, name, is_default) VALUES (?, 'Check', 1)",
            (user_id,),
        ).lastrowid
        run_game = conn.execute(
            """INSERT INTO run_games (run_id, user_id, game_id, mode, grid_json, analyzed_at)
               VALUES (?, ?, ?, ?, ?, datetime('now', ?))""",
            (run_id, user_id, game_id, mode, json.dumps([1100, 1500]),
             f"+{game_id} seconds"),
        ).lastrowid
        rows = []
        for i, label in enumerate(white_moves):
            rows.append((run_game, 1 + 2 * i, label))
        for i, label in enumerate(black_moves):
            rows.append((run_game, 2 + 2 * i, label))
        conn.executemany(
            """INSERT INTO analysis_moves (run_game_id, ply, san, classification)
               VALUES (?, ?, 'e4', ?)""",
            rows,
        )
        return run_game


def main():
    init_db()
    client = TestClient(app)

    print("Everything is behind a login:")
    check("401 without a session", client.get("/api/move-quality").status_code == 401)

    client.post("/api/auth/accounts", json={"username": "checker", "display_name": "Checker"})
    assert client.post("/api/auth/login", json={"username": "checker"}).status_code == 200
    user_id = client.get("/api/auth/me").json()["id"]

    print("\nAn empty library:")
    empty = client.get("/api/move-quality").json()
    check("counts every classification as zero", set(empty["counts"].values()) == {0},
          str(empty["counts"]))
    check("no games", empty["games"] == 0)
    check("no moves", empty["moves"] == 0)

    print("\nYour moves, not your opponent's:")
    # You are white here, so the blunders on the even plies are the opponent's.
    white_game = add_game(user_id, your_color="w")
    add_analysis(user_id, white_game, "full",
                 white_moves=["best", "best", "brilliant", "inaccuracy"],
                 black_moves=["blunder", "blunder", "blunder", "mistake"])
    counts = client.get("/api/move-quality").json()
    check("counts your side", counts["counts"]["best"] == 2, str(counts["counts"]))
    check("finds the brilliant", counts["counts"]["brilliant"] == 1)
    check("ignores the opponent's blunders", counts["counts"]["blunder"] == 0,
          str(counts["counts"]["blunder"]))
    check("totals your moves only", counts["moves"] == 4, str(counts["moves"]))

    # And the mirror image: as black, the same parity has to select the *even*
    # plies. A test with only one colour in it passes with the test inverted.
    black_game = add_game(user_id, your_color="b")
    add_analysis(user_id, black_game, "full",
                 white_moves=["blunder", "blunder"],
                 black_moves=["great", "good"])
    counts = client.get("/api/move-quality").json()
    check("counts black's moves when you were black", counts["counts"]["great"] == 1,
          str(counts["counts"]))
    check("still no opponent blunders", counts["counts"]["blunder"] == 0,
          str(counts["counts"]["blunder"]))
    check("two games", counts["games"] == 2, str(counts["games"]))

    print("\nA game analysed twice is counted once:")
    add_analysis(user_id, white_game, "quick",
                 white_moves=["blunder", "blunder", "blunder", "blunder"],
                 black_moves=["good", "good", "good", "good"])
    counts = client.get("/api/move-quality").json()
    check("the full run wins over the quick one", counts["counts"]["best"] == 2,
          str(counts["counts"]))
    check("the quick run's moves are not added", counts["moves"] == 6, str(counts["moves"]))
    check("still two games", counts["games"] == 2, str(counts["games"]))

    print("\nQuick-only games are flagged, because they can't produce Brilliant:")
    quick_game = add_game(user_id, your_color="w")
    add_analysis(user_id, quick_game, "quick",
                 white_moves=["good", "mistake"], black_moves=["good", "good"])
    counts = client.get("/api/move-quality").json()
    check("counted like any other game", counts["counts"]["mistake"] == 1,
          str(counts["counts"]))
    check("and reported as quick-only", counts["games_quick_only"] == 1,
          str(counts["games_quick_only"]))
    check("swept games counted separately", counts["games_swept"] == 2,
          str(counts["games_swept"]))

    print("\nA game with no side assigned is skipped, and said so:")
    orphan = add_game(user_id, your_color="unassigned")
    add_analysis(user_id, orphan, "full", white_moves=["blunder"], black_moves=["blunder"])
    counts = client.get("/api/move-quality").json()
    check("not counted", counts["counts"]["blunder"] == 0, str(counts["counts"]["blunder"]))
    check("reported", counts["skipped"]["unassigned_color"] == 1, str(counts["skipped"]))

    print("\nThe library filter is the Games list's:")
    rapid_game = add_game(user_id, your_color="w", speed="rapid", time_control="600")
    add_analysis(user_id, rapid_game, "full",
                 white_moves=["miss", "miss"], black_moves=["good", "good"])
    rapid = client.get("/api/move-quality?speed=rapid").json()
    check("narrows to the speed", rapid["counts"]["miss"] == 2, str(rapid["counts"]))
    check("and to its games", rapid["games"] == 1, str(rapid["games"]))
    check("echoes what it filtered by", rapid["library_filter"]["speed"] == "rapid",
          str(rapid["library_filter"]))
    blitz = client.get("/api/move-quality?speed=blitz").json()
    check("the other slice excludes it", blitz["counts"]["miss"] == 0, str(blitz["counts"]))
    check("a bad speed is a 400, not an empty count",
          client.get("/api/move-quality?speed=nonsense").status_code == 400)

    print("\nThe same slice the pooled estimate uses:")
    strength = client.get("/api/strength?speed=rapid").json()
    check("both report the same filter",
          strength["library_filter"] == rapid["library_filter"],
          f"{strength['library_filter']} vs {rapid['library_filter']}")


if __name__ == "__main__":
    try:
        main()
    finally:
        import shutil

        shutil.rmtree(SCRATCH, ignore_errors=True)
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for line in failures:
            print("  - " + line)
        sys.exit(1)
    print("all checks passed")
