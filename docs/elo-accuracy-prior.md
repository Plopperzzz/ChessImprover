# Maia3's accuracy curve in the Elo estimate

Maia3's move-matching accuracy is **not one number per model**. It climbs
steeply with the rating of the player being predicted — 79M matches barely 48%
of a 600-rated player's moves and 62% of a 2600's — and the headline figures
(62.5% / 61% / ~59%) are the *peaks* of those curves, reached only near master
level.

That shape is the whole story. This document records what the curves buy the
estimate, what they don't, and how already-analysed games pick it up without a
second sweep.

Every number below is reproducible with `python backend/sims/accuracy_prior.py`
— no engine, no database. The curves themselves live in
`backend/app/maia_accuracy.py`.

---

## 1. The identity that makes it usable

`A(θ)` is the match rate when Maia's Elo is set to the player's true strength
θ, over *all* their positions. So the sweep's full-set curve satisfies
`rate_full(θ) = A(θ)` by definition, not by assumption.

`elo_sweep.py` fits the **discriminative** subset only, but the two are related
by an identity rather than a model: rows that are all-1 across the grid
contribute 1 at every Elo and all-0 rows contribute 0, so

```
rate_full(e) = (n_all1 + n_disc * rate_disc(e)) / n_total
```

which is just the mean over every row. `_ceiling()` therefore needs no data the
sweep didn't already cache — that identity is why this works on old games.

---

## 2. What this does *not* buy: pinning the peak height

The obvious move is to constrain the fit so `base + amp` lands on the curve,
turning the 4-parameter bump into a 3-parameter one. **Tested and rejected.**
Bias / sd / RMSE in Elo, 400 replicates:

| scenario | free (shipped) | hard pin | soft prior |
|---|---|---|---|
| 100 games, peak at 1500 | -0 / 10 / 10 | -0 / 10 / 10 | -0 / 10 / 10 |
| 25 games, peak at 1500 | -1 / 21 / 21 | -0 / 21 / 21 | -0 / 21 / 21 |
| 1 game, peak at 1500 | -2 / 123 / 123 | -28 / 263 / 264 | -36 / 328 / 330 |
| 25 games, narrow 1100-1900 grid | 0 / 24 / 24 | 1 / 43 / 43 | 0 / 23 / 23 |
| 25 games, tight 1200-1800 grid | -1 / 29 / 29 | -4 / 49 / 49 | 5 / 43 / 44 |
| 100 games, tight 1200-1800 grid | -2 / 14 / 14 | -6 / 34 / 34 | 1 / 16 / 16 |
| 25 games, coarse batch grid, peak 2450 | 3 / 29 / 29 | 8 / 39 / 39 | 5 / 29 / 30 |

The free fit is already unbiased to a few Elo everywhere the peak is inside or
near the grid, including the narrow, tight and coarse grids where an
under-determined fit was the worry. Pinning *inflates* the spread there — 1.8×
on the narrow grid, 2.4× on the tight one at 100 games — because height and
centre are not independent: forcing the height slightly wrong drags the centre
along to compensate.

It is also fragile. With the accuracy 5 points too high, a hard pin on a
near-edge peak goes to **+133 bias, sd 155**, against 5 / 29 for the free fit.

The single exception is a player off the grid entirely, where a *soft* prior
helps: at a true 2900 (grid tops out at 2600) the free fit gives -164 / 13 and a
soft prior -52 / 37. §3 gets most of that value more safely, by saying the grid
does not reach the player rather than extrapolating past its end.

**`_fit_bump` is unchanged.** The curves are not a better way to find the peak.

---

## 3. What this does buy: an absolute yardstick

The estimator never had one. Every other check is relative — interval width
against the swept span, peak position against the grid edges — so none could
answer "did this sweep find the player at all?"

`_ceiling()` computes, off the cached matrix:

```
ratio = (best full-set match rate over the grid) / A(fitted rating)
```

### 3a. It must be the curve, not the headline number

Scoring against a flat 62.5% instead of `A(θ)` — the version this proposal
started as, before the plot — would have been actively harmful:

| true rating | ratio vs flat 62.5% | falsely flagged | ratio vs curve | falsely flagged |
|---|---|---|---|---|
| 800 | 0.80 | **100%** | 1.00 | 0% |
| 1200 | 0.85 | **100%** | 1.00 | 0% |
| 1600 | 0.90 | **44%** | 1.00 | 0% |
| 2000 | 0.93 | 2% | 1.00 | 0% |
| 2400 | 0.97 | 0% | 1.00 | 0% |
| 2600 | 0.99 | 0% | 1.00 | 0% |

Every player below master level would have been told their sweep failed. Against
the curve the false-alarm rate is 0–1% across the whole range.

### 3b. It detects an off-grid player

Ratio at a 0.90 threshold, grid 600–2600:

