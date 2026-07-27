"""What Maia3's published move-matching accuracy is worth to the Elo estimate.

Accuracy is not one number per model. It climbs steeply with the rating of the
player being predicted -- 79M matches barely 48% of a 600-rated player's moves
and 62% of a 2600's -- and the headline figures (62.5% / 61% / ~59%) are the
peaks of those curves, reached only near master level. `app.maia_accuracy`
holds the digitised curves; this script works out what they can and cannot buy.

Run it with `python backend/sims/accuracy_prior.py`. It needs numpy and scipy
and nothing else -- no engine, no database.

The generative model reproduces the structure a real sweep matrix has:
contiguous runs of 1s across the Elo grid, plus all-1 rows (the obvious move
every Elo finds) and all-0 rows (the move no Elo plays).

    position i:
      p_always -> matched at every Elo                       (all-1 row)
      p_never  -> matched at no Elo                          (all-0 row)
      else     -> matched iff |e - theta - d_i| <= r_i
                  d_i ~ N(0, s)       the move you played sits above or below
                                      your own level
                  r_i ~ HalfNormal(w) how wide a band of Elos plays it

`p_always` is a property of the position mix, so it is held fixed; `p_never` is
set per rating to make the ceiling land exactly on the published curve. The
per-position offsets d_i are what make a finite sample's curve asymmetric, so
the peak of the observed curve is a genuinely noisy estimate of theta -- which
is the thing being measured.

Findings, in the order the experiments run:

  A/B  Pinning the bump's height to the curve does NOT improve the point
       estimate. The free 4-parameter fit is already unbiased to a few Elo
       wherever the peak is inside or near the grid, and hard-pinning inflates
       its spread. It only helps when the player is off the grid entirely.
  C    A 5-point error in the assumed accuracy is harmless mid-grid and
       catastrophic at the edge under a hard pin -- which is why the model
       behind an old sweep has to be recovered rather than guessed.
  H    Two effects at once. A weaker *model* costs less than its accuracy gap
       suggests, because only the amplitude above the common baseline
       discriminates. But a weaker *player* costs a great deal: Maia predicts
       everyone worse down there, so the bump is shorter and the peak much
       harder to find. This is the finding a flat accuracy hid completely.
  I    The peak-height shortfall is an excellent off-grid detector, and it must
       be measured against the curve at the fitted rating -- against a flat
       62.5% every player under about 2400 reads as a false positive.
  J    The same statistic separates "the grid does not reach you" from "you
       play less consistently than the population at your rating", by whether
       the fitted peak sits at an edge or mid-grid.
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

try:
    from scipy.optimize import curve_fit
except ImportError:  # pragma: no cover
    raise SystemExit("this simulation needs scipy: pip install scipy")

from app import maia_accuracy  # noqa: E402

WIDE = np.arange(600, 2601, 100, dtype=float)     # the app's default grid
BATCH = np.arange(600, 2601, 200, dtype=float)    # the coarser batch grid
NARROW = np.arange(1100, 1901, 100, dtype=float)  # the pre-migration default
TIGHT = np.arange(1200, 1801, 100, dtype=float)

MODELS = ["3m", "5m", "23m", "79m"]


# --------------------------------------------------------------------- shared

def bump(e, base, amp, centre, width):
    return base + amp * np.exp(-((e - centre) ** 2) / (2.0 * width ** 2))


def binomial_se(rates, n):
    if n <= 0:
        return np.ones_like(rates)
    return np.maximum(np.sqrt(np.clip(rates * (1 - rates), 1e-6, None) / n), 1e-3)


def fit_free(elos, rates, se):
    """The fit elo_sweep.py performs today: four free parameters."""
    span = float(elos.max() - elos.min())
    guess = [float(rates.min()), max(float(rates.max() - rates.min()), 1e-3),
             float(elos[int(np.argmax(rates))]), max(span / 4.0, 100.0)]
    low = [0.0, 0.0, elos.min() - 0.25 * span, 50.0]
    high = [1.0, 1.0, elos.max() + 0.25 * span, 4.0 * span]
    for kwargs in ({"maxfev": 2000}, {"maxfev": 20000, "bounds": (low, high)}):
        try:
            popt, _ = curve_fit(bump, elos, rates, p0=guess, sigma=se,
                                absolute_sigma=True, **kwargs)
        except Exception:
            continue
        v = [float(x) for x in popt]
        if np.isfinite(v).all() and all(lo <= x <= hi for x, lo, hi in zip(v, low, high)):
            return v[2]
    return guess[2]


def fit_anchored(elos, rates, se, peak_rate, sigma_a=None):
    """base + amp pinned to peak_rate. sigma_a=None is a hard pin, a number
    makes it a Gaussian prior of that standard deviation."""
    span = float(elos.max() - elos.min())
    centre0 = float(elos[int(np.argmax(rates))])
    if sigma_a is None:
        def model(e, base, centre, width):
            return bump(e, base, peak_rate - base, centre, width)
        guess = [float(rates.min()), centre0, max(span / 4.0, 100.0)]
        low = [-0.2, elos.min() - 0.5 * span, 50.0]
        high = [1.0, elos.max() + 0.5 * span, 4.0 * span]
        try:
            popt, _ = curve_fit(model, elos, rates, p0=guess, sigma=se,
                                absolute_sigma=True, maxfev=20000)
        except Exception:
            return centre0
        v = [float(x) for x in popt]
        if not np.isfinite(v).all() or not all(lo <= x <= hi for x, lo, hi in zip(v, low, high)):
            return centre0
        return v[1]

    SENT = -1e9   # a pseudo-observation carrying the prior on base + amp
    x = np.concatenate([elos, [SENT]])
    y = np.concatenate([rates, [peak_rate]])
    s = np.concatenate([se, [sigma_a]])

    def model(e, base, amp, centre, width):
        e = np.asarray(e, dtype=float)
        return np.where(e == SENT, base + amp, bump(e, base, amp, centre, width))

    guess = [float(rates.min()), max(float(rates.max() - rates.min()), 1e-3),
             centre0, max(span / 4.0, 100.0)]
    try:
        popt, _ = curve_fit(model, x, y, p0=guess, sigma=s, absolute_sigma=True,
                            maxfev=20000)
    except Exception:
        return centre0
    v = [float(z) for z in popt]
    return v[2] if np.isfinite(v).all() else centre0


def split(m):
    varies = m.max(axis=1) != m.min(axis=1)
    return np.flatnonzero(varies), np.flatnonzero(~varies)


class World:
    """Positions whose ceiling at theta reproduces a real published curve.

    `p_always` -- the share of moves every Elo finds -- is a property of the
    position mix rather than of the model, so it is held fixed across models
    and ratings. Everything else follows from the curve: the share of moves no
    Elo ever plays is whatever makes the match rate at theta come out at
    accuracy_at(model, theta).
    """

    def __init__(self, model="79m", p_always=0.34, s=260.0, w=330.0, seed=7):
        rng = np.random.default_rng(seed)
        n = 400_000
        d, r = rng.normal(0, s, n), np.abs(rng.normal(0, w, n))
        self.model = model
        self.p_always, self.s, self.w = p_always, s, w
        self._at_peak = float(np.mean(np.abs(d) <= r))
        self._far = float(np.mean(np.abs(1000.0 - d) <= r))
        self.curve = maia_accuracy.for_model(model)

    def A(self, theta: float) -> float:
        return float(self.curve.at(theta))

    def _p_mid(self, theta: float) -> float:
        return (self.A(theta) - self.p_always) / self._at_peak

    def amplitude(self, theta: float) -> float:
        """Height of the bump above the flat baseline -- the part that actually
        tells one Elo setting from another."""
        return self.A(theta) - (self.p_always + self._p_mid(theta) * self._far)

    def sample(self, theta, n_positions, grid, rng):
        p_mid = self._p_mid(theta)
        u = rng.random(n_positions)
        m = np.zeros((n_positions, len(grid)))
        m[u < self.p_always] = 1.0
        mid = (u >= self.p_always) & (u < self.p_always + p_mid)
        k = int(mid.sum())
        d = rng.normal(0, self.s, k)
        r = np.abs(rng.normal(0, self.w, k))
        m[mid] = (np.abs(grid[None, :] - theta - d[:, None]) <= r[:, None]).astype(float)
        return m


def curve_of(m, grid):
    """(discriminative rates, n_disc, full-set match rate per grid point).

    The last one is an identity, not a model: all-1 rows contribute 1 at every
    Elo and all-0 rows contribute 0, so
        rate_full(e) = (n_all1 + sum of discriminative hits) / n_total
    which is what lets the published accuracy -- defined over all positions --
    be compared against a fit done on the discriminative subset alone.
    """
    disc, uninf = split(m)
    keep = disc if disc.size else np.arange(m.shape[0])
    fm = m[keep]
    if fm.shape[0] == 0:
        return None, 0, None
    n_all1 = int(m[uninf].max(axis=1).sum()) if uninf.size else 0
    return fm.mean(axis=0), fm.shape[0], (n_all1 + fm.sum(axis=0)) / m.shape[0]


# ------------------------------------------------------- A/B/C: does pinning help?

def compare(label, world, theta, n_positions, grid=WIDE, A_assumed=None,
            reps=400, seed=0, soft_pp=0.02):
    A_assumed = world.A(theta) if A_assumed is None else A_assumed
    rng = np.random.default_rng(seed)
    lo, hi = grid.min() - 400, grid.max() + 400
    out, nfits = [], []
    for _ in range(reps):
        m = world.sample(theta, n_positions, grid, rng)
        rates, n_fit, full = curve_of(m, grid)
        if rates is None:
            continue
        se = binomial_se(rates, n_fit)
        n_all1 = round(float(full[0] * m.shape[0] - rates[0] * n_fit))
        peak = float(np.clip((A_assumed * m.shape[0] - n_all1) / n_fit, 0.05, 1.0))
        sigma_a = max(soft_pp * m.shape[0] / n_fit, 1e-3)
        out.append([float(np.clip(v, lo, hi)) for v in (
            fit_free(grid, rates, se),
            fit_anchored(grid, rates, se, peak),
            fit_anchored(grid, rates, se, peak, sigma_a=sigma_a))])
        nfits.append(n_fit)
    a = np.asarray(out)
    print(f"\n  {label}  theta={theta}  grid {int(grid[0])}-{int(grid[-1])}"
          f"/{int(grid[1] - grid[0])}  {n_positions} pos (~{np.mean(nfits):.0f} disc)")
    print(f"    {'fit':<8} {'bias':>7} {'sd':>7} {'RMSE':>7} {'<100':>7} {'<200':>7}")
    for i, name in enumerate(("free", "hard", "soft")):
        err = a[:, i] - theta
        print(f"    {name:<8} {err.mean():>7.0f} {err.std():>7.0f} "
              f"{np.sqrt((err ** 2).mean()):>7.0f} "
              f"{np.mean(np.abs(err) < 100):>6.0%} {np.mean(np.abs(err) < 200):>6.0%}")


# -------------------------------------------- H: information per model and rating

def spread(world, theta, n_positions, grid=WIDE, reps=600, seed=0):
    rng = np.random.default_rng(seed)
    est = []
    for _ in range(reps):
        rates, n_fit, _ = curve_of(world.sample(theta, n_positions, grid, rng), grid)
        if rates is None:
            continue
        est.append(fit_free(grid, rates, binomial_se(rates, n_fit)))
    e = np.asarray(est) - theta
    return float(e.std()), float(np.sqrt((e ** 2).mean()))


# ------------------------------------ I/J: the peak-height shortfall statistic

def shortfall(world, sampler, grid=WIDE, reps=400, seed=3):
    """(peak match rate / the curve at the fitted rating, fitted centre)."""
    rng = np.random.default_rng(seed)
    ratios, centres = [], []
    for _ in range(reps):
        m = sampler(rng)
        rates, n_fit, full = curve_of(m, grid)
        if rates is None:
            continue
        centre = float(np.clip(fit_free(grid, rates, binomial_se(rates, n_fit)),
                               grid.min(), grid.max()))
        ratios.append(float(full.max()) / world.A(centre))
        centres.append(centre)
    return np.asarray(ratios), np.asarray(centres)


def mixed(world, thetas, weights, n_positions, grid, rng):
    """One inconsistent player: positions drawn from several strengths."""
    counts = rng.multinomial(n_positions, weights)
    return np.vstack([world.sample(t, int(c), grid, rng)
                      for t, c in zip(thetas, counts) if c])


# ------------------------------------------------------------------------ main

def main():
    w79 = World("79m")
    print("maia3-79m: " + "  ".join(
        f"{r}:{w79.A(r):.1%}" for r in (600, 1000, 1500, 2000, 2600)))

    print("\n" + "=" * 78)
    print("A) pinning the peak height, peak inside the grid")
    for lbl, n in (("100 games", 2500), ("25 games", 620), ("1 game", 25)):
        compare(lbl, w79, 1500, n)

    print("\n" + "=" * 78)
    print("B) narrow, tight and coarse grids -- where a free fit is least")
    print("   determined and pinning should help most")
    compare("25 games", w79, 1500, 620, grid=NARROW)
    compare("25 games", w79, 1650, 620, grid=TIGHT)
    compare("100 games", w79, 1650, 2500, grid=TIGHT)
    compare("25 games", w79, 2450, 620, grid=BATCH)

    print("\n" + "=" * 78)
    print("B2) peak outside the grid -- the one case pinning does help")
    for th in (2700, 2900):
        compare("100 games", w79, th, 2500)

    print("\n" + "=" * 78)
    print("C) a 5-point error in the assumed accuracy (wrong model size")
    print("   recovered for an old sweep)")
    compare("25 games, +5pts", w79, 1500, 620, A_assumed=w79.A(1500) + 0.05)
    compare("25 games at the edge, +5pts", w79, 2400, 620, A_assumed=w79.A(2400) + 0.05)

    print("\n" + "=" * 78)
    print("H) signal by model size AND by player rating")
    print("\n  bump amplitude above the baseline (what locates the peak):")
    print(f"    {'rating':>7} " + "".join(f"{'maia3-' + m:>12}" for m in MODELS))
    worlds = {m: World(m) for m in MODELS}
    for r in (800, 1200, 1600, 2000, 2400):
        print(f"    {r:>7} " + "".join(f"{worlds[m].amplitude(r):>11.1%} " for m in MODELS))

    print("\n  sd of the estimate, 25 games (620 positions):")
    print(f"    {'rating':>7} " + "".join(f"{'maia3-' + m:>12}" for m in MODELS))
    sds = {}
    for r in (800, 1200, 1600, 2000, 2400):
        row = {}
        for m in MODELS:
            row[m] = spread(worlds[m], r, 620)[0]
        sds[r] = row
        print(f"    {r:>7} " + "".join(f"{row[m]:>9.0f} E " for m in MODELS))

    # Referenced to the best case rather than to an endpoint: 800 and 2400 are
    # both degraded, and for different reasons -- one by a short bump, the
    # other by crowding the top of the grid -- so neither is a fair baseline.
    best = min(sds, key=lambda r: sds[r]["79m"])
    print(f"\n  positions needed for the same interval, against the best case"
          f" ({best} on 79m):")
    for r in (800, 1200, 1600, 2000, 2400):
        rel_model = (sds[r]["3m"] / sds[r]["79m"]) ** 2
        rel_rating = (sds[r]["79m"] / sds[best]["79m"]) ** 2
        print(f"    at {r:>4}: x{rel_rating:.2f} for the rating; "
              f"x{rel_model:.2f} for using 3m instead of 79m")
    print("\n  Model size barely registers. Rating dominates -- and not")
    print("  monotonically: 800 suffers a short bump (15% amplitude against")
    print("  26% at 2400) and 2400 suffers from crowding the grid's top end.")

    print("\n" + "=" * 78)
    print("I) peak-height shortfall as an off-grid detector, scored against")
    print("   the curve at the fitted rating\n")
    print(f"  {'true theta':>11}   {'25 games':^24}   {'100 games':^24}")
    print(f"  {'':>11}   {'median   5th   flagged<0.90':^24}"
          f"   {'median   5th   flagged<0.90':^24}")
    for theta in (800, 1200, 1600, 2000, 2400, 2600, 2800, 3000):
        line = f"  {theta:>11}"
        for n in (620, 2500):
            v, _ = shortfall(w79, lambda r, t=theta, k=n: w79.sample(t, k, WIDE, r))
            line += (f"   {np.median(v):>6.2f} {np.percentile(v, 5):>6.2f} "
                     f"{np.mean(v < 0.90):>10.0%}")
        print(line)
    print("\n  theta <= 2600 is inside the grid; 2800+ is off the top.")

    print("\n" + "=" * 78)
    print("I2) the same statistic scored against a FLAT 62.5% -- what a single")
    print("    headline accuracy would have done\n")
    print(f"  {'true theta':>11}  {'median ratio':>13}  {'flagged<0.90':>13}")
    for theta in (800, 1200, 1600, 2000, 2400, 2600):
        v, _ = shortfall(w79, lambda r, t=theta: w79.sample(t, 2500, WIDE, r))
        flat = v * np.array([w79.A(theta)]) / 0.625
        print(f"  {theta:>11}  {np.median(flat):>13.2f}  {np.mean(flat < 0.90):>12.0%}")
    print("\n  Every rating below master level would have been called a")
    print("  failed sweep. This is why the curve is not a constant.")

    print("\n" + "=" * 78)
    print("J) telling the two causes of a shortfall apart (100 games, 79m)\n")
    print(f"  {'player':<45} {'peak/A':>7} {'centre':>7} {'at edge':>8}")
    print(f"  {'-' * 45} {'-' * 7} {'-' * 7} {'-' * 8}")
    cases = [
        ("consistent 1500", lambda r: w79.sample(1500, 2500, WIDE, r)),
        ("consistent 2600 (exactly at the grid edge)",
         lambda r: w79.sample(2600, 2500, WIDE, r)),
        ("consistent 3000 (off the grid)", lambda r: w79.sample(3000, 2500, WIDE, r)),
        ("mixed 1300/1700, half each",
         lambda r: mixed(w79, [1300, 1700], [.5, .5], 2500, WIDE, r)),
        ("mixed 1100/1900, half each",
         lambda r: mixed(w79, [1100, 1900], [.5, .5], 2500, WIDE, r)),
        ("mixed 800/2200, half each",
         lambda r: mixed(w79, [800, 2200], [.5, .5], 2500, WIDE, r)),
        ("1500 mostly, 20% blitzed-out moves at 700",
         lambda r: mixed(w79, [1500, 700], [.8, .2], 2500, WIDE, r)),
        ("1500 mostly, 20% engine-quality moves at 2600",
         lambda r: mixed(w79, [1500, 2600], [.8, .2], 2500, WIDE, r)),
    ]
    edge = 0.02 * (WIDE.max() - WIDE.min())
    for label, sampler in cases:
        ratios, centres = shortfall(w79, sampler, seed=11)
        at_edge = (centres <= WIDE.min() + edge) | (centres >= WIDE.max() - edge)
        print(f"  {label:<45} {np.median(ratios):>7.2f} "
              f"{np.median(centres):>7.0f} {np.mean(at_edge):>7.0%}")
    print("\n  A shortfall with the centre mid-grid is inconsistency; a shortfall")
    print("  with the centre pinned to an edge is a grid that does not reach")
    print("  the player. A full-height peak at an edge is a real player there.")


if __name__ == "__main__":
    main()
