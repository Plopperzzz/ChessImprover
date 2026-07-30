"""Downloading a library straight from chess.com, clocks included.

chess.com publishes every finished game through a public, unauthenticated
read-only API, split into one archive per calendar month:

    GET /pub/player/{username}/games/archives   -> the list of month URLs
    GET /pub/player/{username}/games/{YYYY}/{MM}/pgn  -> that month as PGN

The `/pgn` form is used rather than the JSON one because it is the same
multi-game PGN text a manual "download my games" gives you, `%clk` comments
and all -- which means it goes through `parse_games_from_text` unchanged and
lands in `games.clocks_json` exactly like an uploaded file. The think times
are the reason to prefer it: the Elo fit drops moves played instantly, and a
library imported without clocks quietly loses that filter.

Two things about the API that are easy to get wrong and expensive to debug:

* It requires a descriptive `User-Agent`. Cloudflare answers the default
  client UA with 403, which looks like "the player doesn't exist".
* It is rate limited, and parallel requests to it are what trip the limit.
  Months are therefore fetched one at a time, and the frontend asks for a
  small number of them per request so a five-year import is a sequence of
  short calls with a progress line rather than one request that times out.

**Only new games are downloaded.** Games already in the library have always
been skipped at insert (`games.external_id`), but that happened *after*
pulling the whole month down again, so "get my latest games" re-downloaded
years of history to find the four played since Tuesday. Two things now stop
that, in order of how much they save:

* **A finished month is never requested again.** A monthly archive holds the
  games that *ended* in that month, so once the month is over nothing can be
  added to it. A month we read after it ended is final -- there is no point
  even asking whether it changed. This is what turns a ten-year library from
  120 downloads into none.
* **Everything else is asked conditionally.** The current month, and any month
  we happened to read while it was still running, are fetched with chess.com's
  own `ETag`/`Last-Modified` sent back, so an unchanged archive answers 304
  with no body at all.

Both are bookkeeping, not guesswork: what is skipped is recorded in
`chesscom_archives` and reported back, so the browser can say which months it
didn't need rather than silently doing less than you asked.

A deliberate escape hatch remains. `mode="refetch"` ignores all of the above
and pulls the months down in full -- which is what you want after deleting
games from the library and wanting them back, and is the one case the caching
would otherwise make impossible.
"""

import re
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor
from .pgn_parse import account_names, insert_parsed_games, parse_games_from_text

router = APIRouter(prefix="/api/games/chesscom", tags=["games"])

API_ROOT = "https://api.chess.com/pub"

# chess.com asks that clients identify themselves; an anonymous request is
# answered with 403 by their edge. There is no contact address to put here for
# a self-hosted app, so the project name and URL are what it carries.
USER_AGENT = "ChessImprover/1.0 (self-hosted chess analysis; +https://github.com/Plopperzzz/ChessImprover)"

TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# ".../games/2024/07" -- the two trailing path segments are the archive month.
_ARCHIVE_RE = re.compile(r"/games/(\d{4})/(\d{2})/?$")

# How many months one import request will actually *fetch*. The cap exists so
# a request can't sit there for minutes: the caller loops instead, and gets to
# show progress and stop halfway.
#
# Months skipped without a request don't count towards it. That distinction is
# the point: asking for "everything new" over ten years should be one call
# that skips 119 finished months for free and fetches the current one, not
# twenty calls that each do almost nothing.
MAX_MONTHS_PER_REQUEST = 6


def source_name_for(username: str, year: int, month: int) -> str:
    """Where an imported game says it came from. Stable, so re-importing a
    month is recognisable as the same source in the library, and readable,
    since it is what the game picker shows."""
    return f"chess.com/{username}/{year:04d}-{month:02d}"


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=TIMEOUT,
        headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"},
        follow_redirects=True,
    )


def _raise_for(response: httpx.Response, username: str):
    """Turns chess.com's status codes into something a person can act on.
    A bare 'HTTP 404' next to a username they are sure about is not useful;
    'no chess.com player called X' tells them to check the spelling."""
    if response.status_code == 404:
        raise HTTPException(404, f"chess.com has no player called '{username}'")
    if response.status_code == 429:
        raise HTTPException(429, "chess.com is rate limiting this import — wait a minute and carry on")
    if response.status_code == 403:
        raise HTTPException(
            502,
            "chess.com refused the request (403). This usually means their edge is "
            "blocking the server rather than that anything is wrong with the username.",
        )
    if response.status_code >= 400:
        raise HTTPException(502, f"chess.com returned HTTP {response.status_code}")


