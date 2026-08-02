"""Applying /api/strength's own calibration to one game, not just the pooled
account figure.

The offset measures the gap between Maia's own scale and whatever site your
header ratings are actually on -- it is a property of that gap, not of any
one player, so the same number converts your own estimate and a single
opponent's exactly the same way `/api/strength` already converts "you" for
the pooled figure. Applying it to the opponent card in a single game is not
circular even though the pooled *field* estimate is what measured the offset
in the first place: this is a different number (one opponent, not the pool)
being converted by an offset that was already fixed before this game's own
sweep was read.

Scoped to the game's own database and time control -- a chess.com bullet
rating and a chess.com rapid rating do not sit the same distance from Maia's
scale, any more than chess.com and Lichess do -- so this asks
`strength.build` for exactly that slice rather than the account-wide default
`/api/strength` itself shows.
"""

import json

from fastapi import APIRouter, Depends, HTTPException

from . import strength
from .auth import require_user
from .db import db_cursor
from .games import LibraryFilter, game_database

router = APIRouter(prefix="/api/games", tags=["games"])


def platform_label(headers_json: str, database: str) -> str:
    """Best guess at which site your header rating in this game is from --
    the offset converts onto *that* scale, so the calibrated number is
    mislabelled if this is wrong. A chess.com download always is one; anything
    else falls back to sniffing Site/Link the way `pgn_parse.external_game_id`
    already does (Lichess exports carry their permanent URL in Site, chess.com
    in Link, and either can say the site's name outright)."""
    if database == "chesscom":
        return "Chess.com"
    try:
        headers = json.loads(headers_json or "{}")
    except ValueError:
        headers = {}
    for key in ("Site", "Link"):
        value = (headers.get(key) or "").lower()
        if "lichess" in value:
            return "Lichess"
        if "chess.com" in value:
            return "Chess.com"
    return "your rating"


def for_game(user_id: int, game_row) -> dict:
    """The calibration offset for one game's own database and time control."""
    database = game_database(game_row["source_name"])
    speed = game_row["speed"]
    calibration = strength.build(
        user_id, library=LibraryFilter(database=database, speed=speed)
    )["calibration"]
    if not calibration.get("available"):
        return {
            "available": False,
            "reason": calibration.get("reason"),
            "database": database,
            "speed": speed,
        }
    return {
        "available": True,
        "offset": calibration["offset"],
        "database": database,
        "speed": speed,
        "platform_label": platform_label(game_row["headers_json"], database),
    }


@router.get("/{game_id}/calibration")
def get_game_calibration(game_id: int, user: dict = Depends(require_user)):
    """Whether -- and how -- to convert this game's Elo-sweep cards onto the
    scale your own recorded rating is on, rather than Maia's own.

    A plain read alongside the usual GET, not a button: the query pools this
    game's own database/time-control slice of the library rather than the
    whole account, so it costs a fraction of what `/api/strength` already
    costs the Progress screen on every load, and the sweep cards want an
    answer as soon as they render rather than a second click to get one.
    """
    with db_cursor() as conn:
        game = conn.execute(
            "SELECT * FROM games WHERE id = ? AND user_id = ?", (game_id, user["id"])
        ).fetchone()
    if not game:
        raise HTTPException(404, "no such game")
    return for_game(user["id"], game)
