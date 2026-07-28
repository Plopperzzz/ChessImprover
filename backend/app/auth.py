import secrets

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel

from .db import db_cursor
from .pgn_parse import account_names, reassign_your_colors

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE = "ci_session"

# Everything the browser needs about the logged-in user, in one place so the
# three queries that return a user can't drift apart as fields are added.
USER_FIELDS = ("id, username, display_name, asset_set, board_set, piece_set, "
               "show_legal_moves, allow_premoves, eval_bar_side")


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    asset_set: str
    board_set: str
    piece_set: str
    show_legal_moves: int
    allow_premoves: int
    eval_bar_side: str


class CreateAccountIn(BaseModel):
    username: str
    display_name: str


class UpdateAccountIn(BaseModel):
    """Both fields optional: renaming the display name alone is the common
    case (it's the one that has to match the PGN headers)."""
    username: str | None = None
    display_name: str | None = None


class LoginIn(BaseModel):
    username: str


@router.get("/accounts")
def list_accounts():
    """Every account, with what would be lost if it were deleted -- the delete
    confirmation says how many games and analyses go with it, which is the
    only thing that makes it an informed choice."""
    with db_cursor() as conn:
        rows = conn.execute(
            f"""SELECT {", ".join("u." + f for f in USER_FIELDS.split(", "))},
                       (SELECT COUNT(*) FROM games WHERE user_id = u.id) AS game_count,
                       (SELECT COUNT(*) FROM run_games WHERE user_id = u.id) AS analysis_count,
                       (SELECT COUNT(*) FROM puzzles WHERE user_id = u.id) AS puzzle_count
                FROM users u ORDER BY u.id"""
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/accounts")
def create_account(body: CreateAccountIn):
    """Bootstrap-only: lets the two accounts be created the first time the app runs.
    There's no password -- this is a two-person home app, not public-facing."""
    username = body.username.strip().lower()
    display_name = body.display_name.strip()
    if not username or not display_name:
        raise HTTPException(400, "username and display_name are required")
    with db_cursor() as conn:
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if existing:
            raise HTTPException(409, "that username already exists")
        cur = conn.execute(
            "INSERT INTO users (username, display_name) VALUES (?, ?)", (username, display_name)
        )
        user_id = cur.lastrowid
        conn.execute("INSERT INTO engine_settings (user_id) VALUES (?)", (user_id,))
    return {"id": user_id, "username": username, "display_name": display_name,
            "asset_set": "default", "board_set": "default", "piece_set": "default",
            "show_legal_moves": 1, "allow_premoves": 1,
            "eval_bar_side": "top"}


@router.patch("/accounts/{user_id}")
def update_account(user_id: int, body: UpdateAccountIn):
    """Renames an account, and re-matches the whole library against the new
    names.

    The display name is what decides which side of each game was yours, so
    changing it has to reach back through games already uploaded -- otherwise
    a typo made at account-creation time is permanent, and every game stays
    'unassigned' with no way to fix it but deleting and re-uploading. Games
    whose colour was set by hand are left alone.

    Reachable without logging in, like account creation: an account you can't
    get into (because its username is wrong) is exactly the one that needs
    fixing, and this is a two-person home app with no passwords at all.
    """
    with db_cursor() as conn:
        current = conn.execute(
            f"SELECT {USER_FIELDS} FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not current:
            raise HTTPException(404, "no such account")

        username = current["username"] if body.username is None else body.username.strip().lower()
        display_name = (current["display_name"] if body.display_name is None
                        else body.display_name.strip())
        if not username or not display_name:
            raise HTTPException(400, "username and display_name cannot be blank")

        clash = conn.execute(
            "SELECT id FROM users WHERE username = ? AND id != ?", (username, user_id)
        ).fetchone()
        if clash:
            raise HTTPException(409, "that username already exists")

        conn.execute(
            "UPDATE users SET username = ?, display_name = ? WHERE id = ?",
            (username, display_name, user_id),
        )
        names = account_names({"username": username, "display_name": display_name})
        rematched = reassign_your_colors(conn, user_id, names)
        user = conn.execute(f"SELECT {USER_FIELDS} FROM users WHERE id = ?", (user_id,)).fetchone()
    return {**dict(user), "rematched": rematched}


@router.delete("/accounts/{user_id}")
def delete_account(user_id: int, response: Response, ci_session: str | None = Cookie(default=None)):
    """Removes an account and everything filed under it -- games, uploads,
    saved analyses, puzzles and engine settings all go by the schema's
    cascades, so nothing is left orphaned in the database.

    Deleting the account you are currently logged into logs you out, rather
    than leaving the browser holding a session token pointing at a user row
    that no longer exists.
    """
    with db_cursor() as conn:
        user = conn.execute(
            "SELECT username, display_name FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "no such account")
        counts = conn.execute(
            """SELECT (SELECT COUNT(*) FROM games WHERE user_id = ?) AS games,
                      (SELECT COUNT(*) FROM run_games WHERE user_id = ?) AS analyses,
                      (SELECT COUNT(*) FROM puzzles WHERE user_id = ?) AS puzzles""",
            (user_id, user_id, user_id),
        ).fetchone()
        current = conn.execute(
            "SELECT user_id FROM sessions WHERE token = ?", (ci_session,)
        ).fetchone() if ci_session else None
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    logged_out = bool(current and current["user_id"] == user_id)
    if logged_out:
        response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True, "display_name": user["display_name"],
            "deleted": dict(counts), "logged_out": logged_out}


@router.post("/login")
def login(body: LoginIn, response: Response):
    username = body.username.strip().lower()
    with db_cursor() as conn:
        user = conn.execute(
            f"SELECT {USER_FIELDS} FROM users WHERE username = ?", (username,)
        ).fetchone()
        if not user:
            raise HTTPException(404, "no such account")
        token = secrets.token_urlsafe(32)
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user["id"]))
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 30, path="/"
    )
    return dict(user)


@router.post("/logout")
def logout(response: Response, ci_session: str | None = Cookie(default=None)):
    if ci_session:
        with db_cursor() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (ci_session,))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(ci_session: str | None = Cookie(default=None)):
    user = _user_for_token(ci_session)
    if not user:
        raise HTTPException(401, "not logged in")
    return dict(user)


def _user_for_token(token: str | None):
    if not token:
        return None
    with db_cursor() as conn:
        row = conn.execute(
            f"""SELECT {", ".join("u." + f for f in USER_FIELDS.split(", "))} FROM sessions s
                JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
            (token,),
        ).fetchone()
        if row:
            conn.execute("UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?", (token,))
    return row


def require_user(ci_session: str | None = Cookie(default=None)) -> dict:
    """FastAPI dependency: every user-scoped route depends on this so nothing
    can accidentally read/write another user's data."""
    user = _user_for_token(ci_session)
    if not user:
        raise HTTPException(401, "not logged in")
    return dict(user)
