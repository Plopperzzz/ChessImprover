"""Importing the Lichess puzzle database.

Lichess publishes every one of its puzzles as a single zstd-compressed CSV at
https://database.lichess.org/#puzzles -- around five million rows, each with a
position, the solution line, a rating measured against real solvers, and the
themes their tagger assigned. It is CC0, it is the best free puzzle set there
is, and the ratings are the reason: a difficulty derived from a hundred
thousand real attempts is worth more than any heuristic this app could invent.

Four things shape this module.

**It runs off the event loop.** Everything here is blocking and is meant to
be: `start` puts it on a worker thread and returns immediately. The first
version did the work inside the request with async streaming and a few
`await asyncio.sleep(0)` calls between chunks, which looked cooperative and
wasn't -- the decompression, the CSV parse and the SQLite writes still ran on
the event loop, so for the whole import the server answered nothing at all.
The progress poll this feature exists to feed was dead for exactly as long as
there was progress to report, and any other request -- a puzzle scan in
another tab -- died with it as "Failed to fetch".

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

Nor is the file's wrapper. Lichess publishes `.csv.zst`, but by the time a
file reaches here it may have been decompressed by a browser or re-wrapped by
an archive manager, so zstd, gzip, bzip2, xz, zip and plain CSV are all
accepted -- sniffed from the leading bytes, because the extension is the part
most likely to be wrong.
"""

import csv
import io
import json
import os
import random
import re
import threading
import time
from dataclasses import dataclass, field

import chess
import chess.pgn
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
#
# A plain threading lock, not an asyncio one: the import runs in a worker
# thread (see `start`), because doing this work on the event loop stops the
# server answering anything at all for as long as it takes -- including the
# progress poll that is supposed to be showing you how it's going.
_current: ImportProgress | None = None
_lock = threading.Lock()


def current_progress() -> dict | None:
    return _current.snapshot() if _current else None


def is_running() -> bool:
    return _current is not None and not _current.finished


def cancel_running() -> bool:
    """Asks a running import to stop at the next batch boundary. What it has
    already committed stays."""
    if _current and not _current.finished:
        _current.cancelled = True
        _current.message = "stopping..."
        return True
    return False


# ---------------------------------------------------------------------------
# Reading whatever file you actually have
# ---------------------------------------------------------------------------

# Lichess publishes one format, but by the time a file reaches this importer
# it has been through a browser, maybe an archive manager, maybe a transfer
# that decompressed it on the way. Refusing everything but the published
# `.csv.zst` -- which is what the first version of this did -- means telling
# someone their own copy of the database is the wrong file.
#
# Sniffed from the leading bytes rather than the extension, because the
# extension is the thing most likely to be wrong.
_MAGIC = [
    (b"\x28\xb5\x2f\xfd", "zstd"),
    (b"\x1f\x8b", "gzip"),
    (b"BZh", "bzip2"),
    (b"\xfd7zXZ\x00", "xz"),
    (b"PK\x03\x04", "zip"),
]

# How much of the file to look at to identify it. The longest magic number is
# six bytes; the rest is so a plain CSV can be recognised by its header.
_SNIFF_BYTES = 4096


def detect_format(head: bytes) -> str:
    """What kind of file this is: 'zstd', 'gzip', 'bzip2', 'xz', 'zip' or
    'plain'. Unknown binary comes back as 'plain' and fails later on the
    header check, which gives a better message than guessing here would."""
    for magic, name in _MAGIC:
        if head.startswith(magic):
            return name
    return "plain"


def _require(module: str, package: str, why: str):
    try:
        return __import__(module)
    except ImportError:
        raise PuzzleImportError(
            f"{why} needs the {package} package -- install it with "
            f"`pip install {package}` (it is in backend/requirements.txt)"
        )


class _Inflater:
    """Turns a stream of compressed chunks into a stream of plain ones.

    One object for every format rather than a branch at each call site, so
    the import loop doesn't care what it was handed.
    """

    def __init__(self, kind: str):
        self.kind = kind
        if kind == "zstd":
            zstandard = _require("zstandard", "zstandard",
                                 "reading Lichess's .zst database")
            self._obj = zstandard.ZstdDecompressor().decompressobj()
        elif kind == "gzip":
            import zlib
            # 16 + MAX_WBITS is zlib's "expect a gzip wrapper".
            self._obj = zlib.decompressobj(16 + zlib.MAX_WBITS)
        elif kind == "bzip2":
            import bz2
            self._obj = bz2.BZ2Decompressor()
        elif kind == "xz":
            import lzma
            self._obj = lzma.LZMADecompressor()
        else:
            self._obj = None

    def feed(self, chunk: bytes) -> bytes:
        if self._obj is None:
            return chunk
        try:
            return self._obj.decompress(chunk)
        except Exception as e:
            raise PuzzleImportError(
                f"that file is not valid {self.kind} data ({e}). If it was "
                "decompressed or re-compressed on the way here, point the "
                "importer at the plain .csv instead."
            )


