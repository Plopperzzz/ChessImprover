"""Trend over time, per user (spec section 15).

Estimated Elo from saved analyses, bucketed by date and plotted against the
actual Elo in the PGN headers.

The whole point of storing per-*position* sweep scores (section 13) is that
this view re-buckets without touching an engine: switching from month to week
re-pools the same cached (position x Elo) match matrices and re-fits. Nothing
here starts a job, and there is no engine code in this module at all.

Two things get more care than the plot itself:

* **Buckets are estimated from pooled positions, not averaged estimates.** A
  month's estimate is one fit over every position played that month, so a
  month with four games gets an honestly wide interval instead of the falsely
  tidy mean of four noisy per-game numbers.
* **An apparent trend is checked against the buckets' own intervals.** A
  headline "improving by X Elo a year" is meaningless if X is smaller than
  the noise in each bucket, so the slope is a weighted fit whose weights come
  from those intervals, and it is reported with its own interval and a plain
  statement of whether it is distinguishable from noise.
"""

import calendar
import json
from datetime import date

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from . import elo_sweep
from .auth import require_user
from .db import db_cursor

router = APIRouter(prefix="/api/trend", tags=["trend"])

GRANULARITIES = ("year", "month", "week")
MIN_COMMON_GRID = 3


def _parse_date(row) -> date | None:
    """PGN dates are 'YYYY.MM.DD', often with '??' for unknown parts. A game
    whose day is unknown can still be bucketed by month or year, so return
    what's parseable and let the caller decide."""
    for raw in (row["utc_date_header"], row["date_header"]):
        if not raw:
            continue
        parts = str(raw).replace("-", ".").split(".")
        if len(parts) < 2:
            continue
        try:
            year, month = int(parts[0]), int(parts[1])
            day = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 1
        except ValueError:
            continue
        if not (1000 <= year <= 3000 and 1 <= month <= 12):
            continue
        day = min(max(day, 1), calendar.monthrange(year, month)[1])
        return date(year, month, day)
    return None


def _day_known(row) -> bool:
    for raw in (row["utc_date_header"], row["date_header"]):
        if raw:
            parts = str(raw).replace("-", ".").split(".")
            return len(parts) > 2 and parts[2].isdigit()
    return False


def _bucket(day: date, granularity: str) -> tuple[str, str, float]:
    """(key, label, x) where x is a fractional year, so gaps in the calendar
    show up as gaps on the axis rather than being closed up."""
    if granularity == "year":
        return str(day.year), str(day.year), day.year + 0.5
    if granularity == "month":
        key = f"{day.year:04d}-{day.month:02d}"
        label = f"{calendar.month_abbr[day.month]} {day.year}"
        return key, label, day.year + (day.month - 0.5) / 12.0
    iso_year, iso_week, _ = day.isocalendar()
    # The Thursday of an ISO week is always inside its own ISO year.
    thursday = date.fromisocalendar(iso_year, iso_week, 4)
    days_in_year = 366 if calendar.isleap(thursday.year) else 365
    x = thursday.year + (thursday.timetuple().tm_yday - 0.5) / days_in_year
    return f"{iso_year:04d}-W{iso_week:02d}", f"W{iso_week} {iso_year}", x


def _header_elo(headers_json: str, side: str):
    try:
        headers = json.loads(headers_json or "{}")
    except ValueError:
        return None
    raw = headers.get("WhiteElo" if side == "w" else "BlackElo")
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if 100 <= value <= 4000 else None


