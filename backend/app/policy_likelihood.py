"""Strength from one game, by likelihood over Maia's move preferences.

The top-1 sweep in `elo_sweep` asks one bit per move -- *was this the model's
single favourite at this rating?* -- and throws away everything else. A move
Maia ranked second and would have played 30% of the time, and a move it never
considered at all, both score zero. That is why the bump fit needs a hundred
positions to settle, and why one game of 25 returns a number-shaped
non-answer.

This asks the question Maia's own tooling asks:

    rating_hat = argmax_r  sum over moves of  log P(move played | position, r)

and takes the answer straight out of the log-likelihood:

* **The peak is the estimate.** A local quadratic through the grid points near
  the maximum, and its vertex. No bump to fit, because there is no baseline to
  separate out -- an obvious move that every rating plays contributes the same
  log probability at every rating and drops out of the *differences* by itself,
  which is exactly what the old code had to identify a "baseline" parameter to
  do.
* **The curvature is the standard error.** For a one-parameter likelihood the
  observed information is -L''(peak), and the error on the peak is its inverse
  square root. No bootstrap: several hundred refits per estimate bought an
  interval that this reads off the same quadratic for nothing.
* **Moves within a game are not independent**, so the reported error is a
  *cluster-robust sandwich*: the model-based information in the denominator,
  and the variance of the per-game score sums in the numerator. That is the
  same correction the cluster bootstrap was making, done in closed form, and
  it degrades honestly to the independent-moves form when there is only one
  game to resample.
* **The scale is absolute.** Mean log probability per move is comparable
  across players, games and grids without calibrating against a published
  accuracy curve: a player Maia predicts as well as it predicts anyone scores
  about `WELL_PREDICTED_LOGP`, and one it cannot predict at all scores
  `UNPREDICTABLE_LOGP` -- the log of picking uniformly among legal moves. That
  is what tells a beginner apart from a bad fit, which under the top-1
  objective needed the whole `_ceiling` apparatus and a digitised figure from
  a paper.

Where the probabilities come from
---------------------------------

Two sources, deliberately reduced to the same thing -- a (position x rating)
matrix of log probabilities -- so that everything above is written once.

* **Exact**, when the engine reports per-candidate policy. `sweep_job` stores
  it and `elo_sweep.decode_policies` reads it back.
* **A rank surrogate**, from the rank the sweep already stores, via
  `rank_log_probabilities`. This is what lets every sweep already in the
  database re-fit under the new objective with no engine time at all --
  including sweeps run before any of this existed, which recorded only rank 1.

The surrogate is a *proper* likelihood, not a fudge: the probability assigned
to a rank does not depend on the rating, so the same total mass is spread over
the same move vocabulary at every grid point, and the normalisation cancels in
the comparison between ratings. All the rating-dependence enters through which
rank the played move got -- which is precisely the extra information the top-1
bit was discarding.
"""

import numpy as np

# Ranks the sweep can record. Matches sweep_job.MAX_RANK -- one digit per grid
# point in the stored string, so 9 is the ceiling for the encoding, not a
# statistical choice.
MAX_RANK = 9

# --- the rank surrogate -----------------------------------------------------
#
# A policy net's sorted move probabilities fall away steeply and in a fairly
# stable shape, so the k-th ranked move can be given a typical mass without
# knowing the position. These three numbers fix that shape.
#
# TOP1_MASS is the average probability a Maia model puts on its own first
# choice, which is also roughly the rate at which it matches a player it has
# the rating right for -- Maia's published top-1 accuracy runs from about 0.47
# at 600 to the low 0.5s at master level, and `maia_accuracy` carries that
# curve. RANK_DECAY is the Zipf exponent through the rest of the ordering.
#
# The estimator is not sensitive to these being *exactly* right, because they
# set how many nats a rank improvement is worth -- the scale of the
# log-likelihood -- while the peak is where the ranks improve, which does not
# move. Simulated over every combination of decay 1.0/1.5/2.2 and top-1 mass
# 0.35/0.45/0.55, the bias stays within 14 Elo and coverage within 92-98%.
#
# What they do cost is precision. A decay of 1.0 spreads the mass too evenly
# across the ranks, so a rank-1 move is worth little more than a rank-5 one and
# the spread over seeds runs to 120-180 Elo against 77 at 1.5. The default is
# the middle of the range where a policy net's sorted probabilities actually
# fall, and being wrong in the flat direction is the expensive way to be wrong.
TOP1_MASS = 0.45
RANK_DECAY = 1.5
# Legal moves in a typical middlegame position, which is what the mass left
# over after the recorded ranks has to be shared between. Only the unranked
# level depends on it, and only logarithmically.
TYPICAL_LEGAL_MOVES = 31


