"""Importing the Lichess puzzle database.

Lichess publishes every one of its puzzles as a single zstd-compressed CSV at
https://database.lichess.org/#puzzles -- around five million rows, each with a
position, the solution line, a rating measured against real solvers, and the
themes their tagger assigned. It is CC0, it is the best free puzzle set there
is, and the ratings are the reason: a difficulty derived from a hundred
thousand real attempts is worth more than any heuristic this app could invent.

Three things shape this module.

**It streams.** The download is a few hundred megabytes compressed and about
a gigabyte expanded. Nothing here ever holds the whole file, decompressed
text, or parsed rows in memory: the HTTP response is decompressed in chunks,
split into lines, and handed to SQLite in batches. Peak memory is one batch.

**It subsets.** Importing all five million puzzles takes a while and costs
real disk, and most people want a band around their own rating rather than
mate-in-nine studies. Filters are applied while streaming, so asking for
40,000 puzzles between 1200 and 1800 reads the file once, keeps what matches,
and stops early once it has enough. A `source_path` skips the download
entirely for anyone who already has the file.

**It is resumable in the only way that matters.** An import that dies halfway
leaves the puzzles it already committed, and re-running it skips them
(INSERT OR IGNORE on the puzzle id). A half-finished import is a smaller
puzzle set, never a corrupt one.

The CSV's own column order is not assumed. Lichess has added columns before
and the header row is read to find them, so a new column appearing on the end
is a non-event rather than an import that silently loads ratings into the
popularity field.
"""

import asyncio
import csv
import json
import os
import random
import time
from dataclasses import dataclass, field

import httpx

from .db import db_cursor, get_conn
from .puzzle_themes import parse as parse_themes

DATABASE_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"

# Same reasoning as the chess.com importer: identify the client rather than
# hammering someone's free CDN anonymously.
USER_AGENT = ("ChessImprover/1.0 (self-hosted chess analysis; "
              "+https://github.com/Plopperzzz/ChessImprover)")

# Generous: this is a several-hundred-megabyte download over whatever
# connection a home server has. The read timeout is what matters and it is
# per-chunk, not for the whole transfer.
TIMEOUT = httpx.Timeout(60.0, connect=30.0, read=120.0)

# Rows per transaction. Large enough that the per-statement overhead vanishes,
# small enough that a cancelled import loses a fraction of a second of work.
BATCH_ROWS = 5000

# How often to publish progress. Every batch would be several hundred updates
# a second for a browser that redraws one line of text.
PROGRESS_INTERVAL_S = 0.4

# Bytes pulled from the socket at a time.
CHUNK_BYTES = 1 << 20

# Every column this app reads. Anything else in the file is ignored.
REQUIRED_COLUMNS = ("PuzzleId", "FEN", "Moves", "Rating", "Themes")


class PuzzleImportError(Exception):
    """Something went wrong that the person who pressed the button can act on."""


@dataclass
class ImportProgress:
    """Live state of the running import, polled by the browser."""

    state: str = "idle"          # idle | downloading | importing | done | error | cancelled
    rows_read: int = 0
    rows_kept: int = 0
    bytes_read: int = 0
    total_bytes: int | None = None
    message: str = ""
    started_at: float = field(default_factory=time.monotonic)
    finished: bool = False
    cancelled: bool = False

    def snapshot(self) -> dict:
        elapsed = time.monotonic() - self.started_at
        return {
            "state": self.state,
            "rows_read": self.rows_read,
            "rows_kept": self.rows_kept,
            "bytes_read": self.bytes_read,
            "total_bytes": self.total_bytes,
            "message": self.message,
            "elapsed_s": round(elapsed, 1),
            "finished": self.finished,
        }


@dataclass
class ImportFilters:
    """Which slice of the database to keep."""

    min_rating: int | None = None
    max_rating: int | None = None
    themes: list[str] = field(default_factory=list)
    max_puzzles: int | None = None

    def as_json(self) -> str:
        return json.dumps({
            "min_rating": self.min_rating, "max_rating": self.max_rating,
            "themes": self.themes, "max_puzzles": self.max_puzzles,
        })

    def matches(self, rating: int, themes: list[str]) -> bool:
        if self.min_rating is not None and rating < self.min_rating:
            return False
        if self.max_rating is not None and rating > self.max_rating:
            return False
        if self.themes and not set(self.themes) & set(themes):
            return False
        return True


