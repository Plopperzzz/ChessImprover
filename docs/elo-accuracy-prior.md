# Using Maia3's published accuracy in the Elo estimate

Maia3 predicts human moves correctly **62.5%** of the time at 79m, **61%** at
23m and **57.5%** at 5m, measured against players at the rating the model is
set to. This is a proposal for what that buys the estimate in §9, what it does
not buy, and whether already-analysed games can take advantage of it without a
second sweep.

Every number below comes from `backend/sims/accuracy_prior.py`, which is
reproducible with `python backend/sims/accuracy_prior.py` and needs no engine
and no database.

---

## 1. The one identity these numbers give

`A` is defined as the match rate when Maia's Elo is set to the player's true
strength, over *all* their positions. So for the curve the sweep measures,

```
rate_full(theta) = A
```

by definition of A -- not by assumption. The fit in `elo_sweep.py` runs on the
**discriminative** subset only, but the two are related by an identity rather
than a model: rows that are all-1 across the grid contribute 1 at every Elo and
all-0 rows contribute 0, so

```
rate_full(e) = (n_all1 + n_disc * rate_disc(e)) / n_total
```

and therefore

```
rate_disc(theta) = (A * n_total - n_all1) / n_disc
```

`n_total`, `n_all1` and `n_disc` all come off the cached score matrix, so both
forms are computable from what is already stored. That identity is what makes
everything below work on old data.

---

## 2. What this does *not* buy: pinning the peak height

The obvious move is to use `rate_disc(theta)` as a constraint -- fit
`base + amp` pinned to it, turning the 4-parameter bump into a 3-parameter one.
**Tested and rejected.** Bias / sd / RMSE in Elo, over 400 replicates:

| scenario | free (today) | hard pin | soft prior |
|---|---|---|---|
| 100 games, peak at 1500 | 0 / 9 / 9 | 0 / 9 / 9 | 0 / 9 / 9 |
| 25 games, peak at 1500 | -0 / 18 / 18 | 1 / 17 / 17 | 1 / 17 / 17 |
| 1 game, peak at 1500 | -6 / 106 / 107 | -18 / 168 / 169 | -20 / 230 / 231 |
| 25 games, narrow 1100-1900 grid | 2 / 20 / 21 | -2 / 37 / 37 | 2 / 20 / 20 |
| 25 games, tight 1200-1800 grid, peak at 1650 | 0 / 26 / 26 | -2 / 46 / 46 | 5 / 31 / 32 |
| 100 games, tight 1200-1800 grid, peak at 1650 | -2 / 13 / 13 | 1 / 34 / 34 | 1 / 14 / 14 |
| 25 games, coarse batch grid, peak at 2450 | 3 / 29 / 29 | 7 / 37 / 37 | 5 / 29 / 30 |

The free fit is already unbiased to within a few Elo everywhere the peak is
inside or near the grid, including on the narrow, tight and coarse grids where
an under-determined fit was the worry. Hard-pinning *inflates* the spread there
rather than shrinking it — by 1.8× on the narrow grid, 2.6× on the tight one at
100 games — because the height and the centre are not independent: forcing the
height slightly wrong drags the centre along to compensate. A soft prior is
merely harmless.

It is also fragile. With the accuracy misspecified by 5 points -- a 5m sweep
mistaken for a 79m one, or a player who is simply less predictable than the
population -- a hard pin on a near-edge peak goes to **+116 Elo bias, sd 147**,
against 2 / 26 for the free fit.

The single exception is a player whose strength is off the grid entirely, where
a *soft* prior helps a lot:

| true strength (grid tops out at 2600) | free | hard pin | soft prior |
|---|---|---|---|
| 2700 | 44 / 42 / 61 | 18 / 29 / 34 | 38 / 33 / 51 |
| 2900 | **-162** / 13 / 163 | -163 / 13 / 163 | **-53** / 28 / 60 |
| 3100 | **-436** / 14 / 436 | -436 / 14 / 437 | **-253** / 32 / 255 |

That is worth having, but §3 gets most of the same value more safely: rather
than extrapolating a number past the end of the grid, say plainly that the grid
does not reach the player.

**Recommendation: leave `_fit_bump` alone.** The accuracy figures are not a
better way to find the peak.

---

## 3. What this does buy: an absolute yardstick

The estimator has never had one. Every check in `_confidence` is relative --
interval width against the swept span, peak position against the grid edges,
rate range against its own standard error. None of them can answer "did this
sweep actually find the player?" because there was no scale to answer it on.

`A` is that scale. The statistic is one line off the cached matrix:

```
ceiling_ratio = max over the grid of rate_full(e)   /   A
```

### 3a. It detects an off-grid player, cleanly

Median ratio and the share of replicates flagged at a 0.90 threshold:

