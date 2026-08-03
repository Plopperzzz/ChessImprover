import json
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
    -- Whether to ask Maia3 for the policy probability behind its ordering
    -- (see app/maia_policy.py). On by default: it costs one extra process
    -- probe per sweep and turns the rank surrogate into the real thing.
    maia_policy INTEGER NOT NULL DEFAULT 1,
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

-- A line you played that the game didn't (B3). One row per *line* rather than
-- per move: a line is what a person means by "that variation", and the common
-- case -- play four moves, keep them -- is one insert.
--
-- parent_id NULL means it branches off the game's mainline after `start_ply`
-- half-moves; otherwise it branches off another line after `start_ply` moves of
-- that line. The self-referencing cascade is what makes deleting a variation
-- take its nested ones with it.
CREATE TABLE IF NOT EXISTS variations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES variations(id) ON DELETE CASCADE,
    start_ply INTEGER NOT NULL,
    moves_json TEXT NOT NULL,       -- SAN, in order, from the anchor
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_variations_game ON variations(user_id, game_id);

-- Board, pieces and sounds per screen, over the top of the defaults on `users`.
--
-- A table rather than nine more columns on `users` (A7): three screens times
-- three kinds of asset is nine today, and every screen or asset kind added
-- later is another migration on the table that holds accounts. NULL means
-- "follow the default" and is the normal state -- a row exists only for a
-- screen someone has actually overridden, so the defaults keep working for
-- everyone who never opens that pane.
CREATE TABLE IF NOT EXISTS screen_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    screen TEXT NOT NULL,           -- 'analysis' | 'puzzles' | 'play'
    board_set TEXT,
    piece_set TEXT,
    sound_set TEXT,
    PRIMARY KEY (user_id, screen)
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
    -- The game's permanent URL on the site it came from (chess.com's `Link`
    -- header, lichess's `Site`), so re-downloading a month adds only what is
    -- new. NULL whenever the export carries no such header, and deliberately
    -- not UNIQUE: uploading the same file twice by hand is the user saying
    -- "yes, again", and only the importers dedupe on this.
    external_id TEXT,
    -- The TimeControl header as written ('600+5'), and the speed bucket it
    -- falls in ('bullet' | 'blitz' | 'rapid' | 'daily'). Derived at ingest and
    -- stored rather than computed per query, because filtering the library by
    -- them is a per-keystroke operation. Both NULL when the export carries no
    -- usable TimeControl, which the filters treat as "unknown", never as a
    -- bucket of its own to hide games in.
    time_control TEXT,
    speed TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_games_user ON games(user_id);
CREATE INDEX IF NOT EXISTS idx_games_upload ON games(upload_id);

-- A named group of games -- "my Caro-Kanns", "September tournament". A game
-- can be in any number of them, and being in none is the normal state, so
-- this is a tagging relation and not a folder tree.
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
);

