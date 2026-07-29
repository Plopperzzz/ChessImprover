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
* **The peak's height is checked against Maia's published accuracy.** Every
  other test here is relative -- interval width against the swept span, peak
  position against the grid edges -- so none of them can answer "did this sweep
  find the player at all?". `maia_accuracy` supplies the absolute scale: the
  share of a player's moves the model is known to match at each rating. The
  fitted bump's height should land on that curve at the fitted bump's position,
  and when it falls short there are exactly two explanations, told apart by
  where the peak sits. At a grid edge it means the grid never reached the
  player, and the estimate is a bound rather than a measurement -- a case the
  edge check alone cannot see, because a genuine 2600 and a 3000 both pin the
  peak to the same edge. Away from the edge it means the player is less
  predictable than the population at that rating, which is a fact about them
  and not a defect in the fit.
"""

import numpy as np

from . import maia_accuracy, policy_likelihood

# Which objective a caller gets when it doesn't ask for one. The likelihood
# beats the top-1 match rate on the same stored data at every sample size
# measured -- see `backend/sims/policy_likelihood.py` and section 9 of the
# spec -- so it is what the app fits by default. 'top1' remains reachable
# through `estimate_from_ranks(objective='top1')`, and is still what
# `apply_great_brilliant` asks for, since "would a player at this strength have
# played exactly this move" really is a top-1 question.
DEFAULT_OBJECTIVE = "likelihood"
OBJECTIVES = ("likelihood", "top1")

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
MAX_TOP_N = 9
WIDE_INTERVAL_FRACTION = 0.55
TIGHT_INTERVAL_FRACTION = 0.10

# How far the observed peak may fall below the accuracy curve before the fit is
# treated as not having found the player, as a fraction of the expected rate.
#
# Simulated against a known curve, an in-grid player's ratio sits at 1.00 with a
# 5th percentile of 0.95 even from 25 games, while a player 400 Elo off the end
# of the grid comes in at 0.79 -- so the two populations do not overlap and the
# threshold has a wide corridor to sit in. It is set low in that corridor
# because the curve itself carries error the simulation did not: it is digitised
# from a published figure, and it is measured on blitz, so a library of slower
# games sits below it through no fault of the player.
CEILING_SHORTFALL = 0.90
# Above this the sweep is taken to have reached the curve, which is what makes
# an edge-pinned peak trustworthy as a floor rather than an artefact.
CEILING_REACHED = 0.95
# Far below the shortfall threshold rather than a little under it. Simulated
# above: a player 400 Elo off the end of the grid still manages 0.79, and a
# genuine in-grid player 0.95+, so two thirds of the expected rate is not a
# player the sweep merely struggled with -- it is one it never located. A
# beginner whose moves no Maia setting predicts lands at 0.3.
CEILING_LOST = 0.70
# Roughly what the models manage against the weakest players they cover. Worth
# quoting in the message: it is what makes "no setting explains this" a claim
# about the play rather than about the grid being too narrow.
LOWEST_RATED_ACCURACY = 0.47


def hits(rank_matrix: np.ndarray, top_n: int = 1) -> np.ndarray:
    """Binary match indicators from a rank matrix, under a top-N objective.

    The sweep stores *where* your move ranked in Maia's ordering (1 = its own
    choice, 0 = not a candidate at all), which is strictly more information
    than a yes/no. Everything statistical downstream still wants a 0/1 matrix,
    so this is where the objective is applied -- and because it applies to
    cached scores, switching objectives costs no engine time.

    top_n=1 reproduces the original "did Maia play exactly this" question, and
    is what the classification rules mean by "a player at this Elo would have
    found it".
    """
    m = np.asarray(rank_matrix, dtype=float)
    return ((m >= 1.0) & (m <= float(top_n))).astype(float)


def decode_scores(scores: str) -> list[float]:
    """Stored score string to ranks. Old top-1-only rows used '1'/'0', which
    decode to rank 1 and rank 0 -- the same meaning, so nothing needs
    migrating."""
    return [float(c) if c.isdigit() else 0.0 for c in (scores or "")]


# --- policy probabilities ---------------------------------------------------
#
# When the engine reports per-candidate policy, the probability it gave the
# move actually played is stored alongside the rank. A float per (position,
# Elo) would multiply the size of the largest table in the database, so it is
# quantised the way `scores` is: fixed-width characters, no separators, decoded
# by position.
#
# Two characters per grid point over the 94 printable ASCII codes gives 8836
# levels across the log-probability range below, a resolution of about 0.001
# nats. That is far finer than it needs to be -- but the whole point of the
# likelihood is that differences of a tenth of a nat per move decide where the
# peak sits, and a one-character encoding would have quantised at 0.1.
POLICY_ALPHABET_START = 33
POLICY_ALPHABET_SIZE = 94
POLICY_LEVELS = POLICY_ALPHABET_SIZE * POLICY_ALPHABET_SIZE
# Probabilities below e^-12 (about 6 in a million) are recorded as the floor.
# Nothing downstream can tell them apart from zero and a true zero would make
# the log-likelihood infinite, which one unlucky move would then decide.
POLICY_LOG_FLOOR = -12.0


def encode_policies(probabilities) -> str:
    """Per-grid-point probabilities for one position -> the stored string."""
    out = []
    for p in probabilities:
        logp = POLICY_LOG_FLOOR if not p or p <= 0 else max(float(np.log(p)), POLICY_LOG_FLOOR)
        level = int(round((logp - POLICY_LOG_FLOOR) / -POLICY_LOG_FLOOR * (POLICY_LEVELS - 1)))
        level = min(max(level, 0), POLICY_LEVELS - 1)
        hi, lo = divmod(level, POLICY_ALPHABET_SIZE)
        out.append(chr(POLICY_ALPHABET_START + hi))
        out.append(chr(POLICY_ALPHABET_START + lo))
    return "".join(out)


def decode_policies(encoded: str) -> list[float]:
    """Stored string -> log probabilities, one per grid point. Empty for a
    sweep that recorded no policy, which is every sweep run against a build
    that doesn't report one."""
    if not encoded or len(encoded) % 2:
        return []
    out = []
    for i in range(0, len(encoded), 2):
        hi = ord(encoded[i]) - POLICY_ALPHABET_START
        lo = ord(encoded[i + 1]) - POLICY_ALPHABET_START
        if not (0 <= hi < POLICY_ALPHABET_SIZE and 0 <= lo < POLICY_ALPHABET_SIZE):
            return []
        level = hi * POLICY_ALPHABET_SIZE + lo
        out.append(POLICY_LOG_FLOOR + level / (POLICY_LEVELS - 1) * -POLICY_LOG_FLOOR)
    return out


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