def rank_probabilities(top1_mass: float = TOP1_MASS, decay: float = RANK_DECAY,
                       legal_moves: int = TYPICAL_LEGAL_MOVES,
                       max_rank: int = MAX_RANK) -> np.ndarray:
    """Typical policy mass by rank. Index 0 is "not among the recorded
    candidates at all", indices 1..max_rank are Maia's ordering.

    The unranked level is the leftover mass shared over the legal moves that
    did not make the list, and is held strictly below the last recorded rank:
    a move the model did not rank cannot be more likely than one it ranked
    last, and a careless combination of the constants above can otherwise put
    it there.
    """
    ranks = np.arange(1, max_rank + 1, dtype=float)
    listed = top1_mass * ranks ** (-decay)
    remaining = max(legal_moves - max_rank, 1)
    unranked = max(1.0 - listed.sum(), 1e-6) / remaining
    unranked = min(unranked, listed[-1] * 0.9)
    return np.concatenate([[unranked], listed])


def rank_log_probabilities(**kwargs) -> np.ndarray:
    return np.log(rank_probabilities(**kwargs))


def logp_from_ranks(rank_matrix, **kwargs) -> np.ndarray:
    """(position x rating) ranks -> log probabilities, via the surrogate.

    Reads the old '1'/'0' top-1 rows exactly as it reads ranked ones: rank 1
    is rank 1, and 0 has always meant "not a candidate". Nothing needs
    migrating, and an old sweep simply carries less information rather than
    being unreadable.
    """
    table = rank_log_probabilities(**kwargs)
    ranks = np.asarray(rank_matrix, dtype=float)
    idx = np.clip(np.rint(ranks), 0, len(table) - 1).astype(int)
    return table[idx]


# A player Maia predicts as well as it predicts the population it was measured
# on scores this per move: the entropy of the rank distribution above. It is
# the likelihood's own version of "did this sweep find the player at all", and
# unlike the match-rate ceiling it needs no published curve to compare against.
WELL_PREDICTED_LOGP = float(
    (lambda q: (q[1:] * np.log(q[1:])).sum()
     + (TYPICAL_LEGAL_MOVES - MAX_RANK) * q[0] * np.log(q[0]))(rank_probabilities())
)
# And a player it cannot predict at all scores what guessing uniformly among
# legal moves scores. Between the two is the whole usable range.
UNPREDICTABLE_LOGP = float(-np.log(TYPICAL_LEGAL_MOVES))


# --- fitting ----------------------------------------------------------------

# How the grid points are weighted in the peak fit, in nats of log-likelihood
# below the maximum. Every point gets weight exp((L - Lmax) / PEAK_TAU), so the
# fit is local to the peak without ever choosing a window.
#
# That "without choosing" is the whole point, and it was worth several attempts
# to get to. Fitting a quadratic through a hard window of grid points around
# the maximum -- the obvious thing -- makes the estimate a *discontinuous*
# function of the data: the window is picked by where the maximum landed, so a
# sample that nudges the maximum to the next grid point moves the fit bodily.
# The extra spread that injects is invisible to any standard error computed
# afterwards, because it comes from the step the error formula never sees.
# Measured against a known 1500 over 500 seeds of one game (see
# `backend/sims/policy_likelihood.py`):
#
#     hard 5-point window   spread 134 Elo, stated 76,  covers 78% of the time
#     hard 11-point window  spread  94 Elo, stated 80,  covers 87%
#     soft weights, tau 4   spread  79 Elo, stated 90,  covers 97%
#
# The soft fit is both tighter *and* honest about it, because a smooth weight
# makes the whole estimator a smooth function of the data.
#
# tau trades bias against spread: too small and the fit sees too few points to
# average the jaggedness out, too large and it reaches into the tails of the
# curve where a quadratic no longer describes it and drags the peak toward the
# middle of the grid -- the exact failure the old smoothing spline was replaced
# for. Between 1200 and 1800 on the default grid, tau 4 holds the bias under 15
# Elo and coverage between 96% and 97%.
PEAK_TAU = 4.0
# Weights this concentrated leave nothing to fit a curve through. A large
# library makes the likelihood so sharp that only one or two grid points carry
# any weight at all, so tau is relaxed until the weights span enough of the
# grid to determine a parabola.
MIN_EFFECTIVE_POINTS = 4.0
MAX_TAU_RELAXATIONS = 8
# Elo per unit of the fitting variable. The grid runs to thousands and the
# design matrix carries its square, so the fit is done in hundreds of Elo to
# keep the normal equations well conditioned.
ELO_UNIT = 100.0