# One import at a time, process-wide. Two concurrent imports would race on
# the same table for no benefit -- the work is one sequential file read.
_current: ImportProgress | None = None
_lock = asyncio.Lock()


def current_progress() -> dict | None:
    return _current.snapshot() if _current else None


def cancel_running() -> bool:
    """Asks a running import to stop at the next batch boundary. What it has
    already committed stays."""
    if _current and not _current.finished:
        _current.cancelled = True
        _current.message = "stopping..."
        return True
    return False


def _decompressor():
    """zstd streaming decompressor, with a legible error if the library is
    missing. It is the one dependency this feature adds and it is not in
    anyone's default environment."""
    try:
        import zstandard
    except ImportError:
        raise PuzzleImportError(
            "the zstandard package is needed to read Lichess's .zst database "
            "-- install it with `pip install zstandard` (it is in "
            "backend/requirements.txt)"
        )
    return zstandard.ZstdDecompressor().decompressobj()


def _theme_ids(conn, themes: list[str]) -> dict[str, int]:
    """Numbers for these theme keys, minting any that are new. Cached by the
    caller across the whole import -- there are a few dozen themes and several
    million rows, so this must not be a query per row."""
    if not themes:
        return {}
    conn.executemany(
        "INSERT OR IGNORE INTO lichess_theme_names (theme) VALUES (?)",
        [(theme,) for theme in themes],
    )
    placeholders = ", ".join("?" * len(themes))
    rows = conn.execute(
        f"SELECT id, theme FROM lichess_theme_names WHERE theme IN ({placeholders})",
        themes,
    ).fetchall()
    return {row["theme"]: row["id"] for row in rows}