| true rating | 25 games | 100 games |
|---|---|---|
| 800 – 2600 (inside the grid) | 1.00 — 0–1% flagged | 1.00 — 0% |
| 2800 | 0.91 — 38% | 0.91 — 30% |
| 3000 | 0.75 — **100%** | 0.75 — **100%** |

This is **not** the existing edge check. A genuine 2600 and a 3000 both pin the
fitted peak to the same grid edge, and nothing but the height separates them:
1.00 against 0.75. The old code reported a true 3000 as "2600, medium
confidence" with a -164 Elo bias. It now reports **≥2600** and says to widen the
range.

### 3c. The same statistic measures consistency

100 games, 79m:

| player | peak / A | fitted centre | at edge |
|---|---|---|---|
| consistent 1500 | 1.00 | 1500 | 0% |
| consistent 2600 (really at the edge) | 1.00 | 2600 | 100% |
| consistent 3000 (off the grid) | 0.75 | 2600 | 100% |
| mixed 1300/1700, half each | 0.94 | 1513 | 0% |
| mixed 1100/1900, half each | 0.84 | 1549 | 0% |
| mixed 800/2200, half each | 0.79 | 2204 | 0% |
| 1500 with 20% blitzed-out moves at 700 | 0.93 | 1439 | 0% |
| 1500 with 20% engine-quality moves at 2600 | 0.92 | 1560 | 0% |

| | peak at a grid edge | peak mid-grid |
|---|---|---|
| **ratio ≈ 1** | a real player at the edge — sound floor, widen the grid | a clean measurement |
| **ratio < 0.9** | the grid does not reach the player — report a bound | the player is less predictable than the field at their rating |

That bottom-right cell is a new output, and arguably more useful to a player
than the Elo: a 1500 who plays like a 1500 every move and a 1500 who alternates
1100 and 1900 get the same estimate today and shouldn't.

The last mixed row is also a warning: a strongly bimodal player breaks the
single-bump model outright — the fit lands on 2204 for someone whose average is
1500 — and the ratio at 0.79 is the only signal that the number is meaningless.

### 3d. The second, independent estimate — and why it is reported carefully

Inverting the curve on the observed match rate gives a strength estimate that
never looks at *which* Elo setting matched, only at how often Maia agreed. It is
much blunter: the curve climbs about 0.7 of a percentage point per 100 Elo, so a
one-point error in the measured rate is worth ~140 Elo. `implied_rating_se`
propagates that, and `gap_significant` gates the reading, because at realistic
sample sizes most gaps are not distinguishable from zero. The standard error is
a *floor* — the binomial term treats positions as independent when moves within
a game are not.

---

## 4. Model size barely matters; the player's rating dominates

The baseline — the share of moves every Elo finds — is a property of the
positions, not the model, so only the amplitude above it discriminates:

**Bump amplitude above baseline:**

| rating | 3m | 5m | 23m | 79m |
|---|---|---|---|---|
| 800 | 14.1% | 14.9% | 15.1% | 15.5% |
| 1600 | 20.3% | 20.9% | 21.4% | 21.7% |
| 2400 | 23.3% | 24.3% | 25.4% | 25.9% |

**sd of the estimate, 25 games:**

| rating | 3m | 5m | 23m | 79m |
|---|---|---|---|---|
| 800 | 34 | 34 | 34 | 34 |
| 1200 | 21 | 20 | 22 | 21 |
| 1600 | 20 | 20 | 20 | 20 |
| 2000 | 19 | 19 | 19 | 19 |
| 2400 | 29 | 28 | 28 | 28 |

Positions needed for the same interval, against the best case (2000 on 79m):

| rating | for the rating | for using 3m instead of 79m |
|---|---|---|
| 800 | **×3.21** | ×1.01 |
| 1200 | ×1.23 | ×0.97 |
| 1600 | ×1.13 | ×1.02 |
| 2000 | ×1.00 | ×1.02 |
| 2400 | **×2.26** | ×1.05 |

Two conclusions:

* **Model size is nearly irrelevant to the Elo estimate.** Even 3m costs within
  5% of 79m. Sweep with whatever is fastest; the accuracy gap is real but it
  sits almost entirely in the part of the match rate that every Elo setting
  shares, not in the part that discriminates between them. (This does not carry
  over to Great/Brilliant classification, which asks about individual moves.)
* **A weak player is much harder to estimate**, and not for the reason it looks:
  a 800 needs 3.2× the positions of a 2000 because Maia predicts everyone poorly
  down there, leaving a 15% bump instead of a 24% one. The 2400 penalty is
  different again — it is crowding the top of the default grid, and widening the
  range fixes it.

---

## 5. What shipped

* `backend/app/maia_accuracy.py` — the digitised curves, per-model and pooled
  lookup (`AccuracyCurve`), inversion with its standard error, and
  `model_size_from_note`.
