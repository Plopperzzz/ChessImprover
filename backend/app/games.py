from typing import NamedTuple

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor
from .pgn_parse import (
    FILTER_SPEEDS,
    account_names,
    insert_parsed_games,
    parse_games_from_text,
    reassign_your_colors,
)
from .runs import analyzed_game_ids, estimated_elos

router = APIRouter(prefix="/api/games", tags=["games"])


@router.post("/upload")
async def upload_games(
    files: list[UploadFile] = File(default=[]),
    pasted_pgn: str = Form(default=""),
    user: dict = Depends(require_user),
):
    sources: list[tuple[str, str]] = []
    for f in files:
        raw = (await f.read()).decode("utf-8", errors="replace")
        sources.append((f.filename or "upload.pgn", raw))
    if pasted_pgn.strip():
        sources.append(("pasted", pasted_pgn))

    if not sources:
        raise HTTPException(400, "no PGN files or pasted text provided")

    created = []
    with db_cursor() as conn:
        batch_index = 0
        for source_name, raw_text in sources:
            cur = conn.execute(
                "INSERT INTO uploads (user_id, source_name, raw_text) VALUES (?, ?, ?)",
                (user["id"], source_name, raw_text),
            )
            upload_id = cur.lastrowid
            games = parse_games_from_text(source_name, raw_text, account_names(user))
            if not games:
                continue
            # `external_id` is recorded here too, even though this path never
            # dedupes: a chess.com import run afterwards can then tell that a
            # month you already uploaded by hand is the same set of games.
            ids = insert_parsed_games(conn, user["id"], upload_id, games, batch_index)
            for offset, (game_id, g) in enumerate(zip(ids, games)):
                created.append({"id": game_id, "batch_index": batch_index + offset, **g})
            batch_index += len(ids)

    if not created:
        raise HTTPException(400, "no games could be parsed from the given input")
    return {"created": len(created), "games": [_summarize(g) for g in created]}


def _summarize(row: dict) -> dict:
    return {
        "id": row["id"],
        "batch_index": row["batch_index"],
        "source_name": row["source_name"],
        "white": row["white"],
        "black": row["black"],
        "result": row["result"],
        "utc_date_header": row["utc_date_header"],
        "date_header": row["date_header"],
        "year": row["year"],
        "month": row["month"],
        "your_color": row["your_color"],
    }



# Which database a game belongs to, read off `source_name` rather than a
# stored column: every path that inserts a game already writes one of exactly
# three shapes there -- `chess.com/{user}/{yyyy-mm}` (chesscom.import_months),
# the literal `play-vs-maia` (play.PlaySession.save_to_library), or a filename
# / `pasted` (games.upload_games) -- so the split is free and can't drift out
# of sync with a second column nobody remembered to set. New databases are a
# new prefix here, not a migration.
GAME_DATABASES = ("library", "chesscom", "played")
DATABASE_LABELS = {"library": "My library", "chesscom": "Chess.com", "played": "Played vs Maia"}


def game_database(source_name: str) -> str:
    if source_name == "play-vs-maia":
        return "played"
    if source_name.startswith("chess.com/"):
        return "chesscom"
    return "library"


def game_filter_sql(user_id: int, speed: str | None = None,
                    time_control: str | None = None,
                    collection_id: int | None = None,
                    database: str | None = None) -> tuple[str, list]:
    """The WHERE fragment and parameters shared by everything that works on a
    filtered slice of the library -- the picker, bulk delete, batch analysis.

    Kept in one function so those three can never disagree about what the
    filter means, which is what makes "delete everything I'm looking at" safe
    to offer at all.
    """
    where = ["g.user_id = ?"]
    params: list = [user_id]
    if speed:
        # 'unknown' is a real choice, not a missing one: it selects exactly the
        # games whose export carried no usable TimeControl, which is the set
        # you want when working out why some games aren't in a bucket.
        if speed == "unknown":
            where.append("g.speed IS NULL")
        else:
            where.append("g.speed = ?")
            params.append(speed)
    if time_control:
        where.append("g.time_control = ?")
        params.append(time_control)
    if collection_id is not None:
        where.append(
            "EXISTS (SELECT 1 FROM game_collections gc "
            "WHERE gc.game_id = g.id AND gc.collection_id = ?)"
        )
        params.append(collection_id)
    if database == "played":
        where.append("g.source_name = 'play-vs-maia'")
    elif database == "chesscom":
        where.append("g.source_name LIKE 'chess.com/%'")
    elif database == "library":
        where.append("g.source_name != 'play-vs-maia' AND g.source_name NOT LIKE 'chess.com/%'")
    return " AND ".join(where), params


