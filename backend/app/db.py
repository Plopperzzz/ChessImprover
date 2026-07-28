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
    -- The set a board and its pieces came from together. Kept because the two
    -- below were split out of it, and it is still what "use one set for both"
    -- writes to.
    asset_set TEXT NOT NULL DEFAULT 'default',
    -- Board and pieces are chosen separately: the two are independent art, and
    -- the combination someone wants is rarely both halves of one set.
    board_set TEXT NOT NULL DEFAULT 'default',
    piece_set TEXT NOT NULL DEFAULT 'default',
    -- Board-view preferences live with the user rather than in the browser, so
    -- they follow you from the desktop to the phone.
    show_legal_moves INTEGER NOT NULL DEFAULT 1,
    allow_premoves INTEGER NOT NULL DEFAULT 1,
    -- Where the evaluation bar goes: 'top' runs it along the top of the
    -- board, 'left'/'right' stand it up beside the board.
    eval_bar_side TEXT NOT NULL DEFAULT 'top',
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
    -- Wide by default. A narrow grid can't locate a peak near its edge, and
    -- the fit has fewer points to work with; the sweep costs one engine call
    -- per grid point per position, so widen the range and coarsen the step in
    -- batch rather than sweeping a narrow window finely.
    maia_elo_min INTEGER NOT NULL DEFAULT 600,
    maia_elo_max INTEGER NOT NULL DEFAULT 2600,
    maia_elo_step INTEGER NOT NULL DEFAULT 100,
    -- Coarser grid for batch runs: a fine sweep is affordable for one game
    -- and not for a thousand (section 9).
    maia_elo_step_batch INTEGER NOT NULL DEFAULT 200,
    -- How many ranked candidates to record per position. At `go nodes 1` the
    -- policy net has already ordered every legal move, so asking for several
    -- costs no extra engine time and lets the fit use a top-N objective later
    -- without re-running anything.
    maia_multipv INTEGER NOT NULL DEFAULT 3,
    -- Shifts Maia's published accuracy curves before the match rate is scored
    -- against them. The curves are measured on Lichess blitz, so a library of
    -- rapid or classical games sits a little below them through no fault of
    -- the player -- longer thinking finds more moves the policy net doesn't.
    -- Left at 0 by default rather than guessing a correction.
    maia_accuracy_offset REAL NOT NULL DEFAULT 0.0,
    -- Moves played in less than this are dropped from the Elo fit: a move
    -- made in half a second is a premove or an instant recapture, not
    -- evidence of how well you play. Ignored when the games carry no clocks,
    -- and disabled automatically when it would remove most of a library.
    min_think_ms INTEGER NOT NULL DEFAULT 2000,
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
    -- Set when a human picked the side by hand. A re-match after an account
    -- rename skips these rows, so correcting one odd game (an alt handle, a
    -- team event under a different name) isn't undone by the next rename.
    your_color_locked INTEGER NOT NULL DEFAULT 0,
    pgn_text TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    -- Milliseconds spent per ply, from the %clk comments in the export. Read
    -- at upload because pgn_text is stored without comments -- once a game is
    -- in, its clocks are unrecoverable. NULL when the export carried none.
    clocks_json TEXT,
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
    -- Which Maia binary actually swept this game. Needed to score the match
    -- rate against that model's published accuracy curve, which differs enough
    -- between sizes at master level to matter. NULL when it can't be known --
    -- a generic maia3-uci, or a fallback to a binary of unstated size.
    maia_model_size TEXT,
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
    -- How long the player took over this move, so a re-fit can drop moves
    -- played with no thought without re-parsing any PGN. NULL means unknown,
    -- which is never treated as "instant".
    think_ms INTEGER,
    PRIMARY KEY (run_game_id, ply)
);