* `elo_sweep.estimate(..., accuracy=, top_n=)` — computes `ceiling`, `bound` and
  `full_match_rates`. Passing no curve reproduces the previous output exactly.
* `_confidence` — the 2×2 above replaces the purely geometric edge rule. A peak
  that reached the curve at an edge is now `high` confidence and described as a
  sound floor; one that fell short is a bound.
* `run_games.maia_model_size`, written by `save_analysis`, backfilled from
  `engine_note` (§6).
* `strength.py` — per-game model tracking, pooled `AccuracyCurve` for mixed
  libraries, and a `predictability` block.
* `trend.py` — anchored per bucket, so switching model size mid-library doesn't
  read as a change in consistency.
* `engine_settings` — `maia_accuracy_offset`, and a field for it in the dialog.
* Frontend — bounds render as `≥ 2600`, and the predictability reading sits with
  the calibration note.

Gated on `top_n == 1` throughout: the published figures are top-1 rates and the
wider objective has no published ceiling, so the check is dropped rather than
compared against the wrong number.

---

## 6. Already-analysed games: yes, no re-sweep

Three things are needed and all three are on disk:

| need | where | status |
|---|---|---|
| the per-(position × Elo) score matrix | `sweep_positions.scores` | already stored (§13) |
| `n_total`, `n_all1`, `n_disc` | the same matrix — see the identity in §1 | free |
| which model swept it | `run_games.engine_note` | recoverable |

The parser was tested against every note `resolve_binary` can emit, with and
without the MultiPV suffix — run `python backend/sims/model_size_from_note.py`:

| stored note | recovered |
|---|---|
| `model 79m -> maia3-79m` | `79m` |
| `model 23m -> maia3-23m` | `23m` |
| `model 5m -> maia3-5m` | `5m` |
| `using configured binary 'maia3-5m'` | `5m` |
| `using configured binary 'maia3-uci'` | `None` (correctly) |
| `model size NOT applied: ... next to 'maia3-uci' ...` | `None` (correctly) |
| `model size NOT applied: ... in /path` | `None` (correctly) |

All eight cases resolve correctly. The first form covers essentially every real
run, since `maia_model_size` is `NOT NULL DEFAULT '5m'` and `open_maia` always
passes it.

Where the note genuinely cannot say, the model is `None`, the ceiling check is
suppressed for those positions, and the estimate is exactly what it was before.
**No guessing** — the user's *current* model-size setting is not a substitute,
because it may have changed since the sweep ran. A library where under half the
positions can name their model gets no pooled curve at all
(`MIN_KNOWN_SHARE`), rather than a confident number resting on the minority
that can.

Nothing else stands in the way. `strength.build()` and `trend.build()` are
already pure re-fits called on page load, so a deploy recomputes on next load.
The schema work is additive: one nullable column plus a one-time backfill
through the existing `migrations` table, the same pattern
`_widen_default_elo_grid` uses. `results_json` holds the *old* per-game estimate
and stays stale until re-analysis — already true of every other re-fit here, and
the pooled and trend views are the ones that matter.

One caveat: `ceiling_ratio` is computed on the same position set the fit uses,
so the `min_think_ms` filter applies first. Dropping premoves removes the least
predictable moves, so a filtered library scores above an unfiltered one on the
same games. The UI says so; the two are not comparable.

---

## 7. Caveats on the curves themselves

* **Digitised by eye** from the published figure, at roughly a quarter-point of
  precision. Good enough for the uses above, which turn on differences of
  several points; not good enough to quote as Maia's published results. Replace
  `CURVES` with the exact table if it becomes available — nothing else changes.
* **The 5M peak reads ~59% off the plot, not 57.5%.** 57.5% is closer to where
  the 3M curve peaks (~58%). If 57.5% came from a source other than this figure,
  the 5m row needs correcting.
* **These are blitz numbers.** Maia3 is trained on Lichess blitz, so it predicts
  rapid and classical moves less well — a player who thinks for two minutes has
  more chance to find something off-policy. A slower library sits below these
  curves as a matter of course, with no inconsistency on the player's part.
  `maia_accuracy_offset` shifts every curve to absorb that and defaults to 0.
  This is the same class of problem `_calibrate` already solves for the Elo axis
  by measuring the offset from the user's own opponents; the difference is that
  there is no equivalent self-measurement for the accuracy axis, so it stays a
  setting.
* **Read the ratio as relative.** Within one library, across a player's own
  months, it is sound regardless of where the absolute anchor sits — "you have
  got more consistent since March" survives a mis-set offset, "you are 0.93
  consistent" does not.
* The ratio is a max over a discrete grid, so it is very slightly optimistic —
  the true peak sits between grid points. At step 100 on a bump ~330 Elo wide
  that is under a percentage point, well inside the slack the 0.90 threshold
  leaves.
