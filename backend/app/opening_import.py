"""Build the opening database from a PGN dump.

    python -m app.opening_import /path/to/LumbrasGigaBase.pgn

Run from `backend/`. This is a one-off (or occasional) job, not something the
server does: a giga-base is millions of games, and the whole point of the
positions table is that the walk over them happens once.

Only the first `--max-plies` moves of each game are indexed. That is not a
shortcut -- past the opening, positions stop repeating between games, so every
extra ply adds rows that will only ever be seen once and can't tell you
anything about what people play.

The reader here is deliberately hand-rolled rather than `chess.pgn.read_game`.
It reads only the four headers this needs and stops pushing moves at the ply
limit, which on a file this size is the difference between an afternoon and a
coffee.
"""

import argparse
import bz2
import gzip
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone

import chess

from .openings import DB_PATH, SCHEMA, position_key

RESULTS = {"1-0": 0, "1/2-1/2": 1, "0-1": 2, "*": None}
MOVE_NUMBER = re.compile(r"\d+\.(?:\.\.)?")
TRAILING_ANNOTATION = re.compile(r"[!?]+$")
HEADER = re.compile(r'^\[([A-Za-z0-9_]+)\s+"(.*)"\]\s*$')
WANTED_HEADERS = ("Result", "WhiteElo", "BlackElo", "Date")


def open_pgn(path: str):
    """Plain, gzipped or bzipped -- giga-bases are usually shipped compressed
    and there is no reason to make someone unpack 30GB first."""
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    if path.endswith(".bz2"):
        return bz2.open(path, "rt", encoding="utf-8", errors="replace")
    if path.endswith(".zst"):
        try:
            import zstandard
        except ImportError:
            raise SystemExit(
                f"{path} is zstd-compressed; `pip install zstandard` or unpack it first"
            )
        fh = open(path, "rb")
        return zstandard.ZstdDecompressor().stream_reader(fh)
    return open(path, "rt", encoding="utf-8", errors="replace")


def strip_movetext(text: str) -> str:
    """Comments, variations and NAGs out; moves and results left. Brace
    comments and parenthesised variations both nest and both run across
    lines, so this walks the string rather than reaching for a regex."""
    out = []
    depth_brace = 0
    depth_paren = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "{":
            depth_brace += 1
        elif ch == "}":
            depth_brace = max(0, depth_brace - 1)
        elif ch == ";" and not depth_brace and not depth_paren:
            # Rest-of-line comment.
            nl = text.find("\n", i)
            i = len(text) if nl == -1 else nl
            continue
        elif not depth_brace and ch == "(":
            depth_paren += 1
        elif not depth_brace and ch == ")":
            depth_paren = max(0, depth_paren - 1)
        elif not depth_brace and not depth_paren:
            out.append(ch)
        i += 1
    return "".join(out)


def san_tokens(movetext: str):
    """The moves of the mainline, in order."""
    text = MOVE_NUMBER.sub(" ", strip_movetext(movetext))
    for token in text.split():
        if token in RESULTS:
            return
        if token[0] in "$%":
            continue
        token = TRAILING_ANNOTATION.sub("", token)
        if token:
            yield token


def read_games(handle):
    """Yields (headers, movetext) per game. A PGN game is a header block, a
    blank line, then movetext -- but exports disagree about blank lines inside
    movetext, so a game ends at the header line that starts the next one."""
    headers: dict[str, str] = {}
    movetext: list[str] = []
    in_headers = False
    for line in handle:
        stripped = line.strip()
        if stripped.startswith("["):
            match = HEADER.match(stripped)
            if match:
                if not in_headers and movetext:
                    yield headers, " ".join(movetext)
                    headers, movetext = {}, []
                in_headers = True
                if match.group(1) in WANTED_HEADERS:
                    headers[match.group(1)] = match.group(2)
                continue
        if not stripped:
            continue
        in_headers = False
        movetext.append(stripped)
    if movetext:
        yield headers, " ".join(movetext)


def rating_of(headers: dict) -> tuple[int, int]:
    """(sum, count) of the two players' ratings, skipping the ones that aren't
    there. Half a rated game is still worth averaging."""
    total = count = 0
    for key in ("WhiteElo", "BlackElo"):
        raw = headers.get(key, "")
        if raw.isdigit():
            value = int(raw)
            if value:
                total += value
                count += 1
    return total, count


def year_of(headers: dict) -> int:
    date = headers.get("Date", "")
    head = date.split(".")[0]
    return int(head) if head.isdigit() else 0


