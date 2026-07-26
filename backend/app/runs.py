"""Saved analysis runs (spec section 13).

Every completed analysis is persisted, so switching games in the picker no
longer throws the result away -- selecting a game loads whatever was last
computed for it. Runs are named containers that games are appended to, which
is the same shape a batch will need in section 12.

Per-*position* sweep data is stored, not just the final labels, so the trend
view can be recomputed or re-bucketed later without re-running any engine.
"""

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_user
from .db import db_cursor

router = APIRouter(prefix="/api/runs", tags=["runs"])

DEFAULT_RUN_NAME = "My analyses"


def get_default_run_id(conn, user_id: int) -> int:
    row = conn.execute(
        "SELECT id FROM analysis_runs WHERE user_id = ? AND is_default = 1", (user_id,)
    ).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO analysis_runs (user_id, name, is_default) VALUES (?, ?, 1)",
        (user_id, DEFAULT_RUN_NAME),
    )
    return cur.lastrowid


def save_analysis(user_id: int, game_id: int, mode: str, payload: dict, run_id: int | None = None) -> int:
    """Writes one analysed game into a run, replacing any previous result for
    the same game and mode. Returns the run_games id."""
    moves = payload.get("moves") or []
    with db_cursor() as conn:
        target_run = run_id or get_default_run_id(conn, user_id)
        owns = conn.execute(
            "SELECT id FROM analysis_runs WHERE id = ? AND user_id = ?", (target_run, user_id)
        ).fetchone()
        if not owns:
            raise HTTPException(404, "no such run")

        conn.execute(
            "DELETE FROM run_games WHERE run_id = ? AND game_id = ? AND mode = ?",
            (target_run, game_id, mode),
        )
        cur = conn.execute(
            """INSERT INTO run_games (run_id, user_id, game_id, mode, grid_json, results_json, engine_note)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                target_run, user_id, game_id, mode,
                json.dumps(payload.get("grid")) if payload.get("grid") else None,
                json.dumps(payload.get("results")) if payload.get("results") else None,
                payload.get("model_note"),
            ),
        )
        run_game_id = cur.lastrowid

        conn.executemany(
            """INSERT INTO analysis_moves
               (run_game_id, ply, san, cp_before, cp_after, wp_drop, classification,
                maia_match_rate, lowest_matching_elo)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    run_game_id, m["ply"], m.get("san"), m.get("cp_before"), m.get("cp_after"),
                    m.get("drop"), m.get("classification"), m.get("maia_match_rate"),
                    m.get("lowest_matching_elo"),
                )
                for m in moves
            ],
        )

        sweep = payload.get("sweep_cache")
        if sweep:
            rows = []
            for side, block in (sweep.get("players") or {}).items():
                for i, position in enumerate(block.get("positions", [])):
                    scores = "".join("1" if v else "0" for v in block["matrix"][i])
                    rows.append((run_game_id, side, position["ply"], position["fen"],
                                 position["uci"], scores))
            conn.executemany(
                """INSERT INTO sweep_positions (run_game_id, side, ply, fen, uci, scores)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                rows,
            )

        conn.execute("UPDATE analysis_runs SET updated_at = datetime('now') WHERE id = ?", (target_run,))
    return run_game_id


def load_for_game(user_id: int, game_id: int) -> dict | None:
    """The saved analysis to show when a game is selected. Full mode wins over
    quick when both exist -- it's a superset -- and otherwise the most recent."""
    with db_cursor() as conn:
        row = conn.execute(
            """SELECT * FROM run_games WHERE user_id = ? AND game_id = ?
               ORDER BY (mode = 'full') DESC, analyzed_at DESC LIMIT 1""",
            (user_id, game_id),
        ).fetchone()
        if not row:
            return None
        moves = conn.execute(
            """SELECT ply, san, cp_before, cp_after, wp_drop AS "drop", classification,
                      maia_match_rate, lowest_matching_elo
               FROM analysis_moves WHERE run_game_id = ? ORDER BY ply""",
            (row["id"],),
        ).fetchall()
    return {
        "run_game_id": row["id"],
        "run_id": row["run_id"],
        "mode": row["mode"],
        "analyzed_at": row["analyzed_at"],
        "grid": json.loads(row["grid_json"]) if row["grid_json"] else None,
        "results": json.loads(row["results_json"]) if row["results_json"] else None,
        "model_note": row["engine_note"],
        "moves": [dict(m) for m in moves],
    }


def analyzed_game_ids(user_id: int) -> dict[int, str]:
    """{game_id: mode} for games with a saved analysis, so the picker can mark
    them without a request per row."""
    with db_cursor() as conn:
        rows = conn.execute(
            """SELECT game_id, MAX(mode = 'full') AS has_full
               FROM run_games WHERE user_id = ? GROUP BY game_id""",
            (user_id,),
        ).fetchall()
    return {r["game_id"]: ("full" if r["has_full"] else "quick") for r in rows}


class RunIn(BaseModel):
    name: str


@router.get("")
def list_runs(user: dict = Depends(require_user)):
    with db_cursor() as conn:
        rows = conn.execute(
            """SELECT r.id, r.name, r.is_default, r.created_at, r.updated_at,
                      COUNT(g.id) AS game_count
               FROM analysis_runs r
               LEFT JOIN run_games g ON g.run_id = r.id
               WHERE r.user_id = ?
               GROUP BY r.id ORDER BY r.is_default DESC, r.updated_at DESC""",
            (user["id"],),
        ).fetchall()
        if not rows:
            get_default_run_id(conn, user["id"])
            rows = conn.execute(
                """SELECT id, name, is_default, created_at, updated_at, 0 AS game_count
                   FROM analysis_runs WHERE user_id = ?""",
                (user["id"],),
            ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_run(body: RunIn, user: dict = Depends(require_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "a run needs a name")
    with db_cursor() as conn:
        cur = conn.execute(
            "INSERT INTO analysis_runs (user_id, name) VALUES (?, ?)", (user["id"], name)
        )
        return {"id": cur.lastrowid, "name": name, "is_default": 0, "game_count": 0}


@router.get("/{run_id}")
def get_run(run_id: int, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        run = conn.execute(
            "SELECT * FROM analysis_runs WHERE id = ? AND user_id = ?", (run_id, user["id"])
        ).fetchone()
        if not run:
            raise HTTPException(404, "no such run")
        games = conn.execute(
            """SELECT rg.id, rg.game_id, rg.mode, rg.analyzed_at, rg.results_json,
                      g.white, g.black, g.result, g.utc_date_header, g.your_color
               FROM run_games rg JOIN games g ON g.id = rg.game_id
               WHERE rg.run_id = ? ORDER BY rg.analyzed_at DESC""",
            (run_id,),
        ).fetchall()
    return {
        "id": run["id"],
        "name": run["name"],
        "games": [
            {**dict(g), "results": json.loads(g["results_json"]) if g["results_json"] else None}
            for g in games
        ],
    }


@router.delete("/{run_id}")
def delete_run(run_id: int, user: dict = Depends(require_user)):
    with db_cursor() as conn:
        run = conn.execute(
            "SELECT is_default FROM analysis_runs WHERE id = ? AND user_id = ?", (run_id, user["id"])
        ).fetchone()
        if not run:
            raise HTTPException(404, "no such run")
        if run["is_default"]:
            raise HTTPException(400, "the default run can't be deleted")
        conn.execute("DELETE FROM analysis_runs WHERE id = ?", (run_id,))
    return {"ok": True}


class AppendIn(BaseModel):
    game_id: int
    mode: str = "quick"


@router.post("/{run_id}/append")
def append_to_run(run_id: int, body: AppendIn, user: dict = Depends(require_user)):
    """Copies an already-analysed game into another run, so a run can be built
    up from existing work rather than only by re-analysing."""
    saved = load_for_game(user["id"], body.game_id)
    if not saved:
        raise HTTPException(404, "that game has no saved analysis to append")
    with db_cursor() as conn:
        source = conn.execute(
            "SELECT * FROM sweep_positions WHERE run_game_id = ?", (saved["run_game_id"],)
        ).fetchall()
    payload = {
        "moves": saved["moves"],
        "grid": saved["grid"],
        "results": saved["results"],
        "model_note": saved["model_note"],
    }
    if source and saved["grid"]:
        payload["sweep_cache"] = {
            "grid": saved["grid"],
            "players": _regroup(source),
        }
    new_id = save_analysis(user["id"], body.game_id, saved["mode"], payload, run_id=run_id)
    return {"run_game_id": new_id}


def _regroup(rows) -> dict:
    players: dict[str, dict] = {}
    for r in rows:
        block = players.setdefault(r["side"], {"positions": [], "matrix": []})
        block["positions"].append({"ply": r["ply"], "fen": r["fen"], "uci": r["uci"]})
        block["matrix"].append([1.0 if c == "1" else 0.0 for c in (r["scores"] or "")])
    return players
