import io
import json
import re

import chess.pgn


def _parse_year_month(headers: dict) -> tuple[int | None, int | None]:
    """Prefer UTCDate over Date (chess.com/lichess exports carry UTCDate).
    A game whose year/month can't be parsed gets (None, None) so it's
    excluded from date-bucketed views rather than guessed at."""
    raw = headers.get("UTCDate") or headers.get("Date") or ""
    parts = raw.split(".")
    if len(parts) < 2:
        return None, None
    try:
        year = int(parts[0])
        month = int(parts[1])
        if not (1 <= month <= 12) or year < 1000:
            return None, None
        return year, month
    except ValueError:
        return None, None


def account_names(user) -> list[str]:
    """Every name an account may appear under in a PGN header.

    Both the display name and the username are tried, because which of the two
    someone typed as their chess.com handle is not something they should have
    to get right when creating the account -- getting it wrong used to leave
    every uploaded game 'unassigned', with no way to correct it short of
    re-uploading.
    """
    names = []
    for key in ("display_name", "username"):
        value = (user[key] or "").strip().lower() if key in user.keys() else ""
        if value and value not in names:
            names.append(value)
    return names


def external_game_id(headers: dict) -> str | None:
    """A stable identity for a game on the site it came from, or None.

    chess.com and lichess both put a permanent per-game URL in the export --
    `Link` on chess.com, `Site` on lichess -- and that is what lets a repeat
    import of the current month add only the games played since the last one.
    A PGN with neither returns None, which callers must read as "can't tell",
    not as "not a duplicate of anything".
    """
    for key in ("Link", "Site"):
        value = (headers.get(key) or "").strip()
        if value.lower().startswith(("http://", "https://")):
            return value
    return None


def match_color(headers: dict, names) -> str:
    """Which side the account played, by matching any of its names against the
    White/Black headers (case-insensitive, trimmed). Returns 'unassigned'
    rather than guessing if neither matches -- callers must surface that to
    the user, not drop the game or silently pick a side."""
    if isinstance(names, str):
        names = [names]
    wanted = {n.strip().lower() for n in names if n and n.strip()}
    white = (headers.get("White") or "").strip().lower()
    black = (headers.get("Black") or "").strip().lower()
    if white in wanted:
        return "w"
    if black in wanted:
        return "b"
    return "unassigned"


def reassign_your_colors(conn, user_id: int, names) -> dict:
    """Re-runs the White/Black match over every game already in the library,
    for when the names an account answers to have changed.

    Only games whose colour actually moves are written, and a game the user
    has assigned by hand is left alone -- see `games.your_color_locked`.
    Puzzles built for a side that is no longer the user's side are dropped:
    they were made from the opponent's mistakes, which are not your lesson.
    """
    rows = conn.execute(
        "SELECT id, headers_json, your_color FROM games "
        "WHERE user_id = ? AND your_color_locked = 0",
        (user_id,),
    ).fetchall()
    changed = []
    for row in rows:
        try:
            headers = json.loads(row["headers_json"])
        except (ValueError, TypeError):
            continue
        colour = match_color(headers, names)
        if colour != row["your_color"]:
            changed.append((colour, row["id"]))
    if changed:
        conn.executemany("UPDATE games SET your_color = ? WHERE id = ?", changed)
        conn.executemany(
            "DELETE FROM puzzles WHERE game_id = ? AND your_color != ?",
            [(game_id, colour) for colour, game_id in changed],
        )
    assigned = sum(1 for colour, _ in changed if colour != "unassigned")
    return {"changed": len(changed), "assigned": assigned,
            "unassigned": len(changed) - assigned}


_CLK_RE = re.compile(r"\[%clk\s+(\d+):(\d+):([\d.]+)\]")


def parse_time_control(raw: str) -> tuple[float | None, float]:
    """(base seconds, increment seconds) from a TimeControl header like
    '600', '600+5' or '180/9000'. Returns (None, 0) for '-' or anything
    unrecognised -- the first move of each side then has no baseline, so its
    think time is simply unknown rather than guessed."""
    raw = (raw or "").strip()
    if not raw or raw == "-":
        return None, 0.0
    base_part, _, inc_part = raw.partition("+")
    base_part = base_part.split("/")[-1]
    try:
        base = float(base_part)
    except ValueError:
        return None, 0.0
    try:
        increment = float(inc_part) if inc_part else 0.0
    except ValueError:
        increment = 0.0
    return base, increment


def normalise_time_control(raw) -> str | None:
    """The TimeControl header as something worth filtering on, or None.

    PGN writes "no time control given" as `-`, which is not a control anyone
    can pick out of a list -- it becomes NULL so it lands in the filter's
    "unknown" bucket alongside the games that had no header at all, instead of
    appearing as its own pickable option.
    """
    value = (raw or "").strip()
    return value if value and value != "-" else None


# Where one speed ends and the next begins, in seconds of *estimated game
# length* -- see time_control_speed for why that isn't just the base time.
SPEED_THRESHOLDS = (("bullet", 180), ("blitz", 600))


