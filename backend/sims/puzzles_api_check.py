"""Driving the puzzle endpoints over a real database, through the real app.

Uses FastAPI's TestClient against a temporary SQLite file with a handful of
Lichess puzzles imported, so what is exercised is the actual routing, the
actual SQL and the actual rating arithmetic -- not a mock of any of them.

Run it with `python backend/sims/puzzles_api_check.py`.

Own-game puzzles are only covered as far as they go without an engine
(building them from a stored PGN, tagging their phases, listing them). Grading
one is an engine search, and this is a check that has to run on a machine with
no Stockfish on it.

What matters most here, in order:

* **The multi-move line.** A Lichess puzzle is a sequence, and the server must
  hand back one opponent reply at a time without ever putting the rest of the
  answer in the response. A trainer that ships the solution to the browser is
  not a trainer.
* **The first-attempt rule.** Only your first go at a puzzle moves the rating.
  Without it, retrying a failed puzzle until it works is free rating, and the
  number stops meaning anything.
* **Per-theme ratings.** Solving a `fork` puzzle must move the fork rating and
  not the ones it wasn't tagged with.
"""

import csv
import io
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="puzzles-api-check-")
os.environ["CHESSIMPROVER_DB"] = os.path.join(SCRATCH, "check.db")

import chess  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import lichess_puzzles as lp  # noqa: E402
from app.db import db_cursor, init_db  # noqa: E402
from app.main import app  # noqa: E402

failures = []


def check(label: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}{(': ' + detail) if detail else ''}")


HEADER = ["PuzzleId", "FEN", "Moves", "Rating", "RatingDeviation", "Popularity",
          "NbPlays", "Themes", "GameUrl", "OpeningTags"]

# Real puzzles from the published database, kept verbatim. The four-move one
# is the important case: two moves for the solver with a reply in between.
PUZZLES = [
    ["00sHx", "q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K1R b k - 0 17",
     "e8d7 a2e6 d7d8 f7f8", "1200", "80", "83", "72",
     "mate mateIn2 middlegame short", "https://lichess.org/yyznGmXs/black#34",
     "Italian_Game"],
    ["00sJ9", "r3r1k1/p4ppp/2p2n2/1p6/3P1qb1/2NQR3/PPB2PP1/R1B3K1 w - - 5 18",
     "e3g3 e8e1 g1h2 e1c1 a1c1 f4h6 h2g1 h6c1", "2000", "75", "95", "300",
     "advantage fork long middlegame", "https://lichess.org/gyFeQsOE#35", ""],
    ["00sO1", "1k1r4/pp3pp1/2p1p3/4b3/P3n1P1/8/KPP2PP1/R1B1R3 b - - 2 31",
     "b8c7 e1e4 d8d1 e4e1", "900", "70", "88", "150",
     "advantage endgame short pin", "https://lichess.org/H2iCLRLW#62", ""],
]


_seed_count = 0


def seed_lichess_rows(rows: list) -> None:
    """Imports more puzzles on top of what's already there, under a name of
    its own so it never collides with an earlier seed file still on disk."""
    global _seed_count
    _seed_count += 1
    import zstandard

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(HEADER)
    for row in rows:
        writer.writerow(row)
    path = os.path.join(SCRATCH, f"puzzles-{_seed_count}.csv.zst")
    with open(path, "wb") as handle:
        handle.write(zstandard.ZstdCompressor().compress(buffer.getvalue().encode()))
    lp.run_import(lp.ImportFilters(), source_path=path, replace=False)


def seed_lichess():
    seed_lichess_rows(PUZZLES)


def login(client: TestClient) -> None:
    client.post("/api/auth/accounts",
                json={"username": "checker", "display_name": "Checker"})
    response = client.post("/api/auth/login", json={"username": "checker"})
    assert response.status_code == 200, response.text


def rating_of(client: TestClient, theme: str | None = None):
    progress = client.get("/api/puzzles/stats").json()["progress"]
    if theme is None:
        return progress["overall"]["rating"]
    for entry in progress["themes"]:
        if entry["theme"] == theme:
            return entry["rating"]
    return None