async def _archive_months(client: httpx.AsyncClient, username: str) -> list[tuple[int, int]]:
    """Every month this player has games in, oldest first, as (year, month)."""
    try:
        response = await client.get(f"{API_ROOT}/player/{username}/games/archives")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"could not reach chess.com: {e}")
    _raise_for(response, username)
    try:
        urls = response.json().get("archives") or []
    except ValueError:
        raise HTTPException(502, "chess.com returned something that isn't JSON")
    months = []
    for url in urls:
        m = _ARCHIVE_RE.search(url)
        if m:
            months.append((int(m.group(1)), int(m.group(2))))
    months.sort()
    return months


def month_ended_before(year: int, month: int, when: datetime) -> bool:
    """Whether the month was already over at `when`.

    The whole "don't ask again" argument rests on this: a monthly archive
    holds the games that ended in that month, so if we read it after the month
    was over, nothing can have been added since.
    """
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return when >= end


def _parse_stamp(raw: str | None) -> datetime | None:
    """A `datetime('now')` string back into a UTC datetime."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _known_archives(conn, user_id: int, username: str) -> dict[tuple[int, int], dict]:
    """What we already know about this player's months, keyed (year, month)."""
    rows = conn.execute(
        """SELECT year, month, etag, last_modified, fetched_at, games
           FROM chesscom_archives WHERE user_id = ? AND username = ?""",
        (user_id, username),
    ).fetchall()
    return {(row["year"], row["month"]): dict(row) for row in rows}


def is_settled(record: dict | None) -> bool:
    """Whether this month is finished and already read, so it can be skipped
    without so much as a conditional request."""
    if not record:
        return False
    fetched = _parse_stamp(record.get("fetched_at"))
    if fetched is None:
        return False
    return month_ended_before(record["year"], record["month"], fetched)


def _remember(conn, user_id: int, username: str, year: int, month: int,
              etag: str | None, last_modified: str | None, games: int):
    conn.execute(
        """INSERT INTO chesscom_archives
             (user_id, username, year, month, etag, last_modified, fetched_at, games)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(user_id, username, year, month) DO UPDATE SET
             etag = excluded.etag,
             last_modified = excluded.last_modified,
             fetched_at = excluded.fetched_at,
             games = excluded.games""",
        (user_id, username, year, month, etag, last_modified, games),
    )


async def _month_pgn(client: httpx.AsyncClient, username: str, year: int, month: int,
                     known: dict | None = None) -> dict:
    """One month's PGN, asked for conditionally when we've read it before.

    Returns `{"status": ..., "text": ..., "etag": ..., "last_modified": ...}`.
    A status of 304 means the archive is byte-for-byte what we already have
    and `text` is empty -- chess.com sent no body, which is the entire saving.
    """
    url = f"{API_ROOT}/player/{username}/games/{year:04d}/{month:02d}/pgn"
    headers = {}
    if known:
        # Both validators when we have both: a server may honour either, and
        # sending both is what the spec asks for.
        if known.get("etag"):
            headers["If-None-Match"] = known["etag"]
        if known.get("last_modified"):
            headers["If-Modified-Since"] = known["last_modified"]
    try:
        response = await client.get(url, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"could not reach chess.com: {e}")

    if response.status_code == 304:
        return {"status": 304, "text": "",
                # Keep the validators we sent: a 304 doesn't have to repeat
                # them, and dropping them would make the next request
                # unconditional again.
                "etag": (known or {}).get("etag"),
                "last_modified": (known or {}).get("last_modified")}

    # A month with no games 404s on some accounts rather than returning an
    # empty body. That is not an error worth failing a multi-month import
    # over, so it comes back as "nothing here" and the loop moves on.
    if response.status_code == 404:
        return {"status": 404, "text": "", "etag": None, "last_modified": None}
    _raise_for(response, username)
    return {
        "status": response.status_code,
        "text": response.text,
        "etag": response.headers.get("ETag"),
        "last_modified": response.headers.get("Last-Modified"),
    }


def _clean_username(raw: str) -> str:
    """chess.com handles are case-insensitive and the API wants them
    lowercased. Pasting a profile URL instead of a handle is common enough to
    be worth accepting."""
    name = (raw or "").strip().lower()
    if "chess.com" in name:
        name = name.rstrip("/").rsplit("/", 1)[-1]
    if not name:
        raise HTTPException(400, "a chess.com username is required")
    return name


