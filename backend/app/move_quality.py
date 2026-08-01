"""How your moves were classified, across the library.

`analysis_moves` has held a classification per move since the Stockfish pass
was written, but nothing ever counted them: `/api/strength` and `/api/trend`
both work from the sweep matrices and neither touches the column. So the
Progress screen could show a fitted rating and not how many blunders it was
fitted through.

Two things read this: the brilliant-move count, and the move-quality pie. They
are one query rather than two endpoints, because a count beside a chart that
disagrees with it is worse than either alone.

Nothing here runs an engine or re-fits anything -- it is a GROUP BY over rows
that were written when the analysis ran.
"""

from fastapi import APIRouter, Depends

from .auth import require_user
from .db import db_cursor
from .games import LibraryFilter, library_filter

router = APIRouter(prefix="/api/move-quality", tags=["strength"])

# The labels `classify.py` writes, best first. Fixed here rather than read back
# off the rows so a classification nobody has played yet still appears (as a
# zero) instead of silently leaving the chart.
CLASSIFICATIONS = (
    "brilliant", "great", "best", "excellent", "good",
    "book", "inaccuracy", "mistake", "miss", "blunder",
)

# Only a full run sweeps, and only a sweep can promote a move to great or
# brilliant (`classify.upgrade_with_sweep`). A quick-analysed game therefore
# contributes real Good/Blunder counts and a structural zero for those two.
SWEPT_MODES = ("full", "sweep")

# SQLite's default limit is 999 host parameters per statement, and a library
# large enough to matter here can exceed that in run_game ids alone.
CHUNK = 400


def _latest_per_game(conn, user_id: int, run_id: int | None,
                     library: LibraryFilter) -> tuple[list[dict], dict]:
    """One analysis per game: the most recent, preferring a full run.

    Same rule as `strength.collect`, and for the same reason -- a game that was
    analysed twice, or appended into a second run, would otherwise have every
    one of its moves counted twice.
    """
    slice_where, slice_params = library.where(user_id)
    params: list = [user_id]
    run_clause = ""
    if run_id is not None:
        run_clause = " AND rg.run_id = ?"
        params.append(run_id)

    rows = conn.execute(
        f"""SELECT rg.id AS run_game_id, rg.mode, g.id AS game_id, g.your_color
            FROM run_games rg
            JOIN games g ON g.id = rg.game_id
            WHERE rg.user_id = ?{run_clause}
              AND {slice_where}
            ORDER BY g.id, (rg.mode = 'full') DESC, rg.analyzed_at DESC""",
        params + slice_params,
    ).fetchall()

    skipped = {"unassigned_color": 0}
    seen: set[int] = set()
    chosen = []
    for row in rows:
        if row["game_id"] in seen:
            continue
        seen.add(row["game_id"])
        # Which moves were yours is decided by which side you played, so a game
        # whose import couldn't match either header to you has no answer. The
        # fix is renaming the account, which is why the count is reported
        # rather than folded in silently.
        if row["your_color"] not in ("w", "b"):
            skipped["unassigned_color"] += 1
            continue
        chosen.append({"run_game_id": row["run_game_id"], "mode": row["mode"],
                       "your_color": row["your_color"]})
    return chosen, skipped


def build(user_id: int, run_id: int | None = None,
          library: LibraryFilter | None = None) -> dict:
    library = library or LibraryFilter()
    counts = {label: 0 for label in CLASSIFICATIONS}
    other = 0

    with db_cursor() as conn:
        chosen, skipped = _latest_per_game(conn, user_id, run_id, library)

        # White plays the odd plies, so "your moves" is a parity test against
        # the side you played -- `analysis_moves` stores no side of its own.
        by_parity = {1: [], 0: []}
        for entry in chosen:
            by_parity[1 if entry["your_color"] == "w" else 0].append(entry["run_game_id"])

        for parity, ids in by_parity.items():
            for start in range(0, len(ids), CHUNK):
                batch = ids[start:start + CHUNK]
                placeholders = ", ".join("?" * len(batch))
                for row in conn.execute(
                    f"""SELECT classification, COUNT(*) AS n
                        FROM analysis_moves
                        WHERE run_game_id IN ({placeholders})
                          AND classification IS NOT NULL
                          AND (ply % 2) = ?
                        GROUP BY classification""",
                    (*batch, parity),
                ):
                    if row["classification"] in counts:
                        counts[row["classification"]] += row["n"]
                    else:
                        # A label from a future classifier, or a hand-edited
                        # row. Counted into the total so the percentages still
                        # add up, rather than dropped.
                        other += row["n"]

    swept = sum(1 for e in chosen if e["mode"] in SWEPT_MODES)
    return {
        "counts": counts,
        "other": other,
        "moves": sum(counts.values()) + other,
        "games": len(chosen),
        # Great and Brilliant can only come out of a swept game, so a library
        # that is mostly quick analyses reads low on both by construction.
        "games_swept": swept,
        "games_quick_only": len(chosen) - swept,
        # Echoed for the same reason `/api/strength` echoes it: a filtered
        # count and an unfiltered one are different measurements.
        "library_filter": library.as_dict(),
        "skipped": skipped,
    }


@router.get("")
def get_move_quality(run_id: int | None = None,
                     filters: LibraryFilter = Depends(library_filter),
                     user: dict = Depends(require_user)):
    """Your moves, by classification, over the same slice of the library the
    pooled estimate is fitted on.

    `speed`, `time_control` and `collection_id` are spelled exactly as the
    Games list spells them -- filtering this differently from `/api/strength`
    would put a count next to an estimate that describes other games.
    """
    return build(user["id"], run_id, filters)
