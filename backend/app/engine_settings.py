import json
import os
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import USER_FIELDS, require_user
from .db import db_cursor
from . import engine_probe, engines
from .maia import FALLBACK_SIZES, discover_sizes, resolve_binary
from .paths import (ENGINES_DIR, list_asset_sets, list_audio_sets,
                    list_board_images)

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
    maia_elo_min: int = 600
    maia_elo_max: int = 2600
    maia_elo_step: int = 100
    maia_elo_step_batch: int = 200
    maia_multipv: int = Field(default=3, ge=1, le=9)
    # Ask Maia3 for the policy probability behind its ordering, by running the
    # same engine through `maia_policy`'s shim. Off means the fit scores moves
    # by rank instead, which is what happens anyway on any engine the shim
    # can't drive -- so this is an escape hatch, not a feature switch.
    maia_policy: bool = True
    min_think_ms: int = Field(default=2000, ge=0, le=120000)
    # Maia's published accuracy curves are measured on Lichess blitz. Slower
    # games sit a little below them, so a rapid or classical library can shift
    # the whole curve down rather than every player in it reading as erratic.
    maia_accuracy_offset: float = Field(default=0.0, ge=-0.15, le=0.15)
    great_max_drop: float = Field(default=0.02, ge=0.0, le=0.5)
    great_max_match_rate: float = Field(default=0.20, ge=0.0, le=1.0)
    brilliant_enabled: bool = True
    maia_options: dict[str, str] = {}
    stockfish_options: dict[str, str] = {}