def _imported_counts(conn, user_id: int, username: str) -> dict[str, int]:
    """How many games are already in the library from each month of this
    player, keyed 'YYYY-MM'. The month list shows it so a repeat import is an
    informed choice rather than a guess at what you already have."""
    rows = conn.execute(
        "SELECT source_name, COUNT(*) AS n FROM games "
        "WHERE user_id = ? AND source_name LIKE ? GROUP BY source_name",
        (user_id, f"chess.com/{username}/%"),
    ).fetchall()
    return {row["source_name"].rsplit("/", 1)[-1]: row["n"] for row in rows}


class ArchivesIn(BaseModel):
    username: str


@router.post("/archives")
async def list_archives(body: ArchivesIn, user: dict = Depends(require_user)):
    """The months this player has games in, newest first, each marked with how
    many of its games are already in the library and whether it is finished.

    `settled` is what the "download new games" button reads: a settled month
    is over and already read, so it will be skipped without a request. It is
    reported rather than merely acted on, because "I asked for ten years and
    it downloaded one month" needs to be visibly a decision, not a bug.
    """
    username = _clean_username(body.username)
    async with _client() as client:
        months = await _archive_months(client, username)
    with db_cursor() as conn:
        already = _imported_counts(conn, user["id"], username)
        known = _known_archives(conn, user["id"], username)
    out = []
    settled_count = 0
    for year, month in reversed(months):
        label = f"{year:04d}-{month:02d}"
        record = known.get((year, month))
        settled = is_settled(record)
        settled_count += 1 if settled else 0
        out.append({"year": year, "month": month, "label": label,
                    "imported": already.get(label, 0),
                    "settled": settled,
                    "checked_at": (record or {}).get("fetched_at")})
    return {"username": username, "months": out,
            # So the browser can say "1 month to check" before doing anything.
            "settled": settled_count,
            "to_check": len(out) - settled_count}


class ImportIn(BaseModel):
    username: str
    # 'YYYY-MM' labels, exactly as /archives returned them.
    months: list[str]
    # Optional group to file the new games into as they land, so "download my
    # tournament month into its own group" is one action rather than an
    # import followed by hunting the same games back down in the picker.
    collection_id: int | None = None
    # 'new'     -- skip finished months already read, ask conditionally
    #              otherwise, and keep only games not already held.
    # 'refetch' -- download every named month in full regardless. The way to
    #              get back games deleted from the library, which the caching
    #              would otherwise make impossible.
    mode: str = "new"


def _parse_label(label: str) -> tuple[int, int]:
    try:
        year_s, month_s = label.strip().split("-")
        year, month = int(year_s), int(month_s)
    except (ValueError, AttributeError):
        raise HTTPException(400, f"'{label}' is not a YYYY-MM month")
    if not (1 <= month <= 12) or year < 1000:
        raise HTTPException(400, f"'{label}' is not a YYYY-MM month")
    return year, month


