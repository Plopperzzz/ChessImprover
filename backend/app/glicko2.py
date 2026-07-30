"""Glicko-2, the rating system Lichess rates puzzles with.

Why this and not plain Elo: a puzzle rating has to mean something after five
attempts *and* after five thousand, and Elo has no way to say which of those
it is. Glicko-2 carries a deviation alongside the rating -- how unsure the
number is -- and moves an uncertain rating further per result than a settled
one. That is the whole reason a new solver converges in a couple of dozen
puzzles instead of a couple of hundred, and it is what makes rating a puzzle
whose difficulty is *estimated* (see `puzzles.own_puzzle_rating`) honest
rather than fictional: a coarse estimate is handed in with a large deviation
and correctly moves the solver's rating less.

The implementation is Glickman's paper (glicko2.pdf) step for step, with one
game per rating period, which is how an interactive puzzle trainer works --
you want the number to move when you finish the puzzle, not at the end of the
week. Rating periods are otherwise the system's one awkward fit here, and
per-result updates are what Lichess does too.

Constants match Lichess's puzzle configuration: 1500/350/0.06 to start, and
tau 0.75. Tau bounds how fast the volatility itself may move; low values keep
a rating from lurching after one surprising result, and 0.75 is the value
Lichess settled on for puzzles.
"""

import math
from dataclasses import dataclass

# Glickman's scale factor between the human-readable 1500-ish scale and the
# internal one the maths is done on.
SCALE = 173.7178

DEFAULT_RATING = 1500.0
DEFAULT_RD = 350.0
DEFAULT_VOL = 0.06

# Bounds the change in volatility. Smaller = a rating that trusts its own
# history more and reacts to an upset less.
TAU = 0.75

# A deviation is never allowed to reach zero -- a rating that claims perfect
# certainty stops responding to results forever, including to real
# improvement. The ceiling is the "we have no idea" value a fresh solver
# starts at, and a long absence decays back toward it rather than past it.
MIN_RD = 45.0
MAX_RD = 350.0

# Convergence of the volatility iteration (Glickman step 5). 1e-6 is the
# paper's own suggestion; the loop cap is belt and braces against a pathological
# input keeping the request open.
CONVERGENCE = 1e-6
MAX_ITERATIONS = 100


@dataclass
class Rating:
    """A rating and how much to trust it."""

    rating: float = DEFAULT_RATING
    rd: float = DEFAULT_RD
    vol: float = DEFAULT_VOL

    @property
    def provisional(self) -> bool:
        """Whether this is still settling. Shown rather than hidden: a 1500
        that has seen two puzzles and a 1500 that has seen two hundred are
        different claims, and a trainer that presents them identically is
        lying by omission."""
        return self.rd > 110.0

    def interval(self, z: float = 1.96) -> tuple[float, float]:
        """The range the true rating is probably in. This, not the point
        estimate, is the honest answer to "what am I rated"."""
        return (self.rating - z * self.rd, self.rating + z * self.rd)


def _g(phi: float) -> float:
    return 1.0 / math.sqrt(1.0 + 3.0 * phi * phi / (math.pi * math.pi))


def _expected(mu: float, mu_j: float, phi_j: float) -> float:
    return 1.0 / (1.0 + math.exp(-_g(phi_j) * (mu - mu_j)))


def _new_volatility(phi: float, sigma: float, v: float, delta: float) -> float:
    """Glickman step 5: the Illinois variant of regula falsi on f(x).

    This is the part of Glicko-2 that people skip and approximate. It is worth
    doing properly -- it is what stops a single upset from inflating the
    deviation permanently, which is the failure mode that makes an
    approximated implementation drift.
    """
    a = math.log(sigma * sigma)
    delta_sq = delta * delta
    phi_sq = phi * phi

    def f(x: float) -> float:
        ex = math.exp(x)
        numerator = ex * (delta_sq - phi_sq - v - ex)
        denominator = 2.0 * (phi_sq + v + ex) ** 2
        return numerator / denominator - (x - a) / (TAU * TAU)

    big_a = a
    if delta_sq > phi_sq + v:
        big_b = math.log(delta_sq - phi_sq - v)
    else:
        k = 1
        while f(a - k * TAU) < 0 and k <= MAX_ITERATIONS:
            k += 1
        big_b = a - k * TAU

    f_a, f_b = f(big_a), f(big_b)
    for _ in range(MAX_ITERATIONS):
        if abs(big_b - big_a) <= CONVERGENCE:
            break
        big_c = big_a + (big_a - big_b) * f_a / (f_b - f_a)
        f_c = f(big_c)
        if f_c * f_b <= 0:
            big_a, f_a = big_b, f_b
        else:
            # Illinois: halving the retained endpoint's value is what stops
            # one side sticking and the iteration crawling.
            f_a = f_a / 2.0
        big_b, f_b = big_c, f_c

    return math.exp(big_a / 2.0)


def update(player: Rating, opponent: Rating, score: float) -> Rating:
    """One result against one opponent. `score` is 1 solved, 0 failed.

    For puzzles the "opponent" is the puzzle: its rating is its difficulty and
    its deviation is how well that difficulty is known. A puzzle imported from
    Lichess carries a deviation measured over its real play history; one whose
    difficulty this app estimated carries a deliberately large one, so it
    nudges the solver rather than shoving them.
    """
    mu = (player.rating - DEFAULT_RATING) / SCALE
    phi = player.rd / SCALE
    mu_j = (opponent.rating - DEFAULT_RATING) / SCALE
    phi_j = opponent.rd / SCALE

    g_j = _g(phi_j)
    expected = _expected(mu, mu_j, phi_j)

    # Estimated variance of the rating from this result alone, and the change
    # the result alone suggests.
    v = 1.0 / (g_j * g_j * expected * (1.0 - expected))
    delta = v * g_j * (score - expected)

    sigma_prime = _new_volatility(phi, player.vol, v, delta)
    phi_star = math.sqrt(phi * phi + sigma_prime * sigma_prime)
    phi_prime = 1.0 / math.sqrt(1.0 / (phi_star * phi_star) + 1.0 / v)
    mu_prime = mu + phi_prime * phi_prime * g_j * (score - expected)

    return Rating(
        rating=mu_prime * SCALE + DEFAULT_RATING,
        rd=min(MAX_RD, max(MIN_RD, phi_prime * SCALE)),
        vol=sigma_prime,
    )


def expected_score(player: Rating, opponent: Rating) -> float:
    """The chance this solver gets this puzzle. Used to pick puzzles that are
    actually worth attempting -- one you'd solve 95% of the time teaches
    nothing and moves the rating by nothing."""
    mu = (player.rating - DEFAULT_RATING) / SCALE
    mu_j = (opponent.rating - DEFAULT_RATING) / SCALE
    return _expected(mu, mu_j, opponent.rd / SCALE)


def decay(player: Rating, periods: float) -> Rating:
    """Widens the deviation for time not spent solving.

    Without this, someone who stops for six months comes back to a rating the
    system is still fully confident in, and their first few results barely
    move it. Glickman's step 6 with no games played is exactly this, and it is
    capped at the starting deviation so a lapsed account converges from
    "unknown" rather than from something worse than unknown.
    """
    if periods <= 0:
        return player
    phi = player.rd / SCALE
    phi_star = math.sqrt(phi * phi + periods * player.vol * player.vol)
    return Rating(
        rating=player.rating,
        rd=min(MAX_RD, max(MIN_RD, phi_star * SCALE)),
        vol=player.vol,
    )
