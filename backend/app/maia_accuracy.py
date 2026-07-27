"""Maia3's move-matching accuracy as a function of the player's rating.

The headline figures -- 79M matches human moves 62.5% of the time, 23M 61%,
5M a little under 59% -- are the *peaks* of curves, not flat rates. Accuracy
rises steeply with the rating of the games being predicted: the 79M model
matches barely 48% of a 600-rated player's moves and 62% of a 2600-rated
player's, because stronger players play more forced and more obvious moves.
Past about 2600 it falls away again, sharply.

That shape is the whole reason this module exists. A single number would make
every player below master strength look like they had failed a test they were
never taking: comparing a 1200's 53% match rate against 62.5% would read as a
38% shortfall when it is in fact exactly on curve.

What the curves are used for (see `docs/elo-accuracy-prior.md`):

* an absolute yardstick for the sweep -- the fitted bump's peak *height* should
  land on the curve at the fitted bump's peak *position*, and a shortfall means
  either the grid never reached the player or the player is less predictable
  than the population at that rating;
* a second, independent read of strength from the same cached scores, by
  inverting the curve on the match rate rather than reading the peak's
  position.

**These numbers are digitised by eye from the published figure**, at roughly a
quarter of a percentage point of precision -- good enough for both uses above,
which turn on differences of several points, and not good enough to quote as
Maia's published results. Replace them with the exact table if it becomes
available; nothing else needs to change.

**They are also blitz numbers.** Maia3 is trained on Lichess blitz, so it
predicts rapid and classical moves somewhat less well -- a player who thinks
for two minutes has more chance to find something off-policy. A library of
slower games will therefore sit slightly below these curves as a matter of
course, with no inconsistency on the player's part. `accuracy_offset` exists to
absorb that; it shifts every curve by a fixed amount and defaults to 0.
"""

import os
import re

# The x-axis of the published figure, in Elo.
RATINGS = list(range(600, 2901, 100))

# Move-matching accuracy per model, as a fraction, aligned to RATINGS.
# 'allie-policy' is the published baseline rather than a Maia model; it is kept
# for reference and never used as an anchor.
CURVES: dict[str, list[float]] = {
    "3m": [
        0.463, 0.473, 0.485, 0.500, 0.516, 0.519, 0.524, 0.532, 0.538, 0.544,
        0.549, 0.553, 0.554, 0.558, 0.563, 0.568, 0.572, 0.576, 0.580, 0.578,
        0.573, 0.562, 0.545, 0.505,
    ],
    "5m": [
        0.471, 0.481, 0.493, 0.507, 0.522, 0.524, 0.529, 0.537, 0.543, 0.550,
        0.555, 0.560, 0.562, 0.567, 0.572, 0.577, 0.582, 0.586, 0.590, 0.589,
        0.583, 0.572, 0.555, 0.510,
    ],
    "23m": [
        0.474, 0.484, 0.496, 0.510, 0.525, 0.527, 0.532, 0.541, 0.547, 0.554,
        0.560, 0.566, 0.566, 0.574, 0.579, 0.584, 0.590, 0.596, 0.602, 0.607,
        0.611, 0.606, 0.594, 0.562,
    ],
    "79m": [
        0.479, 0.489, 0.500, 0.514, 0.528, 0.530, 0.535, 0.544, 0.551, 0.558,
        0.564, 0.570, 0.570, 0.579, 0.584, 0.589, 0.595, 0.601, 0.607, 0.615,
        0.621, 0.616, 0.604, 0.580,
    ],
    "allie-policy": [
        0.470, 0.480, 0.492, 0.506, 0.521, 0.523, 0.528, 0.536, 0.542, 0.549,
        0.555, 0.561, 0.564, 0.570, 0.574, 0.580, 0.585, 0.589, 0.591, 0.588,
        0.580, 0.568, 0.550, 0.505,
    ],
}

MAIA_SIZES = ("3m", "5m", "23m", "79m")

for _name, _curve in CURVES.items():
    assert len(_curve) == len(RATINGS), f"{_name} curve does not match RATINGS"


def known(model_size: str | None) -> bool:
    return bool(model_size) and str(model_size).lower() in CURVES