def flush(conn, counts: dict) -> None:
    if not counts:
        return
    conn.executemany(
        """INSERT INTO positions (pos, uci, san, white, draws, black, rating_sum, rating_n)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pos, uci) DO UPDATE SET
             white      = white      + excluded.white,
             draws      = draws      + excluded.draws,
             black      = black      + excluded.black,
             rating_sum = rating_sum + excluded.rating_sum,
             rating_n   = rating_n   + excluded.rating_n""",
        [(pos, uci, *rest) for (pos, uci), rest in counts.items()],
    )
    conn.commit()
    counts.clear()


def build(args) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    if args.reset and os.path.isfile(args.out):
        os.remove(args.out)
    conn = sqlite3.connect(args.out)
    conn.executescript(SCHEMA)
    # This is a rebuildable derived file, so durability during the build buys
    # nothing: if it dies halfway the answer is to run it again.
    conn.execute("PRAGMA journal_mode = OFF")
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA cache_size = -200000")   # ~200MB

    counts: dict[tuple[str, str], list] = {}
    kept = skipped = 0
    started = time.time()

    for path in args.pgn:
        with open_pgn(path) as handle:
            for headers, movetext in read_games(handle):
                outcome = RESULTS.get(headers.get("Result", "*"))
                if outcome is None:
                    skipped += 1
                    continue
                rating_sum, rating_n = rating_of(headers)
                average = rating_sum / rating_n if rating_n else 0
                if args.min_elo and average < args.min_elo:
                    skipped += 1
                    continue
                if args.since and year_of(headers) < args.since:
                    skipped += 1
                    continue

                board = chess.Board()
                plies = 0
                for token in san_tokens(movetext):
                    if plies >= args.max_plies:
                        break
                    try:
                        move = board.parse_san(token)
                    except ValueError:
                        # One unreadable move ends this game's contribution;
                        # everything up to it is still perfectly good data.
                        break
                    key = (position_key(board), move.uci())
                    row = counts.get(key)
                    if row is None:
                        row = counts[key] = [token, 0, 0, 0, 0, 0]
                    row[1 + outcome] += 1
                    row[4] += rating_sum
                    row[5] += rating_n
                    board.push(move)
                    plies += 1

                kept += 1
                if kept % args.progress_every == 0:
                    rate = kept / max(1e-6, time.time() - started)
                    print(
                        f"  {kept:,} games ({rate:,.0f}/s), {len(counts):,} pending rows",
                        file=sys.stderr, flush=True,
                    )
                if len(counts) >= args.flush_rows:
                    flush(conn, counts)
                if args.limit and kept >= args.limit:
                    break
        if args.limit and kept >= args.limit:
            break

    flush(conn, counts)

    positions = conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
    previous = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    sources = [s for s in previous.get("sources", "").split("\n") if s]
    sources += [os.path.basename(p) for p in args.pgn]
    meta = {
        "games": str(int(previous.get("games", 0)) + kept),
        "positions": str(positions),
        "max_plies": str(args.max_plies),
        "min_elo": str(args.min_elo),
        "sources": "\n".join(dict.fromkeys(sources)),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    conn.executemany(
        "INSERT INTO meta (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        list(meta.items()),
    )
    conn.commit()
    print(f"Compacting {args.out}...", file=sys.stderr, flush=True)
    conn.execute("VACUUM")
    conn.close()

    elapsed = time.time() - started
    print(
        f"Indexed {kept:,} games ({skipped:,} skipped) into {positions:,} rows"
        f" in {elapsed / 60:.1f} min -> {args.out}",
        file=sys.stderr,
    )


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(
        description="Index a PGN library into the opening database the board reads."
    )
    parser.add_argument("pgn", nargs="+", help="PGN files (.pgn, .pgn.gz, .pgn.bz2, .pgn.zst)")
    parser.add_argument("--out", default=os.path.abspath(DB_PATH), help="database to write")
    parser.add_argument(
        "--max-plies", type=int, default=24,
        help="how deep to index, in half-moves (default 24, i.e. 12 moves a side)",
    )
    parser.add_argument(
        "--min-elo", type=int, default=0,
        help="skip games whose players average below this (0 = keep everything)",
    )
    parser.add_argument("--since", type=int, default=0, help="skip games played before this year")
    parser.add_argument("--limit", type=int, default=0, help="stop after this many games (for a trial run)")
    parser.add_argument(
        "--reset", action="store_true",
        help="delete the existing database first, rather than adding to it",
    )
    parser.add_argument("--flush-rows", type=int, default=2_000_000, help=argparse.SUPPRESS)
    parser.add_argument("--progress-every", type=int, default=100_000, help=argparse.SUPPRESS)
    build(parser.parse_args(argv))


if __name__ == "__main__":
    main()