def time_control_speed(raw: str) -> str | None:
    """'bullet' | 'blitz' | 'rapid' | 'daily', or None when it can't be told.

    These are chess.com's buckets and chess.com's rule, deliberately: the
    games come from there, and a library that disagreed with the site it was
    downloaded from about what counts as blitz would be worse than useless
    for comparing against your rating there.

    The rule scores a time control by how long a game under it is expected to
    last -- base plus forty moves' worth of increment -- rather than by the
    base alone, which is why 2+1 is bullet (160s) and 3+2 is blitz (260s).
    Every control in chess.com's own picker lands in the bucket chess.com
    files it under.

    Note there is no 'classical': chess.com has no such class and calls its
    60-minute games rapid. A 90+30 game from elsewhere therefore comes out
    rapid too. That is a deliberate choice to match one site rather than
    silently split its rapid games in half.
    """
    raw = (raw or "").strip()
    if not raw or raw == "-":
        return None
    # 'moves/seconds': one move per day-sized allowance is correspondence.
    # A real '40/9000' tournament control is not, so only the one-move form
    # with an allowance no live game could have counts as daily.
    moves_part, slash, rest = raw.partition("/")
    if slash:
        try:
            if int(moves_part) == 1 and float(rest.partition("+")[0]) >= 86400:
                return "daily"
        except ValueError:
            pass
    base, increment = parse_time_control(raw)
    if base is None:
        return None
    estimate = base + 40 * increment
    for name, limit in SPEED_THRESHOLDS:
        if estimate < limit:
            return name
    return "rapid"


def _think_times(game, headers: dict) -> list | None:
    """Milliseconds spent on each ply, from the `%clk` comments chess.com and
    lichess put in their exports.

    A `%clk` value is the clock *after* the move, so the time spent is the
    player's previous reading minus this one, plus any increment they just
    received. Entries are None where the clock is missing (including the very
    first move when the time control is unknown), and the caller treats
    unknown as "don't filter it" rather than as zero.
    """
    readings: list[float | None] = []
    for node in game.mainline():
        m = _CLK_RE.search(node.comment or "")
        if m:
            h, mi, sec = int(m.group(1)), int(m.group(2)), float(m.group(3))
            readings.append(h * 3600 + mi * 60 + sec)
        else:
            readings.append(None)
    if not any(r is not None for r in readings):
        return None

    base, increment = parse_time_control(headers.get("TimeControl") or "")
    out: list[int | None] = []
    for i, now in enumerate(readings):
        previous = readings[i - 2] if i >= 2 else base
        if now is None or previous is None:
            out.append(None)
            continue
        # Clamped at zero: a clock that went up (a correction, or a berserk)
        # says nothing about how long the move took.
        out.append(int(max(0.0, previous - now + increment) * 1000))
    return out


def parse_games_from_text(source_name: str, text: str, names) -> list[dict]:
    """Parses every game out of a (possibly multi-game) PGN text blob.
    Returns a list of dicts ready to insert into the games table, in the
    order the games appear in the source text."""
    results = []
    stream = io.StringIO(text)
    idx = 0
    while True:
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        headers = dict(game.headers)
        year, month = _parse_year_month(headers)
        your_color = match_color(headers, names)
        # Clocks are read here because the exporter below strips comments --
        # once a game is stored there is no way to recover them.
        think_ms = _think_times(game, headers)
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        pgn_text = game.accept(exporter)
        results.append(
            {
                "source_name": source_name,
                "game_index_in_source": idx,
                "white": headers.get("White"),
                "black": headers.get("Black"),
                "result": headers.get("Result"),
                "event": headers.get("Event"),
                "date_header": headers.get("Date"),
                "utc_date_header": headers.get("UTCDate"),
                "year": year,
                "month": month,
                "your_color": your_color,
                "pgn_text": pgn_text,
                "headers_json": json.dumps(headers),
                "clocks_json": json.dumps(think_ms) if think_ms else None,
                # Both derived from the same header and stored side by side:
                # the raw control is what the filter groups by exactly ("10+5"
                # against "15+10"), the speed is what it groups by loosely.
                "time_control": normalise_time_control(headers.get("TimeControl")),
                "speed": time_control_speed(headers.get("TimeControl") or ""),
                "external_id": external_game_id(headers),
            }
        )
        idx += 1
    return results


# The columns every ingest path writes, in one place: there are two of them
# (hand upload and the chess.com importer) and they were drifting apart every
# time a column was added.
_GAME_COLUMNS = (
    "user_id", "upload_id", "batch_index", "source_name", "game_index_in_source",
    "white", "black", "result", "event", "date_header", "utc_date_header",
    "year", "month", "your_color", "pgn_text", "headers_json", "clocks_json",
    "time_control", "speed", "external_id",
)


def insert_parsed_games(conn, user_id: int, upload_id: int, games: list[dict],
                        start_index: int = 0) -> list[int]:
    """Files parsed games under an upload, returning the new row ids.

    `start_index` continues the batch numbering across several sources in one
    submission, which is what `games.batch_index` is for.
    """
    placeholders = ", ".join("?" * len(_GAME_COLUMNS))
    sql = (f"INSERT INTO games ({', '.join(_GAME_COLUMNS)}) VALUES ({placeholders})")
    ids = []
    for offset, g in enumerate(games):
        row = {**g, "user_id": user_id, "upload_id": upload_id,
               "batch_index": start_index + offset}
        cur = conn.execute(sql, tuple(row.get(c) for c in _GAME_COLUMNS))
        ids.append(cur.lastrowid)
    return ids