def estimate_from_ranks(elos, rank_matrix, groups=None, accuracy=None,
                        top_n: int = 1, objective: str = DEFAULT_OBJECTIVE,
                        log_policies=None) -> dict:
    """The one entry point that knows about objectives.

    Callers hold *ranks* -- which is what the sweep stores and what every
    re-fit reads back -- and want an estimate. Which objective turns those into
    a fit is this function's business and nobody else's, so switching it does
    not touch the sweep view, the trend or the pooled strength fit.

    `objective`:
      'likelihood' scores each move by the probability Maia gave it, from the
        engine's own policy when `log_policies` carries it and from the rank
        otherwise (`policy_likelihood`). This is the default.
      'top1' is the original "was this Maia's single favourite" match rate,
        with the bump fit, the bootstrap and the accuracy-curve ceiling. Kept
        reachable because it is what every stored number was produced by, and
        because the comparison between the two is only possible while both run.
    """
    if objective == "likelihood":
        if log_policies is not None and np.asarray(log_policies).size:
            logp = np.asarray(log_policies, dtype=float)
            exact = True
        else:
            logp = policy_likelihood.logp_from_ranks(rank_matrix)
            exact = False
        return policy_likelihood.estimate(elos, logp, groups=groups, exact_policy=exact)
    return estimate(elos, hits(rank_matrix, top_n), groups=groups,
                    accuracy=accuracy, top_n=top_n)


