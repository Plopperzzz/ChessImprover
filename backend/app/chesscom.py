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
"""

import re

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

# How many months one import request will fetch. The cap exists so a request
# can't sit there for minutes: the caller loops instead, and gets to show
# progress and stop halfway.
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


async def _month_pgn(client: httpx.AsyncClient, username: str, year: int, month: int) -> str:
    url = f"{API_ROOT}/player/{username}/games/{year:04d}/{month:02d}/pgn"
    try:
        response = await client.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"could not reach chess.com: {e}")
    # A month with no games 404s on some accounts rather than returning an
    # empty body. That is not an error worth failing a multi-month import
    # over, so it comes back as "nothing here" and the loop moves on.
    if response.status_code == 404:
        return ""
    _raise_for(response, username)
    return response.text


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
    many of its games are already in the library."""
    username = _clean_username(body.username)
    async with _client() as client:
        months = await _archive_months(client, username)
    with db_cursor() as conn:
        already = _imported_counts(conn, user["id"], username)
    out = []
    for year, month in reversed(months):
        label = f"{year:04d}-{month:02d}"
        out.append({"year": year, "month": month, "label": label,
                    "imported": already.get(label, 0)})
    return {"username": username, "months": out}


class ImportIn(BaseModel):
    username: str
    # 'YYYY-MM' labels, exactly as /archives returned them.
    months: list[str]
    # Optional group to file the new games into as they land, so "download my
    # tournament month into its own group" is one action rather than an
    # import followed by hunting the same games back down in the picker.
    collection_id: int | None = None


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
    """Downloads the named months and files their games in the library.

    Games already imported are skipped rather than duplicated: chess.com gives
    every game a permanent `Link` header, which is recorded on the row the
    first time it lands (see `games.external_id`). That makes re-importing the
    current month -- the normal way to pick up the games played since the last
    import -- cost nothing but the download.
    """
    username = _clean_username(body.username)
    if not body.months:
        raise HTTPException(400, "no months selected")
    if len(body.months) > MAX_MONTHS_PER_REQUEST:
        raise HTTPException(
            400,
            f"at most {MAX_MONTHS_PER_REQUEST} months per request — "
            "ask for the rest in a second call",
        )
    wanted = [_parse_label(label) for label in body.months]

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

    names = account_names(user)
    # Downloading happens outside the database transaction: a slow month
    # shouldn't hold a write lock, and nothing is inserted until its text is
    # actually in hand.
    downloaded: list[tuple[int, int, str]] = []
    async with _client() as client:
        for year, month in wanted:
            downloaded.append((year, month, await _month_pgn(client, username, year, month)))

    months_out = []
    total_added = total_skipped = total_clocked = 0
    with db_cursor() as conn:
        seen = {
            row["external_id"]
            for row in conn.execute(
                "SELECT external_id FROM games WHERE user_id = ? AND external_id IS NOT NULL",
                (user["id"],),
            )
        }
        batch_index = 0
        for year, month, raw_text in downloaded:
            label = f"{year:04d}-{month:02d}"
            source_name = source_name_for(username, year, month)
            games = parse_games_from_text(source_name, raw_text, names) if raw_text.strip() else []
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
                                   "with_clocks": 0})
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
                               "with_clocks": clocked})
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
        "months": months_out,
    }
