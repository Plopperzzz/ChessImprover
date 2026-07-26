import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import require_user
from .db import db_cursor
from .paths import list_asset_sets

router = APIRouter(prefix="/api/settings", tags=["settings"])


class EngineSettings(BaseModel):
    stockfish_path: str | None = None
    stockfish_threads: int = Field(default=1, ge=1, le=64)
    stockfish_hash_mb: int = Field(default=128, ge=1, le=16384)
    sf_limit_type: str = "depth"  # 'depth' | 'movetime'
    sf_limit_value: int = Field(default=18, ge=1)
    sf_skill_level: int | None = Field(default=None, ge=0, le=20)
    maia_path: str | None = None
    maia_model_size: str = "5m"  # '5m' | '25m' | '79m'
    maia_elo_min: int = 1100
    maia_elo_max: int = 1900
    maia_elo_step: int = 100


def get_effective_settings(user_id: int) -> dict:
    """Settings row with the STOCKFISH_PATH env-var fallback applied. Shared
    by the settings endpoint and the live-eval engine launcher so they never
    disagree about which binary path is in effect."""
    with db_cursor() as conn:
        row = conn.execute("SELECT * FROM engine_settings WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no settings row for this user")
    d = dict(row)
    if not d.get("stockfish_path"):
        d["stockfish_path"] = os.environ.get("STOCKFISH_PATH")
    return d


@router.get("")
def get_settings(user: dict = Depends(require_user)):
    return get_effective_settings(user["id"])


@router.put("")
def update_settings(body: EngineSettings, user: dict = Depends(require_user)):
    if body.sf_limit_type not in ("depth", "movetime"):
        raise HTTPException(400, "sf_limit_type must be 'depth' or 'movetime'")
    if body.maia_model_size not in ("5m", "25m", "79m"):
        raise HTTPException(400, "maia_model_size must be one of '5m', '25m', '79m'")
    with db_cursor() as conn:
        conn.execute(
            """UPDATE engine_settings SET
                stockfish_path=?, stockfish_threads=?, stockfish_hash_mb=?,
                sf_limit_type=?, sf_limit_value=?, sf_skill_level=?,
                maia_path=?, maia_model_size=?, maia_elo_min=?, maia_elo_max=?, maia_elo_step=?,
                updated_at=datetime('now')
               WHERE user_id=?""",
            (
                body.stockfish_path, body.stockfish_threads, body.stockfish_hash_mb,
                body.sf_limit_type, body.sf_limit_value, body.sf_skill_level,
                body.maia_path, body.maia_model_size, body.maia_elo_min, body.maia_elo_max, body.maia_elo_step,
                user["id"],
            ),
        )
    return get_settings(user)


class ProfileUpdate(BaseModel):
    display_name: str | None = None
    asset_set: str | None = None


@router.put("/profile")
def update_profile(body: ProfileUpdate, user: dict = Depends(require_user)):
    updates: dict = {}
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(400, "display_name cannot be blank")
        updates["display_name"] = name
    if body.asset_set is not None:
        available = list_asset_sets()
        if body.asset_set not in available:
            raise HTTPException(400, f"unknown asset set '{body.asset_set}' (available: {available})")
        updates["asset_set"] = body.asset_set
    if not updates:
        raise HTTPException(400, "nothing to update")
    with db_cursor() as conn:
        for column, value in updates.items():
            conn.execute(f"UPDATE users SET {column}=? WHERE id=?", (value, user["id"]))
        row = conn.execute(
            "SELECT id, username, display_name, asset_set FROM users WHERE id=?", (user["id"],)
        ).fetchone()
    return dict(row)
