import io
import json

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
            }
        )
        idx += 1
    return results
