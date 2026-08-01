"""Saved variations: lines you played that the game didn't.

The classic UI has had a real move tree since the beginning
(`frontend/js/explorer.js`) but only in memory -- close the tab and the line
you found is gone. This stores them.

A row is a *line*, not a node: the moves from where it leaves its parent to
wherever it ends, in SAN. One row per line rather than one per move because a
line is what a person means by "that variation" -- it is what they name, delete
and come back to -- and because the alternative makes the common case (play
four moves, keep them) four inserts and a tree walk to read back.

`parent_id` is what makes nesting work. NULL means the line branches off the
game's mainline after `start_ply` half-moves; otherwise it branches off another
line after `start_ply` moves *of that line*. Deleting a line takes its nested
ones with it, by the schema's own cascade -- which is the behaviour the classic
UI's `deleteVariation` implements by hand.

Every line is replayed on the way in. A line that doesn't play out from its
anchor is rejected rather than stored, because a variation is only worth
keeping if the position it describes can be reached: a stored line that no
longer replays is indistinguishable, later, from a bug in the board.
"""

import io
import json

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor

router = APIRouter(tags=["variations"])

# A line has to end somewhere. Long enough for any real analysis line, short
# enough that a runaway client can't write a novel into the row.
MAX_LINE_MOVES = 300
# How deep variations may nest. Three is already "a variation on a variation on
# a variation", and the limit is what stops a cycle -- introduced by a bad
# parent_id -- from being walked forever.
MAX_DEPTH = 8


class VariationIn(BaseModel):
    """`moves` are SAN, in order, starting from the anchor."""
    parent_id: int | None = None
    start_ply: int
    moves: list[str]
    label: str | None = None


class VariationPatch(BaseModel):
    moves: list[str] | None = None
    label: str | None = None


def _game_or_404(conn, user_id: int, game_id: int):
    row = conn.execute(
        "SELECT id, pgn_text FROM games WHERE id = ? AND user_id = ?", (game_id, user_id)
    ).fetchone()
    if not row:
        raise HTTPException(404, "no such game")
    return row


