"""Your puzzle rating, overall and per theme.

Sits between `glicko2` (the arithmetic) and `puzzles` (the endpoints), and
owns two decisions that are easy to get wrong and hard to notice.

**Only the first attempt at a puzzle is rated.** This is Lichess's rule and
it is the only one that makes the number mean anything: without it, failing a
puzzle and immediately retrying until it works would ratchet the rating
upwards for free. A retry still records an attempt and still counts towards
the solved/attempted tallies -- it just doesn't move the rating.

**A theme's rating is rated against the puzzle, not against the theme.** When
you solve a puzzle tagged `fork middlegame crushing`, all three theme ratings
update against that puzzle's difficulty, alongside the overall one. The
alternative -- deriving a theme rating from the overall one -- would make
every theme move together and tell you nothing about which you are actually
better at, which is the entire point of tracking them separately.

The per-theme numbers are noisier than the overall one by construction: they
see a fraction of the attempts. That is what the deviation is for, and why it
is reported alongside every rating rather than hidden.
"""

from .glicko2 import (
    DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL, Rating, decay, update,
)

# How long a Glicko-2 rating period is here. The system assumes results are
# batched into periods and widens an idle rating's deviation by one period's
# worth of volatility per period missed; a week is the conventional choice and
# is about right for a trainer someone uses in bursts.
RATING_PERIOD_DAYS = 7.0

# The 'theme' of the row holding the overall rating. The empty string rather
# than NULL so it can sit in the primary key with the real themes.
OVERALL = ""

# Themes too broad to be worth a rating of their own. 'middlegame' tells you
# nothing you don't get from the overall number, and having them in the list
# buries the ones that matter under noise.
UNRATED_THEMES = frozenset({
    "opening", "middlegame", "endgame",
    "oneMove", "short", "long", "veryLong",
    "master", "superGM",
})


def rateable_themes(themes: list[str]) -> list[str]:
    """The themes worth keeping a separate rating for."""
    return [theme for theme in themes if theme not in UNRATED_THEMES]


def get(conn, user_id: int, theme: str = OVERALL) -> Rating:
    """The rating as it stands *now*, which is not quite the rating as stored.

    Time away widens the deviation. Someone who solved fifty puzzles in March
    and comes back in September is not still known to within 50 points, and a
    rating the system stays certain of barely responds to their first few
    results -- including to real improvement. Glickman's step 6 with no games
    played is exactly this; it moves the deviation and never the rating.
    """
    row = conn.execute(
        """SELECT rating, rd, vol,
                  (julianday('now') - julianday(updated_at)) AS days_idle
           FROM puzzle_ratings WHERE user_id = ? AND theme = ?""",
        (user_id, theme),
    ).fetchone()
    if not row:
        return Rating(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL)
    stored = Rating(row["rating"], row["rd"], row["vol"])
    periods = max(0.0, (row["days_idle"] or 0.0)) / RATING_PERIOD_DAYS
    return decay(stored, periods)


def already_attempted(conn, user_id: int, puzzle_key: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM puzzle_attempts WHERE user_id = ? AND puzzle_key = ? LIMIT 1",
        (user_id, puzzle_key),
    ).fetchone() is not None


def _store(conn, user_id: int, theme: str, rating: Rating, solved: bool):
    conn.execute(
        """INSERT INTO puzzle_ratings (user_id, theme, rating, rd, vol, attempts,
                                       solved, best_rating, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))
           ON CONFLICT(user_id, theme) DO UPDATE SET
             rating = excluded.rating,
             rd = excluded.rd,
             vol = excluded.vol,
             attempts = puzzle_ratings.attempts + 1,
             solved = puzzle_ratings.solved + excluded.solved,
             best_rating = MAX(COALESCE(puzzle_ratings.best_rating, 0), excluded.rating),
             updated_at = datetime('now')""",
        (user_id, theme, rating.rating, rating.rd, rating.vol,
         1 if solved else 0, rating.rating),
    )


