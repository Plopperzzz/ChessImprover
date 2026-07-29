# Estimating strength from one game

The Elo sweep used to ask one bit per move: *was this Maia's single favourite
at this rating?* A move it ranked second and would have played 30% of the time,
and a move it never considered at all, both scored zero.

That is why one game returned a number-shaped non-answer. This document records
what replaced it, what the replacement is measured to be worth, and the several
things that had to be got right before it was.

Every number below is reproducible with `python backend/sims/policy_likelihood.py`
— no engine, no database, no Maia binary. The estimator is
`backend/app/policy_likelihood.py`.

---

## 1. The objective

```
    rating_hat = argmax_r  sum over moves of  log P(move played | position, r)
```

The peak is the estimate. Three things fall out of that which the old fit
needed extra machinery for:

* **No baseline parameter.** The old code fitted a bump on a baseline, the
  baseline being "the share of your moves that every rating finds". Under a
  likelihood those moves contribute the same log probability at every rating
  and cancel out of the comparison between ratings by themselves.
* **No bootstrap.** The uncertainty is a property of the same fit (§4).
* **No calibration against a published accuracy curve.** Mean log probability
  per move is on an absolute scale already (§5).

## 2. Where the probabilities come from

Two sources, reduced to the same thing — a (position × rating) matrix of log
probabilities — so everything downstream is written once.

### 2a. The rank surrogate

The sweep stores *where* the played move ranked in Maia's ordering: `1` is its
own choice, `2` its second, `0` means it wasn't a candidate. `logp_from_ranks`
maps a rank to a typical policy mass — Zipf-shaped, top-1 mass 0.45, decay 1.5.

This is a **proper** likelihood and not a fudge. The mass assigned to a rank
does not depend on the rating, so the same total is spread over the same move
vocabulary at every grid point and the normalisation cancels when ratings are
compared. All the rating-dependence enters through *which rank the played move
got*, which is exactly the information the top-1 bit was discarding.

It costs no engine time, so **every sweep already in the database re-fits under
the new objective**, including sweeps taken before MultiPV was recorded, which
stored only rank 1. Those simply carry less information.

The three constants are assumed rather than measured, so the estimator has to
survive getting them wrong. Across every combination of decay 1.0/1.5/2.2 and
top-1 mass 0.35/0.45/0.55 — a far wider range than the truth can plausibly sit
in — the bias stays within 14 Elo and coverage within 92–98%. They set how many
nats a rank improvement is worth, and so the scale of the log-likelihood; they
do not move the place where the ranks improve.

They do cost *precision*, in one direction. A decay of 1.0 spreads the mass too
evenly, so a rank-1 move is worth little more than a rank-5 one, and the spread
over seeds runs to 120–180 Elo against 77 at the default 1.5. Being wrong in
the flat direction is the expensive way to be wrong; the top-1 mass barely
matters at all.

### 2b. The engine's own policy

Maia3 computes the real thing. `maia3/uci.py` builds a softmax over the legal
moves, takes the top MultiPV of it, and carries each candidate's probability in
a field it calls `policy`.

**It never prints it.** What `cmd_go` emits per candidate is `score cp` and
`wdl`, and both come from the *value* head — its guess at how the game ends
after that move, not the probability it would play it. Driving the stock engine
here confirms they are frequently identical across every candidate:

```
info depth 1 multipv 1 score cp 81 wdl 373 335 292 pv d2d4
info depth 1 multipv 2 score cp 81 wdl 373 335 292 pv d2d3
info depth 1 multipv 3 score cp 81 wdl 373 335 292 pv c2c3
```

Scoring a likelihood with those would silently produce a flat curve.
`sweep_job.POLICY_FIELDS` therefore lists the field names that mean policy and
excludes `wdl` and `cp` by name. Section 9 of the spec asks for exactly this
check.

So the probability is one `print` away, on the far side of a process boundary.
`backend/app/maia_policy.py` reaches across it. The configured engine
(`assets/Engines/maia3-23m`) is a pip console script: a stub that runs one
specific Python interpreter and calls `maia3.presets:main_23m`. That
interpreter has `maia3` importable by construction, or the engine the user
already configured would not start. So the shim recovers the interpreter from
the stub — a `#!` line on Linux and macOS, the same string stored just before
the appended zip in the Windows launcher `.exe` — and re-runs the same engine
under it, subclassing `Maia3UCIEngine` to add one field:

```
info depth 1 multipv 1 score cp 81 wdl 373 335 292 policy 54 pv d2d4
```

