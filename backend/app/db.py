import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("CHESSIMPROVER_DB", os.path.join(os.path.dirname(__file__), "..", "data", "chessimprover.db"))
os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    asset_set TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engine_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stockfish_path TEXT,
    stockfish_threads INTEGER NOT NULL DEFAULT 1,
    stockfish_hash_mb INTEGER NOT NULL DEFAULT 128,
    sf_limit_type TEXT NOT NULL DEFAULT 'depth',   -- 'depth' | 'movetime'
    sf_limit_value INTEGER NOT NULL DEFAULT 18,
    sf_skill_level INTEGER,                        -- NULL = full strength
    maia_path TEXT,
    maia_model_size TEXT NOT NULL DEFAULT '5m',     -- '5m' | '25m' | '79m'
    maia_elo_min INTEGER NOT NULL DEFAULT 1100,
    maia_elo_max INTEGER NOT NULL DEFAULT 1900,
    maia_elo_step INTEGER NOT NULL DEFAULT 100,
    -- Coarser grid for batch runs: a fine sweep is affordable for one game
    -- and not for a thousand (section 9).
    maia_elo_step_batch INTEGER NOT NULL DEFAULT 200,
    -- Great/Brilliant criteria (spec section 8 asked for these to be pinned
    -- down rather than improvised, and they're taste, so they're settings).
    great_max_drop REAL NOT NULL DEFAULT 0.02,
    great_max_match_rate REAL NOT NULL DEFAULT 0.20,
    brilliant_enabled INTEGER NOT NULL DEFAULT 1,
    -- Free-form per-engine UCI option overrides ({name: value}), driven by
    -- whatever the engine advertises rather than a fixed set of columns.
    maia_options_json TEXT NOT NULL DEFAULT '{}',
    stockfish_options_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per uploaded file or pasted-PGN submission (raw text kept for provenance).
CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,       -- filename, or 'pasted' for pasted text
    raw_text TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per parsed game. batch_index is stable across the whole multi-file
-- upload batch that produced it (assigned at parse time, not on later re-fetch).
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    upload_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    batch_index INTEGER NOT NULL,
    source_name TEXT NOT NULL,
    game_index_in_source INTEGER NOT NULL,
    white TEXT,
    black TEXT,
    result TEXT,
    event TEXT,
    date_header TEXT,
    utc_date_header TEXT,
    year INTEGER,          -- NULL if year/month unparseable -- excluded from date-bucketed views
    month INTEGER,
    your_color TEXT,       -- 'w' | 'b' | 'unassigned'
    pgn_text TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id);
CREATE INDEX IF NOT EXISTS idx_games_upload ON games(upload_id);

-- A saved analysis run: a named container that games get appended to, so a
-- batch (section 12) and a one-off single-game analysis are the same shape.
CREATE TABLE IF NOT EXISTS analysis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One analysed game inside a run. Re-analysing the same game in the same
-- mode replaces the previous result rather than piling up duplicates.
CREATE TABLE IF NOT EXISTS run_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,             -- 'quick' | 'full'
    grid_json TEXT,                 -- swept Elo grid (full mode only)
    results_json TEXT,              -- per-side Elo estimate + confidence
    engine_note TEXT,
    analyzed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, game_id, mode)
);

CREATE TABLE IF NOT EXISTS analysis_moves (
    run_game_id INTEGER NOT NULL REFERENCES run_games(id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,
    san TEXT,
    cp_before REAL,
    cp_after REAL,
    wp_drop REAL,                   -- 'drop' is a SQL keyword
    classification TEXT,
    maia_match_rate REAL,
    lowest_matching_elo INTEGER,
    PRIMARY KEY (run_game_id, ply)
);

-- Per-position sweep scores, kept so the trend view (section 15) can be
-- recomputed or re-bucketed without re-running any engine (section 13).
-- `scores` is one character per grid point, which keeps a 1000-game batch to
-- a sane row count while staying trivially decodable.
CREATE TABLE IF NOT EXISTS sweep_positions (
    run_game_id INTEGER NOT NULL REFERENCES run_games(id) ON DELETE CASCADE,
    side TEXT NOT NULL,
    ply INTEGER NOT NULL,
    fen TEXT,
    uci TEXT,
    scores TEXT,
    PRIMARY KEY (run_game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_run_games_user ON run_games(user_id);
CREATE INDEX IF NOT EXISTS idx_run_games_game ON run_games(game_id);
"""


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_column(conn, table: str, column: str, ddl: str):
    """Adds a column to an already-existing table if it's missing, so a
    schema addition doesn't break a database created by an earlier version
    of this app (CREATE TABLE IF NOT EXISTS alone would silently skip new
    columns on a table that already exists)."""
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db():
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        _ensure_column(conn, "users", "asset_set", "TEXT NOT NULL DEFAULT 'default'")
        _ensure_column(conn, "engine_settings", "maia_options_json", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "engine_settings", "great_max_drop", "REAL NOT NULL DEFAULT 0.02")
        _ensure_column(conn, "engine_settings", "great_max_match_rate", "REAL NOT NULL DEFAULT 0.20")
        _ensure_column(conn, "engine_settings", "brilliant_enabled", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "engine_settings", "maia_elo_step_batch", "INTEGER NOT NULL DEFAULT 200")
        _ensure_column(conn, "engine_settings", "stockfish_options_json", "TEXT NOT NULL DEFAULT '{}'")
        conn.commit()
    finally:
        conn.close()


@contextmanager
def db_cursor():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