def _zip_member(path: str) -> str:
    """The CSV inside a zip archive.

    Someone who unzips and re-zips the database, or downloads it through
    something that wraps it, ends up here. A zip can't be inflated from a
    forward-only byte stream the way the others can, so this opens it
    properly and picks the member that looks like the database.
    """
    import zipfile

    with zipfile.ZipFile(path) as archive:
        names = [n for n in archive.namelist() if not n.endswith("/")]
    if not names:
        raise PuzzleImportError("that zip archive is empty")
    csvs = [n for n in names if n.lower().endswith(".csv")]
    if len(csvs) == 1:
        return csvs[0]
    if not csvs:
        raise PuzzleImportError(
            "no .csv inside that zip archive -- it contains "
            + ", ".join(names[:5])
        )
    # More than one: prefer the one that names itself.
    for name in csvs:
        if "puzzle" in name.lower():
            return name
    raise PuzzleImportError(
        "several .csv files inside that zip -- unzip it and point the "
        "importer at the puzzle one: " + ", ".join(csvs[:5])
    )


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


def _open_source(source_path: str | None, progress: ImportProgress):
    """A (chunks, inflater) pair for whatever we've been pointed at.

    Everything here is blocking on purpose -- this whole module runs in a
    worker thread now. The first version streamed with async httpx and
    sprinkled `await asyncio.sleep(0)` between chunks, which looked like
    cooperative multitasking and wasn't: the decompression, the CSV parse and
    the SQLite writes all still ran on the event loop, so the server answered
    nothing for the entire import -- including the progress poll that was
    meant to be reporting on it, and including a puzzle scan in another tab,
    which the browser eventually gave up on as "Failed to fetch".
    """
    if source_path:
        expanded = os.path.expanduser(source_path.strip())
        if not os.path.exists(expanded):
            raise PuzzleImportError(
                f"no such file on the server: {expanded}. This is a path on "
                "the machine running the app, not on the machine you are "
                "browsing from."
            )
        if os.path.isdir(expanded):
            raise PuzzleImportError(f"{expanded} is a directory, not a file")

        with open(expanded, "rb") as handle:
            head = handle.read(_SNIFF_BYTES)
        kind = detect_format(head)

        if kind == "zip":
            # A zip has to be opened as an archive, so this one reads through
            # zipfile instead of the raw file.
            import zipfile

            member = _zip_member(expanded)
            progress.state = "importing"
            progress.message = f"reading {member} from {os.path.basename(expanded)}"
            archive = zipfile.ZipFile(expanded)
            progress.total_bytes = archive.getinfo(member).file_size

            def zip_chunks():
                with archive.open(member) as stream:
                    while chunk := stream.read(CHUNK_BYTES):
                        progress.bytes_read += len(chunk)
                        yield chunk
                archive.close()

            return zip_chunks(), _Inflater("plain")

        progress.total_bytes = os.path.getsize(expanded)
        progress.state = "importing"
        label = "csv" if kind == "plain" else kind
        progress.message = f"reading {os.path.basename(expanded)} ({label})"

        def file_chunks():
            with open(expanded, "rb") as handle:
                while chunk := handle.read(CHUNK_BYTES):
                    progress.bytes_read += len(chunk)
                    yield chunk

        return file_chunks(), _Inflater(kind)

    progress.state = "downloading"
    progress.message = "connecting to database.lichess.org"

    def http_chunks():
        headers = {"User-Agent": USER_AGENT}
        try:
            with httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                              headers=headers) as client:
                with client.stream("GET", DATABASE_URL) as response:
                    if response.status_code >= 400:
                        raise PuzzleImportError(
                            f"database.lichess.org returned HTTP {response.status_code}"
                        )
                    length = response.headers.get("Content-Length")
                    progress.total_bytes = (int(length) if length and length.isdigit()
                                            else None)
                    progress.state = "importing"
                    progress.message = "downloading and importing"
                    for chunk in response.iter_bytes(CHUNK_BYTES):
                        progress.bytes_read += len(chunk)
                        yield chunk
        except httpx.HTTPError as e:
            raise PuzzleImportError(f"could not download the puzzle database: {e}")

    # The download is always zstd -- that is what Lichess publishes.
    return http_chunks(), _Inflater("zstd")


