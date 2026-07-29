"""Named groups of games -- "September tournament", "my Caro-Kanns".

Tags, not folders. A game belongs to any number of groups and to none by
default, which is what makes them safe: putting a game in a group changes
nothing about it, and deleting a group deletes no games. Both directions of
that are enforced by the schema's cascades rather than by remembering to
clean up here.

Filtering the library by group is done in `games.list_games` alongside the
speed filter, so "my rapid games from the September group" is one query and
not two lists intersected in the browser.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor

router = APIRouter(prefix="/api/collections", tags=["collections"])

MAX_NAME = 60


def _clean_name(raw: str) -> str:
    name = (raw or "").strip()
    if not name:
        raise HTTPException(400, "a group needs a name")
    if len(name) > MAX_NAME:
        raise HTTPException(400, f"group names are limited to {MAX_NAME} characters")
    return name


def _owned(conn, collection_id: int, user_id: int):
    row = conn.execute(
        "SELECT id, name FROM collections WHERE id = ? AND user_id = ?",
        (collection_id, user_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "no such group")
    return row


class NameIn(BaseModel):
    name: str


class GameIdsIn(BaseModel):
    game_ids: list[int]


@router.get("")
def list_collections(user: dict = Depends(require_user)):
    """Every group with how many games are in it. The count is what the
    picker shows beside the name, so it comes from the same query rather than
    a request per group."""
    with db_cursor() as conn:
        rows = conn.execute(
            """SELECT c.id, c.name, c.created_at,
                      (SELECT COUNT(*) FROM game_collections gc
                       WHERE gc.collection_id = c.id) AS game_count
               FROM collections c WHERE c.user_id = ?
               ORDER BY c.name COLLATE NOCASE""",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_collection(body: NameIn, user: dict = Depends(require_user)):
    name = _clean_name(body.name)
    with db_cursor() as conn:
        if conn.execute(
            "SELECT 1 FROM collections WHERE user_id = ? AND name = ?", (user["id"], name)
        ).fetchone():
            raise HTTPException(409, f"you already have a group called '{name}'")
        cur = conn.execute(
            "INSERT INTO collections (user_id, name) VALUES (?, ?)", (user["id"], name)
        )
        return {"id": cur.lastrowid, "name": name, "game_count": 0}


@router.patch("/{collection_id}")
def rename_collection(collection_id: int, body: NameIn, user: dict = Depends(require_user)):
    name = _clean_name(body.name)
    with db_cursor() as conn:
        _owned(conn, collection_id, user["id"])
        clash = conn.execute(
            "SELECT 1 FROM collections WHERE user_id = ? AND name = ? AND id != ?",
            (user["id"], name, collection_id),
        ).fetchone()
        if clash:
            raise HTTPException(409, f"you already have a group called '{name}'")
        conn.execute("UPDATE collections SET name = ? WHERE id = ?", (name, collection_id))
    return {"id": collection_id, "name": name}


@router.delete("/{collection_id}")
def delete_collection(collection_id: int, user: dict = Depends(require_user)):
    """Removes the group. The games in it stay in the library -- a group is a
    label, and taking the label off is not a reason to lose the games. Use the
    bulk delete for that, deliberately."""
    with db_cursor() as conn:
        row = _owned(conn, collection_id, user["id"])
        released = conn.execute(
            "SELECT COUNT(*) AS n FROM game_collections WHERE collection_id = ?",
            (collection_id,),
        ).fetchone()["n"]
        conn.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
    return {"ok": True, "name": row["name"], "games_released": released}


@router.post("/{collection_id}/games")
def add_games(collection_id: int, body: GameIdsIn, user: dict = Depends(require_user)):
    """Adds games to a group, ignoring the ones already in it so 'add all' is
    repeatable. Only the caller's own games can be added -- the ids are
    filtered against ownership rather than trusted."""
    with db_cursor() as conn:
        _owned(conn, collection_id, user["id"])
        owned = _owned_game_ids(conn, body.game_ids, user["id"])
        before = conn.execute(
            "SELECT COUNT(*) AS n FROM game_collections WHERE collection_id = ?",
            (collection_id,),
        ).fetchone()["n"]
        conn.executemany(
            "INSERT OR IGNORE INTO game_collections (collection_id, game_id) VALUES (?, ?)",
            [(collection_id, game_id) for game_id in owned],
        )
        after = conn.execute(
            "SELECT COUNT(*) AS n FROM game_collections WHERE collection_id = ?",
            (collection_id,),
        ).fetchone()["n"]
    return {"added": after - before, "already_in": len(owned) - (after - before),
            "game_count": after}


@router.post("/{collection_id}/games/remove")
def remove_games(collection_id: int, body: GameIdsIn, user: dict = Depends(require_user)):
    """Takes games out of a group. The games themselves are untouched.

    A POST rather than a DELETE with a body: which ids to remove has to be in
    the request body, and a body on DELETE is the kind of thing intermediaries
    are entitled to drop.
    """
    with db_cursor() as conn:
        _owned(conn, collection_id, user["id"])
        owned = _owned_game_ids(conn, body.game_ids, user["id"])
        conn.executemany(
            "DELETE FROM game_collections WHERE collection_id = ? AND game_id = ?",
            [(collection_id, game_id) for game_id in owned],
        )
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM game_collections WHERE collection_id = ?",
            (collection_id,),
        ).fetchone()["n"]
    return {"removed": len(owned), "game_count": remaining}


def _owned_game_ids(conn, game_ids: list[int], user_id: int) -> list[int]:
    """The subset of `game_ids` this user actually owns. Silently dropping the
    rest is right here: a stale id from a picker whose game was deleted in
    another tab shouldn't fail the whole action."""
    if not game_ids:
        return []
    unique = list(dict.fromkeys(game_ids))
    marks = ", ".join("?" * len(unique))
    rows = conn.execute(
        f"SELECT id FROM games WHERE user_id = ? AND id IN ({marks})",
        (user_id, *unique),
    ).fetchall()
    return [row["id"] for row in rows]
