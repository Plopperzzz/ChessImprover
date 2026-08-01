"""The estimated Elo the Games list carries for every row, over the real app.

D4 moved the sweep's estimate out of the open game and onto every row of the
library, so a list of a hundred games shows a hundred numbers rather than one.
That is a join the browser cannot do for itself -- which side of a game was
yours lives on the game, and the estimate lives in whichever `run_games` row
last swept it -- so the whole thing is decided here, and every wrong answer is
still a plausible four-digit number.

Run it with `python backend/sims/library_estimates_check.py`.

What matters most here, in order:

* **Whose estimate it is.** `results_json` holds both sides. Showing white's
  number on a game you played as black is the failure that looks most like
  success: it is the right shape, the right magnitude, and someone else's.
* **Which sweep it comes from.** A game can be swept more than once, and a
  bare sweep must not displace the full analysis the open game reads from --
  the row in the list and the panel in the game have to say the same thing.
* **Absence is a value.** A game nobody has swept reports null rather than
  being left out, because the list draws a placeholder for it; the endpoint
  can't quietly omit the key.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="library-estimates-check-")
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


def add_game(user_id: int, *, your_color: str, speed: str = "blitz") -> int:
    with db_cursor() as conn:
        upload = conn.execute(
            "INSERT INTO uploads (user_id, source_name, raw_text) VALUES (?, 'check.pgn', ?)",
            (user_id, PGN),
        ).lastrowid
        return conn.execute(
            """INSERT INTO games (user_id, upload_id, batch_index, source_name,
                                  game_index_in_source, white, black, result, date_header,
                                  year, month, your_color, pgn_text, headers_json, speed)
               VALUES (?, ?, 0, 'check.pgn', 0, 'Checker', 'Other', '1-0', '2026.05.01',
                       2026, 5, ?, ?, '{}', ?)""",
            (user_id, upload, your_color, PGN, speed),
        ).lastrowid


def add_sweep(user_id: int, game_id: int, mode: str, results: dict | None,
              *, age_seconds: int = 0) -> int:
    """One `run_games` row. `age_seconds` backdates it, so precedence between
    two rows for the same game can be set up deliberately rather than depending
    on how fast this script runs."""
    with db_cursor() as conn:
        run = conn.execute(
            "SELECT id FROM analysis_runs WHERE user_id = ? ORDER BY id LIMIT 1", (user_id,)
        ).fetchone()
        run_id = run["id"] if run else conn.execute(
            "INSERT INTO analysis_runs (user_id, name, is_default) VALUES (?, 'Check', 1)",
            (user_id,),
        ).lastrowid
        return conn.execute(
            """INSERT INTO run_games (run_id, user_id, game_id, mode, results_json, analyzed_at)
               VALUES (?, ?, ?, ?, ?, datetime('now', ?))""",
            (run_id, user_id, game_id, mode,
             json.dumps(results) if results is not None else None,
             f"-{age_seconds} seconds"),
        ).lastrowid


def estimate(rows: list[dict], game_id: int):
    row = next(r for r in rows if r["id"] == game_id)
    return row["estimated_elo"]


def sides(white: float | int | None, black: float | int | None) -> dict:
    return {
        "w": {"estimate": white, "confidence": "medium", "reasons": []},
        "b": {"estimate": black, "confidence": "medium", "reasons": []},
    }


def main():
    init_db()
    client = TestClient(app)

    client.post("/api/auth/accounts", json={"username": "checker", "display_name": "Checker"})
    assert client.post("/api/auth/login", json={"username": "checker"}).status_code == 200
    user_id = client.get("/api/auth/me").json()["id"]

    never_swept = add_game(user_id, your_color="w")
    as_white = add_game(user_id, your_color="w")
    as_black = add_game(user_id, your_color="b")
    unassigned = add_game(user_id, your_color="unassigned")
    reswept = add_game(user_id, your_color="w")
    half_fitted = add_game(user_id, your_color="b")

    add_sweep(user_id, as_white, "full", sides(1450, 1310))
    add_sweep(user_id, as_black, "full", sides(1450, 1310))
    add_sweep(user_id, unassigned, "full", sides(1450, 1310))
    # A fit that produced no number for your side, which is not the same thing
    # as never having been swept -- but reads the same in the list.
    add_sweep(user_id, half_fitted, "full", sides(1450, None))
    # The full analysis is older than the bare sweep run over it afterwards.
    add_sweep(user_id, reswept, "full", sides(1600, 1200), age_seconds=60)
    add_sweep(user_id, reswept, "sweep", sides(900, 1200))
    # A quick run has no estimate at all and must not shadow anything.
    add_sweep(user_id, as_white, "quick", None)

    rows = client.get("/api/games").json()

    print("A game nobody has swept:")
    check("the key is present", "estimated_elo" in rows[0], str(sorted(rows[0])[:4]))
    check("and is null", estimate(rows, never_swept) is None,
          repr(estimate(rows, never_swept)))

    print("\nWhose estimate is shown:")
    check("your side when you were white", estimate(rows, as_white) == 1450,
          repr(estimate(rows, as_white)))
    check("your side when you were black", estimate(rows, as_black) == 1310,
          repr(estimate(rows, as_black)))
    check("nobody's when the game isn't assigned a side",
          estimate(rows, unassigned) is None, repr(estimate(rows, unassigned)))
    check("null when the fit produced no number for your side",
          estimate(rows, half_fitted) is None, repr(estimate(rows, half_fitted)))

    print("\nWhich sweep it comes from:")
    check("a full analysis outranks a later bare sweep",
          estimate(rows, reswept) == 1600, repr(estimate(rows, reswept)))
    saved = client.get(f"/api/analysis/saved/{reswept}").json()
    check("which is the number the open game shows too",
          saved["results"]["w"]["estimate"] == estimate(rows, reswept),
          f"{saved['results']['w']['estimate']} vs {estimate(rows, reswept)}")

    print("\nThe filtered list carries it as well:")
    filtered = client.get("/api/games?speed=blitz").json()
    check("same games", len(filtered) == len(rows), f"{len(filtered)} vs {len(rows)}")
    check("same estimates", estimate(filtered, as_black) == 1310,
          repr(estimate(filtered, as_black)))

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