def estimate(elos: list[int], score_matrix: np.ndarray, rng_seed: int = 0,
             groups: np.ndarray | None = None,
             accuracy: "maia_accuracy.AccuracyCurve | None" = None,
             top_n: int = 1) -> dict:
    """Full estimate for one player, under the original top-1 objective.

    score_matrix: (n_positions, n_elos) of 1/0 match indicators.
    groups: optional per-row game id. When several games are pooled, moves
        from the same game are not independent -- one opponent, one opening,
        one sitting -- so the bootstrap resamples *games* rather than moves.
        Resampling moves there would report an interval far tighter than the
        data supports.
    accuracy: the model's published match-rate curve, when the model that swept
        these positions is known. Adds the absolute check described above;
        leaving it None reproduces the older behaviour exactly.
    top_n: which objective built score_matrix. The published curves are top-1
        rates, so a wider objective silently clears them -- the accuracy check
        is dropped rather than compared against the wrong number.
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
    if peaks:
        ci_low = float(np.percentile(peaks, 2.5))
        ci_high = float(np.percentile(peaks, 97.5))
        # A percentile bootstrap interval need not contain the point estimate,
        # and when it doesn't the pair reads as broken ("1600, 95% 1400-1400").
        # Widening to include it is the conservative direction -- it can only
        # ever admit more uncertainty, never hide any.
        ci_low, ci_high = min(ci_low, peak), max(ci_high, peak)
    else:
        ci_low, ci_high = None, None

    # The accuracy check runs on *every* position, not just the discriminative
    # ones: the published rate is a share of all a player's moves, and the
    # uninformative rows are part of that denominator. No extra data is needed
    # -- an all-1 row contributes 1 at every Elo and an all-0 row contributes 0,
    # so the full-set curve is just the mean over every row.
    full_rates = score_matrix.mean(axis=0)
    ceiling = _ceiling(full_rates, peak, elos_arr, accuracy, top_n, n_total)

    confidence, reasons = _confidence(
        n_fit=n_fit, n_total=n_total, rates=rates, params=params, se=se,
        ci_low=ci_low, ci_high=ci_high, elos=elos_arr, peak=peak,
        n_units=n_games, clustered=rows_by_group is not None, single_game=fell_back,
        ceiling=ceiling,
    )

    return {
        "estimate": round(peak),
        "ceiling": ceiling,
        "bound": ceiling.get("bound") if ceiling else None,
        "full_match_rates": [float(r) for r in full_rates],
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


def at_edge(peak: float, elos: np.ndarray) -> tuple[bool, bool]:
    """(pinned to the bottom, pinned to the top) of the swept range."""
    edge = 0.02 * float(elos.max() - elos.min())
    return peak <= elos.min() + edge, peak >= elos.max() - edge


def _ceiling(full_rates: np.ndarray, peak: float, elos: np.ndarray,
             accuracy, top_n: int, n_total: int) -> dict | None:
    """The peak's height against the model's published accuracy at that rating.

    `observed` is the best match rate anywhere on the grid over *all* the
    player's positions, and `expected` is what the model is known to manage
    against players at the rating the fit landed on. The ratio of the two is
    the whole point: it is the first check here that has an absolute scale
    behind it rather than the sweep's own spread.

    `implied` inverts the curve on the observed rate instead, which is a second
    and entirely independent read of strength -- it uses only how often Maia
    agreed with the player, never which Elo setting agreed most. It is far
    blunter (a point of match rate is worth about 140 Elo) but it is wrong in
    different ways, so a wide gap between the two is informative even though
    neither is precise.
    """
    if accuracy is None or top_n != 1 or full_rates.size == 0:
        return None
    observed = float(full_rates.max())
    expected = float(accuracy.at(peak))
    if expected <= 0:
        return None
    ratio = observed / expected
    low, high = at_edge(peak, elos)
    short = ratio < CEILING_SHORTFALL
    implied = accuracy.implied(observed)

    # How precise that inversion is. The curve climbs about 0.7 of a percentage
    # point per 100 Elo, so the standard error of the match rate has to be
    # divided by a very small slope to become an Elo -- which is why a rate
    # that looks bang on the curve can still imply a rating hundreds of points
    # away. Reporting the number without this would be indefensible.
    #
    # It is a *floor*: the binomial term treats positions as independent when
    # moves within a game are not, so the real interval is wider still.
    implied_se = None
    if implied is not None and n_total > 0:
        slope = (accuracy.at(implied + 50) - accuracy.at(implied - 50)) / 100.0
        if slope > 1e-6:
            rate_se = float(np.sqrt(max(observed * (1.0 - observed), 1e-6) / n_total))
            implied_se = rate_se / slope

    return {
        "observed": round(observed, 4),
        "expected": round(expected, 4),
        "ratio": round(ratio, 3),
        "implied_rating": round(implied) if implied is not None else None,
        "implied_rating_se": round(implied_se) if implied_se is not None else None,
        "model": accuracy.label,
        "share_known": round(accuracy.share_known, 3),
        # A shortfall at the top of the grid means the player is somewhere past
        # it and the estimate is a floor; at the bottom, a ceiling. Away from
        # both edges it is not a bound at all -- it is inconsistency.
        "bound": "lower" if (short and high) else "upper" if (short and low) else None,
        "reached": ratio >= CEILING_REACHED,
    }


def _confidence(*, n_fit, n_total, rates, params, se, ci_low, ci_high, elos, peak,
                n_units=None, clustered=False, single_game=False, ceiling=None):
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
    edged = any(at_edge(peak, elos))

    # With the accuracy curve in hand this is no longer guesswork. A peak that
    # reached the curve *is* the player, even sitting on the boundary; one that
    # fell short of it is the grid running out. Nothing but the height can tell
    # those apart, since both pin the fit to the same Elo.
    if ceiling and edged:
        if ceiling["bound"]:
            score -= 1
            side = "above" if ceiling["bound"] == "lower" else "below"
            reasons.append(
                f"the best match rate anywhere on the grid was {ceiling['observed']:.1%}, "
                f"against the {ceiling['expected']:.1%} {ceiling['model']} manages on players "
                f"at {round(peak)} -- the sweep never reached this player, who is {side} the "
                f"swept range. Treat the number as a bound and widen the Elo range")
        elif ceiling["reached"]:
            reasons.append(
                f"peak sits at the edge of the swept range, but the match rate got to "
                f"{ceiling['observed']:.1%} against the {ceiling['expected']:.1%} expected there "
                f"-- the player really is around the edge, so this is a sound floor. Widen the "
                f"range to pin it down")
        else:
            score -= 1
            reasons.append("peak sits at the edge of the swept range -- widen the Elo range")
    elif edged:
        score -= 1
        reasons.append("peak sits at the edge of the swept range -- widen the Elo range")

    # A shortfall this deep is not "harder to predict than the field", it is
    # the sweep not having found the player at all: no Elo on the grid agreed
    # with them much more than any other, so the peak is where the noise put
    # it. The curves run down to 600, so this is not the grid being too narrow
    # -- it is a player the model has no setting for, or too few moves to tell.
    # Saying it any more gently reads as a rating.
    if ceiling and not ceiling["reached"] and ceiling["ratio"] < CEILING_LOST:
        score -= 1
        reasons.append(
            f"{ceiling['model']} agreed with {ceiling['observed']:.1%} of these moves at its best "
            f"setting, against the {ceiling['expected']:.1%} it manages on players at "
            f"{round(peak)} -- and it manages {LOWEST_RATED_ACCURACY:.0%} even on 600-rated "
            f"players. No Elo on the grid explains this play, so the number above is where the "
            f"fit landed rather than a strength")
    # Away from the edges a milder shortfall is not about the grid at all. The
    # player is simply harder to predict than the population Maia was measured
    # on -- which is worth saying plainly, because it is a fact about how they
    # play rather than a failure of the estimate.
    elif ceiling and not edged and not ceiling["reached"]:
        gap = f", the rate of a {ceiling['implied_rating']}" if ceiling["implied_rating"] else ""
        reasons.append(
            f"your moves match {ceiling['model']} {ceiling['observed']:.1%} of the time at best{gap}, "
            f"against the {ceiling['expected']:.1%} it manages on players at {round(peak)} -- "
            f"you play less predictably than the field at your level, so the estimate describes "
            f"a wider spread of moves than usual")
    elif ceiling and ceiling["reached"] and not edged:
        reasons.append(
            f"match rate peaked at {ceiling['observed']:.1%}, on the {ceiling['expected']:.1%} "
            f"{ceiling['model']} is known to manage at {round(peak)}")

    confidence = "high" if score >= 2 else "medium" if score >= 0 else "low"
    if edged and confidence == "high" and not (ceiling and ceiling["reached"]):
        confidence = "medium"
    # An interval covering most of the grid is disqualifying on its own: a
    # large sample that still can't locate the peak is not a better estimate,
    # it is more evidence there is nothing to locate.
    if unusable:
        confidence = "low"
    return confidence, reasons
