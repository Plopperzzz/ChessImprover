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

from . import elo_sweep, strength
from .auth import require_user

router = APIRouter(prefix="/api/trend", tags=["trend"])

GRANULARITIES = ("year", "month", "week")


def _parse_date(raw) -> date | None:
    """PGN dates are 'YYYY.MM.DD', often with '??' for unknown parts. A game
    whose day is unknown can still be bucketed by month or year, so return
    what's parseable and let the caller decide."""
    if not raw:
        return None
    parts = str(raw).replace("-", ".").split(".")
    if len(parts) < 2:
        return None
    try:
        year, month = int(parts[0]), int(parts[1])
        day = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 1
    except ValueError:
        return None
    if not (1000 <= year <= 3000 and 1 <= month <= 12):
        return None
    day = min(max(day, 1), calendar.monthrange(year, month)[1])
    return date(year, month, day)


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


# Rate units, largest first: (minimum span in years to use it, years per
# unit, name). Quoting a per-year rate off three weeks of games turns 30 Elo
# of drift into "+1500 Elo a year", which is arithmetically true and useless
# -- the unit has to suit the window the data actually covers.
RATE_UNITS = [
    (1.5, 1.0, "year"),
    (0.5, 1.0 / 12.0, "month"),
    (0.0, 7.0 / 365.25, "week"),
]
# Below this, no rate is quoted at all: any slope read off a window this
# short is dominated by which games happened to land in which bucket.
MIN_SPAN_DAYS_FOR_RATE = 21


def _rate_unit(span_years: float) -> tuple[float, str]:
    for minimum, years, name in RATE_UNITS:
        if span_years >= minimum:
            return years, name
    return RATE_UNITS[-1][1], RATE_UNITS[-1][2]


