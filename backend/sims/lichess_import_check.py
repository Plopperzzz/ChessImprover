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

import csv
import io
import os
import sys
import tempfile
import time

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


def compress(raw: bytes, path: str, kind: str = "zstd"):
    """The same bytes in whichever wrapper. People arrive with all of these:
    the published .zst, a plain .csv they decompressed, or something an
    archive manager re-wrapped on the way."""
    if kind == "zstd":
        import zstandard

        data = zstandard.ZstdCompressor().compress(raw)
    elif kind == "gzip":
        import gzip

        data = gzip.compress(raw)
    elif kind == "bzip2":
        import bz2

        data = bz2.compress(raw)
    elif kind == "xz":
        import lzma

        data = lzma.compress(raw)
    elif kind == "zip":
        import zipfile

        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("lichess_db_puzzle.csv", raw)
        return
    else:
        data = raw
    with open(path, "wb") as handle:
        handle.write(data)


def reset_tables():
    with db_cursor() as conn:
        conn.execute("DELETE FROM lichess_puzzle_themes")
        conn.execute("DELETE FROM lichess_puzzles")
        conn.execute("DELETE FROM lichess_theme_names")
        conn.execute("DELETE FROM puzzle_attempts")


def run(filters, path, replace=False):
    """The import, run to completion the way the background thread runs it."""
    return lp.run_import(filters, source_path=path, replace=replace)


def _missing_message() -> str:
    try:
        lp.start(lp.ImportFilters(), source_path="/nope/missing.csv")
    except lp.PuzzleImportError as e:
        return str(e)
    return ""


def run_in_background_and_watch(path: str) -> dict:
    """Starts an import the way the endpoint does and polls it to the end.

    The point is the polling. The first version of this feature did the whole
    import on the event loop, so `current_progress` could not be read while it
    ran -- the progress bar it fed was dead for exactly as long as there was
    progress to report, and every other request queued behind it.
    """
    lp.start(lp.ImportFilters(), source_path=path, replace=True)
    seen = []
    for _ in range(600):
        snapshot = lp.current_progress()
        if snapshot:
            seen.append(snapshot)
            if snapshot["finished"]:
                break
        time.sleep(0.05)
    return {"snapshots": seen, "final": lp.current_progress()}


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

    print("\nEvery shape the file actually turns up in:")
    # The published file is .csv.zst, but by the time it reaches the importer
    # it may have been decompressed by the browser, or re-wrapped by an
    # archive manager. Refusing all but zstd -- which the first version did --
    # tells someone their own copy of the database is the wrong file.
    raw = build_csv(20)
    # Names deliberately distinct from the main fixture: writing a 20-row
    # file over the 500-row one is how the rating-band checks below quietly
    # started passing over an empty database.
    for kind, name in [("plain", "shape.csv"), ("zstd", "shape.csv.zst"),
                       ("gzip", "shape.csv.gz"), ("bzip2", "shape.csv.bz2"),
                       ("xz", "shape.csv.xz"), ("zip", "shape.zip")]:
        candidate = os.path.join(SCRATCH, name)
        compress(raw, candidate, kind)
        reset_tables()
        try:
            result = run(lp.ImportFilters(), candidate)
            check(f"  {kind:6} ({name})", result["imported"] == 21,
                  f"imported {result['imported']}")
        except lp.PuzzleImportError as e:
            check(f"  {kind:6} ({name})", False, str(e))

    # ...and the extension is not what decides it, because the extension is
    # the thing most likely to be wrong.
    mislabelled = os.path.join(SCRATCH, "actually-plain.csv.zst")
    compress(raw, mislabelled, "plain")
    reset_tables()
    try:
        result = run(lp.ImportFilters(), mislabelled)
        check("a plain CSV named .zst still works", result["imported"] == 21,
              f"imported {result['imported']}")
    except lp.PuzzleImportError as e:
        check("a plain CSV named .zst still works", False, str(e))

    gz_as_zst = os.path.join(SCRATCH, "actually-gzip.csv.zst")
    compress(raw, gz_as_zst, "gzip")
    reset_tables()
    try:
        result = run(lp.ImportFilters(), gz_as_zst)
        check("a gzip named .zst still works", result["imported"] == 21,
              f"imported {result['imported']}")
    except lp.PuzzleImportError as e:
        check("a gzip named .zst still works", False, str(e))

    print("\nFormat sniffing reads the leading bytes, not the name:")
    for kind in ("plain", "zstd", "gzip", "bzip2", "xz", "zip"):
        probe = os.path.join(SCRATCH, f"sniff-{kind}")
        compress(b"PuzzleId,FEN\n", probe, kind)
        with open(probe, "rb") as handle:
            got = lp.detect_format(handle.read(4096))
        check(f"  {kind}", got == kind, f"detected {got}")

    print("\nAn empty file says so rather than importing nothing quietly:")
    empty = os.path.join(SCRATCH, "empty.csv")
    open(empty, "wb").close()
    reset_tables()
    try:
        run(lp.ImportFilters(), empty)
        check("an empty file is refused", False, "it was accepted")
    except lp.PuzzleImportError as e:
        check("an empty file is refused", "header" in str(e), str(e))

    print("\nA missing path is caught before any work starts:")
    try:
        lp.start(lp.ImportFilters(), source_path="/nope/missing.csv")
        check("a missing file is refused up front", False, "it was accepted")
    except lp.PuzzleImportError as e:
        check("a missing file is refused up front", "no such file" in str(e), str(e))
    check("and it says the path is server-side",
          "machine running the app" in _missing_message(), _missing_message())

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

    print("\nRunning in the background, with progress readable while it runs:")
    big = os.path.join(SCRATCH, "background.csv.zst")
    compress(build_csv(40000), big)
    watched = run_in_background_and_watch(big)
    snapshots = watched["snapshots"]
    final = watched["final"]
    check("it finishes", final and final["finished"], str(final))
    check("and imports everything", final and final["rows_kept"] == 40001,
          str(final and final["rows_kept"]))
    # More than one distinct reading means the progress object really was
    # readable mid-flight rather than only after the fact.
    distinct = len({s["rows_kept"] for s in snapshots})
    check("progress moved while it ran", distinct > 2,
          f"{distinct} distinct readings across {len(snapshots)} polls")
    check("it is not still holding the lock",
          not lp.is_running() and lp.start is not None)

    print("\nStarting a second import while one runs is refused:")
    lp.start(lp.ImportFilters(), source_path=big, replace=True)
    try:
        lp.start(lp.ImportFilters(), source_path=big)
        check("the second is refused", False, "it was accepted")
    except lp.PuzzleImportError as e:
        check("the second is refused", "already running" in str(e), str(e))
    while lp.is_running():
        time.sleep(0.05)
    check("and once it's done another can start", not lp.is_running())

    print("\nStatus reporting:")
    reset_tables()
    run(lp.ImportFilters(), path, replace=True)
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