def _claim(source_path: str | None) -> ImportProgress:
    """Takes the one-import-at-a-time lock and publishes a fresh progress.

    Done by the *caller*, synchronously, before any worker thread starts.
    Leaving it to the thread leaves a window where the lock is taken but no
    progress is published yet, in which a second request sees "nothing
    running", starts a second thread, and that thread fails to take the lock
    and dies quietly -- so the button says "started" and nothing happens.
    """
    global _current
    if not _lock.acquire(blocking=False):
        raise PuzzleImportError("an import is already running")
    try:
        if source_path:
            expanded = os.path.expanduser(source_path.strip())
            if not os.path.exists(expanded):
                raise PuzzleImportError(
                    f"no such file on the server: {expanded}. This is a path "
                    "on the machine running the app, not on the machine you "
                    "are browsing from."
                )
    except BaseException:
        _lock.release()
        raise
    # Published already started rather than 'idle', so the acknowledgement the
    # button gets back says something true about the job.
    _current = ImportProgress(state="starting", message="starting...")
    return _current


def _release(progress: ImportProgress):
    """Ends an import. The lock goes first and `finished` last, so anything
    that sees the job as finished can immediately start another."""
    _lock.release()
    progress.finished = True


def run_import(filters: ImportFilters, source_path: str | None = None,
               replace: bool = False) -> dict:
    """Downloads (or reads) the database and imports the rows that match.

    Blocking, and meant to be: `start` runs it on a worker thread. Progress
    is published through `current_progress` as it goes, which is only useful
    because nothing here is on the event loop any more.
    """
    progress = _claim(source_path)
    try:
        return _import_into(progress, filters, source_path, replace)
    finally:
        _release(progress)


