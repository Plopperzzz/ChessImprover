"""How hard a puzzle from your own games is, measured with Maia.

The problem this solves
-----------------------

A Lichess puzzle carries a difficulty measured against millions of real
solvers. A puzzle built from your own blunders carries nothing, and until now
it borrowed one: `puzzles.own_puzzle_rating` looks up the average rating of
imported Lichess puzzles sharing its themes. That is a reasonable guess and it
has two problems. It needs the Lichess database imported to work at all, and it
cannot tell a hard fork from an easy one -- every `fork middlegame crushing`
puzzle in your library gets the same number.

Maia can answer the actual question. Maia3 at Elo E plays like a human rated E,
so "how hard is this to find" becomes "how strong do you have to be before you
find it", which is a measurement rather than a lookup -- and it is the *same*
construct a Lichess puzzle rating is. A Lichess puzzle rated 1500 is one a
1500-rated solver gets right about half the time; that is a Glicko rating from
solver results, and Glicko's 50% point is what this estimates directly. The two
numbers therefore live on the same scale by construction, which is what lets
one Glicko-2 rating span both sources (`app/puzzle_ratings.py`).

How
---

For each Elo on the sweep's grid, Maia is asked for its move ordering at every
position in the puzzle's line where it is *your* turn. The probability it plays
the whole line is the product of the per-move probabilities -- a two-move
puzzle is only solved if both moves are found -- taken from the engine's own
policy when the build reports one, and from the rank surrogate in
`app/policy_likelihood.py` when it doesn't. That is the same fallback the Elo
sweep uses, so a build without policy output degrades identically in both
places rather than in two different ways.

That gives P(solve) against Elo: low at the bottom of the grid, higher at the
top. A logistic is fitted through it and the Elo where it crosses one half is
the difficulty.

What this deliberately does not claim
-------------------------------------

**Maia plays; solvers solve.** Maia's policy is a move it would play in a game,
at a glance. Someone working on a puzzle knows there is something to find and
takes as long as they like, so they will beat their own game rating at it --
which means this estimator is expected to read *low* against a published
Lichess rating by some fixed amount. `SOLVER_OFFSET` is that correction and it
is 0 until it has been measured rather than guessed: `raw` Maia Elo is stored
separately from the rating handed to the rater precisely so that measuring it
later is a re-derivation and not a re-run of the engine. `backend/sims/
puzzle_difficulty_check.py` measures it, against imported Lichess puzzles whose
real ratings are known, which is the only honest way to fix it.

**A wide interval is the usual answer.** One puzzle is a handful of positions
at a dozen grid points, and the deviation this returns says so. Glicko-2 reads
it as "don't move the solver's rating much on the strength of this", which for
a number derived this way is correct.
"""

import numpy as np

from . import policy_likelihood

# Where the fitted curve can land. Outside this the measurement is an
# extrapolation off the end of the grid rather than a crossing that was seen,
# and it is clamped and told to be unsure (see `_deviation`).
MIN_ELO = 400
MAX_ELO = 3000

# The correction from "Elo at which Maia plays this move" to "Elo of a solver
# who gets this puzzle right half the time". Zero until measured -- see the
# module docstring. Stored separately from `maia_elo` so it can change without
# re-running anything.
SOLVER_OFFSET = 0

# How sure the estimate is allowed to get. The floor is not modesty: a single
# puzzle measured at a dozen grid points cannot pin a difficulty to 50 points
# however clean the crossing looks, and letting it claim so would move a
# solver's rating further on one home-grown puzzle than on a real Lichess one.
MIN_RD = 120.0
MAX_RD = 400.0

# What a crossing that was never actually seen costs, in deviation. A curve
# that is still below one half at the top of the grid says "harder than
# anything measured", which is information -- but not a number.
OFF_GRID_RD = MAX_RD

# How much the curve has to actually rise across the whole grid before a
# crossing drawn through it means anything, in log-odds. One nat is a move
# going from about 27% to about 50% between the bottom of the grid and the
# top -- a small change, and still a change. Below it the line is flat and
# the crossing is wherever the noise put it.
MIN_LOGIT_RISE = 1.0

# Probabilities are clipped before the logit so a position Maia never ranks
# (p = 0) doesn't take the whole product to negative infinity and with it the
# fit.
P_FLOOR = 1e-4
P_CEIL = 1.0 - 1e-4


def move_probability(uci: str, ranked: list[str], policies: dict[str, float]) -> float:
    """Maia's probability of playing `uci`, at whatever Elo it is set to.

    The engine's own policy when it reports one; otherwise the typical mass
    for the rank it gave the move, which is what `policy_likelihood` measures
    the Elo sweep with. A move Maia did not rank at all gets the leftover mass
    for an unlisted move rather than zero -- people play unranked moves, and
    zero would make the product of a two-move line unrecoverable.
    """
    if uci in policies:
        return float(np.clip(policies[uci], P_FLOOR, P_CEIL))
    table = policy_likelihood.rank_probabilities()
    rank = 0
    for index, move in enumerate(ranked[:policy_likelihood.MAX_RANK], start=1):
        if move == uci:
            rank = index
            break
    return float(np.clip(table[rank], P_FLOOR, P_CEIL))


def solve_probabilities(per_elo: dict[int, list[float]]) -> dict[int, float]:
    """{elo: [p per position]} -> {elo: p(whole line)}.

    A line is solved only if every move of it is found, so the moves multiply.
    This is the step that makes a three-move puzzle properly harder than its
    first move alone, which is the whole reason the line is stored.
    """
    return {
        elo: float(np.clip(np.prod(np.asarray(ps, dtype=float)), P_FLOOR, P_CEIL))
        for elo, ps in per_elo.items() if ps
    }


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, P_FLOOR, P_CEIL)
    return np.log(p / (1.0 - p))


