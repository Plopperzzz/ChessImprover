"""The opening database: what a big library of games actually played from
the position in front of you.

This is a *reference* database, not one of your games. It is built once from
a PGN dump (LumbrasGigaBase, or any other) by `app.opening_import`, and from
then on it is read-only -- so it lives in its own SQLite file rather than in
chessimprover.db, and can be rebuilt or thrown away without touching anything
you own.

The shape it is stored in is the shape the board asks for: keyed by position,
listing the moves played from it with their results. Nothing here walks games
-- that work happens once, at import time.
"""

import os
import sqlite3
from contextlib import contextmanager

import chess
from fastapi import APIRouter, Depends, HTTPException

from .auth import require_user

DB_PATH = os.environ.get(
    "CHESSIMPROVER_OPENING_DB",
    os.path.join(os.path.dirname(__file__), "..", "data", "openings.db"),
)

SCHEMA = """
-- One row per (position, move played from it). `pos` is the FEN's first four
-- fields: everything that decides which moves are legal and nothing that
-- doesn't, so two games reaching the same position by different move orders
-- -- or with different clocks on them -- land on the same row.
CREATE TABLE IF NOT EXISTS positions (
    pos TEXT NOT NULL,
    uci TEXT NOT NULL,
    san TEXT NOT NULL,
    white INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    black INTEGER NOT NULL DEFAULT 0,
    -- Sum and count rather than an average, so a later import can add to it.
    rating_sum INTEGER NOT NULL DEFAULT 0,
    rating_n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pos, uci)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def position_key(board: chess.Board) -> str:
    """The part of a FEN that defines the position -- placement, side to move,
    castling rights, en-passant square. The halfmove clock and move number are
    history rather than position, and keeping them would split one opening
    across a dozen rows for no gain.

    That is exactly python-chess's EPD, which is worth using rather than
    slicing a FEN by hand: it also writes the en-passant square as `-` unless
    the capture is actually available, so two games that reach the same
    position agree on the key whether or not a pawn happened to double-step
    into it. The importer keys on the same call, which is the only thing that
    matters."""
    return board.epd()


@contextmanager
def opening_db(create: bool = False):
    """Read-only by default. The importer is the only writer, and it opens its
    own connection -- a request that could write to the reference database is
    a request that could corrupt it."""
    if not create and not os.path.isfile(os.path.abspath(DB_PATH)):
        yield None
        return
    if create:
        os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        if create:
            conn.executescript(SCHEMA)
        yield conn
        if create:
            conn.commit()
    finally:
        conn.close()


def database_status() -> dict:
    """What the frontend needs to decide between showing stats and explaining
    how to get some."""
    with opening_db() as conn:
        if conn is None:
            return {"available": False, "path": os.path.abspath(DB_PATH)}
        try:
            rows = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        except sqlite3.DatabaseError:
            return {"available": False, "path": os.path.abspath(DB_PATH)}
        return {
            "available": True,
            "path": os.path.abspath(DB_PATH),
            "games": int(rows.get("games", 0)),
            "positions": int(rows.get("positions", 0)),
            "max_plies": int(rows.get("max_plies", 0)),
            "min_elo": int(rows.get("min_elo", 0)),
            "sources": rows.get("sources", ""),
            "built_at": rows.get("built_at", ""),
        }


def moves_from(fen: str) -> dict:
    """Every move the database has seen from this position, most-played first.

    `score` is from the side to move's point of view, counting a draw as half
    -- the number you actually want when choosing a move, and the one that
    would be backwards for Black if we reported White's."""
    try:
        board = chess.Board(fen)
    except ValueError:
        raise HTTPException(400, "not a position")

    with opening_db() as conn:
        if conn is None:
            return {"available": False, "moves": [], "total": None}
        try:
            rows = conn.execute(
                "SELECT uci, san, white, draws, black, rating_sum, rating_n"
                " FROM positions WHERE pos = ?",
                (position_key(board),),
            ).fetchall()
        except sqlite3.DatabaseError:
            return {"available": False, "moves": [], "total": None}

    white_to_move = board.turn == chess.WHITE
    moves = []
    for r in rows:
        games = r["white"] + r["draws"] + r["black"]
        if not games:
            continue
        wins = r["white"] if white_to_move else r["black"]
        moves.append({
            "uci": r["uci"],
            "san": r["san"],
            "games": games,
            "white": r["white"],
            "draws": r["draws"],
            "black": r["black"],
            "score": (wins + r["draws"] / 2) / games,
            "avg_rating": round(r["rating_sum"] / r["rating_n"]) if r["rating_n"] else None,
        })
    moves.sort(key=lambda m: (-m["games"], m["san"]))
    total = {
        "games": sum(m["games"] for m in moves),
        "white": sum(m["white"] for m in moves),
        "draws": sum(m["draws"] for m in moves),
        "black": sum(m["black"] for m in moves),
    }
    return {"available": True, "moves": moves, "total": total}


router = APIRouter(prefix="/api/openings", tags=["openings"])


@router.get("/status")
def status(user: dict = Depends(require_user)):
    return database_status()


@router.get("/stats")
def stats(fen: str, user: dict = Depends(require_user)):
    return moves_from(fen)