def _slope(points: list[tuple[float, float, float]], label: str) -> dict:
    """Weighted least squares of value against fractional year.

    The weights are 1/sigma^2 from each bucket's own interval, so the slope's
    interval answers exactly the question section 15 asks: is the apparent
    movement bigger than the noise in the buckets it was drawn from?

    The fit is per year internally, but it is *reported* per week, per month
    or per year depending on how long a stretch the games cover, plus the
    total change across that stretch. Extrapolating a fortnight of games out
    to an annual rate produces four-digit numbers that say nothing.
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
    significant = bool(lo > 0 or hi < 0)

    span_years = float(x.max() - x.min())
    span_days = span_years * 365.25
    unit_years, unit = _rate_unit(span_years)
    # Same fit, expressed per whatever unit suits the window.
    rate, rate_lo, rate_hi = slope * unit_years, lo * unit_years, hi * unit_years
    total = slope * span_years
    span_text = (f"{span_days / 365.25:.1f} years" if span_days >= 365
                 else f"{span_days / 30.44:.0f} months" if span_days >= 60
                 else f"{span_days:.0f} days")

    if span_days < MIN_SPAN_DAYS_FOR_RATE:
        # Report the movement across the window and nothing per-anything.
        change = "no clear change" if not significant else f"{total:+.0f} Elo"
        # Deliberately says "it" -- the caller labels the line as the estimate
        # or the header rating, and naming it here gets one of them wrong.
        verdict = (f"These games only span {span_text}. Over that window it moved "
                   f"{total:+.0f} Elo, and the 95% interval "
                   f"({lo * span_years:.0f} to {hi * span_years:.0f}) "
                   + ("excludes no change, but a window this short is dominated by which games "
                      "landed in which bucket — treat it as a snapshot, not a trend. "
                      if significant else
                      "includes no change at all. ")
                   + "Come back with a few months of games, or bucket by month.")
    elif significant:
        direction = "Improving" if slope > 0 else "Declining"
        verdict = (f"{direction} by about {abs(rate):.0f} Elo a {unit} — "
                   f"{total:+.0f} Elo across the {span_text} these games cover "
                   f"(95% interval {rate_lo:.0f} to {rate_hi:.0f} per {unit}). "
                   f"That is larger than the uncertainty in the individual buckets, "
                   f"so it isn't just noise.")
    else:
        verdict = (f"Apparent change of {rate:+.0f} Elo a {unit} over the {span_text} "
                   f"these games cover, but the 95% interval ({rate_lo:.0f} to "
                   f"{rate_hi:.0f}) includes no change at all — this is not "
                   f"distinguishable from the noise in the individual estimates. "
                   f"More games per bucket, or a coarser bucket, would tighten it.")
    return {
        "available": True,
        "rate": round(rate, 1),
        "rate_unit": unit,
        "rate_ci_low": round(rate_lo, 1),
        "rate_ci_high": round(rate_hi, 1),
        "change_over_span": round(total, 1),
        "span_days": round(span_days, 1),
        "span_text": span_text,
        "too_short_to_extrapolate": bool(span_days < MIN_SPAN_DAYS_FOR_RATE),
        # Kept for anything reading the raw fit; the per-year figure is not
        # what the UI shows unless the games really do span a year.
        "slope_per_year": round(slope, 1),
        "se": round(se, 1),
        "ci_low": round(lo, 1),
        "ci_high": round(hi, 1),
        "significant": significant,
        "overdispersion": round(scatter, 2) if scatter is not None else None,
        "verdict": verdict,
    }


def build(user_id: int, granularity: str, run_id: int | None = None,
          top_n: int = 1) -> dict:
    # Same collection the pooled estimate uses, so a bucket and the overall
    # number are always built from exactly the same rows.
    entries, skipped = strength.collect(user_id, run_id)
    skipped.setdefault("undated", 0)
    dated = []
    for entry in entries:
        day = _parse_date(entry["date"])
        if day is None:
            skipped["undated"] += 1
            continue
        entry["day"] = day
        dated.append(entry)
    entries = dated

    if granularity == "week":
        # A game dated only to the month can't be put in a week without
        # inventing a day, so it sits this granularity out.
        dropped = [e for e in entries if not e["day_known"]]
        if dropped:
            skipped["undated"] += len(dropped)
            entries = [e for e in entries if e["day_known"]]

    grouped: dict[str, dict] = {}
    for entry in entries:
        key, label, x = _bucket(entry["day"], granularity)
        bucket = grouped.setdefault(key, {"key": key, "label": label, "x": x, "entries": []})
        bucket["entries"].append(entry)

    buckets = []
    for key in sorted(grouped):
        bucket = grouped[key]
        grid, usable, excluded = strength.common_grid(bucket["entries"])
        ranks, groups = strength.matrix(usable, grid)
        matrix = elo_sweep.hits(ranks, top_n)
        result = (elo_sweep.estimate(grid, matrix, groups=groups)
                  if matrix.shape[0] and len(grid) >= 2
                  else {"estimate": None, "confidence": "low",
                        "reasons": ["not enough comparable sweep data in this bucket"],
                        "n_positions": int(matrix.shape[0]), "n_discriminative": 0})
        actuals = [e["your_elo"] for e in usable if e["your_elo"] is not None]
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
            # Standard error of the bucket's mean rating, from the spread of
            # the ratings themselves rather than a made-up constant. Floored
            # because one game (or several at the same rating) gives zero
            # spread, which would otherwise carry infinite weight in the fit.
            "actual_se": (max(float(np.std(actuals, ddof=1)) / np.sqrt(len(actuals)), 5.0)
                          if len(actuals) > 1 else 20.0) if actuals else None,
            # Section 15: show sparse buckets, don't hide or error on them.
            "sparse": len(usable) < 3 or (result.get("n_discriminative") or 0) < 10,
        })

    estimated_points = [(b["x"], float(b["estimate"]), _se_from_ci(b))
                        for b in buckets
                        if b["estimate"] is not None and _se_from_ci(b) is not None]
    actual_points = [(b["x"], float(b["actual_elo"]), b["actual_se"])
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
def get_trend(granularity: str = "month", run_id: int | None = None, top_n: int = 1,
              user: dict = Depends(require_user)):
    """Re-bucketing is a pure re-fit of cached per-position scores, so changing
    granularity never re-runs an engine (section 15). Defined `def` rather
    than `async def` on purpose: the bootstrap is CPU work and belongs on the
    threadpool, not on the event loop that the live engines run on."""
    if granularity not in GRANULARITIES:
        raise HTTPException(400, f"granularity must be one of {', '.join(GRANULARITIES)}")
    return build(user["id"], granularity, run_id, top_n)
