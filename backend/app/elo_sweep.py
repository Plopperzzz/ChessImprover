"""Elo estimation from a Maia sweep (spec section 9).

Maia is asked to move in each of a player's positions at every Elo on a grid.
Where its choice matches what the player actually played, that Elo "explains"
the move. The Elo whose match rate peaks is the estimate.

The statistics here matter more than they look:

* Positions where Maia's top choice never changes across the whole grid carry
  no information about strength -- every Elo scores identically on them. They
  only add binomial noise, so they're split out before fitting.
* **The peak comes from a parametric fit, not from smoothing.** The match rate
  against Elo is a broad bump on a baseline: some share of your moves are the
  obvious move that every Elo finds, and on top of that sits a hump centred on
  your actual strength. So that is what gets fitted -- baseline, height,
  centre, width -- by weighted least squares over every grid point, and the
  centre *is* the estimate.

  This replaced a smoothing spline whose argmax was taken as the peak. That
  was measurably biased: on a noiseless, symmetric test curve peaking at 1300
  it returned 1288 over a 1100-1900 grid and 1211 over 600-2600, because
  smoothing drags the apex toward the long flat tails, and worse the wider the
  grid. Simulated against the shape a real 104-game run produces, at ~1300
  discriminative positions the spline gave bias -61 / sd 30 Elo where the bump
  fit gives -1 / sd 10.
* The independent sampling unit is the *position*, and when several games are
  pooled it is really the *game* -- moves from one game share an opponent, an
  opening and a sitting. So the bootstrap resamples whichever unit it was
  given, rebuilding the curve from the cached score matrix each time. No
  engine work is repeated.
"""

import numpy as np

try:  # scipy is in requirements; the fallbacks keep this importable without it
    from scipy.optimize import curve_fit
except ImportError:  # pragma: no cover
    curve_fit = None

BOOTSTRAP_SAMPLES = 400

# How wide the bootstrap interval may be, as a fraction of the swept range,
# before the estimate is called unusable.
#
# This is *the* noise test, and it is measured rather than guessed. The obvious
# alternative -- "is the fitted bump tall enough" -- turns out to be worthless:
# a free-centre fit will spike through a single high point, so under pure noise
# the fitted height reaches 10-90 standard errors, higher than real signal ever
# needs. The bootstrap separates them cleanly, because noise moves the peak
# somewhere else every resample:
#
#     pure noise (an engine ignoring its Elo option):  5th pct 0.60, median 0.90
#     real signal, 100+ positions:                     95th pct 0.12
#     real signal, one game (~25 positions):           median 0.21, 95th 0.50
#
# So 0.55 rejects almost all noise and passes real signal even from one game.
WIDE_INTERVAL_FRACTION = 0.55
TIGHT_INTERVAL_FRACTION = 0.10