def fit(probabilities: dict[int, float]) -> dict:
    """Fit P(solve) against Elo and return where it crosses one half.

    A straight line through the logit, which is a logistic in probability. Two
    grid points is enough to draw one and nowhere near enough to believe it,
    so the deviation carries the residual spread and the fit is refused
    outright when the curve does not rise -- a Maia that is no more likely to
    find the move at 2600 than at 800 has measured nothing about difficulty,
    and inventing a crossing from that would be worse than declining to.
    """
    if len(probabilities) < 3:
        return {"elo": None, "rd": None, "reason": "not enough grid points"}

    elos = np.array(sorted(probabilities), dtype=float)
    y = _logit(np.array([probabilities[int(e)] for e in elos]))

    slope, intercept = np.polyfit(elos, y, 1)
    span = float(elos[-1] - elos[0])
    if slope <= 0:
        return {"elo": None, "rd": None,
                "reason": "Maia is no more likely to find it when it is stronger"}
    if slope * span < MIN_LOGIT_RISE:
        # Flat. Two thousand Elo of extra strength changed nothing about
        # whether the move gets played, so the position has not told us how
        # hard it is -- and a crossing extrapolated off a flat line is an
        # arbitrary number with a confident-looking curve behind it.
        return {"elo": None, "rd": None,
                "reason": "how likely Maia is to find it barely changes with strength"}

    crossing = float(-intercept / slope)

    # Standard error of the crossing, by the delta method on a straight-line
    # fit. Residual spread divided by the slope: a curve that rises steeply
    # and cleanly pins the crossing, a shallow or scattered one does not.
    predicted = slope * elos + intercept
    dof = max(len(elos) - 2, 1)
    residual = float(np.sqrt(np.sum((y - predicted) ** 2) / dof))
    spread = float(np.sqrt(np.sum((elos - elos.mean()) ** 2)))
    se = (residual / slope) * np.sqrt(1.0 / len(elos) + ((crossing - elos.mean()) ** 2)
                                      / (spread ** 2)) if spread > 0 else MAX_RD

    off_grid = crossing < elos[0] or crossing > elos[-1]
    rd = OFF_GRID_RD if off_grid else float(np.clip(se, MIN_RD, MAX_RD))
    return {
        "elo": float(np.clip(crossing, MIN_ELO, MAX_ELO)),
        "rd": rd,
        "off_grid": off_grid,
        "reason": "crossing is off the end of the grid" if off_grid else None,
    }


def to_rating(maia_elo: float | None) -> int | None:
    """The Maia measurement as a puzzle rating for the Glicko-2 rater."""
    if maia_elo is None:
        return None
    return int(round(float(np.clip(maia_elo + SOLVER_OFFSET, MIN_ELO, MAX_ELO))))


# ---------------------------------------------------------------------------
# Driving the engine
# ---------------------------------------------------------------------------

# The grid is the account's sweep grid, coarsened. The sweep walks a whole
# game at every point and can afford 100-Elo steps; this walks two or three
# positions and wants the same *span* rather than the same resolution, because
# what it is looking for is a crossing and the fit interpolates between points
# anyway.
GRID_STEP = 200


async def measure(settings: dict, positions: list[dict], *, user_id: int) -> dict:
    """Measure a puzzle's difficulty by asking Maia at every Elo on the grid.

    `positions` is the puzzle's line as `puzzle_solve.line_positions` returns
    it: one entry per move the solver has to find, each with the position it
    is found in.

    Returns `{'elo', 'rd', 'rating', 'curve', 'reason'}`; `elo` is None
    whenever the measurement could not be made -- no Maia configured, a build
    with no Elo option, a curve that does not rise. The caller falls back to
    the theme-matched estimate, which is what happened before this existed.

    Imported here rather than at module scope so the arithmetic above stays
    importable, and testable, without the whole engine stack behind it.
    """
    from .jobqueue import pool, slots_for
    from .sweep_job import _ranked_moves, build_grid, open_maia

    if not positions:
        return {"elo": None, "rd": None, "rating": None, "reason": "no line to measure"}
    if not settings.get("maia_binary"):
        return {"elo": None, "rd": None, "rating": None, "reason": "no Maia engine selected"}

    grid = build_grid(
        int(settings.get("maia_elo_min") or 600),
        int(settings.get("maia_elo_max") or 2600),
        GRID_STEP,
    )

    per_elo: dict[int, list[float]] = {}
    async with pool.lease(user_id=user_id, slots=slots_for(settings, "quick"),
                          label="puzzle difficulty"):
        try:
            maia = await open_maia(settings)
        except Exception as e:
            return {"elo": None, "rd": None, "rating": None, "reason": str(e)}
        engine = maia["engine"]
        try:
            # Elo outermost, as the sweep does it: one `setoption` per grid
            # point rather than one per position.
            for elo in grid:
                await engine.send_line(
                    f"setoption name {maia['elo_option']} value {elo}")
                await engine.send_line("isready")
                await engine.wait_for("readyok")
                probabilities = []
                for position in positions:
                    ranked, policies = await _ranked_moves(
                        engine, position["fen"], maia["multipv"])
                    probabilities.append(
                        move_probability(position["uci"], ranked, policies))
                per_elo[int(elo)] = probabilities
        finally:
            engine.terminate()
            await engine.wait_closed()

    curve = solve_probabilities(per_elo)
    result = fit(curve)
    return {**result, "rating": to_rating(result.get("elo")),
            "curve": {str(k): round(v, 5) for k, v in sorted(curve.items())}}