@router.post("/import")
async def import_months(body: ImportIn, user: dict = Depends(require_user)):
    """Downloads what's new in the named months and files it in the library.

    Three layers stop the same game being fetched or stored twice, and they
    are separate on purpose because each catches what the one below can't:

    1. **A finished month already read is not requested at all.** Its archive
       can never gain a game, so there is nothing to ask about.
    2. **Everything else is requested conditionally.** An unchanged archive
       answers 304 with no body.
    3. **A game already held is not stored again.** chess.com gives every game
       a permanent `Link`, recorded on the row the first time it lands (see
       `games.external_id`), so even a month that really did change only
       contributes the games played since last time.

    `mode="refetch"` turns off 1 and 2 but not 3.
    """
    username = _clean_username(body.username)
    if body.mode not in ("new", "refetch"):
        raise HTTPException(400, "mode must be 'new' or 'refetch'")
    if not body.months:
        raise HTTPException(400, "no months selected")
    wanted = [_parse_label(label) for label in body.months]

    if body.mode == "refetch" and len(wanted) > MAX_MONTHS_PER_REQUEST:
        raise HTTPException(
            400,
            f"at most {MAX_MONTHS_PER_REQUEST} months per request — "
            "ask for the rest in a second call",
        )

    # Checked before anything is downloaded: failing after a five-minute
    # import because the group was deleted in another tab would be rude.
    collection_id = body.collection_id
    if collection_id is not None:
        with db_cursor() as conn:
            if not conn.execute(
                "SELECT 1 FROM collections WHERE id = ? AND user_id = ?",
                (collection_id, user["id"]),
            ).fetchone():
                raise HTTPException(404, "no such group")

    with db_cursor() as conn:
        known = _known_archives(conn, user["id"], username)

    names = account_names(user)
    # Downloading happens outside the database transaction: a slow month
    # shouldn't hold a write lock, and nothing is inserted until its text is
    # actually in hand.
    downloaded: list[tuple[int, int, dict]] = []
    settled_months: list[str] = []
    remaining: list[str] = []
    fetched = 0

    async with _client() as client:
        for year, month in wanted:
            label = f"{year:04d}-{month:02d}"
            record = known.get((year, month))
            if body.mode == "new" and is_settled(record):
                # Over, and already read. Nothing can have been added to it.
                settled_months.append(label)
                continue
            if fetched >= MAX_MONTHS_PER_REQUEST:
                # The cap counts downloads, not months considered, so asking
                # for ten years of archive is one call that skips the settled
                # ones for free and fetches a handful.
                remaining.append(label)
                continue
            fetched += 1
            result = await _month_pgn(
                client, username, year, month,
                known=record if body.mode == "new" else None,
            )
            downloaded.append((year, month, result))

    months_out = []
    total_added = total_skipped = total_clocked = 0
    unchanged = 0
    with db_cursor() as conn:
        for label in settled_months:
            months_out.append({"month": label, "added": 0, "skipped": 0,
                               "with_clocks": 0, "state": "settled"})

        seen = {
            row["external_id"]
            for row in conn.execute(
                "SELECT external_id FROM games WHERE user_id = ? AND external_id IS NOT NULL",
                (user["id"],),
            )
        }
        batch_index = 0
        for year, month, result in downloaded:
            label = f"{year:04d}-{month:02d}"
            raw_text = result["text"]

            if result["status"] == 304:
                # chess.com says the archive is exactly what we already read.
                # Refresh `fetched_at` so that, if the month has since ended,
                # it counts as settled next time and isn't even asked about.
                _remember(conn, user["id"], username, year, month,
                          result["etag"], result["last_modified"],
                          (known.get((year, month)) or {}).get("games", 0))
                unchanged += 1
                months_out.append({"month": label, "added": 0, "skipped": 0,
                                   "with_clocks": 0, "state": "unchanged"})
                continue

            source_name = source_name_for(username, year, month)
            games = parse_games_from_text(source_name, raw_text, names) if raw_text.strip() else []
            _remember(conn, user["id"], username, year, month,
                      result["etag"], result["last_modified"], len(games))

            fresh = []
            skipped = 0
            for g in games:
                external_id = g.get("external_id")
                if external_id and external_id in seen:
                    skipped += 1
                    continue
                if external_id:
                    seen.add(external_id)
                fresh.append(g)
            if not fresh:
                months_out.append({"month": label, "added": 0, "skipped": skipped,
                                   "with_clocks": 0,
                                   "state": "nothing new" if skipped else "empty"})
                total_skipped += skipped
                continue

            cur = conn.execute(
                "INSERT INTO uploads (user_id, source_name, raw_text) VALUES (?, ?, ?)",
                (user["id"], source_name, raw_text),
            )
            upload_id = cur.lastrowid
            ids = insert_parsed_games(conn, user["id"], upload_id, fresh, batch_index)
            batch_index += len(ids)
            clocked = sum(1 for g in fresh if g.get("clocks_json"))
            if collection_id:
                conn.executemany(
                    "INSERT OR IGNORE INTO game_collections (collection_id, game_id) VALUES (?, ?)",
                    [(collection_id, game_id) for game_id in ids],
                )
            months_out.append({"month": label, "added": len(fresh), "skipped": skipped,
                               "with_clocks": clocked, "state": "new games"})
            total_added += len(fresh)
            total_skipped += skipped
            total_clocked += clocked

    return {
        "username": username,
        "added": total_added,
        "skipped": total_skipped,
        # Reported separately because it is the point of importing this way:
        # a game without clocks sits out the instant-move filter in the Elo
        # fit, and a whole library of them changes what the numbers mean.
        "with_clocks": total_clocked,
        # What the caching actually saved, so "it only downloaded one month"
        # reads as a decision rather than a failure.
        "downloaded": fetched,
        "settled": len(settled_months),
        "unchanged": unchanged,
        # Months the per-request cap didn't reach. The browser loops on this
        # rather than slicing the list itself, because only the server knows
        # which months cost a request.
        "remaining": remaining,
        "months": months_out,
    }