def split_positions(score_matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Indices of discriminative vs uninformative positions.

    score_matrix is (n_positions, n_elos), 1 where Maia's choice at that Elo
    matched the played move. A row that's all-1 or all-0 means the grid never
    changed its mind about that position.
    """
    if score_matrix.size == 0:
        return np.array([], dtype=int), np.array([], dtype=int)
    varies = score_matrix.max(axis=1) != score_matrix.min(axis=1)
    return np.flatnonzero(varies), np.flatnonzero(~varies)


def binomial_se(rates: np.ndarray, n: int) -> np.ndarray:
    """Standard error per grid point. Guarded so a 0% or 100% point doesn't
    get infinite weight in the fit."""
    if n <= 0:
        return np.ones_like(rates)
    se = np.sqrt(np.clip(rates * (1.0 - rates), 1e-6, None) / n)
    return np.maximum(se, 1e-3)


def bump(elos, base, amp, centre, width):
    """Baseline plus a Gaussian hump: the share of your moves any Elo would
    find, plus the extra that only players near your strength find."""
    return base + amp * np.exp(-((elos - centre) ** 2) / (2.0 * width ** 2))


def _fit_bump(elos: np.ndarray, rates: np.ndarray, se: np.ndarray,
              fast: bool = False) -> tuple[dict, str]:
    """Weighted least-squares fit of the bump, using every grid point.

    Returns the parameters and how they were obtained. Falls back to the
    highest observed grid point when the curve has no fittable hump -- which
    is itself information, and the caller reports it as a flat curve rather
    than dressing it up.

    `fast` skips the bounded solver. The bootstrap runs this hundreds of times
    per estimate, and the bounded least-squares path costs roughly seven times
    the unbounded one -- more on noisy replicates, where it burns its whole
    iteration budget. The unbounded fit is checked against the same limits
    afterwards and discarded if it wandered outside them, which is the same
    guarantee at a fraction of the cost.
    """
    span = float(elos.max() - elos.min())
    guess = [float(rates.min()), max(float(rates.max() - rates.min()), 1e-3),
             float(elos[int(np.argmax(rates))]), max(span / 4.0, 100.0)]
    # The centre may sit a little outside the swept range -- that is how "your
    # strength is off the end of this grid" shows up, and clamping it to the
    # edge would hide it.
    low = [0.0, 0.0, elos.min() - 0.25 * span, 50.0]
    high = [1.0, 1.0, elos.max() + 0.25 * span, 4.0 * span]

    def _accept(popt):
        values = [float(v) for v in popt]
        if not np.isfinite(values).all():
            return None
        if any(v < lo or v > hi for v, lo, hi in zip(values, low, high)):
            return None
        base, amp, centre, width = values
        return {"base": base, "amp": amp, "centre": centre, "width": abs(width)}

    if curve_fit is not None and len(elos) >= 4:
        attempts = [{"maxfev": 2000}]
        if not fast:
            attempts.append({"maxfev": 20000, "bounds": (low, high)})
        for kwargs in attempts:
            try:
                popt, _ = curve_fit(bump, elos, rates, p0=guess, sigma=se,
                                    absolute_sigma=True, **kwargs)
            except Exception:
                continue
            params = _accept(popt)
            if params:
                return params, "bump fit"
    return ({"base": float(rates.min()), "amp": float(rates.max() - rates.min()),
             "centre": guess[2], "width": guess[3]}, "highest swept point (no fittable peak)")


def _peak_from(elos: np.ndarray, rates: np.ndarray, se: np.ndarray) -> float:
    """Bootstrap-path peak: the fast fit, clipped to the swept range."""
    params, _ = _fit_bump(elos, rates, se, fast=True)
    return float(np.clip(params["centre"], elos.min(), elos.max()))


def estimate(elos: list[int], score_matrix: np.ndarray, rng_seed: int = 0,
             groups: np.ndarray | None = None) -> dict:
    """Full estimate for one player.

    score_matrix: (n_positions, n_elos) of 1/0 match indicators.
    groups: optional per-row game id. When several games are pooled, moves
        from the same game are not independent -- one opponent, one opening,
        one sitting -- so the bootstrap resamples *games* rather than moves.
        Resampling moves there would report an interval far tighter than the
        data supports.
    """
    elos_arr = np.asarray(elos, dtype=float)
    if score_matrix.size == 0 or len(elos_arr) < 2:
        return {
            "estimate": None,
            "confidence": "low",
            "reasons": ["no positions to estimate from"],
            "n_positions": 0,
            "n_discriminative": 0,
        }

    discriminative, uninformative = split_positions(score_matrix)
    n_total = score_matrix.shape[0]

    # Uninformative positions add binomial variance without signal, so the fit
    # uses only the discriminative ones (section 9).
    keep = discriminative if discriminative.size else np.arange(n_total)
    fitting_matrix = score_matrix[keep]
    fitting_groups = np.asarray(groups)[keep] if groups is not None else None
    n_fit = fitting_matrix.shape[0]

    rates = fitting_matrix.mean(axis=0)
    se = binomial_se(rates, n_fit)
    params, method = _fit_bump(elos_arr, rates, se)
    peak = float(np.clip(params["centre"], elos_arr.min(), elos_arr.max()))
    dense = np.linspace(elos_arr.min(), elos_arr.max(), 400)
    values = bump(dense, params["base"], params["amp"], params["centre"], params["width"])

    # Bootstrap over the independent unit -- games when we have them, moves
    # otherwise -- rebuilding the curve from the cached matrix each time. No
    # engine work is repeated.
    rng = np.random.default_rng(rng_seed)
    peaks = []
    n_games = None
    fell_back = False
    if fitting_groups is not None:
        unique = np.unique(fitting_groups)
        n_games = len(unique)
        if n_games >= 2:
            rows_by_group = [np.flatnonzero(fitting_groups == g) for g in unique]
            n_units = n_games
        else:
            # One game can't be resampled as a cluster -- there is nothing to
            # resample. Fall back to moves so there is still an interval, and
            # say plainly that it assumes an independence the data doesn't
            # have, rather than quietly reporting it as if it did.
            rows_by_group, n_units, fell_back = None, n_fit, True
    else:
        rows_by_group, n_units = None, n_fit

    if n_fit >= 2 and n_units >= 2:
        for _ in range(BOOTSTRAP_SAMPLES):
            if rows_by_group is not None:
                pick = rng.integers(0, n_units, n_units)
                idx = np.concatenate([rows_by_group[i] for i in pick])
            else:
                idx = rng.integers(0, n_fit, n_fit)
            sample = fitting_matrix[idx]
            r = sample.mean(axis=0)
            peaks.append(_peak_from(elos_arr, r, binomial_se(r, sample.shape[0])))
    ci_low, ci_high = (float(np.percentile(peaks, 2.5)), float(np.percentile(peaks, 97.5))) if peaks else (None, None)

    confidence, reasons = _confidence(
        n_fit=n_fit, n_total=n_total, rates=rates, params=params, se=se,
        ci_low=ci_low, ci_high=ci_high, elos=elos_arr, peak=peak,
        n_units=n_games, clustered=rows_by_group is not None, single_game=fell_back,
    )

    return {
        "estimate": round(peak),
        "ci_low": round(ci_low) if ci_low is not None else None,
        "ci_high": round(ci_high) if ci_high is not None else None,
        "confidence": confidence,
        "reasons": reasons,
        "n_positions": int(n_total),
        "n_discriminative": int(n_fit),
        "n_uninformative": int(uninformative.size),
        "n_games": int(n_games) if n_games is not None else None,
        "method": method,
        "peak_height": round(float(params["amp"]), 4),
        "peak_width": round(float(params["width"])),
        "grid": [int(e) for e in elos_arr],
        "match_rates": [float(r) for r in rates],
        "curve_x": [float(x) for x in dense],
        "curve_y": [float(y) for y in values],
    }


def _confidence(*, n_fit, n_total, rates, params, se, ci_low, ci_high, elos, peak,
                n_units=None, clustered=False, single_game=False):
    """High/Medium/Low with the reasons spelled out, since the number alone
    invites more trust than it deserves (section 9)."""
    reasons = []
    score = 0
    span = float(elos.max() - elos.min())

    # A single game is ~25 of your moves, half of them uninformative. Simulated
    # at that size the estimate has a standard deviation near 90 Elo, so it
    # gets no credit for sample size however clean the curve looks.
    if n_fit >= 400:
        score += 2
        reasons.append(f"{n_fit} discriminative positions")
    elif n_fit >= 100:
        score += 1
        reasons.append(f"{n_fit} discriminative positions")
    elif n_fit >= 25:
        reasons.append(f"only {n_fit} discriminative positions -- pool more games for a firm number")
    else:
        score -= 1
        reasons.append(f"very few discriminative positions ({n_fit})")
    if clustered and n_units is not None:
        reasons.append(f"pooled over {n_units} game(s); the interval resamples games, not moves")
    elif single_game:
        score -= 1
        reasons.append("a single game -- the interval resamples moves, which treats them as "
                       "independent when they aren't, so the real uncertainty is wider still")

    # Descriptive only. Height is *not* evidence of a peak -- see the note on
    # WIDE_INTERVAL_FRACTION -- so it is reported and not scored.
    height_se = float(params["amp"]) / max(float(np.mean(se)), 1e-9)
    reasons.append(f"fitted peak +{float(params['amp']):.1%} match rate "
                   f"({height_se:.1f} SE tall, {params['width']:.0f} Elo wide)")

    unusable = False
    # The one check that needs no fitting: if the observed match rate barely
    # moves across the whole grid, the Elo setting is doing nothing. That is
    # what a mis-named Elo option looks like -- the engine plays the same move
    # at 600 and at 2600 -- and no amount of curve fitting can rescue it.
    observed_range = float(rates.max() - rates.min())
    if observed_range < float(np.mean(se)):
        unusable = True
        reasons.append(f"the match rate barely changes across the grid "
                       f"({observed_range:.1%} from end to end) -- check that the engine's Elo "
                       f"option is actually taking effect")

    if ci_low is not None and ci_high is not None:
        width = ci_high - ci_low
        if width >= WIDE_INTERVAL_FRACTION * span:
            unusable = True
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} spans "
                           f"{width / span:.0%} of the swept range -- resampling moves the peak "
                           f"almost anywhere, which is what no real signal looks like")
        elif width <= TIGHT_INTERVAL_FRACTION * span and not unusable:
            score += 1
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} is tight")
        else:
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f}")

    # A peak pinned to the edge usually means the true strength is outside the
    # swept range, so the estimate is a bound rather than a measurement. That
    # caps the label regardless of how clean the rest of the fit looks --
    # a tight interval around a boundary peak is confidently pointing at the
    # edge of the grid, not at the player's strength.
    edge = 0.02 * span
    at_edge = peak <= elos.min() + edge or peak >= elos.max() - edge
    if at_edge:
        score -= 1
        reasons.append("peak sits at the edge of the swept range -- widen the Elo range")

    confidence = "high" if score >= 2 else "medium" if score >= 0 else "low"
    if at_edge and confidence == "high":
        confidence = "medium"
    # An interval covering most of the grid is disqualifying on its own: a
    # large sample that still can't locate the peak is not a better estimate,
    # it is more evidence there is nothing to locate.
    if unusable:
        confidence = "low"
    return confidence, reasons