class LibraryFilter(NamedTuple):
    """A slice of the library, as a value that can be passed around.

    The fragment above is the shared *SQL*; this is the shared *choice*, for
    the callers that have to carry it through several layers before it reaches
    a query -- the Progress fits pass one down from the endpoint into the
    pooled collect. Bundling the fields keeps that from turning every
    signature on the way into four more optional arguments.
    """
    speed: str | None = None
    time_control: str | None = None
    collection_id: int | None = None
    database: str | None = None

    @property
    def active(self) -> bool:
        return any(v is not None for v in self)

    def where(self, user_id: int) -> tuple[str, list]:
        return game_filter_sql(user_id, self.speed, self.time_control, self.collection_id,
                               self.database)

    def as_dict(self) -> dict:
        return self._asdict()


def library_filter(speed: str | None = None, time_control: str | None = None,
                   collection_id: int | None = None,
                   database: str | None = None) -> LibraryFilter:
    """FastAPI dependency: the same four query parameters everywhere the
    library can be sliced, so the Games list and the Progress fits can't end up
    spelling them differently.

    A speed or database outside the known set is rejected rather than quietly
    matching no games: an empty panel that should have been full is a much
    harder thing to diagnose than a 400.
    """
    if speed is not None and speed not in FILTER_SPEEDS:
        raise HTTPException(400, f"speed must be one of {', '.join(FILTER_SPEEDS)}")
    if database is not None and database not in GAME_DATABASES:
        raise HTTPException(400, f"database must be one of {', '.join(GAME_DATABASES)}")
    return LibraryFilter(speed, time_control, collection_id, database)


@router.get("")
def list_games(filters: LibraryFilter = Depends(library_filter),
               user: dict = Depends(require_user)):
    """The library, optionally filtered.

    Filtering happens here rather than in the browser so that the counts the
    picker shows, the ids a bulk action applies to and the games a batch runs
    over are all the same set, decided once.
    """
    where, params = filters.where(user["id"])
    with db_cursor() as conn:
        rows = conn.execute(
            f"""SELECT g.id, g.batch_index, g.source_name, g.white, g.black, g.result,
                       g.date_header, g.utc_date_header, g.year, g.month, g.your_color,
                       g.your_color_locked, g.time_control, g.speed,
                       g.clocks_json IS NOT NULL AS has_clocks
                FROM games g WHERE {where} ORDER BY g.id""",
            params,
        ).fetchall()
        # Which groups each game is in, in one query rather than per row.
        membership: dict[int, list[int]] = {}
        for row in conn.execute(
            """SELECT gc.game_id, gc.collection_id FROM game_collections gc
               JOIN games g ON g.id = gc.game_id WHERE g.user_id = ?""",
            (user["id"],),
        ):
            membership.setdefault(row["game_id"], []).append(row["collection_id"])
    # One lookup for the whole list rather than a request per row, so the
    # picker can mark which games already have a saved analysis, and show the
    # Elo the sweep estimated for your side without opening the game first.
    analysed = analyzed_game_ids(user["id"])
    sweeps = estimated_elos(user["id"])

    def estimate_for(row) -> int | None:
        results = sweeps.get(row["id"])
        side = row["your_color"]
        if not results or side not in ("w", "b"):
            return None
        value = (results.get(side) or {}).get("estimate")
        return int(value) if isinstance(value, (int, float)) else None

    return [{**dict(r), "analyzed": analysed.get(r["id"]),
             # None means "no sweep has been run", which the picker draws as a
             # placeholder rather than leaving the row a different height.
             "estimated_elo": estimate_for(r),
             "collection_ids": membership.get(r["id"], []),
             "database": game_database(r["source_name"])} for r in rows]


