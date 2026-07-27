import secrets

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel

from .db import db_cursor

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_COOKIE = "ci_session"

# Everything the browser needs about the logged-in user, in one place so the
# three queries that return a user can't drift apart as fields are added.
USER_FIELDS = ("id, username, display_name, asset_set, board_set, piece_set, "
               "show_legal_moves, allow_premoves")


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    asset_set: str
    board_set: str
    piece_set: str
    show_legal_moves: int
    allow_premoves: int


class CreateAccountIn(BaseModel):
    username: str
    display_name: str


class LoginIn(BaseModel):
    username: str


@router.get("/accounts")
def list_accounts():
    with db_cursor() as conn:
        rows = conn.execute(f"SELECT {USER_FIELDS} FROM users ORDER BY id").fetchall()
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
            "show_legal_moves": 1, "allow_premoves": 1}


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