# Below this the rating setting is doing nothing: the best and worst points on
# the grid explain the same moves about equally well. Under a real signal from
# one game the span runs to tens of nats; under an engine whose Elo option is
# ignored it is the couple of nats that noise alone produces.
MIN_SPAN_NATS = 3.0


def _weights(total: np.ndarray) -> tuple[np.ndarray, float]:
    """Kernel weights over the grid, and the tau that produced them.

    Relaxed until the weights have enough effective spread to determine a
    quadratic. The effective count is Kish's -- (sum w)^2 / sum w^2 -- which is
    what "how many points is this fit really using" means for unequal weights.
    """
    tau = PEAK_TAU
    for _ in range(MAX_TAU_RELAXATIONS):
        w = np.exp((total - total.max()) / tau)
        if w.sum() ** 2 / max((w ** 2).sum(), 1e-300) >= MIN_EFFECTIVE_POINTS:
            return w, tau
        tau *= 2.0
    return np.ones_like(total), tau


def _vertex(b: np.ndarray, c: np.ndarray):
    """Vertex of a family of quadratics, NaN where one curves the wrong way."""
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(c < -1e-12, -b / (2.0 * c), np.nan)


def fit(elos, logp_matrix, groups=None) -> dict:
    """Peak, standard error and diagnostics from a (position x rating) matrix
    of log probabilities.

    Every move is fitted with its own weighted quadratic, which costs one
    pseudo-inverse for the lot because they all share a design matrix. Summing
    those quadratics *is* the quadratic through the total, so the peak and the
    per-move contributions come from one fit and agree exactly -- which is what
    makes the error estimate below closed-form.

    The error is a **delete-one jackknife over the independent unit**: games
    when `groups` says which game each move came from, moves otherwise.
    Dropping a unit just subtracts its own coefficients from the summed
    quadratic, so every leave-one-out peak is available in closed form and the
    whole jackknife costs one vectorised expression rather than a refit each.
    That is what replaced the 400-sample bootstrap, and it is both cheaper and
    better behaved: the bootstrap resampled a discontinuous estimator, and the
    jackknife covers at 95-97% where the analytic sandwich covered at 94%.
    """
    elos = np.asarray(elos, dtype=float)
    logp = np.asarray(logp_matrix, dtype=float)
    n_moves, n_grid = logp.shape

    total = logp.sum(axis=0)
    weights, tau = _weights(total)

    # A fixed origin, deliberately not the observed maximum: the fitted
    # parabola is the same whichever origin it is written about, but a
    # data-dependent one invites exactly the discontinuity the soft weights
    # exist to avoid.
    origin = float(elos.mean())
    u = (elos - origin) / ELO_UNIT
    design = np.vander(u, 3, increasing=True)                  # [1, u, u^2]
    weighted = design * weights[:, None]
    operator = np.linalg.pinv(design.T @ weighted) @ weighted.T
    coeffs = logp @ operator.T                                 # (n_moves, 3)

    b_i, c_i = coeffs[:, 1], coeffs[:, 2]
    b, c = float(b_i.sum()), float(c_i.sum())

    curved = c < -1e-9
    u_hat = -b / (2.0 * c) if curved else float(u[int(np.argmax(total))])
    peak = float(origin + u_hat * ELO_UNIT)

    # Per-move score at the peak. These sum to zero there by construction --
    # the score equation -- and the residual is reported as a check that the
    # single shared fit really did give the peak and the scores together.
    scores = b_i + 2.0 * c_i * u_hat
    information = -2.0 * c

    se, se_model, clusters = None, None, None
    if curved:
        se_model = float(np.sqrt(1.0 / information) * ELO_UNIT)
        if groups is not None and len(np.unique(groups)) >= 2:
            labels = np.unique(groups)
            clusters = len(labels)
            index = np.searchsorted(labels, np.asarray(groups))
            drop_b = np.bincount(index, weights=b_i, minlength=clusters)
            drop_c = np.bincount(index, weights=c_i, minlength=clusters)
        else:
            drop_b, drop_c = b_i, c_i
        left = _vertex(b - drop_b, c - drop_c)
        left = left[np.isfinite(left)]
        if left.size >= 3:
            m = left.size
            se = float(np.sqrt((m - 1) / m * ((left - left.mean()) ** 2).sum()) * ELO_UNIT)

    a = float(coeffs[:, 0].sum())
    at_peak = a + b * u_hat + c * u_hat ** 2

    return {
        "peak": peak,
        "se": se,
        "se_model": se_model,
        "clusters": clusters,
        "curved": bool(curved),
        "information": float(information),
        "tau": float(tau),
        "total": total,
        "mean_logp": float(at_peak / n_moves) if n_moves else None,
        "span_nats": float(total.max() - total.min()),
        "score_residual": float(scores.sum()),
        "n_moves": int(n_moves),
        "n_grid": int(n_grid),
    }