@router.get("/facets")
def game_facets(database: str | None = None, user: dict = Depends(require_user)):
    """What time controls the library actually contains, and how many games
    each has -- grouped into speeds the way chess.com's own picker is -- plus
    how many games sit in each database.

    The filter is built from this rather than from a fixed list of controls:
    offering "20 sec + 1" to someone who has never played one is noise, and a
    control this app has never heard of still has to be filterable.

    `database`, when given, scopes the *speed* breakdown to that database --
    the point of picking "Chess.com" is not being offered a bullet filter that
    only your played-vs-Maia games ever used. The database breakdown itself is
    always the whole library: it's the list of tabs to choose from, not a
    figure that changes depending which one is already selected.
    """
    if database is not None and database not in GAME_DATABASES:
        raise HTTPException(400, f"database must be one of {', '.join(GAME_DATABASES)}")
    where, params = game_filter_sql(user["id"], database=database)
    with db_cursor() as conn:
        rows = conn.execute(
            f"""SELECT speed, time_control, COUNT(*) AS games
               FROM games g WHERE {where}
               GROUP BY speed, time_control""",
            params,
        ).fetchall()
        source_names = [
            r["source_name"] for r in
            conn.execute("SELECT source_name FROM games WHERE user_id = ?", (user["id"],))
        ]
    speeds: dict[str, dict] = {}
    for row in rows:
        speed = row["speed"] or "unknown"
        bucket = speeds.setdefault(speed, {"speed": speed, "games": 0, "controls": []})
        bucket["games"] += row["games"]
        if row["time_control"]:
            bucket["controls"].append({"time_control": row["time_control"],
                                       "games": row["games"]})
    # Fastest first, matching the picker people are used to, with anything
    # unclassifiable last rather than mixed in.
    order = FILTER_SPEEDS
    for bucket in speeds.values():
        # Within a speed, the control you played most is the one you want
        # first -- an alphabetical list of '1200' and '600+5' helps nobody.
        bucket["controls"].sort(key=lambda c: (-c["games"], c["time_control"]))

    database_counts: dict[str, int] = {}
    for source_name in source_names:
        key = game_database(source_name)
        database_counts[key] = database_counts.get(key, 0) + 1
    databases = [
        {"database": d, "label": DATABASE_LABELS[d], "games": database_counts.get(d, 0)}
        for d in GAME_DATABASES
    ]

    return {"speeds": [speeds[s] for s in order if s in speeds],
            "total": sum(b["games"] for b in speeds.values()),
            "databases": databases}


class BulkDeleteIn(BaseModel):
    """Either an explicit list of ids, or 'everything matching this filter'.

    The filter form exists because the list form can't express "all 900 of my
    bullet games" without the browser first fetching 900 ids and posting them
    back. It is deliberately the same filter the picker was showing.
    """
    game_ids: list[int] | None = None
    speed: str | None = None
    time_control: str | None = None
    collection_id: int | None = None
    database: str | None = None


