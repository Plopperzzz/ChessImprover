from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .auth import require_user
from .db import db_cursor
from .pgn_parse import parse_games_from_text
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
            games = parse_games_from_text(source_name, raw_text, user["display_name"])
            if not games:
                continue
            for g in games:
                cur = conn.execute(
                    """INSERT INTO games (
                        user_id, upload_id, batch_index, source_name, game_index_in_source,
                        white, black, result, event, date_header, utc_date_header,
                        year, month, your_color, pgn_text, headers_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        user["id"], upload_id, batch_index, g["source_name"], g["game_index_in_source"],
                        g["white"], g["black"], g["result"], g["event"], g["date_header"], g["utc_date_header"],
                        g["year"], g["month"], g["your_color"], g["pgn_text"], g["headers_json"],
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
                      date_header, utc_date_header, year, month, your_color
               FROM games WHERE user_id = ? ORDER BY id""",
            (user["id"],),
        ).fetchall()
    # One lookup for the whole list rather than a request per row, so the
    # picker can mark which games already have a saved analysis.
    analysed = analyzed_game_ids(user["id"])
    return [{**dict(r), "analyzed": analysed.get(r["id"])} for r in rows]


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