-- Membership. Both cascades matter: deleting a group must not delete the
-- games in it, and deleting a game must not leave it a member of anything.
CREATE TABLE IF NOT EXISTS game_collections (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (collection_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_game_collections_game ON game_collections(game_id);

-- What we already know about each chess.com monthly archive, so a repeat
-- import doesn't download months it has already got (see app/chesscom.py).
--
-- Two things make a re-download unnecessary, and this table holds the
-- evidence for both:
--
-- * `etag` / `last_modified` are chess.com's own cache validators, sent back
--   on the next request so an unchanged month answers 304 with no body.
-- * `fetched_at` says *when* we last read the archive. A monthly archive
--   holds the games that ended in that month, so once the month is over
--   nothing can be added to it -- a month fetched after it ended is final and
--   need never be requested again, not even to be told it hasn't changed.
--
-- Keyed by username as well as user, because one account may import from more
-- than one chess.com handle (an alt, or a partner's games).
CREATE TABLE IF NOT EXISTS chesscom_archives (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    etag TEXT,
    last_modified TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- How many games the archive held when we last read it. Reported to the
    -- browser so "nothing new" can be said with a number behind it.
    games INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, username, year, month)
);

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
    -- The probability Maia gave the move actually played, per grid point, when
    -- the engine reported a policy at all. Two characters per grid point (see
    -- `elo_sweep.encode_policies`) rather than a JSON array of floats, for the
    -- same reason `scores` is one character: this is the largest table in the
    -- database and a thousand-game batch has to stay a sane size.
    --
    -- NULL is the normal case, not an error -- no stock Maia3 build reports a
    -- policy, and every sweep taken before this column existed has none. The
    -- likelihood fit reads the ranks in `scores` instead when it's absent, so
    -- an old row still re-fits under the new objective without being re-run.
    policies TEXT,
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
    -- Whether the theme tagger has run over this puzzle. A flag rather than
    -- "are there rows in puzzle_themes", because a puzzle can legitimately
    -- have no themes and would otherwise be re-tagged on every pass.
    themes_tagged INTEGER NOT NULL DEFAULT 0,
    -- Estimated difficulty, and how rough the estimate is, on the same scale
    -- as a Lichess puzzle rating. Both NULL until it can be estimated at all
    -- -- which needs the Lichess database imported to calibrate against, and
    -- the solution known so the puzzle has themes to calibrate *on*. An
    -- unrated puzzle is still perfectly playable; it just doesn't move your
    -- rating, because there is nothing honest to move it by.
    rating INTEGER,
    rating_rd INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- One puzzle per bad move, so a re-analysed or re-batched game can't
    -- produce the same position twice.
    UNIQUE(user_id, game_id, ply)
);

CREATE INDEX IF NOT EXISTS idx_puzzles_user ON puzzles(user_id, solved);

-- Themes on a puzzle built from your own games, in Lichess's own vocabulary
-- (see app/puzzle_themes.py). Kept in its own table rather than a text column
-- on `puzzles` so the theme picker can filter with an index instead of a LIKE
-- over every row.
--
-- Filled in lazily, like the solution: most of the motifs are properties of
-- the move you *should* have played, and that move isn't known until an
-- engine works it out. A puzzle whose solution has never been computed
-- carries only the themes readable off the position itself.
CREATE TABLE IF NOT EXISTS puzzle_themes (
    puzzle_id INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
    theme TEXT NOT NULL,
    PRIMARY KEY (puzzle_id, theme)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_themes_theme ON puzzle_themes(theme);

-- The Lichess puzzle database (https://database.lichess.org/#puzzles), as
-- imported by app/lichess_puzzles.py.
--
-- Deliberately NOT scoped to a user. It is a public dataset of several
-- million rows and a copy per account would be several million rows per
-- account; what is per-user is which of them you have attempted, and that
-- lives in `puzzle_attempts`.
CREATE TABLE IF NOT EXISTS lichess_puzzles (
    puzzle_id TEXT PRIMARY KEY,
    -- The position *before* the opponent's move. The first move in `moves` is
    -- theirs and is played automatically; the solver answers from the
    -- position after it. This is Lichess's own convention and keeping it
    -- means an imported row needs no rewriting.
    fen TEXT NOT NULL,
    moves TEXT NOT NULL,              -- space-separated UCI, opponent first
    rating INTEGER NOT NULL,
    rating_deviation INTEGER,
    popularity INTEGER,
    nb_plays INTEGER,
    themes TEXT NOT NULL,             -- space-separated theme keys
    game_url TEXT,
    opening_tags TEXT
);

CREATE INDEX IF NOT EXISTS idx_lichess_puzzles_rating ON lichess_puzzles(rating);

-- Theme keys, numbered. The join table below is the biggest thing in the
-- database -- several themes per puzzle across millions of puzzles -- so the
-- theme is stored there as a small integer rather than as the string.
CREATE TABLE IF NOT EXISTS lichess_theme_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme TEXT NOT NULL UNIQUE
);

-- Which puzzles carry which theme. Ordered (theme, rating) because that is
-- the only query that runs against it: "a puzzle with this theme, near this
-- rating". WITHOUT ROWID because the primary key is the whole row -- there is
-- nothing else to store, and the rowid copy would double the table.
CREATE TABLE IF NOT EXISTS lichess_puzzle_themes (
    theme_id INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    puzzle_id TEXT NOT NULL,
    PRIMARY KEY (theme_id, rating, puzzle_id)
) WITHOUT ROWID;

-- One row, describing the import that produced the table above.
CREATE TABLE IF NOT EXISTS lichess_puzzle_import (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT,
    puzzles INTEGER NOT NULL DEFAULT 0,
    filters_json TEXT NOT NULL DEFAULT '{}'
);

-- PGNs of the games Lichess puzzles came from, fetched one at a time the
-- first blindfold training actually asks for one -- never bulk-downloaded,
-- since that would mean fetching games for puzzles nobody trains blindfold
-- on. Shared across every account on this instance: the PGN is the same
-- for whoever asks, so a game already looked up is free the second time.
CREATE TABLE IF NOT EXISTS lichess_game_cache (
    game_id TEXT PRIMARY KEY,
    pgn TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Your puzzle rating, overall and per theme. One row per (user, theme), with
-- the empty string standing for "overall" -- the per-theme numbers answer
-- "am I actually getting better at forks", which a single rating cannot.
--
-- Glicko-2 (see app/glicko2.py), which is what Lichess rates puzzles with.
-- `rd` is how unsure the rating is and is as much a part of it as the number.
CREATE TABLE IF NOT EXISTS puzzle_ratings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL,              -- '' = overall
    rating REAL NOT NULL DEFAULT 1500,
    rd REAL NOT NULL DEFAULT 350,
    vol REAL NOT NULL DEFAULT 0.06,
    attempts INTEGER NOT NULL DEFAULT 0,
    solved INTEGER NOT NULL DEFAULT 0,
    best_rating REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, theme)
);

-- One row per graded attempt, from either source. This is both the history
-- the progress view reads and the record of what you have already seen, which
-- is what stops the same Lichess puzzle coming round twice.
CREATE TABLE IF NOT EXISTS puzzle_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,             -- 'own' | 'lichess'
    -- 'own:123' or 'lichess:00sHx'. One column rather than a nullable pair,
    -- because every query against it wants "have I done this one".
    puzzle_key TEXT NOT NULL,
    solved INTEGER NOT NULL,
    -- Whether this attempt moved the rating. Only the first attempt at a
    -- puzzle does, which is Lichess's rule and the only one that makes the
    -- number mean anything -- otherwise retrying a failed puzzle until it
    -- works would ratchet the rating up for free.
    rated INTEGER NOT NULL DEFAULT 0,
    puzzle_rating INTEGER,
    rating_before REAL,
    rating_after REAL,
    themes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_key ON puzzle_attempts(user_id, puzzle_key);
CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_user ON puzzle_attempts(user_id, created_at);

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
    # Wait for a writer rather than failing instantly. The puzzle-database
    # import writes for minutes from a background thread (see
    # app/lichess_puzzles.py), and with sqlite3's default a click that
    # happened to land during one of its batches would come back as
    # "database is locked" instead of just taking a moment.
    conn.execute("PRAGMA busy_timeout = 15000")
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


def _backfill_external_ids(conn):
    """Fill `games.external_id` for games uploaded before the column existed.

    Without this the first chess.com import would re-add every game already in
    the library by hand, since a NULL id is "can't tell", not "not seen". The
    `Link`/`Site` header it reads is already stored on every row, so this
    costs one pass over `headers_json` and no network at all. Once, so a row
    whose id is deliberately cleared later isn't refilled.
    """
    if _applied(conn, "backfill_external_ids"):
        return
    from .pgn_parse import external_game_id

    rows = conn.execute(
        "SELECT id, headers_json FROM games WHERE external_id IS NULL"
    ).fetchall()
    updates = []
    for row in rows:
        try:
            headers = json.loads(row["headers_json"])
        except (ValueError, TypeError):
            continue
        if external_id := external_game_id(headers):
            updates.append((external_id, row["id"]))
    if updates:
        conn.executemany("UPDATE games SET external_id = ? WHERE id = ?", updates)


def _backfill_time_controls(conn):
    """Fill `games.time_control`/`games.speed` for games stored before the
    columns existed, from the `TimeControl` header already on every row.

    Without it the speed filter would show an existing library as entirely
    "unknown" until every game was re-imported. Runs once; a game whose
    headers carry no usable control stays NULL, which is what the filters
    read as unknown.
    """
    if _applied(conn, "backfill_time_controls"):
        return
    from .pgn_parse import normalise_time_control, time_control_speed

    rows = conn.execute(
        "SELECT id, headers_json FROM games WHERE time_control IS NULL AND speed IS NULL"
    ).fetchall()
    updates = []
    for row in rows:
        try:
            headers = json.loads(row["headers_json"])
        except (ValueError, TypeError):
            continue
        raw = headers.get("TimeControl")
        if normalise_time_control(raw) or time_control_speed(raw or ""):
            updates.append((normalise_time_control(raw), time_control_speed(raw or ""),
                            row["id"]))
    if updates:
        conn.executemany(
            "UPDATE games SET time_control = ?, speed = ? WHERE id = ?", updates
        )


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
        _ensure_column(conn, "users", "sound_set", "TEXT NOT NULL DEFAULT 'default'")
        _split_asset_set(conn)
        _ensure_column(conn, "engine_settings", "maia_options_json", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "engine_settings", "great_max_drop", "REAL NOT NULL DEFAULT 0.02")
        _ensure_column(conn, "engine_settings", "great_max_match_rate", "REAL NOT NULL DEFAULT 0.20")
        _ensure_column(conn, "engine_settings", "brilliant_enabled", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "engine_settings", "maia_elo_step_batch", "INTEGER NOT NULL DEFAULT 200")
        _ensure_column(conn, "engine_settings", "stockfish_options_json", "TEXT NOT NULL DEFAULT '{}'")
        _ensure_column(conn, "engine_settings", "maia_multipv", "INTEGER NOT NULL DEFAULT 3")
        _ensure_column(conn, "engine_settings", "maia_policy", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "engine_settings", "min_think_ms", "INTEGER NOT NULL DEFAULT 2000")
        _ensure_column(conn, "games", "clocks_json", "TEXT")
        _ensure_column(conn, "games", "your_color_locked", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "games", "external_id", "TEXT")
        _ensure_column(conn, "games", "time_control", "TEXT")
        _ensure_column(conn, "games", "speed", "TEXT")
        # After the column is guaranteed to exist, so a database created by an
        # earlier version can be indexed on the same run that adds it.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_games_external ON games(user_id, external_id)")
        _backfill_external_ids(conn)
        _backfill_time_controls(conn)
        _ensure_column(conn, "puzzles", "themes_tagged", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(conn, "puzzles", "rating", "INTEGER")
        _ensure_column(conn, "puzzles", "rating_rd", "INTEGER")
        # What kind of exercise this position is: 'tactic' (there is something
        # to win, find it) or 'blunder_check' (you were fine and threw it
        # away, find the move that holds). Decided when the puzzle is built,
        # off the evaluations the analysis pass already stored -- see
        # app/puzzles.classify_kind.
        _ensure_column(conn, "puzzles", "kind", "TEXT NOT NULL DEFAULT 'tactic'")
        _ensure_column(conn, "puzzles", "cp_after", "REAL")
        # The whole answer, not just its first move: space-separated UCI,
        # yours first, alternating with the opponent's best replies. Same
        # shape as a Lichess row's `moves` with the setup move removed, so one
        # grader can walk either source's line.
        _ensure_column(conn, "puzzles", "solution_line", "TEXT")
        _ensure_column(conn, "puzzles", "moves_required", "INTEGER NOT NULL DEFAULT 1")
        _ensure_column(conn, "puzzles", "line_cp", "REAL")
        # How much better the solution is than the second-best move, in win
        # probability. This is what says whether the position is a puzzle at
        # all: when three moves are equally fine there is nothing to find.
        _ensure_column(conn, "puzzles", "unique_margin", "REAL")
        # Difficulty measured by asking Maia, at each Elo on the grid, whether
        # it would play the line (app/puzzle_difficulty.py). `rating` above is
        # what the rater uses and may come from either estimator; these two
        # keep the Maia measurement itself, so switching estimators later
        # doesn't lose it.
        _ensure_column(conn, "puzzles", "maia_elo", "REAL")
        _ensure_column(conn, "puzzles", "maia_rd", "REAL")
        _ensure_column(conn, "puzzles", "rating_source", "TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_puzzles_kind ON puzzles(user_id, kind, solved)")
        _ensure_column(conn, "sweep_positions", "think_ms", "INTEGER")
        _ensure_column(conn, "sweep_positions", "policies", "TEXT")
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
