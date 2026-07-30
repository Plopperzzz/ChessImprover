"""Driving the Lichess puzzle importer over a synthetic database file.

The real file is a few hundred megabytes behind a CDN, which is not something
to depend on to know whether the parser works. This builds a small one in
exactly the published format -- same header, same column order, same
zstd-compressed CSV -- and runs the real importer over it.

Run it with `python backend/sims/lichess_import_check.py`.

What it is actually checking, in rough order of how badly each would hurt:

* **Chunk boundaries.** The importer reads the file in fixed-size chunks and
  a CSV row is almost never aligned to one. Getting the carry-over wrong
  loses or corrupts a row per chunk, and on a five-million-row file nobody
  would notice which. The chunk size is shrunk to a few bytes here so every
  row crosses a boundary.
* **Column order.** The header is read rather than assumed, so an extra
  column appearing on the end must not shift ratings into popularity.
* **Filters and the early stop.** Asking for a band, or a cap, must return
  that band and stop reading once it has enough.
* **Selection.** `pick` must respect the rating band and theme, and must
  never hand back a puzzle the user has already attempted.
"""

import asyncio
import csv
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="lichess-puzzle-check-")
os.environ["CHESSIMPROVER_DB"] = os.path.join(SCRATCH, "check.db")

from app import lichess_puzzles as lp  # noqa: E402
from app.db import db_cursor, init_db  # noqa: E402

failures = []


def check(label: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}{(': ' + detail) if detail else ''}")


# The real header, in the real order, as published.
HEADER = ["PuzzleId", "FEN", "Moves", "Rating", "RatingDeviation", "Popularity",
          "NbPlays", "Themes", "GameUrl", "OpeningTags"]

# A real row from the published database, kept verbatim as the format anchor.
REAL_ROW = [
    "00sHx",
    "q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K1R b k - 0 17",
    "e8d7 a2e6 d7d8 f7f8",
    "1760", "80", "83", "72",
    "mate mateIn2 middlegame short",
    "https://lichess.org/yyznGmXs/black#34",
    "Italian_Game Italian_Game_Classical_Variation",
]

THEME_POOL = [
    "fork", "pin", "endgame", "middlegame", "crushing", "advantage",
    "mate", "mateIn2", "short", "long", "hangingPiece", "sacrifice",
]