def record(conn, user_id: int, *, source: str, puzzle_key: str, solved: bool,
           puzzle_rating: int | None, puzzle_rd: float, themes: list[str]) -> dict:
    """Files an attempt and, if it is the first at this puzzle, rates it.

    `puzzle_rd` is how sure we are of the puzzle's difficulty, and it matters
    as much as the rating: an imported Lichess puzzle carries a deviation
    measured over its real play history, while a home-grown one carries an
    estimate, and Glicko-2 will correctly move the solver's rating less for
    the second. See `puzzles.own_puzzle_rating`.

    Returns what happened, so the browser can say "1523 -> 1540" rather than
    just showing a new number.
    """
    first_try = not already_attempted(conn, user_id, puzzle_key)
    # A puzzle with no known difficulty cannot be rated against. It still
    # counts as an attempt -- it just doesn't pretend to measure anything.
    rated = first_try and puzzle_rating is not None

    before = get(conn, user_id)
    after = before
    if rated:
        opponent = Rating(float(puzzle_rating), puzzle_rd, DEFAULT_VOL)
        after = update(before, opponent, 1.0 if solved else 0.0)
        _store(conn, user_id, OVERALL, after, solved)
        for theme in rateable_themes(themes):
            theme_before = get(conn, user_id, theme)
            _store(conn, user_id, theme,
                   update(theme_before, opponent, 1.0 if solved else 0.0), solved)

    conn.execute(
        """INSERT INTO puzzle_attempts
             (user_id, source, puzzle_key, solved, rated, puzzle_rating,
              rating_before, rating_after, themes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, source, puzzle_key, 1 if solved else 0, 1 if rated else 0,
         puzzle_rating, before.rating, after.rating, " ".join(themes)),
    )

    return {
        "rated": rated,
        "first_try": first_try,
        "puzzle_rating": puzzle_rating,
        "before": round(before.rating),
        "after": round(after.rating),
        "delta": round(after.rating - before.rating),
        "rd": round(after.rd),
        "provisional": after.provisional,
    }


# Every row read for display carries how long it has been idle, so the
# deviation shown is the decayed one -- the same number `get` would rate
# against. A panel that claimed more certainty than the rater uses would be
# quietly lying.
_RATING_COLUMNS = ("rating, rd, vol, attempts, solved, best_rating, "
                   "(julianday('now') - julianday(updated_at)) AS days_idle")


def _as_dict(theme: str, row) -> dict:
    periods = max(0.0, (row["days_idle"] or 0.0)) / RATING_PERIOD_DAYS
    rating = decay(Rating(row["rating"], row["rd"], row["vol"]), periods)
    low, high = rating.interval()
    return {
        "theme": theme,
        "rating": round(rating.rating),
        "rd": round(rating.rd),
        "provisional": rating.provisional,
        "interval": [round(low), round(high)],
        "attempts": row["attempts"],
        "solved": row["solved"],
        "best": round(row["best_rating"]) if row["best_rating"] else None,
    }


def overall(conn, user_id: int) -> dict:
    row = conn.execute(
        f"SELECT {_RATING_COLUMNS} FROM puzzle_ratings WHERE user_id = ? AND theme = ?",
        (user_id, OVERALL),
    ).fetchone()
    if not row:
        blank = Rating()
        low, high = blank.interval()
        return {"theme": OVERALL, "rating": round(blank.rating), "rd": round(blank.rd),
                "provisional": True, "interval": [round(low), round(high)],
                "attempts": 0, "solved": 0, "best": None}
    return _as_dict(OVERALL, row)


def by_theme(conn, user_id: int) -> list[dict]:
    """Every theme you have a record against, strongest first.

    Sorted by rating rather than by attempts because the question this
    answers is "what am I good at and what am I not", and the answer should
    read top to bottom.
    """
    rows = conn.execute(
        f"""SELECT theme, {_RATING_COLUMNS}
            FROM puzzle_ratings
            WHERE user_id = ? AND theme != ?
            ORDER BY rating DESC""",
        (user_id, OVERALL),
    ).fetchall()
    return [_as_dict(row["theme"], row) for row in rows]


def history(conn, user_id: int, limit: int = 50) -> list[dict]:
    """Recent rated attempts, oldest first, for the rating sparkline."""
    rows = conn.execute(
        """SELECT created_at, solved, puzzle_rating, rating_after, source
           FROM puzzle_attempts
           WHERE user_id = ? AND rated = 1
           ORDER BY id DESC LIMIT ?""",
        (user_id, limit),
    ).fetchall()
    return [
        {"at": row["created_at"], "solved": bool(row["solved"]),
         "puzzle_rating": row["puzzle_rating"],
         "rating": round(row["rating_after"]) if row["rating_after"] else None,
         "source": row["source"]}
        for row in reversed(rows)
    ]


def summary(conn, user_id: int) -> dict:
    """Everything the Puzzles tab shows about how you're doing."""
    totals = conn.execute(
        """SELECT COUNT(*) AS attempts,
                  COALESCE(SUM(solved), 0) AS solved,
                  COALESCE(SUM(source = 'lichess'), 0) AS lichess,
                  COALESCE(SUM(source = 'own'), 0) AS own
           FROM puzzle_attempts WHERE user_id = ?""",
        (user_id,),
    ).fetchone()
    return {
        "overall": overall(conn, user_id),
        "themes": by_theme(conn, user_id),
        "attempts": totals["attempts"],
        "solved": totals["solved"],
        "by_source": {"lichess": totals["lichess"], "own": totals["own"]},
        "history": history(conn, user_id),
    }


def reset(conn, user_id: int):
    """Clears the rating and the attempt history. Deliberately separate from
    clearing your record against your own puzzles -- one is 'let me do these
    again', the other is 'my rating is wrong, start it over'."""
    conn.execute("DELETE FROM puzzle_ratings WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM puzzle_attempts WHERE user_id = ?", (user_id,))
