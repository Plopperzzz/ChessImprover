# Prompt: estimate strength from one game

Paste this whole file as the task. It is written to be picked up cold.

---

## What to build

Replace the Elo sweep's top-1 matching objective with a **likelihood over
Maia's move preferences**, so that a single game — 20 to 40 of one player's
moves — produces a usable strength estimate with an honest interval.

Today the sweep asks one bit per move: *was this the model's single favourite
move at this rating?* A move Maia ranked second and gave 30% probability, and a
move it never considered at all, both score zero. That is why the current fit
needs ~100 positions to settle and returns a number-shaped non-answer from 25 —
verified by driving `elo_sweep.estimate` with a flat 8% match rate over 25
positions, which returned 715, 1043, 1073, 1259 and 1447 on five random seeds.

Maia's own tooling reads strength from a couple of dozen moves because it uses
the probability the model assigned to the move actually played. Do that:

```
    rating_hat = argmax_r  sum over moves of  log P(move played | position, r)
```

The peak is the estimate. The curvature of the log-likelihood at the peak gives
the standard error directly — no bump fit, no bootstrap, no calibration against
a published accuracy curve, because a likelihood is already on an absolute
scale.

## Two versions. Do (1) first; it is most of the value for none of the risk.

### 1. Rank-weighted, over sweeps already in the database

The sweep already stores **where the played move ranked** in Maia's ordering,
not just hit/miss: `'1'` is its own choice, `'2'` its second, `'0'` means the
move was nowhere in its top `MAX_RANK` (9). `elo_sweep.hits()` is the single
function that flattens that to binary, and everything statistical downstream
reads its output.

So a rank-based pseudo-likelihood needs **no new engine time at all** and can
re-fit every sweep already saved. Model `P(rank = k | rating)` — a
discrete distribution over ranks 1..9 plus "unranked" — and fit its parameters
against the grid. Even a crude monotone form (rank 1 far more likely at the
player's own rating, tailing off with distance) uses several times the
information the current bit does.

Start at `backend/app/elo_sweep.py`, `decode_scores()` and `hits()`. The stored
strings are in the `sweep_positions` table.

### 2. True policy likelihood

Better than anything rank-based, and probably makes `_fit_bump`, the bootstrap
and the whole `_ceiling` check redundant. Needs the Maia wrapper to report
per-candidate **probabilities** rather than an ordering.

**Check first whether it can.** `backend/app/engine_manager.py` reads the
engine's advertised UCI options during the handshake
(`read_uci_options`), and `engine_probe.py` exists for exactly this kind of
question. Some Maia wrappers expose policy via a non-standard `info` field or a
`go nodes 1` MultiPV listing with per-move scores. If it does, store those
probabilities alongside the ranks in `sweep_positions` — the schema note in
`db.py` explains why the encoding was chosen the way it was, and adding a
column there is the established pattern (`_ensure_column`).

## Rules

- **Do not break stored sweeps.** `decode_scores` is explicitly documented as
  reading both the old `'1'`/`'0'` top-1 rows and the newer ranks. Anything you
  add keeps that property; old runs must still fit, even if less precisely.
- **Keep the old estimator reachable** until the new one is shown to be better
  on the same data. Re-fitting cached scores is free — run both over the
  existing library and compare.
- The classification rules read the sweep too. `apply_great_brilliant` uses
  "would a player at this strength have found it" via `match_rate_near`, which
  is a top-1 rate. If you change what the sweep produces, check `classify.py`
  and `sweep_job.py` still mean what they say.
- `docs/spec.md` §9 is the contract for this feature; the README's "Which scale
  is that number on?" and "Elo estimate" sections are the user-facing
  description. Update both when the method changes, and say plainly what
  changed rather than quietly editing the numbers.

## How to verify without an engine

The dev container has **no Stockfish and no Maia binary**, and `pip install
chess` fails on the system Python (a Debian setuptools quirk: `install_layout`).
Working setup:

```bash
python3 -m venv .venv && .venv/bin/pip install chess numpy scipy fastapi
```

Then drive the estimator directly with synthetic score matrices — this is how
the current behaviour above was established, and it is the right way to test a
new one:

- a **control** at a known rating (a bump on a baseline) — the estimate must
  land on it, and the interval must cover it about 95% of the time over many
  seeds;
- a **beginner** whose moves nothing predicts (flat low rate) — must come back
  flagged, not confidently wrong;
- **one game vs a hundred positions** of the same simulated player — the whole
  point is that the first now works, so measure the spread over seeds at both
  sizes and report the numbers.

Report bias and standard deviation over seeds, not one example. The comments in
`elo_sweep.py` quote exactly these figures for the current method (spline
bias -61/sd 30 vs bump fit -1/sd 10) — match that standard.

## Done when

- One game of 20-40 moves gives an estimate whose spread over random seeds is
  small enough to be worth showing, with an interval that covers the truth at
  its stated rate.
- The confidence labels and reasons still tell the truth, including for a
  player the model genuinely cannot predict.
- Every sweep already in the database re-fits under the new objective with no
  re-run, and the comparison against the old numbers is written down.