-- Puzzles built from your own mistakes and blunders (one per bad move you
-- played). The position and the move come from replaying the stored PGN, so
-- generating them needs no engine at all; the *solution* does, and is filled
-- in lazily the first time a puzzle is actually attempted -- a library of
-- 4000 blunders shouldn't cost 4000 searches for the dozen you look at.
CREATE TABLE IF NOT EXISTS puzzles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply INTEGER NOT NULL,
    fen TEXT NOT NULL,                -- the position you faced, before your move
    played_uci TEXT NOT NULL,
    played_san TEXT,
    your_color TEXT NOT NULL,
    classification TEXT NOT NULL,     -- 'mistake' | 'blunder' | 'miss'
    wp_drop REAL,                     -- win probability you gave up with it
    cp_before REAL,
    solution_uci TEXT,
    solution_san TEXT,
    solution_cp REAL,
    solved_at TEXT,                   -- when the engine worked the answer out
    attempts INTEGER NOT NULL DEFAULT 0,
    solved INTEGER NOT NULL DEFAULT 0,
    revealed INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- One puzzle per bad move, so a re-analysed or re-batched game can't
    -- produce the same position twice.
    UNIQUE(user_id, game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_puzzles_user ON puzzles(user_id, solved);

-- Applied one-off data migrations, so a migration that rewrites user data
-- can't run twice and undo a deliberate change made afterwards.
CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
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


def _applied(conn, name: str) -> bool:
    row = conn.execute("SELECT 1 FROM migrations WHERE name = ?", (name,)).fetchone()
    if row:
        return True
    conn.execute("INSERT INTO migrations (name) VALUES (?)", (name,))
    return False


def _widen_default_elo_grid(conn):
    """The original default sweep range was 1100-1900, which is too narrow to
    locate a peak reliably and biased the old curve fit. Widen it for anyone
    still sitting on that exact pair -- and only once, so a user who
    deliberately narrows the range again keeps it."""
    if _applied(conn, "widen_default_elo_grid"):
        return
    conn.execute(
        """UPDATE engine_settings SET maia_elo_min = 600, maia_elo_max = 2600
           WHERE maia_elo_min = 1100 AND maia_elo_max = 1900"""
    )


def _split_asset_set(conn):
    """board_set/piece_set were split out of the single asset_set. Adding the
    columns gives every existing user the column default rather than the set
    they had chosen, so seed both from asset_set -- once, so a user who later
    mixes a board from one set with pieces from another keeps that."""
    if _applied(conn, "split_asset_set"):
        return
    conn.execute("UPDATE users SET board_set = asset_set, piece_set = asset_set")


def _backfill_model_size(conn):
    """Fill `run_games.maia_model_size` for sweeps that ran before the column
    existed, by reading the engine note each of them already stored.

    Every sweep recorded which binary it resolved -- `resolve_binary`'s note
    names it -- so the model behind an old analysis is recoverable without
    re-running anything. Rows whose note genuinely can't say (a generic
    `maia3-uci`, or a fallback to a binary of unstated size) are left NULL and
    simply go unanchored; guessing from the user's *current* model-size setting
    would be wrong, since that setting may have changed since the sweep ran.
    """
    if _applied(conn, "backfill_maia_model_size"):
        return
    from .maia_accuracy import model_size_from_note

    rows = conn.execute(
        "SELECT id, engine_note FROM run_games WHERE maia_model_size IS NULL "
        "AND engine_note IS NOT NULL"
    ).fetchall()
    updates = [(size, row["id"]) for row in rows
               if (size := model_size_from_note(row["engine_note"]))]
    if updates:
        conn.executemany("UPDATE run_games SET maia_model_size = ? WHERE id = ?", updates)


def init_db():
    conn = get_conn()
    try:
        conn.executescript(SCHEMA)
        _ensure_column(conn, "users", "asset_set", "TEXT NOT NULL DEFAULT 'default'")
        _ensure_column(conn, "users", "board_set", "TEXT NOT NULL DEFAULT 'default'")
        _ensure_column(conn, "users", "piece_set", "TEXT NOT NULL DEFAULT 'default'")
        _ensure_column(conn, "users", "show_legal_moves", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "users", "allow_premoves", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "users", "eval_bar_side", "TEXT NOT NULL DEFAULT 'top'")
        _split_asset_set(conn)
        _ensure_column(conn, "engine_settings", "maia_options_json", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "engine_settings", "great_max_drop", "REAL NOT NULL DEFAULT 0.02")
        _ensure_column(conn, "engine_settings", "great_max_match_rate", "REAL NOT NULL DEFAULT 0.20")
        _ensure_column(conn, "engine_settings", "brilliant_enabled", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "engine_settings", "maia_elo_step_batch", "INTEGER NOT NULL DEFAULT 200")
        _ensure_column(conn, "engine_settings", "stockfish_options_json", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "engine_settings", "maia_multipv", "INTEGER NOT NULL DEFAULT 3")
        _ensure_column(conn, "engine_settings", "min_think_ms", "INTEGER NOT NULL DEFAULT 2000")
        _ensure_column(conn, "games", "clocks_json", "TEXT")
        _ensure_column(conn, "games", "your_color_locked", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "sweep_positions", "think_ms", "INTEGER")
        _ensure_column(conn, "run_games", "maia_model_size", "TEXT")
        _ensure_column(conn, "engine_settings", "maia_accuracy_offset", "REAL NOT NULL DEFAULT 0.0")
        _widen_default_elo_grid(conn)
        _backfill_model_size(conn)
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