def curve(elos, total: np.ndarray, n_moves: int, points: int = 400):
    """The log-likelihood over a dense grid, per move so it plots on the same
    absolute scale whatever the sample size. Interpolated between the points
    the engine actually produced rather than extrapolated from the peak fit --
    the quadratic is only claimed near the maximum."""
    elos = np.asarray(elos, dtype=float)
    dense = np.linspace(elos.min(), elos.max(), points)
    per_move = np.asarray(total, dtype=float) / max(n_moves, 1)
    return dense, np.interp(dense, elos, per_move)


# --- the estimate, in the shape everything downstream already reads ---------

# A peak this far outside the swept grid is not a measurement of anything. The
# quadratic is fitted near the maximum and extrapolating it past the end of the
# grid says only "further that way", so the estimate is clamped and reported as
# a bound.
EXTRAPOLATION_LIMIT = 0.25

# Interval width as a fraction of the swept range. Above the first of these the
# fit has located nothing and the label is forced to Low whatever else looks
# good; the rest grade it.
WIDE_INTERVAL_FRACTION = 0.55
# A wide-but-real interval: worth showing, worth arguing down a grade.
LOOSE_INTERVAL_FRACTION = 0.30
# What one game of 20-40 moves typically manages on the default 600-2600 grid
# -- around 300-400 Elo, or 15-20% of the swept range. Enough to be worth
# showing, which is the whole claim being made for this objective.
USABLE_INTERVAL_FRACTION = 0.20
TIGHT_INTERVAL_FRACTION = 0.10


def informative(logp_matrix) -> tuple[np.ndarray, np.ndarray]:
    """Indices of positions whose log probability moves across the grid, and of
    those it doesn't.

    Same split as the top-1 objective made, and for the same reason -- but
    where a binary hit was uninformative whenever Maia's *first* choice never
    changed, a log probability is uninformative only when its whole opinion of
    the move stands still. That is a much weaker condition: over 30-move games
    the top-1 objective keeps 3.6 positions on average and this keeps 15.0,
    and the four-fold difference is a good part of where the extra precision
    comes from.
    """
    m = np.asarray(logp_matrix, dtype=float)
    if m.size == 0:
        return np.array([], dtype=int), np.array([], dtype=int)
    varies = ~np.isclose(m.max(axis=1), m.min(axis=1))
    return np.flatnonzero(varies), np.flatnonzero(~varies)


