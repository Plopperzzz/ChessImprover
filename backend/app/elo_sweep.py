"""Elo estimation from a Maia sweep (spec section 9).

Maia is asked to move in each of a player's positions at every Elo on a grid.
Where its choice matches what the player actually played, that Elo "explains"
the move. The Elo whose match rate peaks is the estimate.

The statistics here matter more than they look:

* Positions where Maia's top choice never changes across the whole grid carry
  no information about strength -- every Elo scores identically on them. They
  only add binomial noise, so they're split out before fitting.
* The same positions are scored at every grid point, so errors are strongly
  correlated along the grid, not i.i.d. A smoothing parameter chosen by the
  usual i.i.d. heuristic badly under-smooths here, and the fitted curve can
  swing outside the observed range near the boundary and put the peak there.
  So we start under that heuristic, sanity-check the fit, and escalate
  smoothing until it behaves -- falling back to a heavily smoothed weighted
  polynomial if the spline can't be tamed.
* The independent sampling unit is the *position*, not the grid point, so the
  bootstrap resamples positions and rebuilds the whole curve from the cached
  score matrix.
"""

import numpy as np

try:  # scipy is in requirements, but the fallback keeps this importable without it
    from scipy.interpolate import UnivariateSpline
except ImportError:  # pragma: no cover
    UnivariateSpline = None

BOOTSTRAP_SAMPLES = 400
# How far outside the observed match-rate range a fitted curve may stray
# before we call it overshoot and smooth harder.
OVERSHOOT_SE_TOLERANCE = 3.0
MAX_SMOOTHING_ESCALATIONS = 6


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


def _fit_curve(elos: np.ndarray, rates: np.ndarray, se: np.ndarray, dense: np.ndarray):
    """Weighted smooth fit over the grid, escalating smoothing until the
    curve stops overshooting. Returns (values_on_dense, description)."""
    n = len(elos)
    observed_lo, observed_hi = rates.min(), rates.max()
    tolerance = OVERSHOOT_SE_TOLERANCE * float(np.mean(se))

    if UnivariateSpline is not None and n >= 4:
        # The i.i.d. heuristic is s = n; correlated errors along the grid mean
        # that under-smooths, so start above it and escalate from there.
        s = float(n)
        for attempt in range(MAX_SMOOTHING_ESCALATIONS):
            try:
                spline = UnivariateSpline(elos, rates, w=1.0 / se, s=s, k=3)
                values = spline(dense)
            except Exception:
                break
            if (values.min() >= observed_lo - tolerance) and (values.max() <= observed_hi + tolerance):
                return values, f"spline (s={s:.1f}, {attempt + 1} attempt(s))"
            s *= 3.0

    # Spline couldn't be tamed (or scipy is missing): heavily smoothed
    # weighted polynomial, low order so it can't wiggle to the boundary.
    degree = min(2, max(1, n - 1))
    coeffs = np.polyfit(elos, rates, degree, w=1.0 / se)
    return np.polyval(coeffs, dense), f"weighted polynomial (degree {degree})"


def _peak(dense: np.ndarray, values: np.ndarray) -> float:
    return float(dense[int(np.argmax(values))])


def estimate(elos: list[int], score_matrix: np.ndarray, rng_seed: int = 0) -> dict:
    """Full estimate for one player.

    score_matrix: (n_positions, n_elos) of 1/0 match indicators.
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
    fitting_matrix = score_matrix[discriminative] if discriminative.size else score_matrix
    n_fit = fitting_matrix.shape[0]

    rates = fitting_matrix.mean(axis=0)
    se = binomial_se(rates, n_fit)
    dense = np.linspace(elos_arr.min(), elos_arr.max(), 400)
    values, method = _fit_curve(elos_arr, rates, se, dense)
    peak = _peak(dense, values)

    # Bootstrap over positions -- the independent unit -- rebuilding the curve
    # from the cached matrix each time. No engine work is repeated.
    rng = np.random.default_rng(rng_seed)
    peaks = []
    if n_fit >= 2:
        for _ in range(BOOTSTRAP_SAMPLES):
            idx = rng.integers(0, n_fit, n_fit)
            sample = fitting_matrix[idx]
            r = sample.mean(axis=0)
            s = binomial_se(r, n_fit)
            v, _ = _fit_curve(elos_arr, r, s, dense)
            peaks.append(_peak(dense, v))
    ci_low, ci_high = (float(np.percentile(peaks, 2.5)), float(np.percentile(peaks, 97.5))) if peaks else (None, None)

    confidence, reasons = _confidence(
        n_fit=n_fit, n_total=n_total, rates=rates, values=values, se=se,
        ci_low=ci_low, ci_high=ci_high, elos=elos_arr, peak=peak,
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
        "method": method,
        "grid": [int(e) for e in elos_arr],
        "match_rates": [float(r) for r in rates],
        "curve_x": [float(x) for x in dense],
        "curve_y": [float(y) for y in values],
    }


def _confidence(*, n_fit, n_total, rates, values, se, ci_low, ci_high, elos, peak):
    """High/Medium/Low with the reasons spelled out, since the number alone
    invites more trust than it deserves (section 9)."""
    reasons = []
    score = 0

    if n_fit >= 25:
        score += 1
        reasons.append(f"{n_fit} discriminative positions")
    elif n_fit >= 10:
        reasons.append(f"only {n_fit} discriminative positions")
    else:
        score -= 1
        reasons.append(f"very few discriminative positions ({n_fit})")

    prominence = float(values.max() - values.min())
    if prominence < 4.0 * float(np.mean(se)):
        score -= 1
        reasons.append(f"flat curve (varies by only {prominence:.1%}); the peak is barely distinguishable")
    elif n_fit >= 10:
        score += 1
        reasons.append(f"clear peak (varies by {prominence:.1%} across the grid)")
    else:
        # With a handful of positions the curve swings wildly by construction;
        # that shape isn't evidence of anything, so don't credit it.
        reasons.append(f"curve varies by {prominence:.1%}, but too few positions for that to mean much")

    if ci_low is not None and ci_high is not None:
        width = ci_high - ci_low
        span = float(elos.max() - elos.min())
        if width <= 0.25 * span:
            score += 1
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} is tight")
        elif width >= 0.6 * span:
            score -= 1
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} covers most of the swept range")
        else:
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f}")

    # A peak pinned to the edge usually means the true strength is outside the
    # swept range, so the estimate is a bound rather than a measurement. That
    # caps the label regardless of how clean the rest of the fit looks --
    # a tight interval around a boundary peak is confidently pointing at the
    # edge of the grid, not at the player's strength.
    edge = 0.02 * (elos.max() - elos.min())
    at_edge = peak <= elos.min() + edge or peak >= elos.max() - edge
    if at_edge:
        score -= 1
        reasons.append("peak sits at the edge of the swept range -- widen the Elo range")

    confidence = "high" if score >= 2 else "medium" if score >= 0 else "low"
    if at_edge and confidence == "high":
        confidence = "medium"
    return confidence, reasons