def _collect(user_id: int, run_id: int | None) -> tuple[list[dict], dict]:
    """One entry per analysed game that can contribute, plus a tally of what
    was left out and why -- a silently short trend is worse than a short one
    that says which games it couldn't use."""
    skipped = {"no_full_analysis": 0, "undated": 0, "unassigned_color": 0,
               "no_sweep_positions": 0, "no_header_elo": 0}
    with db_cursor() as conn:
        # Counted separately because it's the actionable one: a game analysed
        # in Quick mode has no Elo sweep, so it can never appear here until
        # it's run in Full. Saying nothing would look like the games vanished.
        skipped["no_full_analysis"] = conn.execute(
            """SELECT COUNT(*) AS n FROM games g
               WHERE g.user_id = ? AND NOT EXISTS (
                 SELECT 1 FROM run_games rg
                 WHERE rg.game_id = g.id AND rg.user_id = g.user_id AND rg.mode = 'full')""",
            (user_id,),
        ).fetchone()["n"]
    params: list = [user_id]
    run_clause = ""
    if run_id is not None:
        run_clause = " AND rg.run_id = ?"
        params.append(run_id)

    with db_cursor() as conn:
        # A game re-analysed, or appended into a second run, would otherwise
        # contribute its positions twice; keep only its latest analysis.
        rows = conn.execute(
            f"""SELECT rg.id AS run_game_id, rg.grid_json, rg.analyzed_at,
                       g.id AS game_id, g.your_color, g.white, g.black,
                       g.utc_date_header, g.date_header, g.headers_json
                FROM run_games rg
                JOIN games g ON g.id = rg.game_id
                WHERE rg.user_id = ? AND rg.mode = 'full'{run_clause}
                ORDER BY g.id, rg.analyzed_at DESC""",
            params,
        ).fetchall()

        seen: set[int] = set()
        entries = []
        for row in rows:
            if row["game_id"] in seen:
                continue
            seen.add(row["game_id"])
            if row["your_color"] not in ("w", "b"):
                skipped["unassigned_color"] += 1
                continue
            day = _parse_date(row)
            if not day:
                skipped["undated"] += 1
                continue
            try:
                grid = json.loads(row["grid_json"] or "null")
            except ValueError:
                grid = None
            if not grid:
                skipped["no_sweep_positions"] += 1
                continue
            scores = conn.execute(
                "SELECT scores FROM sweep_positions WHERE run_game_id = ? AND side = ? ORDER BY ply",
                (row["run_game_id"], row["your_color"]),
            ).fetchall()
            usable = [s["scores"] for s in scores if s["scores"] and len(s["scores"]) == len(grid)]
            if not usable:
                skipped["no_sweep_positions"] += 1
                continue
            actual = _header_elo(row["headers_json"], row["your_color"])
            if actual is None:
                skipped["no_header_elo"] += 1
            entries.append({
                "game_id": row["game_id"],
                "date": day,
                "day_known": _day_known(row),
                "grid": [int(v) for v in grid],
                "scores": usable,
                "actual_elo": actual,
            })
    return entries, skipped


def _common_grid(entries: list[dict]) -> tuple[list[int], list[dict], int]:
    """A bucket may mix grids -- a single-game sweep at step 100 and a batch
    at step 200 over the same range. Pool on the Elos they share rather than
    interpolating: every score used is one the engine actually produced.
    Falls back to the most-represented grid when the shared set is too thin
    to fit, and says how many games that dropped."""
    if not entries:
        return [], [], 0
    shared = set(entries[0]["grid"])
    for entry in entries[1:]:
        shared &= set(entry["grid"])
    if len(shared) >= MIN_COMMON_GRID:
        return sorted(shared), entries, 0

    tally: dict[tuple, int] = {}
    for entry in entries:
        tally[tuple(entry["grid"])] = tally.get(tuple(entry["grid"]), 0) + len(entry["scores"])
    best = list(max(tally, key=lambda g: tally[g]))
    kept = [e for e in entries if set(best) <= set(e["grid"])]
    return best, kept, len(entries) - len(kept)


def _matrix(entries: list[dict], grid: list[int]) -> np.ndarray:
    rows = []
    for entry in entries:
        index = {elo: i for i, elo in enumerate(entry["grid"])}
        columns = [index[elo] for elo in grid]
        for scores in entry["scores"]:
            rows.append([1.0 if scores[i] == "1" else 0.0 for i in columns])
    return np.asarray(rows, dtype=float) if rows else np.zeros((0, len(grid)))


def _se_from_ci(bucket: dict) -> float | None:
    """One sigma from a bucket's 95% interval, floored at the grid's own
    resolution.

    The bootstrap interval can collapse to zero width -- every resample peaks
    on the same grid point, which happens with a strongly peaked curve or an
    engine that ignores its Elo option. Taking that at face value would give
    the bucket infinite weight in the trend fit; dropping it would quietly
    lose the bucket instead. Neither is right: the estimate can't be more
    precise than the spacing of the grid it was read off, so that is the
    floor."""
    lo, hi = bucket.get("ci_low"), bucket.get("ci_high")
    if lo is None or hi is None:
        return None
    grid = bucket.get("grid") or []
    step = min((b - a for a, b in zip(grid, grid[1:])), default=100)
    return max((hi - lo) / 3.92, step / 2.0)  # a 95% interval is +/- 1.96 sigma