def estimate(elos, logp_matrix, groups=None, exact_policy: bool = False) -> dict:
    """Full estimate for one player, from log probabilities rather than hits.

    Returns the same keys `elo_sweep.estimate` does, so the sweep view, the
    trend and the pooled strength fit read it without knowing which objective
    produced it. `match_rates` and `curve_y` carry mean log probability per
    move instead of a match rate -- `curve_kind` says which, and the chart
    labels itself from that rather than assuming a percentage.
    """
    elos_arr = np.asarray(elos, dtype=float)
    logp = np.asarray(logp_matrix, dtype=float)
    if logp.size == 0 or len(elos_arr) < 2:
        return {"estimate": None, "confidence": "low", "n_positions": 0,
                "n_discriminative": 0,
                "reasons": ["no positions to estimate from"]}

    discriminative, uninformative = informative(logp)
    n_total = logp.shape[0]
    keep = discriminative if discriminative.size else np.arange(n_total)
    fitting = logp[keep]
    fitting_groups = np.asarray(groups)[keep] if groups is not None else None

    result = fit(elos_arr, fitting, fitting_groups)
    span = float(elos_arr.max() - elos_arr.min())
    limit_low = elos_arr.min() - EXTRAPOLATION_LIMIT * span
    limit_high = elos_arr.max() + EXTRAPOLATION_LIMIT * span
    raw_peak = float(np.clip(result["peak"], limit_low, limit_high))
    peak = float(np.clip(raw_peak, elos_arr.min(), elos_arr.max()))

    se = result["se"]
    ci_low = ci_high = None
    if se is not None and np.isfinite(se):
        ci_low = float(np.clip(raw_peak - 1.96 * se, limit_low, limit_high))
        ci_high = float(np.clip(raw_peak + 1.96 * se, limit_low, limit_high))

    dense, values = curve(elos_arr, result["total"], result["n_moves"])
    # The absolute read, on every position rather than only the discriminative
    # ones: the scale is "how well does Maia predict this player's moves", and
    # a move it predicts identically at every rating is still a move it
    # predicted. Mirrors the denominator the old ceiling check used.
    full_per_move = logp.mean(axis=0)

    confidence, reasons = _confidence(
        result=result, elos=elos_arr, peak=peak, raw_peak=raw_peak,
        ci_low=ci_low, ci_high=ci_high, n_total=n_total,
        exact_policy=exact_policy, full_per_move=full_per_move,
    )

    return {
        "estimate": round(peak),
        "ci_low": round(ci_low) if ci_low is not None else None,
        "ci_high": round(ci_high) if ci_high is not None else None,
        "confidence": confidence,
        "reasons": reasons,
        "n_positions": int(n_total),
        "n_discriminative": int(result["n_moves"]),
        "n_uninformative": int(uninformative.size),
        "n_games": result["clusters"],
        "method": ("policy likelihood" if exact_policy else "rank likelihood"),
        "objective": "likelihood",
        "policy_source": "engine" if exact_policy else "rank surrogate",
        # What the y axis means. The top-1 objective plotted a match rate; this
        # plots mean log probability per move, and nothing downstream should
        # have to guess which it was handed.
        "curve_kind": "mean_logp",
        "curve_label": "mean log P(your move)",
        "grid": [int(e) for e in elos_arr],
        "match_rates": [float(v) for v in result["total"] / max(result["n_moves"], 1)],
        "full_match_rates": [float(v) for v in full_per_move],
        "curve_x": [float(x) for x in dense],
        "curve_y": [float(y) for y in values],
        "mean_logp": result["mean_logp"],
        "well_predicted_logp": WELL_PREDICTED_LOGP,
        "unpredictable_logp": UNPREDICTABLE_LOGP,
        "se": round(se) if se is not None and np.isfinite(se) else None,
        # What the curvature alone would have claimed, which assumes both that
        # the player really is a Maia at some rating and that their moves are
        # independent. Reported beside the jackknife because the ratio of the
        # two is how much those assumptions were worth -- measured on this
        # player's own moves rather than asserted.
        "se_curvature": (round(result["se_model"])
                         if result["se_model"] is not None else None),
        "span_nats": round(result["span_nats"], 2),
        "bound": ("lower" if raw_peak >= elos_arr.max() else
                  "upper" if raw_peak <= elos_arr.min() else None),
        # Kept so the score equation can be checked from the API response.
        "score_residual": round(result["score_residual"], 9),
    }