`score cp` and `wdl` are left exactly as the stock engine writes them, so
anything already reading this output keeps working.

It is entirely optional. `probe` actually starts the shim and waits for a
handshake rather than trusting that the import will work, and returns None for
anything it cannot drive. Then the sweep launches the ordinary binary, the fit
uses the rank surrogate, and the engine note says so. Nothing is on the path of
a normal analysis except as an attempt allowed to fail.

Probabilities are stored in `sweep_positions.policies`, two characters per grid
point over the 94 printable ASCII codes: 8836 levels across a log-probability
range of 12 nats, so about 0.001 nats of quantisation. One character would have
quantised at 0.1 nats, and tenths of a nat per move are what decide where the
peak sits. Measured round-trip error through the real save/load path is
6 × 10⁻⁵ in probability.

## 3. Fitting the peak: three attempts

This is the part that took measuring rather than reasoning. Over 500 seeds of
one 30-move game at a known 1500:

| how the peak is fitted | spread over seeds | interval says | actually covers |
|---|---|---|---|
| quadratic through 5 points around the max | 134 Elo | 76 | 78% |
| quadratic through 11 points around the max | 94 Elo | 80 | 87% |
| **smooth weights over the whole grid** | **79 Elo** | **90** | **97%** |

The lesson is that **choosing a window from the data makes the estimate a
discontinuous function of the data**. The window is picked by where the maximum
landed, so a sample that nudges the maximum to the next grid point moves the
fit bodily — and the extra spread that injects is invisible to any standard
error computed afterwards, because it comes from a step the error formula never
sees. The soft fit is both tighter *and* honest about it.

So every grid point gets weight `exp((L - Lmax) / tau)`, with `tau = 4` nats.
`tau` trades bias against spread: too small and the fit sees too few points to
average out the jaggedness that rank flips produce, too large and it reaches
into the tails where a quadratic no longer describes the curve and drags the
peak toward the middle of the grid — the exact failure the old smoothing spline
was replaced for. Between 1200 and 2000 on the default grid, `tau = 4` holds
the bias inside 15 Elo and coverage between 95% and 97%.

A related trap: the window must be *centred* on the maximum, not merely contain
it. An early version took "points within 2 nats of the best", which can put the
maximum at one end; a quadratic through those fits a convex arc and reports no
peak at all. It did so on 5 of the first 6 seeds tried.

## 4. The interval

A **delete-one jackknife over the independent unit** — games when several are
pooled, moves when there is only one game. Dropping a unit subtracts its own
coefficients from the summed quadratic, so every leave-one-out peak is closed
form and the whole interval is one vectorised expression rather than a refit
each.

It replaces a 400-sample bootstrap, and is both cheaper and better behaved. The
analytic sandwich (`sqrt(sum of squared scores) / information`) was tried
alongside and covers at 94% where the jackknife covers at 95–97%; the jackknife
is kept because erring wide is the honest direction. The curvature-only error —
what the likelihood would claim if the player really were a Maia at some rating
and their moves independent — is reported beside it as `se_curvature`, so the
ratio of the two is measured on the player's own moves rather than asserted.

Resampling *games* rather than moves only matters when games genuinely differ,
so the simulation makes them: 12 games each played at its own rating around the
player's, form varying by 120 Elo.

| | true spread | resample games | resample moves |
|---|---|---|---|
| no form variation | 34 | covers 91%, width 124 | covers 95%, width 127 |
| form varies by 120 | 51 | **covers 92%**, width 196 | **covers 85%**, width 137 |

With nothing to cluster over the two agree to within a couple of points, as
they should — and the game-level interval is fractionally the worse of the two,
which is the price of estimating a variance from 12 clusters instead of 360
moves. With realistic between-game variation that reverses and the gap is much
larger: the move-level interval is 30% too narrow and covers 85% of the time
where the game-level one holds 92%. Paying two points in the case where
clustering is unnecessary to gain seven where it is necessary is the trade
worth making, because real games do differ.

For a **single game** the jackknife is over moves, because there is nothing
else to resample — which treats them as independent when they share an
opponent, an opening and a sitting. The table above is exactly the bias that
introduces, and it cannot be measured from one game, so it is stated in the
reasons and the confidence label is capped at Medium however tight the
interval looks.

## 5. The absolute scale

Mean log probability per move is comparable across players, games and grids
without calibrating anything. Two fixed reference points bracket the range:

* a player Maia predicts as well as it predicts anyone scores **−2.11** nats
  per move (the entropy of the rank distribution in §2a);
