"""Does the likelihood objective actually make one game usable?

The claim being tested is the one in `docs/prompts/single-game-strength.md`:
that scoring a move by how much probability Maia gave it, instead of by whether
it was Maia's single favourite, turns 20-40 moves from a number-shaped
non-answer into an estimate worth showing.

Run it with `python backend/sims/policy_likelihood.py`. It needs numpy and
scipy and nothing else -- no engine, no database, no Maia binary.

The generative model is deliberately *not* the model the estimator fits
-------------------------------------------------------------------------

`policy_likelihood` scores a rank with a fixed Zipf-shaped mass that does not
depend on the rating. If the simulation drew ranks from that same shape, good
coverage would be arithmetic rather than evidence. So the player here is built
the way the real data is described in `elo_sweep`'s own comments -- a bump on a
baseline -- and the estimator is never told any of its parameters:

    P(rank 1   | r) = base1 + amp1 * exp(-(r - R)^2 / 2w^2)
    P(in top 9 | r) = base9 + amp9 * exp(-(r - R)^2 / 2w^2)

with the ranks between 2 and 9 shared out in fixed proportions. The rating
enters only through how often the played move is Maia's favourite and how often
it is a candidate at all, which is the structure a sweep really has.

Every position points at a slightly different rating
----------------------------------------------------

Two details decide whether this simulation is worth anything.

*The draw is coupled across the grid.* Each position gets a single uniform and
its rank at every rating is read off that rating's rank-CDF with it. A position
whose move is hard for Maia to guess is hard at every setting, which is how
real positions behave -- drawing independently per grid point would invent
information the sweep does not have and would flatter every interval here.

*But each position is centred on its own rating*, `R + d_i` with
`d_i ~ N(0, SPREAD)`, and gets its own width. This is the detail
`sims/accuracy_prior.py` already found to be load-bearing, and without it the
whole exercise is worthless: with a single shared centre, the coupled draw
makes the score matrix an exact function of `|r - R|`, symmetric about the
truth, so every position's likelihood peaks at exactly `R`, the peak is noise-
free, and the sandwich correctly reports a standard error of zero. The move you
played is sometimes more typical of a 1200 and sometimes of an 1800; that
scatter is the entire reason the peak of a finite sample is uncertain, and so
it is the thing the interval has to get right.

What it reports
---------------

Bias and standard deviation over seeds, and interval coverage, for:

  A  one game (30 moves) and a library (400 moves) of the same player, old
     objective against new;
  B  coverage of the stated 95% interval, which is the claim that actually
     matters -- an estimate with a dishonest interval is worse than none;
  C  a beginner nothing predicts, which must come back flagged rather than
     confidently wrong;
  D  sensitivity to the rank-mass constants, which are assumed rather than
     measured, so the estimator has to survive getting them wrong;
  E  the score equation, as an arithmetic check on the fit;
  F  pooling, where the interval has to resample games rather than moves --
     which only matters when games genuinely differ, so they are made to.
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app import elo_sweep, policy_likelihood as pl  # noqa: E402

GRID = list(range(600, 2601, 100))

# Shape of the simulated player. The peak top-1 rate lands at 0.45, which is
# what Maia's published curves show around club level, on a baseline of moves
# that every setting finds.
BASE1, AMP1 = 0.32, 0.13
BASE9, AMP9 = 0.62, 0.20
WIDTH = 350.0
# How far an individual move's own best-explaining rating strays from the
# player's: some of the moves you played are the moves of a 1200 and some of an
# 1800, and that scatter is what makes a finite sample's peak uncertain.
#
# Anchored against the behaviour already on record rather than picked to
# flatter anything. `docs/prompts/single-game-strength.md` reports the old
# estimator returning 715, 1043, 1073, 1259 and 1447 from 25 positions of one
# simulated player -- a spread in the hundreds. At 300 the old estimator scores
# bias -63 / sd 286 over 30 moves here, which is the same regime; at 100 it is
# still 203, so the one-game noise is mostly the top-1 objective itself rather
# than this constant.
SPREAD = 300.0
# How the ranks between 2 and 9 are shared out. Flatter than the estimator's
# assumed Zipf, so the two disagree about what a rank is worth.
TAIL = np.array([0.34, 0.20, 0.13, 0.09, 0.08, 0.07, 0.05, 0.04])


def simulate(true_elo, n_positions, rng, grid=GRID,
             base1=BASE1, amp1=AMP1, base9=BASE9, amp9=AMP9, width=WIDTH,
             spread=SPREAD):
    """(n_positions x n_grid) matrix of ranks, coupled across the grid."""
    grid = np.asarray(grid, dtype=float)[None, :]
    centres = true_elo + rng.normal(0.0, spread, n_positions)[:, None]
    widths = width * np.clip(0.6 + 0.8 * np.abs(rng.normal(size=n_positions)), 0.4, 3.0)[:, None]
    bump = np.exp(-((grid - centres) ** 2) / (2.0 * widths ** 2))
    p1 = base1 + amp1 * bump
    ptop = np.maximum(base9 + amp9 * bump, p1 + 1e-6)

    u = rng.random(n_positions)[:, None]                      # one draw per position
    ranks = np.zeros_like(bump)
    # Rank 1 when the draw falls under the top-1 mass, then ranks 2..9 through
    # the cumulative tail, then "not a candidate".
    ranks[u < p1] = 1.0
    for k, edge in enumerate(np.cumsum(TAIL)):
        hit = (ranks == 0.0) & (u >= p1) & (u < p1 + (ptop - p1) * edge)
        ranks[hit] = k + 2
    return ranks


def flat_player(rate, n_positions, rng, grid=GRID):
    """A player no rating predicts: the same low match rate everywhere."""
    return simulate(1500, n_positions, rng, grid, base1=rate, amp1=0.0,
                    base9=rate * 2.2, amp9=0.0)


def old_estimate(ranks, grid=GRID):
    return elo_sweep.estimate(grid, elo_sweep.hits(ranks, 1))


def new_estimate(ranks, grid=GRID, groups=None, **kwargs):
    return pl.estimate(grid, pl.logp_from_ranks(ranks, **kwargs), groups=groups)


def run(true_elo, n_positions, seeds, estimator, **kwargs):
    out = []
    for seed in range(seeds):
        rng = np.random.default_rng(seed)
        ranks = simulate(true_elo, n_positions, rng)
        result = estimator(ranks, **kwargs)
        out.append(result)
    return out


def summarise(results, true_elo):
    got = np.array([r["estimate"] for r in results if r["estimate"] is not None], dtype=float)
    covered = [r for r in results
               if r.get("ci_low") is not None and r.get("ci_high") is not None]
    hits = sum(1 for r in covered if r["ci_low"] <= true_elo <= r["ci_high"])
    widths = [r["ci_high"] - r["ci_low"] for r in covered]
    low = sum(1 for r in results if r.get("confidence") == "low")
    return {
        "n": len(got),
        "bias": float(np.mean(got) - true_elo) if len(got) else float("nan"),
        "sd": float(np.std(got)) if len(got) else float("nan"),
        "coverage": hits / len(covered) if covered else float("nan"),
        "median_width": float(np.median(widths)) if widths else float("nan"),
        "low_confidence": low / len(results),
    }


def line(label, s):
    print(f"  {label:<26} bias {s['bias']:+7.1f}  sd {s['sd']:6.1f}  "
          f"95% coverage {s['coverage']:5.1%}  median width {s['median_width']:6.0f}  "
          f"low-confidence {s['low_confidence']:4.0%}")


def experiment_a(seeds=300):
    print("\nA. One game vs a library, old objective vs new")
    print("   True rating 1500, grid 600-2600 step 100, %d seeds each." % seeds)
    for n, label in ((30, "one game (30 moves)"), (400, "library (400 moves)")):
        print(f"\n   {label}")
        line("top-1 match (old)", summarise(run(1500, n, seeds, old_estimate), 1500))
        line("likelihood (new)", summarise(run(1500, n, seeds, new_estimate), 1500))


def experiment_b(seeds=300):
    print("\nB. Does the interval cover at its stated rate, across the grid?")
    print("   One game (30 moves). 600 and 2600 are the grid ends, where the")
    print("   estimate is a bound rather than a measurement and says so.")
    for true_elo in (800, 1000, 1200, 1500, 1800, 2000, 2200, 2400):
        line(f"true {true_elo}", summarise(run(true_elo, 30, seeds, new_estimate), true_elo))


def experiment_c(seeds=200):
    print("\nC. A player nothing predicts must be flagged, not guessed at")
    for rate, label in ((0.08, "beginner (8% flat)"), (0.32, "flat at the baseline")):
        flagged = low = 0
        for seed in range(seeds):
            rng = np.random.default_rng(seed)
            result = pl.estimate(GRID, pl.logp_from_ranks(flat_player(rate, 30, rng)))
            low += result["confidence"] == "low"
            flagged += any("random" in r or "equally well" in r or "no peak" in r
                           for r in result["reasons"])
        print(f"   {label:<24} low confidence {low / seeds:5.0%}   "
              f"explicitly flagged {flagged / seeds:5.0%}")


def experiment_d(seeds=200):
    print("\nD. Sensitivity to the assumed rank masses (true rating 1500)")
    for decay in (1.0, 1.5, 2.2):
        for top1 in (0.35, 0.45, 0.55):
            s = summarise(run(1500, 30, seeds, new_estimate, decay=decay,
                              top1_mass=top1), 1500)
            print(f"   decay {decay:>3}  top-1 mass {top1:>4}: ", end="")
            line("", s)


def experiment_e():
    print("\nE. Score equation and clustering")
    rng = np.random.default_rng(0)
    ranks = simulate(1500, 30, rng)
    result = pl.estimate(GRID, pl.logp_from_ranks(ranks))
    print(f"   sum of per-move scores at the peak: {result['score_residual']:.3e} "
          f"(must be ~0)")
    # Ten games of one player: the clustered error must exceed the one that
    # pretends every move is independent.
    ranks = np.vstack([simulate(1500, 30, np.random.default_rng(s)) for s in range(10)])
    groups = np.repeat(np.arange(10), 30)
    clustered = pl.estimate(GRID, pl.logp_from_ranks(ranks), groups=groups)
    print(f"   10 games pooled: jackknife-over-games SE {clustered['se']}, "
          f"curvature-only SE {clustered['se_curvature']}, "
          f"ratio {clustered['se'] / max(clustered['se_curvature'], 1):.2f}")
    print(f"   estimate {clustered['estimate']} "
          f"({clustered['ci_low']}-{clustered['ci_high']}), "
          f"{clustered['confidence']} confidence")


def experiment_f(trials=200, games=12, per_game=30, form=120.0):
    """Pooling: does resampling *games* rather than moves buy an honest interval?

    Clustering only matters when games genuinely differ, so each game here is
    played at its own rating drawn around the player's -- form varies, and the
    opponent and opening are shared within a game and not across. `form` is
    that between-game spread. With it set to zero the two intervals should
    agree; with it realistic, the move-level one should be too narrow and the
    game-level one should still cover.
    """
    print(f"\nF. Pooling {games} games, between-game form spread {form:.0f} Elo")
    for label, spread in (("no form variation", 0.0), (f"form varies by {form:.0f}", form)):
        clustered_hits = move_hits = 0
        clustered_w, move_w, peaks = [], [], []
        for trial in range(trials):
            rng = np.random.default_rng(10_000 + trial)
            centres = 1500 + rng.normal(0.0, spread, games)
            ranks = np.vstack([simulate(centres[g], per_game,
                                        np.random.default_rng(trial * 97 + g))
                               for g in range(games)])
            logp = pl.logp_from_ranks(ranks)
            groups = np.repeat(np.arange(games), per_game)
            with_clusters = pl.estimate(GRID, logp, groups=groups)
            without = pl.estimate(GRID, logp)
            for result, hits, widths in ((with_clusters, "c", clustered_w),
                                         (without, "m", move_w)):
                if result.get("ci_low") is None:
                    continue
                covered = result["ci_low"] <= 1500 <= result["ci_high"]
                widths.append(result["ci_high"] - result["ci_low"])
                if hits == "c":
                    clustered_hits += covered
                else:
                    move_hits += covered
            if with_clusters["estimate"] is not None:
                peaks.append(with_clusters["estimate"])
        print(f"   {label:<22} true spread of the estimate {np.std(peaks):6.1f}")
        print(f"     resampling games: covers {clustered_hits / trials:5.1%}  "
              f"median width {np.median(clustered_w):6.0f}")
        print(f"     resampling moves: covers {move_hits / trials:5.1%}  "
              f"median width {np.median(move_w):6.0f}")


def main():
    np.seterr(all="ignore")
    print(__doc__.split("\n")[0])
    print(f"\nReference points: a well-predicted player scores "
          f"{pl.WELL_PREDICTED_LOGP:.2f} nats per move, "
          f"guessing scores {pl.UNPREDICTABLE_LOGP:.2f}.")
    experiment_a()
    experiment_b()
    experiment_c()
    experiment_d()
    experiment_e()
    experiment_f()


if __name__ == "__main__":
    main()