def _mainline_board(pgn_text: str, start_ply: int) -> chess.Board:
    """The position after `start_ply` half-moves of the game."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise HTTPException(400, "this game's PGN could not be read")
    board = game.board()
    played = 0
    for move in game.mainline_moves():
        if played >= start_ply:
            break
        board.push(move)
        played += 1
    if played < start_ply:
        raise HTTPException(400, f"the game has only {played} half-moves, not {start_ply}")
    return board


def _replay(board: chess.Board, sans: list[str]) -> chess.Board:
    """Plays `sans` onto a copy of `board`, or 400s saying which move failed."""
    board = board.copy()
    for index, san in enumerate(sans):
        try:
            board.push_san(san)
        except (ValueError, AssertionError):
            raise HTTPException(
                400, f"move {index + 1} of the line ('{san}') is not legal in that position"
            )
    return board


def _anchor_board(conn, user_id: int, game, parent_id: int | None,
                  start_ply: int, depth: int = 0) -> chess.Board:
    """The position a new line starts from.

    Off the mainline that is simply the game after `start_ply` moves; off
    another line it is that line replayed `start_ply` moves deep, which needs
    its own anchor first -- hence the recursion, and the depth cap.
    """
    if start_ply < 0:
        raise HTTPException(400, "start_ply cannot be negative")
    if parent_id is None:
        return _mainline_board(game["pgn_text"], start_ply)
    if depth >= MAX_DEPTH:
        raise HTTPException(400, "variations are nested too deeply")

    parent = conn.execute(
        "SELECT * FROM variations WHERE id = ? AND user_id = ?", (parent_id, user_id)
    ).fetchone()
    if not parent:
        raise HTTPException(404, "no such parent variation")
    if parent["game_id"] != game["id"]:
        raise HTTPException(400, "that variation belongs to a different game")

    parent_moves = json.loads(parent["moves_json"])
    if start_ply > len(parent_moves):
        raise HTTPException(
            400, f"the parent line has {len(parent_moves)} moves, so it has no move {start_ply}"
        )
    base = _anchor_board(conn, user_id, game, parent["parent_id"], parent["start_ply"], depth + 1)
    return _replay(base, parent_moves[:start_ply])


def _row_out(row) -> dict:
    return {
        "id": row["id"],
        "game_id": row["game_id"],
        "parent_id": row["parent_id"],
        "start_ply": row["start_ply"],
        "moves": json.loads(row["moves_json"]),
        "label": row["label"],
        "created_at": row["created_at"],
    }


def _check_line(moves: list[str]) -> list[str]:
    cleaned = [san.strip() for san in moves if san and san.strip()]
    if not cleaned:
        raise HTTPException(400, "a variation needs at least one move")
    if len(cleaned) > MAX_LINE_MOVES:
        raise HTTPException(400, f"a variation is capped at {MAX_LINE_MOVES} moves")
    return cleaned


@router.get("/api/games/{game_id}/variations")
def list_variations(game_id: int, user: dict = Depends(require_user)):
    """Every line saved against this game, oldest first.

    Flat, with `parent_id` -- the client rebuilds the tree by replaying each
    line from its anchor, which it has to do anyway to draw the positions.
    """
    with db_cursor() as conn:
        _game_or_404(conn, user["id"], game_id)
        rows = conn.execute(
            "SELECT * FROM variations WHERE user_id = ? AND game_id = ? ORDER BY id",
            (user["id"], game_id),
        ).fetchall()
    return [_row_out(row) for row in rows]


@router.post("/api/games/{game_id}/variations")
def create_variation(game_id: int, body: VariationIn, user: dict = Depends(require_user)):
    moves = _check_line(body.moves)
    with db_cursor() as conn:
        game = _game_or_404(conn, user["id"], game_id)
        anchor = _anchor_board(conn, user["id"], game, body.parent_id, body.start_ply)
        _replay(anchor, moves)
        cursor = conn.execute(
            """INSERT INTO variations (user_id, game_id, parent_id, start_ply, moves_json, label)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user["id"], game_id, body.parent_id, body.start_ply, json.dumps(moves),
             (body.label or "").strip() or None),
        )
        row = conn.execute("SELECT * FROM variations WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _row_out(row)


@router.put("/api/variations/{variation_id}")
def update_variation(variation_id: int, body: VariationPatch,
                     user: dict = Depends(require_user)):
    """Replaces the line, which is how a variation grows: playing another move
    at its tip rewrites the row rather than starting a second one.

    Shortening a line is allowed and is *not* a way to delete the lines nested
    inside it -- those keep their own anchors, and a nested line whose branch
    point no longer exists is refused, so a line can't be truncated out from
    under its children.
    """
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT * FROM variations WHERE id = ? AND user_id = ?", (variation_id, user["id"])
        ).fetchone()
        if not row:
            raise HTTPException(404, "no such variation")
        game = _game_or_404(conn, user["id"], row["game_id"])

        if body.moves is not None:
            moves = _check_line(body.moves)
            anchor = _anchor_board(conn, user["id"], game, row["parent_id"], row["start_ply"])
            _replay(anchor, moves)
            deepest = conn.execute(
                "SELECT MAX(start_ply) AS n FROM variations WHERE parent_id = ?", (variation_id,)
            ).fetchone()["n"]
            if deepest is not None and deepest > len(moves):
                raise HTTPException(
                    400,
                    "another variation branches off later in this line -- delete it first",
                )
            conn.execute(
                "UPDATE variations SET moves_json = ? WHERE id = ?",
                (json.dumps(moves), variation_id),
            )
        if body.label is not None:
            conn.execute(
                "UPDATE variations SET label = ? WHERE id = ?",
                (body.label.strip() or None, variation_id),
            )
        row = conn.execute("SELECT * FROM variations WHERE id = ?", (variation_id,)).fetchone()
    return _row_out(row)


@router.delete("/api/variations/{variation_id}")
def delete_variation(variation_id: int, user: dict = Depends(require_user)):
    """Takes the lines nested inside it too, by the schema's cascade. The
    mainline is not a variation and so is never deletable -- which is the same
    guarantee the classic UI's tree makes."""
    with db_cursor() as conn:
        row = conn.execute(
            "SELECT id FROM variations WHERE id = ? AND user_id = ?", (variation_id, user["id"])
        ).fetchone()
        if not row:
            raise HTTPException(404, "no such variation")
        nested = conn.execute(
            "SELECT COUNT(*) AS n FROM variations WHERE parent_id = ?", (variation_id,)
        ).fetchone()["n"]
        conn.execute("DELETE FROM variations WHERE id = ?", (variation_id,))
    return {"ok": True, "deleted": 1 + nested}
