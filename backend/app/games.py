import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor
from .pgn_parse import (
    account_names,
    external_game_id,
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
            for g in games:
                # Recorded on hand-uploaded games too, even though this path
                # never dedupes: a chess.com import run afterwards can then
                # tell that a month you already uploaded by hand is the same
                # set of games, and skip it.
                cur = conn.execute(
                    """INSERT INTO games (
                        user_id, upload_id, batch_index, source_name, game_index_in_source,
                        white, black, result, event, date_header, utc_date_header,
                        year, month, your_color, pgn_text, headers_json, clocks_json,
                        external_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        user["id"], upload_id, batch_index, g["source_name"], g["game_index_in_source"],
                        g["white"], g["black"], g["result"], g["event"], g["date_header"], g["utc_date_header"],
                        g["year"], g["month"], g["your_color"], g["pgn_text"], g["headers_json"],
                        g.get("clocks_json"), external_game_id(json.loads(g["headers_json"])),
                    ),
                )
                created.append({"id": cur.lastrowid, "batch_index": batch_index, **g})
                batch_index += 1

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


@router.get("")
def list_games(user: dict = Depends(require_user)):
    with db_cursor() as conn:
        rows = conn.execute(
            """SELECT id, batch_index, source_name, white, black, result,
                      date_header, utc_date_header, year, month, your_color,
                      your_color_locked
               FROM games WHERE user_id = ? ORDER BY id""",
            (user["id"],),
        ).fetchall()
    # One lookup for the whole list rather than a request per row, so the
    # picker can mark which games already have a saved analysis.
    analysed = analyzed_game_ids(user["id"])
    return [{**dict(r), "analyzed": analysed.get(r["id"])} for r in rows]


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