def _load_json_obj(raw) -> dict:
    """Tolerate a malformed or legacy value rather than 500ing the whole
    settings endpoint over one bad row."""
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


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
    d["maia_options"] = _load_json_obj(d.get("maia_options_json"))
    d["stockfish_options"] = _load_json_obj(d.get("stockfish_options_json"))
    sf_family = engines.family_for_selection(d.get("stockfish_path"))
    maia_family = engines.family_for_selection(d.get("maia_path"))
    d["stockfish_family"] = sf_family["id"] if sf_family else None
    d["maia_family"] = maia_family["id"] if maia_family else None
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
                maia_path=?, maia_model_size=?, maia_elo_min=?, maia_elo_max=?, maia_elo_step=?, maia_elo_step_batch=?, maia_multipv=?, maia_policy=?, min_think_ms=?,
                maia_options_json=?, stockfish_options_json=?,
                great_max_drop=?, great_max_match_rate=?, brilliant_enabled=?,
                maia_accuracy_offset=?,
                updated_at=datetime('now')
               WHERE user_id=?""",
            (
                body.stockfish_path, body.stockfish_threads, body.stockfish_hash_mb,
                body.sf_limit_type, body.sf_limit_value, body.sf_skill_level,
                body.maia_path, body.maia_model_size, body.maia_elo_min, body.maia_elo_max, body.maia_elo_step, body.maia_elo_step_batch, body.maia_multipv, int(body.maia_policy), body.min_think_ms,
                json.dumps(body.maia_options or {}), json.dumps(body.stockfish_options or {}),
                body.great_max_drop, body.great_max_match_rate, int(body.brilliant_enabled),
                body.maia_accuracy_offset,
                user["id"],
            ),
        )
    return get_settings(user)


@router.get("/engines")
def list_engines(user: dict = Depends(require_user)):
    """Engines grouped by product (Stockfish-18, Maia3, ...). The dialog shows
    these names; the values inside are the only paths the settings API
    accepts, so the browser never handles an absolute path."""
    return {
        "families": engines.discover_families(),
        "engines_dir_exists": os.path.isdir(ENGINES_DIR),
    }


@router.get("/engine-options")
async def engine_options(engine: str, user: dict = Depends(require_user)):
    """Ask the selected engine what it supports, so settings like Maia's
    temperature appear because the engine advertises them -- not because
    they were guessed at here."""
    path = engines.resolve(engine)
    if not path:
        raise HTTPException(400, "unknown engine")
    result = await engine_probe.probe(path)
    return {
        "binary": os.path.basename(path),
        "options": engine_probe.tunable(result["options"]),
        "error": result["error"],
    }


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


# Along the top of the board, or standing beside it on either hand.
EVAL_BAR_SIDES = {"top", "left", "right"}


class ProfileUpdate(BaseModel):
    display_name: str | None = None
    asset_set: str | None = None       # legacy: one set for both halves
    board_set: str | None = None
    piece_set: str | None = None
    sound_set: str | None = None
    show_legal_moves: bool | None = None
    allow_premoves: bool | None = None
    eval_bar_side: str | None = None


@router.put("/profile")
def update_profile(body: ProfileUpdate, user: dict = Depends(require_user)):
    updates: dict = {}
    if body.display_name is not None:
        name = body.display_name.strip()
        if not name:
            raise HTTPException(400, "display_name cannot be blank")
        updates["display_name"] = name

    available_sets = list_asset_sets()
    board_names = {img["name"] for img in list_board_images()}

    def check(value: str) -> str:
        if value not in available_sets:
            raise HTTPException(400, f"unknown asset set '{value}' (available: {available_sets})")
        return value

    def check_sound(value: str) -> str:
        names = {s["name"] for s in list_audio_sets()}
        if value not in names:
            raise HTTPException(400, f"unknown sound set '{value}' (available: {sorted(names)})")
        return value

    def check_board(value: str) -> str:
        """Board names come from either assets/sets/{name}/board.png or
        assets/boards/{name}.png, so validate against both sources."""
        if value in board_names or value in available_sets:
            return value
        raise HTTPException(400, f"unknown board set '{value}' (available: {sorted(board_names | set(available_sets))})")

    # asset_set predates the board/piece split and means "use this set for
    # both", which is still what a client that doesn't know about the split
    # intends by sending it.
    if body.asset_set is not None:
        updates["asset_set"] = check(body.asset_set)
        updates["board_set"] = body.asset_set
        updates["piece_set"] = body.asset_set
    if body.board_set is not None:
        updates["board_set"] = check_board(body.board_set)
    if body.piece_set is not None:
        updates["piece_set"] = check(body.piece_set)
    if body.sound_set is not None:
        updates["sound_set"] = check_sound(body.sound_set)
    if body.show_legal_moves is not None:
        updates["show_legal_moves"] = int(body.show_legal_moves)
    if body.allow_premoves is not None:
        updates["allow_premoves"] = int(body.allow_premoves)
    if body.eval_bar_side is not None:
        if body.eval_bar_side not in EVAL_BAR_SIDES:
            raise HTTPException(400, f"eval_bar_side must be one of {sorted(EVAL_BAR_SIDES)}")
        updates["eval_bar_side"] = body.eval_bar_side

    if not updates:
        raise HTTPException(400, "nothing to update")
    with db_cursor() as conn:
        for column, value in updates.items():
            conn.execute(f"UPDATE users SET {column}=? WHERE id=?", (value, user["id"]))
        row = conn.execute(f"SELECT {USER_FIELDS} FROM users WHERE id=?", (user["id"],)).fetchone()
    return dict(row)


# ---------------------------------------------------------------------------
# Per-screen board, pieces and sounds (A7)
# ---------------------------------------------------------------------------

# The screens that draw a board. Fixed here rather than free-form, so a typo
# in a client can't quietly file preferences under a screen nothing reads.
SCREENS = ("analysis", "puzzles", "play")
PREF_KINDS = ("board_set", "piece_set", "sound_set")


class ScreenPrefUpdate(BaseModel):
    """`None` in the body means "leave this kind alone"; an explicit JSON null
    can't be told from an omitted field by pydantic here, so clearing an
    override is spelled with the empty string -- see `update_screen_prefs`."""
    board_set: str | None = None
    piece_set: str | None = None
    sound_set: str | None = None


def screen_prefs_for(user: dict) -> dict:
    """Defaults, the per-screen overrides, and what those two resolve to.

    `effective` is computed here rather than in each UI because both of them
    draw the same boards: a rule that lives in one browser is a rule the other
    one gets subtly wrong.
    """
    defaults = {kind: user[kind] for kind in PREF_KINDS}
    with db_cursor() as conn:
        rows = conn.execute(
            "SELECT screen, board_set, piece_set, sound_set FROM screen_prefs WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
    overrides = {row["screen"]: {kind: row[kind] for kind in PREF_KINDS} for row in rows}
    return {
        "defaults": defaults,
        "screens": {
            screen: overrides.get(screen, {kind: None for kind in PREF_KINDS})
            for screen in SCREENS
        },
        "effective": {
            screen: {
                kind: (overrides.get(screen, {}).get(kind) or defaults[kind])
                for kind in PREF_KINDS
            }
            for screen in SCREENS
        },
    }


@router.get("/screens")
def get_screen_prefs(user: dict = Depends(require_user)):
    """What each screen should draw with. A screen with no row of its own
    follows the defaults, which is the normal case."""
    return screen_prefs_for(user)


@router.put("/screens/{screen}")
def update_screen_prefs(screen: str, body: ScreenPrefUpdate,
                        user: dict = Depends(require_user)):
    """Sets one screen's overrides. An empty string clears one, putting that
    kind back on the default -- which is a thing the UI has to be able to say,
    and is why it isn't spelled as a missing field."""
    if screen not in SCREENS:
        raise HTTPException(400, f"screen must be one of {', '.join(SCREENS)}")

    available_sets = list_asset_sets()
    board_names = {img["name"] for img in list_board_images()}
    sound_names = {s["name"] for s in list_audio_sets()}

    updates: dict = {}
    for kind, value in (("board_set", body.board_set), ("piece_set", body.piece_set),
                        ("sound_set", body.sound_set)):
        if value is None:
            continue
        if value == "":
            updates[kind] = None
            continue
        if kind == "board_set" and value not in board_names and value not in available_sets:
            raise HTTPException(400, f"unknown board set '{value}'")
        if kind == "piece_set" and value not in available_sets:
            raise HTTPException(400, f"unknown asset set '{value}'")
        if kind == "sound_set" and value not in sound_names:
            raise HTTPException(400, f"unknown sound set '{value}'")
        updates[kind] = value

    if not updates:
        raise HTTPException(400, "nothing to update")

    with db_cursor() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO screen_prefs (user_id, screen) VALUES (?, ?)",
            (user["id"], screen),
        )
        for column, value in updates.items():
            conn.execute(
                f"UPDATE screen_prefs SET {column} = ? WHERE user_id = ? AND screen = ?",
                (value, user["id"], screen),
            )
        # A row that overrides nothing is the same as no row, and keeping it
        # would make "reset this screen" leave a trace that outlives the reset.
        conn.execute(
            """DELETE FROM screen_prefs
               WHERE user_id = ? AND screen = ?
                 AND board_set IS NULL AND piece_set IS NULL AND sound_set IS NULL""",
            (user["id"], screen),
        )
        row = conn.execute(f"SELECT {USER_FIELDS} FROM users WHERE id = ?", (user["id"],)).fetchone()
    return screen_prefs_for(dict(row))