def _confidence(*, result, elos, peak, raw_peak, ci_low, ci_high, n_total,
                exact_policy, full_per_move):
    """High/Medium/Low with the reasons spelled out. The likelihood carries its
    own absolute scale, so unlike the top-1 version these reasons can say
    whether the player was found at all without consulting a published curve."""
    reasons = []
    score = 0
    span = float(elos.max() - elos.min())
    n_fit = result["n_moves"]
    cap_medium = False

    reasons.append(
        f"{n_fit} of {n_total} positions carry rating information"
        + ("" if exact_policy else
           "; scored from Maia's ranking of your move, not its raw policy"))
    # Sample size counts for much less here than it did under the top-1
    # objective, and deliberately. There, the number of positions was the only
    # handle on precision. Here the interval is read from the curvature of the
    # likelihood itself, so it already knows how much those positions were
    # worth -- a game of sharp, discriminating positions and a game of book
    # moves have different curvatures at the same count. Counting both would
    # be counting the same evidence twice, so the width below carries the
    # weight and this only flags a sample too small to trust either way.
    if n_fit >= 100:
        score += 1
    elif n_fit < 10:
        score -= 1
        reasons.append(f"very few usable positions ({n_fit})")

    if result["clusters"]:
        reasons.append(f"pooled over {result['clusters']} game(s); the interval "
                       f"accounts for moves within a game not being independent")
    elif n_fit:
        # Not a score penalty but a ceiling, which is the honest shape of this
        # objection. One game now produces a genuinely usable number -- 80 Elo
        # of spread over seeds against the old objective's 275, covering at
        # 97% -- so scoring it down to Low would be as wrong as the old code
        # calling it High. But the interval is jackknifed over *moves*, and
        # moves in one game share an opponent, an opening and a sitting, so it
        # is optimistic by an amount this cannot measure from one game. Medium
        # is exactly what that deserves.
        cap_medium = True
        reasons.append("a single game -- the interval jackknifes over your moves, which "
                       "treats them as independent when they share an opponent, an "
                       "opening and a sitting, so the real uncertainty is a little wider")

    unusable = False
    if not result["curved"]:
        unusable = True
        reasons.append("the log-likelihood has no peak to measure -- no rating on the grid "
                       "explains these moves better than its neighbours")
    elif result["span_nats"] < MIN_SPAN_NATS:
        unusable = True
        reasons.append(
            f"the best and worst ratings on the grid explain these moves almost equally "
            f"well ({result['span_nats']:.1f} nats apart over the whole sweep) -- check "
            f"that the engine's Elo option is actually taking effect")

    # The interval is the main evidence, since it is the one quantity that
    # already accounts for how informative these particular positions were.
    if ci_low is not None and ci_high is not None:
        width = ci_high - ci_low
        if width >= WIDE_INTERVAL_FRACTION * span:
            unusable = True
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} spans "
                           f"{width / span:.0%} of the swept range")
        elif width <= TIGHT_INTERVAL_FRACTION * span:
            score += 2
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} is tight")
        elif width <= USABLE_INTERVAL_FRACTION * span:
            score += 1
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f}")
        elif width >= LOOSE_INTERVAL_FRACTION * span:
            score -= 1
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f} is wide -- "
                           f"{width / span:.0%} of the swept range")
        else:
            reasons.append(f"95% interval {ci_low:.0f}-{ci_high:.0f}")

    # The absolute check, which the likelihood gets for free. `best` is how
    # well the model predicted this player at its best setting, in nats per
    # move, against the two fixed reference points: what it manages on a player
    # it has the rating right for, and what guessing among legal moves scores.
    best = float(full_per_move.max())
    if best <= UNPREDICTABLE_LOGP:
        score -= 1
        reasons.append(
            f"at its best setting Maia predicted these moves no better than picking at "
            f"random among legal moves ({best:.2f} against {UNPREDICTABLE_LOGP:.2f} nats "
            f"per move) -- no rating on the grid explains this play, so the number above "
            f"is where the fit landed rather than a strength")
    else:
        reached = ((best - UNPREDICTABLE_LOGP)
                   / (WELL_PREDICTED_LOGP - UNPREDICTABLE_LOGP))
        if reached >= 0.9:
            reasons.append(f"Maia predicted your moves about as well as it predicts anyone "
                           f"({best:.2f} nats per move)")
        else:
            reasons.append(
                f"Maia predicted your moves at {best:.2f} nats per move against the "
                f"{WELL_PREDICTED_LOGP:.2f} it manages on a player whose rating it has "
                f"right -- you play less predictably than the field, so the estimate "
                f"describes a wider spread of moves than usual")

    edged = raw_peak >= elos.max() or raw_peak <= elos.min()
    if edged:
        score -= 1
        side = "above" if raw_peak >= elos.max() else "below"
        reasons.append(f"the likelihood is still climbing at the edge of the swept range, "
                       f"so this player is {side} it -- treat the number as a bound and "
                       f"widen the Elo range")

    confidence = "high" if score >= 3 else "medium" if score >= 1 else "low"
    if (edged or cap_medium) and confidence == "high":
        confidence = "medium"
    if unusable:
        confidence = "low"
    return confidence, reasons