* guessing uniformly among legal moves scores **−3.43**.

This is what the old code needed `maia_accuracy` — a curve digitised from a
published figure, measured on blitz, needing a user-settable offset — to do.
The likelihood gets it for free, and a beginner nothing predicts is flagged in
those words 100% of the time in simulation rather than handed a rating.

The accuracy curve is still used by the top-1 objective, which is still
reachable, and still anchors the "how predictable are you" panel.

## 6. What it is measured to be worth

300 seeds, true rating 1500, grid 600–2600 step 100, both objectives re-fitting
the *same* simulated scores:

| | | old: top-1 | new: likelihood |
|---|---|---|---|
| **one game** (30 moves) | bias | −32 | +15 |
| | spread over seeds | 275 | **80** |
| | interval covers | 62% | **97%** |
| | typical width | 623 | 368 |
| **library** (400 moves) | bias | −6 | +2 |
| | spread over seeds | 51 | **30** |
| | interval covers | 98% | 96% |
| | typical width | 312 | **125** |

An interval that covers 62% of the time is not a 95% interval; the old
one-game number was not merely noisy but wrong about its own reliability. The
library case is not a wash either — the likelihood halves the spread and takes
the interval from 312 Elo to 125 on the same data.

Across the grid, from one game: coverage runs 95–97% between 1200 and 2000
with bias inside 15 Elo. Outside that the peak is pushed against the end of the
swept range, bias grows to 130–150 Elo, and every one of those fits comes back
Low confidence and labelled a bound rather than a measurement — which is the
behaviour wanted, since the honest answer there is "wider than this grid".

Positions that count toward the fit, per 30-move game: **3.6** under top-1,
**15.0** under the likelihood. A position was uninformative unless Maia's
*favourite* changed somewhere on the grid; now it counts unless the model's
whole opinion of the move stands still.

## 7. Is the simulation fair?

It would be worthless if the ranks were drawn from the same Zipf shape the
estimator assumes — good coverage would then be arithmetic rather than
evidence. So the simulated player is built the way `elo_sweep`'s own comments
describe real data, a bump on a baseline, with the ranks between 2 and 9 shared
out on a *flatter* profile than the estimator assumes:

```
    P(rank 1   | r) = base1 + amp1 * exp(-(r - R)^2 / 2w^2)
    P(in top 9 | r) = base9 + amp9 * exp(-(r - R)^2 / 2w^2)
```

Two further details decide whether it means anything.

**The draw is coupled across the grid.** Each position gets a single uniform
and its rank at every rating is read off that rating's rank-CDF with it. A
position whose move is hard for Maia to guess is hard at every setting.
Drawing independently per grid point would invent information the sweep does
not have and would flatter every interval here.

**Each position is centred on its own rating**, `R + d_i` with
`d_i ~ N(0, 300)`. This is load-bearing, and getting it wrong invalidated a
whole run of results. With a single shared centre, the coupled draw makes the
score matrix an exact function of `|r - R|` — perfectly symmetric about the
truth. Every position's likelihood then peaks at exactly `R`, the peak is
noise-free, and the fit correctly reports a standard error of zero. The
first version of this simulation did that, and reported a suspiciously perfect
100% coverage with intervals of width 0 at every rating. The move you played is
sometimes more typical of a 1200 and sometimes of an 1800; that scatter is the
entire reason a finite sample's peak is uncertain, and so it is the thing the
interval has to get right.

The spread is anchored against behaviour already on record rather than picked:
the brief that commissioned this work reports the old estimator returning 715,
1043, 1073, 1259 and 1447 from 25 positions of one simulated player. At
`SPREAD = 300` the old estimator scores bias −63 / sd 286 over 30 moves here,
which is the same regime.

## 8. What did not change

* **`decode_scores` still reads both encodings.** `'1'`/`'0'` from the old
  top-1-only sweeps decode to rank 1 and rank 0, which is what they always
  meant. Nothing was migrated and no sweep needs re-running.
* **`hits()` is untouched**, so `classify.apply_great_brilliant` and
  `blunder_elo_correlation` mean exactly what they meant. "Would a player at
  this strength have found it" really is a top-1 question, and
  `match_rate_near` is still a top-1 rate.
* **The old estimator is still reachable** — `estimate_from_ranks(...,
  objective='top1')`, and the "Fit" dropdown beside the strength panel. Both
  objectives re-fit cached scores, so the comparison above can be repeated on
  real games at no cost.