| true strength | 25 games | 100 games |
|---|---|---|
| 1000 | 1.00 — 0% flagged | 1.00 — 0% |
| 1500 | 1.00 — 0% | 1.00 — 0% |
| 2000 | 1.00 — 0% | 1.00 — 0% |
| 2400 | 1.00 — 0% | 1.00 — 0% |
| 2600 (exactly at the edge) | 1.00 — 0% | 1.00 — 0% |
| 2800 | 0.93 — 15% | 0.93 — 2% |
| 3000 | 0.79 — **100%** | 0.79 — **100%** |
| 3200 | 0.66 — **100%** | 0.66 — **100%** |

100% detection at 400+ Elo off the grid, no false alarms anywhere inside it,
and it works from 25 games. Compare what the estimate does in the same
situation: at a true 3000 the current fit reports **2600 with a bias of -162**
and, because the peak lands at the edge, a confidence of at best "medium".
"Medium confidence, 2600" is not what a 3000 player deserves; "at least 2600,
widen the grid" is.

Note that this is *not* the existing `at_edge` check. A genuine 2600 player and
a 3000 player both pin the fitted peak to the grid edge, and the current code
cannot tell them apart. The ceiling ratio can: 1.00 against 0.79.

### 3b. The same statistic measures consistency

A shortfall has two possible causes, and they are separated by where the fitted
peak sits (100 games, 79m):

| player | peak / A | fitted centre | at edge |
|---|---|---|---|
| consistent 1500 | 1.00 | 1500 | 0% |
| consistent 2600 (really at the edge) | 1.00 | 2600 | 100% |
| consistent 3000 (off the grid) | 0.79 | 2600 | 100% |
| mixed 1300/1700, half each | 0.93 | 1500 | 0% |
| mixed 1100/1900, half each | 0.81 | 1483 | 0% |
| mixed 800/2200, half each | 0.78 | 820 | 0% |
| 1500 with 20% blitzed-out moves at 700 | 0.92 | 1409 | 0% |
| 1500 with 20% engine-quality moves at 2600 | 0.91 | 1544 | 0% |

So:

| | peak at a grid edge | peak mid-grid |
|---|---|---|
| **ratio ≈ 1** | a real player at the edge — widen the grid to pin it down | a clean measurement |
| **ratio < 0.9** | the grid does not reach the player — report a bound, not a number | the player is less consistent than the population Maia was calibrated on |

That bottom-right cell is a genuinely new output for the app, and arguably a
more useful one for a player than the Elo itself: *how much of the variance in
your play is strength, and how much is inconsistency.* A 1500 who plays like a
1500 every move and a 1500 who alternates 1100 and 1900 get the same estimate
today and should not.

The last row of the table is also a warning worth surfacing: a strongly bimodal
player (800/2200) breaks the single-bump model outright — the fit collapses onto
one mode and returns 820 for a player whose average is 1500. The ratio flags it
at 0.78, which is the only signal the system would have that the number is
meaningless.

---

## 4. What this buys for model choice and mixed libraries

The accuracy gap between model sizes is smaller than it looks, because the
**baseline** -- the share of moves every Elo finds, roughly 35% -- is a property
of the positions, not the model. Only the amplitude above that baseline
discriminates:

| model | A | baseline | amplitude | sd @25 games | sd @100 games |
|---|---|---|---|---|---|
| maia3-5m | 0.575 | 0.347 | 0.228 | 19 Elo | 10 Elo |
| maia3-23m | 0.610 | 0.348 | 0.262 | 18 Elo | 9 Elo |
| maia3-79m | 0.625 | 0.348 | 0.277 | 17 Elo | 9 Elo |

Positions needed for the same interval, relative to 79m: **5m ×1.23, 23m ×1.05.**

Two consequences:

* **5m is the right default for batch runs**, which is the opposite of what the
  accuracy numbers suggest at a glance. A 57.5% model sounds much worse than a
  62.5% one; it costs 23% more positions. If 5m sweeps more than 1.23× faster
  than 79m — and it does, by a lot — it wins on precision per unit of wall
  clock. 23m is within 5% of 79m and should be the default for single games.
* **Mixed-model pools need per-game weighting.** `strength.py` currently pools
  every game's positions into one matrix regardless of which binary swept it,
  and `run_games` does not record which one that was. Positions from a 5m sweep
  carry `(0.228/0.277)² ≈ 0.68` of the information of a 79m position, so
  inverse-variance weighting would tighten a mixed pool. This is the smallest
  of the wins here and should come last.

---

## 5. Proposed changes

Ordered by value per unit of risk.

**1. Record the model size on the run.** Add a nullable `maia_model_size`
column to `run_games`, populated at save time in `runs.save_analysis`. Backfill
existing rows from `engine_note` (see §6) via the existing `migrations` table.

**2. `elo_sweep.estimate(..., accuracy=None)` computes `ceiling_ratio`.**
Returns it alongside `estimate`. `accuracy=None` leaves every current output
byte-identical, so nothing breaks while the plumbing lands.

**3. Rework the edge verdict in `_confidence`** along the 2×2 in §3b. When the
ratio is below ~0.90 *and* the peak sits at an edge, report a bound
("at least 2600") rather than a point estimate, and say the grid needs
widening. When the ratio is near 1 at an edge, the current "widen the range"
advice stays but the estimate is trustworthy as a floor.

