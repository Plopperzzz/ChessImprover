from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor
from .pgn_parse import (
    account_names,
    insert_parsed_games,
    parse_games_from_text,
    reassign_your_colors,
)
from .runs import analyzed_game_ids

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


def game_filter_sql(user_id: int, speed: str | None = None,
                    time_control: str | None = None,
                    collection_id: int | None = None) -> tuple[str, list]:
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
    return " AND ".join(where), params


@router.get("")
def list_games(speed: str | None = None, time_control: str | None = None,
               collection_id: int | None = None, user: dict = Depends(require_user)):
    """The library, optionally filtered.

    Filtering happens here rather than in the browser so that the counts the
    picker shows, the ids a bulk action applies to and the games a batch runs
    over are all the same set, decided once.
    """
    where, params = game_filter_sql(user["id"], speed, time_control, collection_id)
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
    # picker can mark which games already have a saved analysis.
    analysed = analyzed_game_ids(user["id"])
    return [{**dict(r), "analyzed": analysed.get(r["id"]),
             "collection_ids": membership.get(r["id"], [])} for r in rows]


@router.get("/facets")
def game_facets(user: dict = Depends(require_user)):
    """What time controls the library actually contains, and how many games
    each has -- grouped into speeds the way chess.com's own picker is.

    The filter is built from this rather than from a fixed list of controls:
    offering "20 sec + 1" to someone who has never played one is noise, and a
    control this app has never heard of still has to be filterable.
    """
    with db_cursor() as conn:
        rows = conn.execute(
            """SELECT speed, time_control, COUNT(*) AS games
               FROM games WHERE user_id = ?
               GROUP BY speed, time_control""",
            (user["id"],),
        ).fetchall()
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
    order = ["bullet", "blitz", "rapid", "daily", "unknown"]
    for bucket in speeds.values():
        # Within a speed, the control you played most is the one you want
        # first -- an alphabetical list of '1200' and '600+5' helps nobody.
        bucket["controls"].sort(key=lambda c: (-c["games"], c["time_control"]))
    return {"speeds": [speeds[s] for s in order if s in speeds],
            "total": sum(b["games"] for b in speeds.values())}


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


@router.post("/bulk-delete")
def bulk_delete(body: BulkDeleteIn, user: dict = Depends(require_user)):
    """Deletes many games at once, with their analyses, puzzles and group
    memberships going by cascade.

    Requires either explicit ids or at least one filter: an empty body would
    otherwise mean "delete my entire library", which is not something a
    dropped field should be able to say.
    """
    has_filter = any(v is not None for v in (body.speed, body.time_control, body.collection_id))
    if body.game_ids is None and not has_filter:
        raise HTTPException(400, "give either game_ids or a filter to delete by")

    where, params = game_filter_sql(user["id"], body.speed, body.time_control,
                                    body.collection_id)
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
