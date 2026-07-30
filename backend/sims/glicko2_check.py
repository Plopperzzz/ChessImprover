"""Checking `app/glicko2.py` against Glickman's own worked example.

A rating system is the kind of code that is quietly wrong for months: every
number it produces looks plausible, and nothing crashes when the volatility
solver converges to the wrong root. Glickman publishes a worked example with
intermediate values (glicko2.pdf, "Example calculation"), so the arithmetic
can be checked against the source rather than against itself.

Run it with `python backend/sims/glicko2_check.py`.

The paper's example is one rating period containing three games, which is not
how the app uses the system -- a puzzle trainer rates one result at a time.
So this checks the two things separately:

* the *pieces* (g, E, v, delta, and the volatility iteration) against the
  paper's printed intermediates, driving them with the paper's three-game
  period;
* the single-game `update` the app actually calls, against the properties
  that have to hold for the rating to mean anything -- an uncertain rating
  moves more than a settled one, beating a stronger puzzle is worth more than
  beating a weaker one, and solving never lowers the rating.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app import glicko2  # noqa: E402
from app.glicko2 import SCALE, Rating, _expected, _g, expected_score, update  # noqa: E402

failures = []


def check(label: str, got: float, want: float, tol: float):
    ok = abs(got - want) <= tol
    if not ok:
        failures.append(f"{label}: got {got:.6f}, want {want:.6f} (+-{tol})")
    print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got:.6f} (paper {want:.6f})")


def paper_example():
    """Glickman's example: 1500/200 plays 1400/30 (win), 1550/100 (loss),
    1700/300 (loss). Tau is 0.5 in the paper, not the 0.75 this app runs."""
    print("Glickman's worked example (tau = 0.5):")
    original_tau = glicko2.TAU
    glicko2.TAU = 0.5
    try:
        mu = (1500.0 - 1500.0) / SCALE
        phi = 200.0 / SCALE
        sigma = 0.06

        opponents = [(1400.0, 30.0, 1.0), (1550.0, 100.0, 0.0), (1700.0, 300.0, 0.0)]
        # The paper prints g and E per opponent to 4dp; these are the values it
        # lists in the table under step 3.
        want_g = [0.9955, 0.9531, 0.7242]
        want_e = [0.639, 0.432, 0.303]

        v_inv = 0.0
        delta_sum = 0.0
        for i, (r_j, rd_j, score) in enumerate(opponents):
            mu_j = (r_j - 1500.0) / SCALE
            phi_j = rd_j / SCALE
            g_j = _g(phi_j)
            e_j = _expected(mu, mu_j, phi_j)
            check(f"g(phi_{i + 1})", g_j, want_g[i], 5e-5)
            check(f"E_{i + 1}", e_j, want_e[i], 5e-4)
            v_inv += g_j * g_j * e_j * (1.0 - e_j)
            delta_sum += g_j * (score - e_j)

        v = 1.0 / v_inv
        delta = v * delta_sum
        check("v", v, 1.7785, 5e-4)
        # Looser than the rest on purpose. The paper computes delta from the
        # 4dp g and E values it printed, not from full precision: feeding its
        # rounded table back in reproduces -0.4834 exactly, while the
        # unrounded sum is -0.48393. The tolerance covers that rounding, and
        # the rating and RD below are checked to 0.02 regardless.
        check("delta", delta, -0.4834, 1e-3)

        sigma_prime = glicko2._new_volatility(phi, sigma, v, delta)
        check("sigma'", sigma_prime, 0.05999, 5e-5)

        phi_star = math.sqrt(phi * phi + sigma_prime * sigma_prime)
        phi_prime = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
        mu_prime = mu + phi_prime * phi_prime * delta_sum

        check("new rating", mu_prime * SCALE + 1500.0, 1464.06, 0.02)
        check("new RD", phi_prime * SCALE, 151.52, 0.02)
    finally:
        glicko2.TAU = original_tau


def single_game_properties():
    """The path the app actually takes: one puzzle, one result."""
    print("\nSingle-result behaviour (tau = %.2f, as shipped):" % glicko2.TAU)
    puzzle = Rating(1500, 75, 0.06)

    fresh = Rating(1500, 350, 0.06)
    settled = Rating(1500, 50, 0.06)
    fresh_gain = update(fresh, puzzle, 1.0).rating - fresh.rating
    settled_gain = update(settled, puzzle, 1.0).rating - settled.rating
    ok = fresh_gain > settled_gain * 3
    print(f"  {'ok  ' if ok else 'FAIL'} an unsure rating moves further: "
          f"+{fresh_gain:.1f} (RD 350) vs +{settled_gain:.1f} (RD 50)")
    if not ok:
        failures.append("an unsure rating should move much further than a settled one")

    player = Rating(1500, 80, 0.06)
    easy_gain = update(player, Rating(1000, 75, 0.06), 1.0).rating - player.rating
    hard_gain = update(player, Rating(2000, 75, 0.06), 1.0).rating - player.rating
    ok = hard_gain > easy_gain > 0
    print(f"  {'ok  ' if ok else 'FAIL'} a harder puzzle is worth more: "
          f"+{hard_gain:.1f} (2000) vs +{easy_gain:.1f} (1000)")
    if not ok:
        failures.append("beating a harder puzzle should gain more than an easier one")

    ok = update(player, Rating(1000, 75, 0.06), 0.0).rating < player.rating
    print(f"  {'ok  ' if ok else 'FAIL'} failing an easy puzzle costs rating")
    if not ok:
        failures.append("failing should lower the rating")

    # The deviation must shrink as results come in, or the rating never settles
    # and every puzzle keeps swinging it.
    r = Rating(1500, 350, 0.06)
    for _ in range(30):
        r = update(r, Rating(1500, 75, 0.06), 1.0 if r.rating < 1600 else 0.0)
    ok = glicko2.MIN_RD <= r.rd < 120
    print(f"  {'ok  ' if ok else 'FAIL'} RD settles after 30 results: {r.rd:.1f}")
    if not ok:
        failures.append(f"RD should settle well below 120 after 30 results, got {r.rd:.1f}")

    # ...but never to zero, or the rating stops responding to real improvement.
    for _ in range(500):
        r = update(r, Rating(1500, 75, 0.06), 1.0 if r.rating < 1600 else 0.0)
    ok = r.rd >= glicko2.MIN_RD
    print(f"  {'ok  ' if ok else 'FAIL'} RD floors at {glicko2.MIN_RD}: {r.rd:.1f}")
    if not ok:
        failures.append("RD should never fall below MIN_RD")

    ok = abs(expected_score(Rating(1500, 50), Rating(1500, 50)) - 0.5) < 1e-9
    print(f"  {'ok  ' if ok else 'FAIL'} an equal puzzle is a coin flip")
    if not ok:
        failures.append("expected_score should be 0.5 against an equal opponent")

    # A coarse difficulty estimate must move the rating less than a measured
    # one -- this is what makes rating own-game puzzles defensible at all.
    measured = update(player, Rating(1900, 60, 0.06), 1.0).rating - player.rating
    guessed = update(player, Rating(1900, 250, 0.06), 1.0).rating - player.rating
    ok = guessed < measured
    print(f"  {'ok  ' if ok else 'FAIL'} a vaguer puzzle rating moves less: "
          f"+{guessed:.1f} (RD 250) vs +{measured:.1f} (RD 60)")
    if not ok:
        failures.append("a puzzle with a larger RD should move the solver's rating less")


def decay_behaviour():
    print("\nIdleness:")
    settled = Rating(1500, 60, 0.06)
    lapsed = glicko2.decay(settled, 40)
    ok = lapsed.rd > settled.rd and lapsed.rating == settled.rating
    print(f"  {'ok  ' if ok else 'FAIL'} time away widens RD but not the rating: "
          f"{settled.rd:.1f} -> {lapsed.rd:.1f}")
    if not ok:
        failures.append("decay should widen RD and leave the rating alone")

    ok = glicko2.decay(Rating(1500, 340, 0.06), 10_000).rd <= glicko2.MAX_RD
    print(f"  {'ok  ' if ok else 'FAIL'} RD is capped at {glicko2.MAX_RD}")
    if not ok:
        failures.append("decay should not push RD past MAX_RD")


if __name__ == "__main__":
    paper_example()
    single_game_properties()
    decay_behaviour()
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for line in failures:
            print("  - " + line)
        sys.exit(1)
    print("all checks passed")