def _import_into(progress: ImportProgress, filters: ImportFilters,
                 source_path: str | None, replace: bool) -> dict:
    """The work itself, with the lock already held and progress published."""
    writer = None
    pending = ""
    reader_columns: list[str] | None = None
    enough = False

    try:
        # Clearing happens first so that `_open_source` has the last word on
        # the message -- otherwise the line the browser polls says "clearing
        # the previous import" for the entire run, long after it has moved on
        # to reading the file.
        if replace:
            progress.message = "clearing the previous import"
            with db_cursor() as conn:
                conn.execute("DELETE FROM lichess_puzzle_themes")
                conn.execute("DELETE FROM lichess_puzzles")
                conn.execute("DELETE FROM lichess_theme_names")

        chunks, inflater = _open_source(source_path, progress)
        writer = _Writer()

        for chunk in chunks:
            if progress.cancelled or enough:
                break
            text = inflater.feed(chunk).decode("utf-8", "replace")
            if not text:
                continue

            pending += text
            # The last line of a chunk is almost always incomplete; hold it
            # back and glue it to the next chunk.
            lines = pending.split("\n")
            pending = lines.pop()

            if reader_columns is None and lines:
                reader_columns = next(csv.reader([lines.pop(0)]))
                missing = [c for c in REQUIRED_COLUMNS if c not in reader_columns]
                if missing:
                    raise PuzzleImportError(
                        "that file doesn't look like the Lichess puzzle database "
                        f"-- its header is missing {', '.join(missing)}. Expected "
                        "the CSV published at database.lichess.org/#puzzles."
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

        # A file that yielded no header at all never had one: an empty file,
        # or a compressed stream that expanded to nothing.
        if reader_columns is None:
            raise PuzzleImportError(
                "that file has no CSV header in it -- it may be empty, or not "
                "the puzzle database"
            )
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
        raise
    except Exception as e:
        progress.state = "error"
        progress.message = f"{type(e).__name__}: {e}"
        raise
    finally:
        if writer is not None:
            writer.close()


def start(filters: ImportFilters, source_path: str | None = None,
          replace: bool = False) -> dict:
    """Kicks the import off in the background and returns straight away.

    The import takes minutes -- longer if it is downloading a few hundred
    megabytes first -- and holding an HTTP request open for that is how the
    browser ends up reporting "Failed to fetch" on a job that is actually
    running fine. The caller gets an acknowledgement and polls
    `current_progress` instead.

    The lock and the progress object are claimed here, on the calling thread,
    so that by the time this returns a second caller is certain to be told
    "already running" rather than starting a thread that dies quietly.
    """
    progress = _claim(source_path)

    def worker():
        try:
            _import_into(progress, filters, source_path, replace)
        except Exception:
            # Already recorded on the progress object, which is where the
            # browser is looking. Nothing here can re-raise usefully -- there
            # is no request left to fail.
            pass
        finally:
            _release(progress)

    threading.Thread(target=worker, name="lichess-puzzle-import",
                     daemon=True).start()
    return {"started": True, "progress": progress.snapshot()}


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


# ---------------------------------------------------------------------------
# The game a puzzle came from
# ---------------------------------------------------------------------------
#
# A Lichess puzzle row carries a `game_url` but not the game itself -- that
# would multiply the several-hundred-megabyte database import by however many
# moves the average game runs. Blindfold training wants the game, so it is
# fetched lazily, one game at a time, the first time someone actually asks --
# never as a bulk prefetch, since that would mean downloading games for
# puzzles nobody ends up training blindfold on. Every fetch is cached in
# `lichess_game_cache`, keyed by Lichess's own game id and shared across every
# account on this instance: the PGN is the same no matter who asked, so the
# second person to reach for a given puzzle's game gets it for free.

GAME_EXPORT_URL = "https://lichess.org/game/export/{game_id}"

# A single game is a few KB; this is generous headroom, not the several
# hundred megabytes the puzzle database import has to plan for.
GAME_FETCH_TIMEOUT = httpx.Timeout(15.0, connect=10.0, read=15.0)

_GAME_URL_RE = re.compile(r"lichess\.org/([A-Za-z0-9]{8})(?:/(?:white|black))?(?:#(\d+))?")


class GameFetchError(Exception):
    """A Lichess game's PGN couldn't be fetched, parsed, or found."""


def parse_game_url(game_url: str | None) -> str | None:
    """The Lichess game id out of a puzzle's stored `GameUrl`, e.g.
    `https://lichess.org/H2iCLRLW#62` -> `H2iCLRLW`. `None` for anything that
    doesn't parse -- a handful of imported rows carry no game_url at all."""
    if not game_url:
        return None
    match = _GAME_URL_RE.search(game_url)
    return match.group(1) if match else None


def fetch_game_pgn(conn, game_id: str) -> str:
    """The PGN of a Lichess game, fetched once and cached from then on."""
    row = conn.execute(
        "SELECT pgn FROM lichess_game_cache WHERE game_id = ?", (game_id,)
    ).fetchone()
    if row:
        return row["pgn"]

    url = GAME_EXPORT_URL.format(game_id=game_id)
    headers = {"User-Agent": USER_AGENT, "Accept": "application/x-chess-pgn"}
    try:
        response = httpx.get(url, headers=headers, timeout=GAME_FETCH_TIMEOUT,
                             follow_redirects=True)
    except httpx.HTTPError as e:
        raise GameFetchError(f"could not reach lichess.org: {e}")
    if response.status_code == 404:
        raise GameFetchError("that game is no longer on lichess.org")
    if response.status_code >= 400:
        raise GameFetchError(f"lichess.org returned HTTP {response.status_code}")
    pgn = response.text
    if not pgn.strip():
        raise GameFetchError("lichess.org returned an empty game")

    conn.execute(
        "INSERT OR REPLACE INTO lichess_game_cache (game_id, pgn) VALUES (?, ?)",
        (game_id, pgn),
    )
    return pgn


def _fen_key(fen: str) -> str:
    """Piece placement, turn, castling rights and the en passant square --
    the part of a FEN that identifies a position, leaving out the two
    counters that depend on how it was reached and so are the one part of a
    freshly-replayed FEN that could disagree with a stored one over nothing
    that matters."""
    return " ".join(fen.split()[:4])


def locate_in_game(pgn: str, puzzle_fen: str, first_move_uci: str):
    """Where a puzzle's position sits inside the game it came from.

    Replays the whole game and looks for a position matching `puzzle_fen`.
    Returns `(positions, sans, target_halfmoves)`: every position of the game
    as a FEN, the SAN of the move that leads from each to the next, and the
    index into `positions` of the puzzle's own starting position -- from
    which a caller can walk back however many plies a blindfold session
    wants. `None` if the game doesn't contain the position at all, which
    would mean the puzzle and the game it claims to be from have drifted
    apart (a Lichess database inconsistency, not something this app did).

    A position can recur (castling rights and repetition both do this in real
    games), so a lone FEN match isn't trusted on its own: among repeats, the
    one actually followed by the puzzle's own first move -- the opponent's
    setup move, always present -- is preferred, since that is the one
    property a wrong occurrence of the same position is unlikely to share.
    """
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return None

    target_key = _fen_key(puzzle_fen)
    board = game.board()
    positions = [board.fen()]
    sans: list[str] = []
    ucis: list[str] = []
    for move in game.mainline_moves():
        sans.append(board.san(move))
        ucis.append(move.uci())
        board.push(move)
        positions.append(board.fen())

    candidates = [i for i, fen in enumerate(positions) if _fen_key(fen) == target_key]
    if not candidates:
        return None
    matching = [i for i in candidates if i < len(ucis) and ucis[i] == first_move_uci]
    target = matching[0] if matching else candidates[0]
    return positions, sans, target