@router.post("/bulk-delete")
def bulk_delete(body: BulkDeleteIn, user: dict = Depends(require_user)):
    """Deletes many games at once, with their analyses, puzzles and group
    memberships going by cascade.

    Requires either explicit ids or at least one filter: an empty body would
    otherwise mean "delete my entire library", which is not something a
    dropped field should be able to say.
    """
    has_filter = any(
        v is not None for v in (body.speed, body.time_control, body.collection_id, body.database)
    )
    if body.game_ids is None and not has_filter:
        raise HTTPException(400, "give either game_ids or a filter to delete by")

    where, params = game_filter_sql(user["id"], body.speed, body.time_control,
                                    body.collection_id, body.database)
    if body.game_ids is not None:
        if not body.game_ids:
            return {"deleted": 0, "uploads_removed": 0}
        unique = list(dict.fromkeys(body.game_ids))
        where += f" AND g.id IN ({', '.join('?' * len(unique))})"
        params += unique

    with db_cursor() as conn:
        rows = conn.execute(
            f"SELECT g.id, g.upload_id FROM games g WHERE {where}", params
        ).fetchall()
        if not rows:
            return {"deleted": 0, "uploads_removed": 0}
        ids = [row["id"] for row in rows]
        touched_uploads = {row["upload_id"] for row in rows}
        conn.executemany("DELETE FROM games WHERE id = ?", [(i,) for i in ids])
        # Same rule as the single delete: an upload whose last game is gone
        # leaves nothing but a PGN blob nobody can reach.
        removed = 0
        for upload_id in touched_uploads:
            remaining = conn.execute(
                "SELECT COUNT(*) AS n FROM games WHERE upload_id = ?", (upload_id,)
            ).fetchone()["n"]
            if remaining == 0:
                conn.execute("DELETE FROM uploads WHERE id = ?", (upload_id,))
                removed += 1
    return {"deleted": len(ids), "uploads_removed": removed}


@router.post("/rematch-colors")
def rematch_colors(user: dict = Depends(require_user)):
    """Re-runs the White/Black match over the whole library using the account's
    current names. An account rename already does this; this is for the games
    that were uploaded under a name that has since been corrected some other
    way, and for seeing the result without renaming anything."""
    with db_cursor() as conn:
        return reassign_your_colors(conn, user["id"], account_names(user))


class ColorIn(BaseModel):
    your_color: str


@router.patch("/{game_id}/color")
def set_your_color(game_id: int, body: ColorIn, user: dict = Depends(require_user)):
    """Assigns which side of one game was yours, by hand.

    Header matching can't win every time -- a game played under an alt handle,
    or a team event that lists a club name -- so a game stuck on 'unassigned'
    needs a way out that doesn't involve renaming the account. The choice is
    marked locked so a later rename doesn't quietly overwrite it. Puzzles
    built for the other side are dropped, since they came from moves that are
    now the opponent's.
    """
    colour = body.your_color.strip().lower()
    if colour not in ("w", "b", "unassigned"):
        raise HTTPException(400, "your_color must be 'w', 'b' or 'unassigned'")
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT id FROM games WHERE id = ? AND user_id = ?", (game_id, user["id"])
        ).fetchone()
        if not row:
            raise HTTPException(404, "no such game")
        # Setting it back to 'unassigned' by hand releases the lock as well:
        # that is "I don't know either", not a decision worth protecting.
        conn.execute(
            "UPDATE games SET your_color = ?, your_color_locked = ? WHERE id = ?",
            (colour, 0 if colour == "unassigned" else 1, game_id),
        )
        conn.execute(
            "DELETE FROM puzzles WHERE game_id = ? AND your_color != ?", (game_id, colour)
        )
    return {"ok": True, "your_color": colour}


@router.delete("/{game_id}")
def delete_game(game_id: int, user: dict = Depends(require_user)):
    """Deletes a game and, by cascade, any saved analysis of it. The upload
    row goes too once its last game is gone, so repeated upload/delete cycles
    don't leave orphaned PGN blobs behind."""
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT upload_id FROM games WHERE id = ? AND user_id = ?", (game_id, user["id"])
        ).fetchone()
        if not row:
            raise HTTPException(404, "no such game")
        conn.execute("DELETE FROM games WHERE id = ?", (game_id,))
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM games WHERE upload_id = ?", (row["upload_id"],)
        ).fetchone()["n"]
        if remaining == 0:
            conn.execute("DELETE FROM uploads WHERE id = ?", (row["upload_id"],))
    return {"ok": True}


@router.get("/{game_id}")
def get_game(game_id: int, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT * FROM games WHERE id = ? AND user_id = ?", (game_id, user["id"])
        ).fetchone()
    if not row:
        raise HTTPException(404, "no such game")
    return dict(row)
