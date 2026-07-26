import os
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import require_user
from .db import db_cursor
from . import engines
from .maia import FALLBACK_SIZES, discover_sizes, resolve_binary
from .paths import ENGINES_DIR, list_asset_sets

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
    """Settings row plus the resolved absolute binaries to actually launch.

    `stockfish_path` / `maia_path` are what the user selected: a path
    relative to the Engines directory. `stockfish_binary` / `maia_binary` are
    those resolved to absolute paths, and are the *only* values callers should
    launch -- resolution rejects anything outside the sandbox.

    STOCKFISH_PATH / MAIA_PATH still work as an escape hatch, but they're set
    by whoever starts the server, never by the browser, so they're allowed to
    point anywhere.
    """
    with db_cursor() as conn:
        row = conn.execute("SELECT * FROM engine_settings WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "no settings row for this user")
    d = dict(row)

    d["stockfish_binary"] = engines.resolve(d.get("stockfish_path")) or os.environ.get("STOCKFISH_PATH")
    d["maia_binary"] = engines.resolve(d.get("maia_path")) or os.environ.get("MAIA_PATH")
    return d


@router.get("")
def get_settings(user: dict = Depends(require_user)):
    return get_effective_settings(user["id"])


@router.put("")
def update_settings(body: EngineSettings, user: dict = Depends(require_user)):
    if body.sf_limit_type not in ("depth", "movetime"):
        raise HTTPException(400, "sf_limit_type must be 'depth' or 'movetime'")
    # Sizes come from whatever maia3-<size> binaries are installed, so don't
    # pin the list here -- the real distribution ships 23m where the spec
    # said 25m, and a future release could add more.
    if not re.fullmatch(r"\d+m", body.maia_model_size or ""):
        raise HTTPException(400, "maia_model_size must look like '5m', '23m', '79m'")
    # Engine selections are names from the discovered list, never arbitrary
    # paths -- reject anything that doesn't resolve inside Engines/.
    for label, value in (("stockfish_path", body.stockfish_path), ("maia_path", body.maia_path)):
        if not engines.is_valid_selection(value):
            raise HTTPException(400, f"{label} must be an engine inside the Engines directory")
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


@router.get("/engines")
def list_engines(user: dict = Depends(require_user)):
    """Engines available to choose from, discovered under the Engines
    directory. These names are the only values the settings API accepts --
    the browser never handles an absolute path."""
    return {"engines": engines.discover(), "engines_dir_exists": os.path.isdir(ENGINES_DIR)}


@router.get("/maia-models")
def maia_models(path: str | None = None, size: str | None = None, user: dict = Depends(require_user)):
    """Which Maia model sizes are installed alongside the selected Maia
    engine, and which binary a given selection would run. `path` (an
    Engines-relative selection) and `size` let the settings dialog preview
    values the user has changed but not saved."""
    settings = get_effective_settings(user["id"])
    if path is not None:
        # Preview an unsaved selection -- still only from inside the sandbox.
        base = engines.resolve(path) if path else None
    else:
        base = settings.get("maia_binary")
    chosen = size or settings.get("maia_model_size")
    sizes = discover_sizes(base)
    resolved, note = resolve_binary(base, chosen)
    return {
        "sizes": sizes or FALLBACK_SIZES,
        "discovered": bool(sizes),
        "resolved_binary": os.path.basename(resolved) if resolved else None,
        "note": note,
    }


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