class _Writer:
    """Buffers parsed rows and commits them in batches.

    Holds its own connection for the life of the import rather than opening
    one per batch: this is a thousand-plus transactions and the connection
    setup would show up in the runtime.
    """

    def __init__(self):
        self.conn = get_conn()
        # WAL and a relaxed sync are safe here and worth a lot. The content is
        # a public dataset that can be re-downloaded, so trading crash
        # durability for a several-fold speedup is the right way round -- and
        # it is restored when the import finishes.
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA synchronous = OFF")
        self.puzzles: list[tuple] = []
        self.themes: list[tuple] = []
        self.theme_ids: dict[str, int] = {}
        self.written = 0

    def theme_id(self, theme: str) -> int:
        if theme not in self.theme_ids:
            self.theme_ids.update(_theme_ids(self.conn, [theme]))
        return self.theme_ids[theme]

    def add(self, row: tuple, themes: list[str]):
        self.puzzles.append(row)
        puzzle_id, rating = row[0], row[3]
        for theme in themes:
            self.themes.append((self.theme_id(theme), rating, puzzle_id))

    def flush(self):
        if not self.puzzles:
            return
        self.conn.executemany(
            """INSERT OR IGNORE INTO lichess_puzzles
                 (puzzle_id, fen, moves, rating, rating_deviation, popularity,
                  nb_plays, themes, game_url, opening_tags)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            self.puzzles,
        )
        self.conn.executemany(
            "INSERT OR IGNORE INTO lichess_puzzle_themes (theme_id, rating, puzzle_id) "
            "VALUES (?, ?, ?)",
            self.themes,
        )
        self.conn.commit()
        self.written += len(self.puzzles)
        self.puzzles.clear()
        self.themes.clear()

    def close(self):
        try:
            self.conn.execute("PRAGMA synchronous = FULL")
            self.conn.commit()
        finally:
            self.conn.close()


def _parse_row(record: dict) -> tuple[tuple, list[str]] | None:
    """One CSV row as (database tuple, theme list), or None if unusable.

    A malformed row is skipped rather than failing the import. The file is
    generated, so this is rare -- but 'one bad row loses a twenty-minute
    download' is not a trade worth making.
    """
    puzzle_id = (record.get("PuzzleId") or "").strip()
    fen = (record.get("FEN") or "").strip()
    moves = (record.get("Moves") or "").strip()
    if not puzzle_id or not fen or not moves:
        return None
    try:
        rating = int(record["Rating"])
    except (KeyError, TypeError, ValueError):
        return None

    def optional_int(name: str) -> int | None:
        try:
            return int(record[name])
        except (KeyError, TypeError, ValueError):
            return None

    themes = parse_themes(record.get("Themes"))
    row = (
        puzzle_id, fen, moves, rating,
        optional_int("RatingDeviation"), optional_int("Popularity"),
        optional_int("NbPlays"), " ".join(themes),
        (record.get("GameUrl") or "").strip() or None,
        (record.get("OpeningTags") or "").strip() or None,
    )
    return row, themes


async def _stream_bytes(source_path: str | None, progress: ImportProgress):
    """Raw file bytes, from disk or over HTTP, a chunk at a time."""
    if source_path:
        if not os.path.exists(source_path):
            raise PuzzleImportError(f"no such file: {source_path}")
        progress.total_bytes = os.path.getsize(source_path)
        progress.state = "importing"
        progress.message = f"reading {os.path.basename(source_path)}"
        with open(source_path, "rb") as handle:
            while chunk := handle.read(CHUNK_BYTES):
                progress.bytes_read += len(chunk)
                yield chunk
                # Reading a local file never awaits, so without this the event
                # loop is blocked for the whole import and the progress the
                # browser is polling for never gets served.
                await asyncio.sleep(0)
        return

    progress.state = "downloading"
    progress.message = "connecting to database.lichess.org"
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True,
                                 headers=headers) as client:
        try:
            async with client.stream("GET", DATABASE_URL) as response:
                if response.status_code >= 400:
                    raise PuzzleImportError(
                        f"database.lichess.org returned HTTP {response.status_code}"
                    )
                length = response.headers.get("Content-Length")
                progress.total_bytes = int(length) if length and length.isdigit() else None
                progress.state = "importing"
                progress.message = "downloading and importing"
                async for chunk in response.aiter_bytes(CHUNK_BYTES):
                    progress.bytes_read += len(chunk)
                    yield chunk
        except httpx.HTTPError as e:
            raise PuzzleImportError(f"could not download the puzzle database: {e}")


async def run_import(filters: ImportFilters, source_path: str | None = None,
                     replace: bool = False) -> dict:
    """Downloads (or reads) the database and imports the rows that match.

    Returns a summary when it finishes. Progress while it runs is published
    through `current_progress`, because this takes minutes and the browser
    needs something to show.
    """
    global _current
    if _lock.locked():
        raise PuzzleImportError("an import is already running")

    async with _lock:
        progress = ImportProgress()
        _current = progress
        decompressor = _decompressor()
        writer = _Writer()
        pending = ""
        reader_columns: list[str] | None = None
        last_published = 0.0
        enough = False

        try:
            if replace:
                progress.message = "clearing the previous import"
                with db_cursor() as conn:
                    conn.execute("DELETE FROM lichess_puzzle_themes")
                    conn.execute("DELETE FROM lichess_puzzles")
                    conn.execute("DELETE FROM lichess_theme_names")

            async for chunk in _stream_bytes(source_path, progress):
                if progress.cancelled or enough:
                    break
                try:
                    text = decompressor.decompress(chunk).decode("utf-8", "replace")
                except Exception as e:
                    raise PuzzleImportError(
                        f"the file isn't valid zstd-compressed data: {e}. "
                        "It should be lichess_db_puzzle.csv.zst, downloaded "
                        "without being decompressed on the way."
                    )
                if not text:
                    continue

                pending += text
                # The last line of a chunk is almost always incomplete; hold
                # it back and glue it to the next chunk.
                lines = pending.split("\n")
                pending = lines.pop()

                if reader_columns is None and lines:
                    reader_columns = next(csv.reader([lines.pop(0)]))
                    missing = [c for c in REQUIRED_COLUMNS if c not in reader_columns]
                    if missing:
                        raise PuzzleImportError(
                            "that file doesn't look like the Lichess puzzle "
                            f"database -- its header is missing {', '.join(missing)}"
                        )

                for record in csv.DictReader(lines, fieldnames=reader_columns):
                    progress.rows_read += 1
                    parsed = _parse_row(record)
                    if parsed is None:
                        continue
                    row, themes = parsed
                    if not filters.matches(row[3], themes):
                        continue
                    writer.add(row, themes)
                    progress.rows_kept += 1
                    if (filters.max_puzzles is not None
                            and progress.rows_kept >= filters.max_puzzles):
                        enough = True
                        break

                if len(writer.puzzles) >= BATCH_ROWS or enough:
                    writer.flush()
                    # Hand the loop back so the progress endpoint can be
                    # served and a cancel can be noticed.
                    await asyncio.sleep(0)

                now = time.monotonic()
                if now - last_published >= PROGRESS_INTERVAL_S:
                    last_published = now
                    await asyncio.sleep(0)

            writer.flush()

            if progress.cancelled:
                progress.state = "cancelled"
                progress.message = (f"stopped after {writer.written:,} puzzles "
                                    "-- what was imported is usable")
            else:
                progress.state = "done"
                progress.message = f"imported {writer.written:,} puzzles"

            with db_cursor() as conn:
                total = conn.execute(
                    "SELECT COUNT(*) AS n FROM lichess_puzzles"
                ).fetchone()["n"]
                conn.execute(
                    """INSERT INTO lichess_puzzle_import
                         (id, imported_at, source, puzzles, filters_json)
                       VALUES (1, datetime('now'), ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         imported_at = excluded.imported_at,
                         source = excluded.source,
                         puzzles = excluded.puzzles,
                         filters_json = excluded.filters_json""",
                    (source_path or DATABASE_URL, total, filters.as_json()),
                )
            progress.finished = True
            return {
                "imported": writer.written,
                "total": total,
                "rows_read": progress.rows_read,
                "cancelled": progress.cancelled,
                "message": progress.message,
            }
        except PuzzleImportError as e:
            progress.state = "error"
            progress.message = str(e)
            progress.finished = True
            raise
        except Exception as e:
            progress.state = "error"
            progress.message = f"{type(e).__name__}: {e}"
            progress.finished = True
            raise
        finally:
            writer.close()


# ---------------------------------------------------------------------------
# Reading what was imported
# ---------------------------------------------------------------------------


def import_status(conn) -> dict:
    """What is in the database, for the UI to decide what to offer."""
    row = conn.execute(
        "SELECT imported_at, source, puzzles, filters_json FROM lichess_puzzle_import "
        "WHERE id = 1"
    ).fetchone()
    total = conn.execute("SELECT COUNT(*) AS n FROM lichess_puzzles").fetchone()["n"]
    out = {
        "available": total > 0,
        "puzzles": total,
        "imported_at": row["imported_at"] if row else None,
        "source": row["source"] if row else None,
        "filters": json.loads(row["filters_json"]) if row else {},
    }
    if total:
        span = conn.execute(
            "SELECT MIN(rating) AS lo, MAX(rating) AS hi FROM lichess_puzzles"
        ).fetchone()
        out["min_rating"] = span["lo"]
        out["max_rating"] = span["hi"]
    running = current_progress()
    if running and not running["finished"]:
        out["running"] = running
    elif running:
        out["last_run"] = running
    return out


def theme_counts(conn) -> dict[str, int]:
    """How many imported puzzles carry each theme. Drives the picker, which
    must not offer a theme that would return nothing."""
    rows = conn.execute(
        """SELECT n.theme AS theme, COUNT(*) AS n
           FROM lichess_puzzle_themes t
           JOIN lichess_theme_names n ON n.id = t.theme_id
           GROUP BY n.theme"""
    ).fetchall()
    return {row["theme"]: row["n"] for row in rows}


def rating_for_themes(conn, themes: list[str]) -> int | None:
    """A representative rating for a puzzle carrying these themes.

    This is how a puzzle built from your own games gets a difficulty at all
    (see `puzzles.own_puzzle_rating`). The claim it makes is modest and
    checkable: a home-grown mate-in-one that hangs a piece is about as hard as
    Lichess's mate-in-one-that-hangs-a-piece puzzles, whose difficulty is
    measured. It is an estimate, and the caller pairs it with a deliberately
    wide deviation so Glicko-2 treats it as one.

    Narrows from the full theme set to the rarest single theme, so an unusual
    combination still gets an answer rather than falling through to nothing.
    """
    if not themes:
        return None
    ids = conn.execute(
        f"SELECT id, theme FROM lichess_theme_names WHERE theme IN "
        f"({', '.join('?' * len(themes))})",
        themes,
    ).fetchall()
    theme_ids = [row["id"] for row in ids]
    if not theme_ids:
        return None

    # All of them at once: puzzles carrying every one of these themes.
    row = conn.execute(
        f"""SELECT AVG(rating) AS r FROM (
              SELECT puzzle_id, COUNT(*) AS hits
              FROM lichess_puzzle_themes
              WHERE theme_id IN ({', '.join('?' * len(theme_ids))})
              GROUP BY puzzle_id HAVING hits = ?
            ) AS matched
            JOIN lichess_puzzles p ON p.puzzle_id = matched.puzzle_id""",
        (*theme_ids, len(theme_ids)),
    ).fetchone()
    if row and row["r"]:
        return int(row["r"])

    # Nothing carries the whole set; fall back to the rarest single theme,
    # which is the most informative one about difficulty.
    row = conn.execute(
        f"""SELECT theme_id, COUNT(*) AS n, AVG(rating) AS r
            FROM lichess_puzzle_themes
            WHERE theme_id IN ({', '.join('?' * len(theme_ids))})
            GROUP BY theme_id ORDER BY n ASC LIMIT 1""",
        theme_ids,
    ).fetchone()
    if row and row["r"]:
        return int(row["r"])
    return None


# How wide a slice of the rating band to look in first, and how far to keep
# widening when it comes back empty. See `pick`.
_WINDOW_STEPS = (25, 75, 200, 600)

# Rows pulled per probe before shuffling. Enough that the choice is varied,
# small enough that the query stays an index range scan.
_CANDIDATE_POOL = 400


def _probe(conn, *, themes: list[str], lo: int, hi: int, exclude_ids: list[str],
           user_id: int, limit: int) -> list:
    """One indexed lookup in a rating window."""
    params: list = []
    if themes:
        # Range on lt.rating, not p.rating: the theme table carries a copy of
        # the rating for exactly this reason, and its (theme_id, rating, ...)
        # key turns theme + band into a single range scan. Filtering on the
        # puzzle table's rating instead would join first and filter after.
        source = ("FROM lichess_puzzle_themes lt "
                  "JOIN lichess_theme_names ln ON ln.id = lt.theme_id "
                  "JOIN lichess_puzzles p ON p.puzzle_id = lt.puzzle_id")
        where = [f"ln.theme IN ({', '.join('?' * len(themes))})", "lt.rating BETWEEN ? AND ?"]
        params += [*themes, lo, hi]
    else:
        source = "FROM lichess_puzzles p"
        where = ["p.rating BETWEEN ? AND ?"]
        params += [lo, hi]

    if exclude_ids:
        where.append(f"p.puzzle_id NOT IN ({', '.join('?' * len(exclude_ids))})")
        params += exclude_ids

    params.append(user_id)
    params.append(limit)
    return conn.execute(
        f"""SELECT DISTINCT p.* {source}
            WHERE {' AND '.join(where)}
              AND NOT EXISTS (
                SELECT 1 FROM puzzle_attempts a
                WHERE a.user_id = ? AND a.puzzle_key = 'lichess:' || p.puzzle_id
              )
            LIMIT ?""",
        params,
    ).fetchall()


def pick(conn, *, themes: list[str], min_rating: int, max_rating: int,
         exclude_keys: list[str], user_id: int, limit: int = 1) -> list:
    """Puzzles in a rating band, carrying (any of) these themes, not yet tried.

    'Not yet tried' is a NOT EXISTS against `puzzle_attempts` rather than a
    flag on the puzzle: the puzzle table is shared between accounts, and one
    person solving something must not take it away from the other.

    The randomness is done by picking a random point in the band and reading
    a window around it, not by `ORDER BY RANDOM()`. The obvious version sorts
    the entire matching set -- hundreds of thousands of rows -- to return one,
    which on a full import is a visible pause every time you press Next. This
    does an index range scan over a few hundred rows and shuffles those.

    The window widens when a narrow one comes up empty, so a sparse theme
    still finds something instead of reporting nothing at a rating where it
    simply has no puzzles within 25 points.
    """
    if min_rating > max_rating:
        min_rating, max_rating = max_rating, min_rating
    exclude_ids = [key.split(":", 1)[-1] for key in exclude_keys]

    for width in _WINDOW_STEPS:
        pivot = random.randint(min_rating, max_rating)
        lo = max(min_rating, pivot - width)
        hi = min(max_rating, pivot + width)
        rows = _probe(conn, themes=themes, lo=lo, hi=hi, exclude_ids=exclude_ids,
                      user_id=user_id, limit=_CANDIDATE_POOL)
        if len(rows) >= limit:
            return random.sample(rows, limit)

    # Nothing near any pivot: sweep the whole band before giving up, so "no
    # puzzles left" means it really is exhausted rather than unlucky.
    rows = _probe(conn, themes=themes, lo=min_rating, hi=max_rating,
                  exclude_ids=exclude_ids, user_id=user_id, limit=_CANDIDATE_POOL)
    random.shuffle(rows)
    return rows[:limit]