def build_csv(rows: int) -> bytes:
    """A file in the published format: header, the real row, then rows with
    ratings spread across the range so band filters have something to bite."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(HEADER)
    writer.writerow(REAL_ROW)
    for i in range(rows):
        rating = 600 + (i * 17) % 2200
        themes = [THEME_POOL[i % len(THEME_POOL)], THEME_POOL[(i * 3) % len(THEME_POOL)]]
        writer.writerow([
            f"p{i:05d}",
            "q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K1R b k - 0 17",
            "e8d7 a2e6 d7d8 f7f8",
            str(rating), "75", "90", "500",
            " ".join(sorted(set(themes))),
            f"https://lichess.org/game{i}",
            "" if i % 3 else "Sicilian_Defense",
        ])
    return buffer.getvalue().encode()


def compress(raw: bytes, path: str):
    import zstandard

    with open(path, "wb") as handle:
        handle.write(zstandard.ZstdCompressor().compress(raw))


def reset_tables():
    with db_cursor() as conn:
        conn.execute("DELETE FROM lichess_puzzle_themes")
        conn.execute("DELETE FROM lichess_puzzles")
        conn.execute("DELETE FROM lichess_theme_names")
        conn.execute("DELETE FROM puzzle_attempts")


def run(filters, path, replace=False):
    return asyncio.run(lp.run_import(filters, source_path=path, replace=replace))


def main():
    init_db()
    with db_cursor() as conn:
        conn.execute(
            "INSERT INTO users (id, username, display_name) VALUES (1, 'checker', 'Checker')"
        )

    path = os.path.join(SCRATCH, "puzzles.csv.zst")
    compress(build_csv(500), path)

    print("Import, with the chunk size forced small so every row straddles a boundary:")
    original_chunk = lp.CHUNK_BYTES
    lp.CHUNK_BYTES = 64
    try:
        reset_tables()
        result = run(lp.ImportFilters(), path)
    finally:
        lp.CHUNK_BYTES = original_chunk

    check("every row survived chunking", result["imported"] == 501,
          f"imported {result['imported']}, expected 501")

    with db_cursor() as conn:
        row = conn.execute(
            "SELECT * FROM lichess_puzzles WHERE puzzle_id = '00sHx'"
        ).fetchone()
    check("the real row round-trips", row is not None)
    if row:
        check("  rating", row["rating"] == 1760, str(row["rating"]))
        check("  deviation", row["rating_deviation"] == 80, str(row["rating_deviation"]))
        check("  popularity", row["popularity"] == 83, str(row["popularity"]))
        check("  plays", row["nb_plays"] == 72, str(row["nb_plays"]))
        check("  moves", row["moves"] == "e8d7 a2e6 d7d8 f7f8", row["moves"])
        check("  themes", row["themes"] == "mate mateIn2 middlegame short", row["themes"])
        check("  opening tags", (row["opening_tags"] or "").startswith("Italian_Game"),
              str(row["opening_tags"]))

    with db_cursor() as conn:
        joined = conn.execute(
            """SELECT n.theme FROM lichess_puzzle_themes t
               JOIN lichess_theme_names n ON n.id = t.theme_id
               WHERE t.puzzle_id = '00sHx' ORDER BY n.theme"""
        ).fetchall()
    check("themes are indexed for the picker",
          [r["theme"] for r in joined] == ["mate", "mateIn2", "middlegame", "short"],
          str([r["theme"] for r in joined]))

    print("\nA column appended to the file must not shift the others:")
    extended_header = HEADER + ["SomeNewColumn"]
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(extended_header)
    writer.writerow(REAL_ROW + ["whatever"])
    extended_path = os.path.join(SCRATCH, "extended.csv.zst")
    compress(buffer.getvalue().encode(), extended_path)
    reset_tables()
    run(lp.ImportFilters(), extended_path)
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT rating, popularity FROM lichess_puzzles WHERE puzzle_id = '00sHx'"
        ).fetchone()
    check("rating still reads as rating", row and row["rating"] == 1760)
    check("popularity still reads as popularity", row and row["popularity"] == 83)

    print("\nA file that isn't the puzzle database is rejected by name, not by crash:")
    wrong_path = os.path.join(SCRATCH, "wrong.csv.zst")
    compress(b"Alpha,Beta\n1,2\n", wrong_path)
    reset_tables()
    try:
        run(lp.ImportFilters(), wrong_path)
        check("a wrong file is refused", False, "it was accepted")
    except lp.PuzzleImportError as e:
        check("a wrong file is refused", "PuzzleId" in str(e), str(e))

    print("\nUncompressed input gets an error that says what to do:")
    plain_path = os.path.join(SCRATCH, "plain.csv.zst")
    with open(plain_path, "wb") as handle:
        handle.write(build_csv(3))
    reset_tables()
    try:
        run(lp.ImportFilters(), plain_path)
        check("plain CSV is refused", False, "it was accepted")
    except lp.PuzzleImportError as e:
        check("plain CSV is refused", "zstd" in str(e), str(e))

    print("\nFilters:")
    reset_tables()
    result = run(lp.ImportFilters(min_rating=1000, max_rating=1500), path)
    with db_cursor() as conn:
        span = conn.execute(
            "SELECT MIN(rating) AS lo, MAX(rating) AS hi, COUNT(*) AS n FROM lichess_puzzles"
        ).fetchone()
    check("a rating band keeps only that band",
          span["lo"] >= 1000 and span["hi"] <= 1500,
          f"{span['lo']}-{span['hi']} over {span['n']} rows")
    check("the band is not empty", span["n"] > 0, str(span["n"]))

    reset_tables()
    run(lp.ImportFilters(themes=["mateIn2"]), path, replace=True)
    with db_cursor() as conn:
        rows = conn.execute("SELECT themes FROM lichess_puzzles").fetchall()
    check("a theme filter keeps only puzzles carrying it",
          rows and all("mateIn2" in r["themes"] for r in rows),
          f"{len(rows)} rows")

    reset_tables()
    result = run(lp.ImportFilters(max_puzzles=25), path, replace=True)
    check("a cap stops the import", result["imported"] == 25, str(result["imported"]))
    check("and stops reading early", result["rows_read"] < 200,
          f"read {result['rows_read']} rows for 25 puzzles")

    print("\nReplace vs. top up:")
    reset_tables()
    run(lp.ImportFilters(max_puzzles=10), path)
    run(lp.ImportFilters(max_puzzles=30), path)
    with db_cursor() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM lichess_puzzles").fetchone()["n"]
    check("re-importing tops up without duplicating", n == 30, str(n))
    run(lp.ImportFilters(max_puzzles=5), path, replace=True)
    with db_cursor() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM lichess_puzzles").fetchone()["n"]
    check("replace clears first", n == 5, str(n))

    print("\nPicking a puzzle:")
    reset_tables()
    run(lp.ImportFilters(), path, replace=True)
    with db_cursor() as conn:
        picked = lp.pick(conn, themes=[], min_rating=1200, max_rating=1400,
                         exclude_keys=[], user_id=1, limit=1)
        check("respects the rating band",
              picked and 1200 <= picked[0]["rating"] <= 1400,
              str(picked[0]["rating"]) if picked else "nothing")

        picked = lp.pick(conn, themes=["fork"], min_rating=600, max_rating=2800,
                         exclude_keys=[], user_id=1, limit=1)
        check("respects the theme",
              picked and "fork" in picked[0]["themes"],
              picked[0]["themes"] if picked else "nothing")

        # Everything attempted -> nothing left to offer.
        ids = [r["puzzle_id"] for r in conn.execute(
            "SELECT puzzle_id FROM lichess_puzzles").fetchall()]
        conn.executemany(
            "INSERT INTO puzzle_attempts (user_id, source, puzzle_key, solved) "
            "VALUES (1, 'lichess', ?, 1)",
            [(f"lichess:{pid}",) for pid in ids],
        )
        check("never re-offers an attempted puzzle",
              lp.pick(conn, themes=[], min_rating=600, max_rating=2800,
                      exclude_keys=[], user_id=1, limit=1) == [])
        check("but only for the user who attempted it",
              lp.pick(conn, themes=[], min_rating=600, max_rating=2800,
                      exclude_keys=[], user_id=2, limit=1) != [])

    print("\nRating estimation for home-grown puzzles:")
    with db_cursor() as conn:
        estimate = lp.rating_for_themes(conn, ["mate", "mateIn2"])
        check("an exact theme match gives a rating", estimate is not None, str(estimate))
        check("a theme nothing carries falls back rather than failing",
              lp.rating_for_themes(conn, ["zugzwang"]) is None
              or isinstance(lp.rating_for_themes(conn, ["zugzwang"]), int))
        check("no themes gives no rating", lp.rating_for_themes(conn, []) is None)

    print("\nStatus reporting:")
    with db_cursor() as conn:
        status = lp.import_status(conn)
    check("reports the database as available", status["available"] is True)
    check("reports how many", status["puzzles"] == 501, str(status["puzzles"]))
    check("reports a rating span",
          status.get("min_rating") is not None and status.get("max_rating") is not None)


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