**4. Surface consistency in the pooled view.** `strength.build` reports
`ceiling_ratio` with a plain reading: "your moves match maia3-79m 58% of the
time at your best-fitting Elo, against the 62.5% it manages on players it is
matched to." Flag bimodality when the ratio is low with a mid-grid peak.

**5. Gate all of it on `top_n == 1`.** The published figure is top-1 accuracy.
The top-N objective the sweep supports has no known ceiling, so `ceiling_ratio`
must be suppressed rather than compared against the wrong number.

**6. Per-model pooling weights** in `strength.matrix`, and a warning when a
pool mixes model sizes. Last, and optional.

Explicitly **not** proposed: changing `_fit_bump`. See §2.

---

## 6. Can already-analysed games use this without re-sweeping?

**Yes — every game already analysed in full mode, with no engine work at all.**

Three things are needed, and all three are already on disk:

| need | where it lives | status |
|---|---|---|
| the per-(position × Elo) score matrix | `sweep_positions.scores`, one digit per grid point | already stored (§13) |
| `n_total`, `n_all1`, `n_disc` | derived from that same matrix by `elo_sweep.split_positions` | free |
| `A` for the model that swept it | `run_games.engine_note` | recoverable — see below |

The first two need no comment: `strength.matrix()` already reconstructs the
full matrix including the all-1 and all-0 rows, and the identity in §1 turns it
into `rate_full` with no extra data.

The third is the only real question, because nothing today records the model
size. It is recoverable from `engine_note`, which `save_analysis` already
persists from `resolve_binary`'s note. I enumerated every string that function
can emit and tested a parser against all of them, with and without the MultiPV
suffix `open_maia` may append:

| stored note | recovered |
|---|---|
| `model 79m -> maia3-79m` | `79m` |
| `model 23m -> maia3-23m` | `23m` |
| `model 5m -> maia3-5m` | `5m` |
| `using configured binary 'maia3-5m'` | `5m` |
| `using configured binary 'maia3-uci'` | `None` (correctly) |
| `model size NOT applied: no maia3-79m executable next to 'maia3-uci' ...` | `None` (correctly) |
| `model size NOT applied: no maia3-79m executable in /path` | `None` (correctly) |

All eight cases resolve correctly. The first form covers essentially every real
run: `maia_model_size` is `NOT NULL DEFAULT '5m'` and `open_maia` always passes
it, so any sweep that ran against an installed size-specific binary carries its
size in the note.

Where the note genuinely cannot say — a generic `maia3-uci`, or a fallback
where the requested size was not on disk — the answer is `None`, `A` is unknown,
and `ceiling_ratio` is suppressed for that game. **No guessing.** Those games
keep exactly the estimate they have today; they just do not get the new
diagnostic. Guessing from the user's *current* `maia_model_size` setting would
be wrong, because the setting may have changed since the sweep ran.

Nothing else stands in the way:

* `strength.build()` and `trend.build()` are already pure re-fits of cached
  scores, called on every page load and documented as never running an engine.
  A deploy recomputes on the next load; there is no backfill job for the
  statistic itself.
* The only schema work is additive — one nullable column plus a one-time
  `engine_note` backfill through the existing `migrations` table, which is the
  same pattern `_widen_default_elo_grid` uses.
* `results_json` on `run_games` holds the *old* per-game estimate. It stays
  stale until the game is re-analysed; that is already true of every other
  re-fit in the app, and the pooled and trend views are the ones that matter.

One caveat on the pooled view: `ceiling_ratio` must be computed on the same
position set the fit uses, so the `min_think_ms` filter has to be applied before
it. Dropping premoves and instant recaptures removes the *least* predictable
moves, so a filtered library will show a slightly higher ratio than an
unfiltered one. That is a real effect and not a bug, but the two are not
comparable and the UI should not present them as if they were.

---

## 7. Caveats on the accuracy figures themselves

These matter more than usual because §3 turns 62.5% into an absolute reference
rather than a relative one.

* **Provenance is unstated.** 62.5 / 61 / 57.5 need a source: which position
  set, which time controls, top-1 at matched rating. If they are measured on
  Lichess blitz and a user's library is classical, or Chess.com, or correspondence,
  the true ceiling for that library is different and every `ceiling_ratio` shifts
  with it. This is the same scale problem `_calibrate` already solves for the
  Elo axis by measuring the offset from the user's own opponents.
* **So make `A` a setting**, three defaults keyed by model size, editable.
* **And treat the ratio as primarily relative**: within one user's library,
  across their own months, it is sound regardless of where the absolute anchor
  sits. That is also where the interesting reading lives — "you have got more
  consistent since March" survives a mis-set anchor, "you are 0.93 consistent"
  does not.
* The ratio is a max over a discrete grid, so it is very slightly optimistic —
  the true peak sits between grid points. At step 100 on a bump ~330 Elo wide
  the effect is under a percentage point, well inside the slack the 0.90
  threshold leaves.