def accuracy_at(model_size: str | None, rating: float,
                accuracy_offset: float = 0.0) -> float | None:
    """Expected top-1 match rate for a player of this rating, or None when the
    model isn't one we have a curve for.

    Linear between the published points. Outside the plotted range the curve is
    held flat at its end value rather than extrapolated: past 2900 the real
    curve is falling off a cliff and inventing where it lands would be worse
    than admitting the edge.
    """
    if not known(model_size):
        return None
    curve = CURVES[str(model_size).lower()]
    if rating <= RATINGS[0]:
        value = curve[0]
    elif rating >= RATINGS[-1]:
        value = curve[-1]
    else:
        i = min(int((rating - RATINGS[0]) // 100), len(RATINGS) - 2)
        span = RATINGS[i + 1] - RATINGS[i]
        t = (rating - RATINGS[i]) / span
        value = curve[i] + t * (curve[i + 1] - curve[i])
    return min(max(value + accuracy_offset, 0.0), 1.0)


def peak(model_size: str | None) -> tuple[int, float] | None:
    """(rating, accuracy) at the top of the curve."""
    if not known(model_size):
        return None
    curve = CURVES[str(model_size).lower()]
    i = max(range(len(curve)), key=lambda k: curve[k])
    return RATINGS[i], curve[i]


class AccuracyCurve:
    """The expected match rate for one model, or for a pool of them.

    A pool needs this because a library can hold games swept by different
    binaries, and those have visibly different curves at master level even
    though they nearly coincide at 800. `weights` are the share of positions
    each model contributed, over the positions whose model is known.
    """

    def __init__(self, weights: dict[str, float], label: str,
                 share_known: float = 1.0, accuracy_offset: float = 0.0):
        self.weights = weights
        self.label = label
        self.share_known = share_known
        self.accuracy_offset = accuracy_offset

    def at(self, rating: float) -> float:
        return min(max(sum(
            w * accuracy_at(size, rating) for size, w in self.weights.items()
        ) + self.accuracy_offset, 0.0), 1.0)

    def _sampled(self) -> list[float]:
        return [self.at(r) for r in RATINGS]

    def peak(self) -> tuple[int, float]:
        values = self._sampled()
        i = max(range(len(values)), key=lambda k: values[k])
        return RATINGS[i], values[i]

    def implied(self, accuracy: float) -> float | None:
        """Invert the curve: what rating matches Maia at this rate?

        A second read of strength from the same cached scores, independent of
        where the sweep's bump sits. Only the rising branch is inverted -- the
        curve turns over near 2600, so a rate above the peak has no answer and
        one on the way down is indistinguishable from the same rate on the way
        up. Returns None there rather than picking a branch.

        It is a much blunter instrument than the peak's position: the curve
        climbs roughly 0.7 of a percentage point per 100 Elo, so a one-point
        error in the measured rate is worth about 140 Elo. It earns its place
        by being wrong in different ways, not by being sharper.
        """
        values = self._sampled()
        top = max(range(len(values)), key=lambda k: values[k])
        rising = values[:top + 1]
        if len(rising) < 2 or accuracy >= rising[-1] or accuracy <= rising[0]:
            return None
        for i in range(len(rising) - 1):
            lo, hi = rising[i], rising[i + 1]
            if lo <= accuracy <= hi and hi > lo:
                t = (accuracy - lo) / (hi - lo)
                return RATINGS[i] + t * (RATINGS[i + 1] - RATINGS[i])
        return None


def for_model(model_size: str | None, accuracy_offset: float = 0.0) -> AccuracyCurve | None:
    if not known(model_size):
        return None
    size = str(model_size).lower()
    return AccuracyCurve({size: 1.0}, f"maia3-{size}", 1.0, accuracy_offset)


# ---------------------------------------------------------------------------
# Recovering the model behind a sweep that has already run
# ---------------------------------------------------------------------------

_SIZE = re.compile(r"\bmaia3[-_](\d+m)\b", re.IGNORECASE)
_NOT_APPLIED = "model size NOT applied"


def model_size_from_note(note: str | None) -> str | None:
    """The model size a stored sweep actually ran, read back out of the
    engine note `maia.resolve_binary` produced at the time.

    Sweeps predate the `run_games.maia_model_size` column, and the note is the
    only record of which binary ran. It names it in every case where the answer
    is knowable at all.

    Returns None when the note genuinely cannot say -- a generic `maia3-uci`,
    or a fallback where the requested size was not on disk. The user's *current*
    model-size setting is not a substitute: it may have changed since the sweep,
    and a wrong curve is worse than no curve.
    """
    if not note:
        return None

    def size_in(name: str) -> str | None:
        m = _SIZE.search(os.path.splitext(name)[0])
        return m.group(1).lower() if m else None

    if _NOT_APPLIED in note:
        quoted = re.search(r"next to '([^']+)'", note)
        return size_in(quoted.group(1)) if quoted else None
    resolved = re.search(r"->\s*(\S+)", note)          # "model 79m -> maia3-79m"
    if resolved:
        found = size_in(resolved.group(1))
        if found:
            return found
    configured = re.search(r"using configured binary '([^']+)'", note)
    if configured:
        return size_in(configured.group(1))
    return None


# Below this share of positions traceable to a known model, no curve is
# offered at all. Anchoring a whole library against the minority of it whose
# binary happens to be identifiable would put a confident-looking number on
# mostly unknown provenance.
MIN_KNOWN_SHARE = 0.5


def blend(counts: dict, accuracy_offset: float = 0.0) -> AccuracyCurve | None:
    """One curve for a pool of games swept by different models.

    `counts` is {model_size: n_positions}; positions whose model could not be
    recovered sit under a None key and count against the known share without
    contributing a curve.
    """
    total = sum(counts.values())
    known_counts = {str(s).lower(): n for s, n in counts.items() if known(s) and n}
    known_total = sum(known_counts.values())
    if not total or not known_total or known_total / total < MIN_KNOWN_SHARE:
        return None
    weights = {size: n / known_total for size, n in known_counts.items()}
    if len(weights) == 1:
        label = f"maia3-{next(iter(weights))}"
    else:
        # Reads inside a sentence -- these labels end up in the estimate's
        # stated reasons. The per-model shares stay available separately.
        label = "a mix of " + "/".join(
            f"maia3-{size}" for size, _ in sorted(weights.items(), key=lambda kv: -kv[1]))
    return AccuracyCurve(weights, label, known_total / total, accuracy_offset)
