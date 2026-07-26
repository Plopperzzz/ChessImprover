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
