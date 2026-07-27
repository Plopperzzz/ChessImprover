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


def _match_color(headers: dict, display_name: str) -> str:
    name = display_name.strip().lower()
    white = (headers.get("White") or "").strip().lower()
    black = (headers.get("Black") or "").strip().lower()
    if name and name == white:
        return "w"
    if name and name == black:
        return "b"
    return "unassigned"


_CLK_RE = re.compile(r"\[%clk\s+(\d+):(\d+):([\d.]+)\]")


def _parse_time_control(headers: dict) -> tuple[float | None, float]:
    """(base seconds, increment seconds) from a TimeControl header like
    '600', '600+5' or '180/9000'. Returns (None, 0) for '-' or anything
    unrecognised -- the first move of each side then has no baseline, so its
    think time is simply unknown rather than guessed."""
    raw = (headers.get("TimeControl") or "").strip()
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

    base, increment = _parse_time_control(headers)
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


def parse_games_from_text(source_name: str, text: str, display_name: str) -> list[dict]:
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
        your_color = _match_color(headers, display_name)
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
            }
        )
        idx += 1
    return results