def main():
    init_db()
    seed_lichess()
    client = TestClient(app)
    login(client)

    print("Everything is behind a login:")
    anonymous = TestClient(app)
    check("an anonymous request is refused",
          anonymous.get("/api/puzzles/stats").status_code == 401)

    print("\nThe theme picker:")
    themes = client.get("/api/puzzles/themes?source=lichess").json()
    offered = {t["key"]: t for g in themes["groups"] for t in g["themes"]}
    check("offers themes the imported set actually has", "fork" in offered)
    check("with counts", offered.get("fork", {}).get("count") == 1,
          str(offered.get("fork", {}).get("count")))
    check("hides themes nothing carries", "zugzwang" not in offered)
    check("an unknown source is refused",
          client.get("/api/puzzles/themes?source=nonsense").status_code == 400)
    check("an unknown theme is refused",
          client.get("/api/puzzles/next?source=lichess&themes=notATheme")
          .status_code == 400)

    print("\nServing a puzzle:")
    body = client.get("/api/puzzles/next?source=lichess").json()
    puzzle = body["puzzle"]
    check("comes with the position after the opponent's move",
          puzzle["setup"] is not None and puzzle["fen"] != puzzle["setup"]["fen"])
    check("says whose move it is", puzzle["your_color"] in ("w", "b"))
    check("carries its themes", isinstance(puzzle["themes"], list) and puzzle["themes"])
    check("withholds its rating until the puzzle is over",
          "rating" not in puzzle, str(sorted(puzzle)))
    check("and how many moves it takes",
          "moves_required" not in puzzle, str(sorted(puzzle)))
    leaked = [k for k in puzzle if k == "moves"]
    check("never ships the solution", not leaked, str(leaked))
    check("nor anywhere else in the payload",
          "d7d8" not in str(body) and "e8e1" not in str(body))

    print("\nA hint names the square, not the move:")
    # 00sO1: line is b8c7 (opponent) e1e4 (yours) d8d1 (opponent) e4e1 (yours).
    # Read-only -- this doesn't touch the attempt this puzzle gets below.
    hinted = client.post("/api/puzzles/lichess/00sO1/hint", json={"moves": []}).json()
    check("points at the piece for the first move",
          set(hinted) == {"square"} and hinted["square"] == "e1", str(hinted))
    next_hint = client.post("/api/puzzles/lichess/00sO1/hint",
                            json={"moves": ["e1e4"]}).json()
    check("and advances with the line once a move is confirmed",
          next_hint.get("square") == "e4", str(next_hint))
    exhausted_hint = client.post("/api/puzzles/lichess/00sO1/hint",
                                 json={"moves": ["e1e4", "e4e1"]})
    check("and refuses once there's nothing left to hint",
          exhausted_hint.status_code == 409, str(exhausted_hint.status_code))

    print("\nA theme filter picks the right puzzle:")
    forked = client.get("/api/puzzles/next?source=lichess&themes=fork").json()["puzzle"]
    check("returns a puzzle with that theme", "fork" in forked["themes"],
          str(forked["themes"]))
    check("and it is the one we expect", forked["id"] == "00sJ9", forked["id"])

    print("\nSolving a two-move line, one move at a time:")
    # 00sO1: line is b8c7 (opponent) e1e4 (yours) d8d1 (opponent) e4e1 (yours).
    first = client.post("/api/puzzles/lichess/00sO1/attempt",
                        json={"moves": ["e1e4"]}).json()
    check("the first move is accepted", first["correct"] is True, str(first))
    check("the puzzle is not over yet", first["done"] is False)
    check("the opponent replies", first.get("reply", {}).get("uci") == "d8d1",
          str(first.get("reply")))
    check("and a new position comes back", bool(first.get("fen")))
    check("the rest of the line still isn't leaked", "e4e1" not in str(first))
    check("doesn't say how many moves it takes until it's over",
          "moves_required" not in first, str(sorted(first)))

    second = client.post("/api/puzzles/lichess/00sO1/attempt",
                         json={"moves": ["e1e4", "e4e1"]}).json()
    check("the last move finishes it", second["solved"] is True, str(second))
    check("and it is marked done", second["done"] is True)
    check("the rating moved", second["rating"]["rated"] is True)
    check("upwards, for a solve", second["rating"]["delta"] > 0,
          str(second["rating"]["delta"]))
    check("and now it says how many moves the answer was",
          second.get("moves_required") == 2, str(second.get("moves_required")))
    check("and what the puzzle's own rating is",
          isinstance(second.get("puzzle_rating"), int), str(second.get("puzzle_rating")))

    print("\nAn illegal move is a broken request, not a failed attempt:")
    before = rating_of(client)
    refused = client.post("/api/puzzles/lichess/00sJ9/attempt",
                          json={"moves": ["e3g3"]})
    check("it is rejected outright", refused.status_code == 400,
          f"HTTP {refused.status_code}: {refused.text[:120]}")
    check("and costs no rating", rating_of(client) == before,
          f"{before} -> {rating_of(client)}")

    print("\nA wrong move ends the puzzle and shows the answer:")
    # 00sJ9's line opens with White's e3g3, so the solver is Black and their
    # first move is e8e1. Getting this backwards is the easiest mistake to
    # make about the format, which is why it is checked.
    wrong = client.post("/api/puzzles/lichess/00sJ9/attempt",
                        json={"moves": ["g8h8"]}).json()
    check("it is graded wrong", wrong["correct"] is False)
    check("the puzzle is over", wrong["done"] is True)
    check("the expected move is revealed", wrong["expected"]["uci"] == "e8e1",
          str(wrong.get("expected")))
    check("in readable notation", wrong["expected"]["san"] == "Re1+",
          str(wrong["expected"].get("san")))
    check("the rating moved down", wrong["rating"]["delta"] < 0,
          str(wrong["rating"]["delta"]))
    check("and the puzzle's own rating is revealed, now that it's missed",
          isinstance(wrong.get("puzzle_rating"), int), str(wrong.get("puzzle_rating")))

    print("\nOnly the first attempt counts:")
    before = rating_of(client)
    retry = client.post("/api/puzzles/lichess/00sJ9/attempt",
                        json={"moves": ["e8e1", "e1c1", "f4h6", "h6c1"]}).json()
    check("a retry can still be solved", retry["solved"] is True, str(retry)[:200])
    check("but it is not rated", retry["rating"]["rated"] is False)
    check("and the rating did not move", rating_of(client) == before,
          f"{before} -> {rating_of(client)}")

    print("\nAn attempted puzzle never comes round again:")
    seen = set()
    for _ in range(6):
        response = client.get("/api/puzzles/next?source=lichess")
        if response.status_code == 404:
            break
        seen.add(response.json()["puzzle"]["id"])
    check("only the untried one is offered", seen <= {"00sHx"}, str(seen))
    # 00sHx opens with Black's e8d7, so the solver is White: a2e6 then f7f8#.
    part = client.post("/api/puzzles/lichess/00sHx/attempt",
                       json={"moves": ["a2e6"]}).json()
    check("an unfinished puzzle is not yet graded", part["done"] is False, str(part)[:160])
    client.post("/api/puzzles/lichess/00sHx/attempt", json={"moves": ["a2e6", "f7f8"]})
    exhausted = client.get("/api/puzzles/next?source=lichess")
    check("and when they're all done it says so, in words",
          exhausted.status_code == 404 and "import" in exhausted.json()["detail"],
          f"HTTP {exhausted.status_code}: {exhausted.text[:160]}")

    print("\nPer-theme ratings:")
    progress = client.get("/api/puzzles/stats").json()["progress"]
    by_theme = {entry["theme"]: entry for entry in progress["themes"]}
    check("the themes of solved puzzles are tracked", "pin" in by_theme,
          str(sorted(by_theme)))
    check("a theme it never saw is absent", "knightEndgame" not in by_theme)
    check("phase themes aren't given their own rating", "middlegame" not in by_theme,
          str(sorted(by_theme)))
    check("length themes aren't either", "short" not in by_theme)
    check("the overall rating has an interval",
          len(progress["overall"]["interval"]) == 2)
    check("and says whether it's still provisional",
          isinstance(progress["overall"]["provisional"], bool))
    check("history is recorded for the graph", len(progress["history"]) >= 3,
          str(len(progress["history"])))

    print("\nTime away widens the rating's deviation:")
    # Backdate the stored row and read it again. The decay is applied on read,
    # so this is the only way to see it without waiting a month -- and without
    # a check it is exactly the kind of thing that gets written and never
    # wired up.
    settled = client.get("/api/puzzles/stats").json()["progress"]["overall"]
    with db_cursor() as conn:
        conn.execute(
            "UPDATE puzzle_ratings SET updated_at = datetime('now', '-200 days') "
            "WHERE user_id = 1"
        )
    lapsed = client.get("/api/puzzles/stats").json()["progress"]["overall"]
    check("the deviation grows", lapsed["rd"] > settled["rd"],
          f"{settled['rd']} -> {lapsed['rd']}")
    check("the rating itself does not", lapsed["rating"] == settled["rating"],
          f"{settled['rating']} -> {lapsed['rating']}")
    check("and the interval widens with it",
          (lapsed["interval"][1] - lapsed["interval"][0])
          > (settled["interval"][1] - settled["interval"][0]))

    print("\nGiving up:")
    client.post("/api/puzzles/rating/reset")
    revealed = client.post("/api/puzzles/lichess/00sO1/reveal").json()
    check("the whole line comes back", len(revealed["line"]) == 3,
          str(len(revealed["line"])))
    check("marked with whose moves are whose",
          [m["yours"] for m in revealed["line"]] == [True, False, True],
          str([m["yours"] for m in revealed["line"]]))
    check("in readable notation", all(m.get("san") for m in revealed["line"]))
    check("and it counts as a failure", revealed["rating"]["delta"] < 0,
          str(revealed["rating"]["delta"]))

    print("\nResetting:")
    client.post("/api/puzzles/rating/reset")
    progress = client.get("/api/puzzles/stats").json()["progress"]
    check("the rating goes back to the start", progress["overall"]["rating"] == 1500,
          str(progress["overall"]["rating"]))
    check("the theme records are cleared", progress["themes"] == [])
    check("and the puzzles are on offer again",
          client.get("/api/puzzles/next?source=lichess").status_code == 200)

    print("\nA hint keeps a puzzle off the rating, solved or not:")
    # Two fresh puzzles, seeded on top of what's already imported, so this
    # doesn't disturb the "seen" bookkeeping the sections above depend on.
    seed_lichess_rows([
        ["00hntA", "1k1r4/pp3pp1/2p1p3/4b3/P3n1P1/8/KPP2PP1/R1B1R3 b - - 2 31",
         "b8c7 e1e4 d8d1 e4e1", "900", "70", "88", "150", "endgame pin", "", ""],
        ["00hntB", "1k1r4/pp3pp1/2p1p3/4b3/P3n1P1/8/KPP2PP1/R1B1R3 b - - 2 31",
         "b8c7 e1e4 d8d1 e4e1", "900", "70", "88", "150", "endgame pin", "", ""],
    ])

    before = rating_of(client)
    client.post("/api/puzzles/lichess/00hntA/hint", json={"moves": []})
    solved_with_hint = client.post(
        "/api/puzzles/lichess/00hntA/attempt",
        json={"moves": ["e1e4", "e4e1"], "hint_used": True},
    ).json()
    check("still gets marked solved", solved_with_hint["solved"] is True,
          str(solved_with_hint))
    check("but a hint means it isn't rated",
          solved_with_hint["rating"]["rated"] is False, str(solved_with_hint["rating"]))
    check("and the rating genuinely didn't move", rating_of(client) == before,
          f"{before} -> {rating_of(client)}")

    before = rating_of(client)
    client.post("/api/puzzles/lichess/00hntB/hint", json={"moves": []})
    given_up_with_hint = client.post(
        "/api/puzzles/lichess/00hntB/reveal?hint_used=true"
    ).json()
    check("giving up after a hint is unrated too",
          given_up_with_hint["rating"]["rated"] is False,
          str(given_up_with_hint["rating"]))
    check("and, again, the rating doesn't move", rating_of(client) == before,
          f"{before} -> {rating_of(client)}")

    print("\nOwn-game puzzles, as far as they go without an engine:")
    check("an empty set says what to do first",
          "analyse" in client.get("/api/puzzles/next?source=own").json()["detail"],
          client.get("/api/puzzles/next?source=own").json()["detail"])

    # A tiny analysed game, built the way the analysis pass would leave it, so
    # the builder has something real to find.
    pgn = ('[Event "Check"]\n[White "Checker"]\n[Black "Someone"]\n[Result "0-1"]\n\n'
           "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 0-1\n")
    with db_cursor() as conn:
        conn.execute("INSERT INTO uploads (id, user_id, source_name, raw_text) "
                     "VALUES (1, 1, 'check', ?)", (pgn,))
        conn.execute(
            """INSERT INTO games (id, user_id, upload_id, batch_index, source_name,
                                  game_index_in_source, white, black, result,
                                  your_color, pgn_text, headers_json)
               VALUES (1, 1, 1, 0, 'check', 0, 'Checker', 'Someone', '0-1', 'w', ?, '{}')""",
            (pgn,),
        )
        conn.execute("INSERT INTO analysis_runs (id, user_id, name) VALUES (1, 1, 'check')")
        conn.execute("INSERT INTO run_games (id, run_id, user_id, game_id, mode) "
                     "VALUES (1, 1, 1, 1, 'quick')")
        # Ply 11 is White's 6th move, Nxf7 -- the blunder, and White's own.
        conn.execute(
            """INSERT INTO analysis_moves (run_game_id, ply, san, cp_before, cp_after,
                                           wp_drop, classification)
               VALUES (1, 11, 'Nxf7', 60, -250, 0.34, 'blunder')"""
        )

    built = client.post("/api/puzzles/rebuild").json()
    check("the rescan does not 500", "added" in built, str(built))
    check("it finds the blunder", built["added"] == 1, str(built))
    check("and reports the total", built["total"] == 1, str(built))

    again = client.post("/api/puzzles/rebuild").json()
    check("a second rescan adds nothing", again["added"] == 0, str(again))
    check("and keeps what was there", again["total"] == 1, str(again))
    # The rescan is a button people press after every analysis, and it is a
    # blocking request with no progress bar. It stays quick because it skips
    # games whose puzzles already exist; if that regresses, a large library's
    # rescan goes back to re-parsing every PGN and looking hung.
    with db_cursor() as conn:
        conn.execute("DELETE FROM puzzles WHERE user_id = 1")
    from app.puzzles import build as build_puzzles  # noqa: PLC0415

    build_puzzles(1)
    seen = []
    for _ in range(3):
        started = time.monotonic()
        build_puzzles(1)
        seen.append(time.monotonic() - started)
    check("and re-parses nothing when there is nothing new",
          max(seen) < 0.25, f"slowest repeat rescan {max(seen)*1000:.0f}ms")

    own = client.get("/api/puzzles/next?source=own").json()["puzzle"]
    check("the puzzle is the position before the blunder",
          own["fen"].split()[0].endswith("R1BQK2R") or own["ply"] == 11,
          f"ply {own['ply']}")
    check("it is White to move", own["your_color"] == "w")
    check("the move played is withheld", "played_uci" not in own, str(sorted(own)))
    check("phases are tagged without an engine",
          any(t in own["themes"] for t in ("opening", "middlegame", "endgame")),
          str(own["themes"]))
    check("its rating and length are withheld too, same as a Lichess one",
          "rating" not in own and "moves_required" not in own, str(sorted(own)))

    own_themes = client.get("/api/puzzles/themes?source=own").json()
    offered = {t["key"] for g in own_themes["groups"] for t in g["themes"]}
    check("the picker offers the phase it found", offered & {"opening", "middlegame"},
          str(offered))

    print("\nBlindfold: replaying the puzzle's own game from further back:")
    # No engine needed -- this is a straight PGN replay -- so it runs
    # wherever the rest of this file's own-puzzle checks do.
    blind = client.get(f"/api/puzzles/{own['id']}/blindfold?ply=4").json()
    check("hands back a position from earlier in the same game",
          blind["fen"] != own["fen"], str(blind))
    check("with exactly the real moves that lead back to the puzzle",
          blind["moves"] == ["Ng5", "d5", "exd5", "Nxd5"], str(blind["moves"]))
    shallower = client.get(f"/api/puzzles/{own['id']}/blindfold?ply=1").json()
    check("and a shorter recital for a shallower request",
          shallower["moves"] == ["Nxd5"], str(shallower["moves"]))
    clamped = client.get(f"/api/puzzles/{own['id']}/blindfold?ply=999").json()
    check("clamped rather than walking off the start of the game",
          clamped["fen"] == chess.Board().fen(), str(clamped["fen"]))
    missing = client.get("/api/puzzles/999999/blindfold?ply=4")
    check("a puzzle that isn't yours 404s rather than 500ing",
          missing.status_code == 404, str(missing.status_code))

    print("\nBlunder checks, including the ones built before there were any:")
    # A second bad move in the same game, shaped like a blunder check: White
    # was comfortably better and after it Black is (cp_after is scored for
    # whoever is to move, so a large positive number there is a large negative
    # one for the player whose puzzle this is).
    with db_cursor() as conn:
        conn.execute(
            """INSERT INTO analysis_moves (run_game_id, ply, san, cp_before, cp_after,
                                           wp_drop, classification)
               VALUES (1, 9, 'exd5', 120, 400, 0.45, 'blunder')"""
        )
    built = client.post("/api/puzzles/rebuild").json()
    check("the rescan finds it", built["added"] == 1, str(built))
    check("and files it as a blunder check", built["by_kind"]["blunder_check"] == 1,
          str(built["by_kind"]))

    # What every library built before the tactic/blunder-check split looks
    # like: the puzzle rows are there, the evaluations they are classified on
    # are not. The rescan has to repair those, because it will never insert
    # them again -- it skips positions it already holds.
    with db_cursor() as conn:
        conn.execute("UPDATE puzzles SET cp_before = NULL, cp_after = NULL, "
                     "kind = 'tactic' WHERE user_id = 1")
    stale = client.get("/api/puzzles/stats").json()
    check("which starts with no blunder checks at all",
          stale["by_kind"]["blunder_check"] == 0, str(stale["by_kind"]))

    repaired = client.post("/api/puzzles/rebuild").json()
    check("the rescan fills the missing evaluations in",
          repaired["evals_filled"] == 2, str(repaired.get("evals_filled")))
    check("adding no puzzles while it does", repaired["added"] == 0, str(repaired))
    check("and the blunder check comes back",
          repaired["by_kind"]["blunder_check"] == 1, str(repaired["by_kind"]))
    check("without turning the tactic into one too",
          repaired["by_kind"]["tactic"] == 1, str(repaired["by_kind"]))

    only_checks = client.get("/api/puzzles/next?source=own&kinds=blunder_check").json()
    check("and filtering to blunder checks now returns one",
          only_checks["puzzle"]["ply"] == 9, str(only_checks["puzzle"]["ply"]))

    print("\nImport status:")
    status = client.get("/api/puzzles/lichess/status").json()
    check("reports the database as imported", status["available"] is True)
    # The 3 original rows plus the pair seeded for the hint checks above.
    check("with a count", status["puzzles"] == 5, str(status["puzzles"]))
    check("and a rating span", status.get("min_rating") == 900, str(status.get("min_rating")))


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