def _slope(points: list[tuple[float, float, float]], label: str) -> dict:
    """Weighted least squares of value against fractional year.

    The weights are 1/sigma^2 from each bucket's own interval, so the slope's
    interval answers exactly the question section 15 asks: is the apparent
    movement bigger than the noise in the buckets it was drawn from?
    """
    if len(points) < 2:
        return {"available": False,
                "verdict": f"Not enough {label} buckets to talk about a trend yet."}
    x = np.array([p[0] for p in points])
    y = np.array([p[1] for p in points])
    w = np.array([1.0 / max(p[2], 1e-6) ** 2 for p in points])

    sw = w.sum()
    mx = float((w * x).sum() / sw)
    my = float((w * y).sum() / sw)
    sxx = float((w * (x - mx) ** 2).sum())
    if sxx <= 0:
        return {"available": False,
                "verdict": "All the buckets sit at the same point in time."}
    slope = float((w * (x - mx) * (y - my)).sum() / sxx)
    se = float(np.sqrt(1.0 / sxx))

    # If the buckets disagree with each other by more than their own intervals
    # allow, those intervals are understating the real spread -- widen the
    # slope's interval to match rather than reporting false precision.
    dof = len(points) - 2
    scatter = None
    if dof > 0:
        residual = y - (my + slope * (x - mx))
        chi2 = float((w * residual ** 2).sum())
        scatter = chi2 / dof
        if scatter > 1.0:
            se *= float(np.sqrt(scatter))

    lo, hi = slope - 1.96 * se, slope + 1.96 * se
    significant = lo > 0 or hi < 0
    direction = "improving" if slope > 0 else "declining"
    if significant:
        verdict = (f"{direction.capitalize()} by about {abs(slope):.0f} Elo a year "
                   f"(95% interval {lo:.0f} to {hi:.0f}). That is larger than the "
                   f"uncertainty in the individual buckets, so it isn't just noise.")
    else:
        verdict = (f"Apparent change of {slope:+.0f} Elo a year, but the 95% interval "
                   f"({lo:.0f} to {hi:.0f}) includes no change at all — this is not "
                   f"distinguishable from the noise in the individual estimates. "
                   f"More games per bucket, or a coarser bucket, would tighten it.")
    return {
        "available": True,
        "slope_per_year": round(slope, 1),
        "se": round(se, 1),
        "ci_low": round(lo, 1),
        "ci_high": round(hi, 1),
        "significant": bool(significant),
        "overdispersion": round(scatter, 2) if scatter is not None else None,
        "verdict": verdict,
    }


def build(user_id: int, granularity: str, run_id: int | None = None) -> dict:
    entries, skipped = _collect(user_id, run_id)

    if granularity == "week":
        # A game dated only to the month can't be put in a week without
        # inventing a day, so it sits this granularity out.
        dropped = [e for e in entries if not e["day_known"]]
        if dropped:
            skipped["undated"] += len(dropped)
            entries = [e for e in entries if e["day_known"]]

    grouped: dict[str, dict] = {}
    for entry in entries:
        key, label, x = _bucket(entry["date"], granularity)
        bucket = grouped.setdefault(key, {"key": key, "label": label, "x": x, "entries": []})
        bucket["entries"].append(entry)

    buckets = []
    for key in sorted(grouped):
        bucket = grouped[key]
        grid, usable, excluded = _common_grid(bucket["entries"])
        matrix = _matrix(usable, grid)
        result = (elo_sweep.estimate(grid, matrix) if matrix.shape[0] and len(grid) >= 2
                  else {"estimate": None, "confidence": "low",
                        "reasons": ["not enough comparable sweep data in this bucket"],
                        "n_positions": int(matrix.shape[0]), "n_discriminative": 0})
        actuals = [e["actual_elo"] for e in usable if e["actual_elo"] is not None]
        buckets.append({
            "key": key,
            "label": bucket["label"],
            "x": round(bucket["x"], 4),
            "games": len(usable),
            "games_excluded_grid_mismatch": excluded,
            "positions": int(result.get("n_positions") or 0),
            "estimate": result.get("estimate"),
            "ci_low": result.get("ci_low"),
            "ci_high": result.get("ci_high"),
            "confidence": result.get("confidence"),
            "reasons": result.get("reasons", []),
            "n_discriminative": result.get("n_discriminative", 0),
            "grid": grid,
            "actual_elo": round(float(np.mean(actuals)), 1) if actuals else None,
            "actual_n": len(actuals),
            # Section 15: show sparse buckets, don't hide or error on them.
            "sparse": len(usable) < 3 or (result.get("n_discriminative") or 0) < 10,
        })

    estimated_points = [(b["x"], float(b["estimate"]), _se_from_ci(b))
                        for b in buckets
                        if b["estimate"] is not None and _se_from_ci(b) is not None]
    actual_points = [(b["x"], float(b["actual_elo"]), 30.0)
                     for b in buckets if b["actual_elo"] is not None]

    offsets = [b["estimate"] - b["actual_elo"] for b in buckets
               if b["estimate"] is not None and b["actual_elo"] is not None]

    return {
        "granularity": granularity,
        "buckets": buckets,
        "trend": _slope(estimated_points, granularity),
        "actual_trend": _slope(actual_points, granularity),
        "offset": {
            "n": len(offsets),
            "mean": round(float(np.mean(offsets)), 1) if offsets else None,
        },
        "skipped": skipped,
        "total_games": len(entries),
    }


@router.get("")
def get_trend(granularity: str = "month", run_id: int | None = None,
              user: dict = Depends(require_user)):
    """Re-bucketing is a pure re-fit of cached per-position scores, so changing
    granularity never re-runs an engine (section 15). Defined `def` rather
    than `async def` on purpose: the bootstrap is CPU work and belongs on the
    threadpool, not on the event loop that the live engines run on."""
    if granularity not in GRANULARITIES:
        raise HTTPException(400, f"granularity must be one of {', '.join(GRANULARITIES)}")
    return build(user["id"], granularity, run_id)
