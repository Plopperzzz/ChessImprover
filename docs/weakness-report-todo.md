# Weakness report — what to build

A reconciliation of the *Engine Room — Weakness Analysis* spec against the app
that exists, and the steps to build the version that comes out of it.

The spec's goal is right and nothing here argues with it: go past "you blunder
0.8 times a game" to *why* a bad move happened and *what kind* of thing was
missed, then aggregate that across a library into something you can act on.

What has to change is the *construction*. The spec was written against an app
that isn't this one — a Flask/SSE backend with an `analysis_core.py` and a
vanilla-JS front end — and, more importantly, it specifies from scratch three
things this app already has, measured better than the spec asks for. Sections
1 and 2 below are that argument. Section 3 is the modified spec. Section 4 is
the work.

---

## 1. Where the spec and the app disagree

### 1.1 The stack, which is simply named wrong

| Spec says | Actually | Consequence |
|---|---|---|
| Flask, SSE | FastAPI; jobs stream over WebSockets (`/ws/analysis/{job_id}`, `/ws/sweep/{job_id}`) | Endpoints and the job wrapper are written the app's way |
| `analysis_core.py` | `app/classify.py` (the algorithm) and `app/analysis.py` (the pass and the job) | File names in the spec are read as roles |
| vanilla-JS front end | React + TypeScript in `web/` (`frontend/` is the retired classic UI) | The report is a React panel |
| `config.json` | per-user rows in the `engine_settings` table, `/api/settings`, migrated by `db._ensure_column` | Config lands as columns, not a JSON blob |
| `tests/fake_uci.py` | `backend/sims/*_check.py`; there is no fake-UCI harness | Checks follow the sims convention |

None of this is a disagreement about the feature. It is all translation, and
it is listed so nobody goes looking for `analysis_core.py`.

### 1.2 §3.4's motif classifier already exists, and is better

The spec asks for a new heuristic registry over seven motifs (`fork`,
`pin_or_skewer`, `discovered_attack`, `back_rank`, `hanging_piece`,
`mate_net`, `other`).

`app/puzzle_themes.py` already does this. It tags in Lichess's own vocabulary,
it runs over the *whole solution line* rather than one move, it is already
applied to every mistake and blunder in the library (`puzzles._tag_solution`),
and it is driven over known positions by `backend/sims/puzzle_themes_check.py`
— which asserts what must *not* be tagged as well as what must, the thing that
separates a motif detector from a plausible one.

It is also strictly finer-grained. The spec's `pin_or_skewer` is one label for
two motifs the existing tagger separates, and a pin and a skewer are not the
same weakness. Against that, the spec's seven-item list has nothing the tagger
lacks.

**Decision: reuse `puzzle_themes`.** Report by theme key. Do not build a
second registry — two vocabularies for the same idea is how the theme picker
and the weakness report end up disagreeing about what a fork is.

### 1.3 §3.4's game phase already exists (this is the spec's own open question)

The spec proposes `opening` = move ≤ 15 and an endgame threshold on non-pawn
*material*, and asks in §9 whether a phase detector exists first. It does:
`puzzle_themes._phase_themes`, which follows Lichess — endgame at six or fewer
non-pawn, non-king pieces, opening below move 10, middlegame otherwise — and
which says in its own comment why *counting* pieces beats summing their values:
by value a queen-and-rook ending for both sides is 28 points and reads as a
middlegame.

**Decision: use the existing one, unchanged.** A weakness report that bins by
one phase rule while the puzzle picker bins by another is a bug waiting to be
reported as a data discrepancy.

### 1.4 §3.1a's Maia-Elo ladder already exists, and is better

This is the substantive disagreement.

The spec wants: for each flagged move, walk a fixed eight-rung Elo ladder
(1100…2500), ask Maia at each rung, and record the lowest rung whose **top-1
prediction equals the best move**. `null` if no rung matches.

`app/puzzle_difficulty.py` already measures the same quantity, and measures it
properly. For each Elo on the account's own sweep grid it asks Maia for its
ordering at every position of the puzzle's line, takes the probability it plays
the *whole* line — from the engine's real policy where the build reports one
and from `policy_likelihood`'s rank surrogate where it doesn't — fits a
logistic to P(solve) against Elo, and reports the Elo where it crosses one half
together with a deviation. It is stored as `puzzles.maia_elo` / `maia_rd`.

Four ways that is the better instrument:

1. **It is graded, not binary.** "Maia's top-1 matched" throws away the
   difference between a move Maia gave 45% and one it gave 0.1%. Both are
   "didn't match" on the ladder, and they are not the same difficulty.
2. **It carries an uncertainty.** The spec's threshold is a step function with
   no error bar, on a rung spacing of 200 Elo. Every downstream number in §3.5
   is an average of these, and an average of point estimates with no spread is
   how a 40-Elo difference gets reported as a finding.
3. **It is already on a scale that means something.** A Lichess puzzle rated
   1500 is one a 1500 solver gets right half the time; that is the same
   construct, which is why one Glicko-2 rating already spans both sources
   (`puzzle_ratings.py`). The gap this feature is built on is therefore
   comparable with a puzzle rating rather than being its own unit.
4. **One grid, not two.** It uses the account's configured sweep grid. A second
   hardcoded ladder is a second thing to keep in step with the settings dialog.

The spec's "harder than the ladder covers → `null`" case has a better answer
already too: `puzzle_difficulty` reports `off_grid` with a widened deviation,
so an off-the-end position stays in the average as a weak measurement instead
of dropping out of it.

**Decision: `maia_elo_threshold` := `puzzles.maia_elo`.** No ladder pass. The
spec's `maia_gap` and its `maia_elo_source` config (long-term vs per-game Elo
estimate) survive intact — those are genuine additions, and the choice really
is defensible either way, so it stays configurable as the spec says.

### 1.5 §3.2's clock work is half-built

`pgn_parse._think_times` already reads `%clk`, already adjusts for the
increment from the `TimeControl` header, already clamps a clock that went up,
and already returns `None` per ply where the clock is missing. It is stored on
`games.clocks_json` at upload and copied per-ply onto `sweep_positions.think_ms`.
The graceful-skip behaviour the spec asks for is the behaviour.

What is genuinely new is the percentile *within the player's own pace in that
phase*, and `rushed_flag`. That is the good idea in §3.2 and it is a pure
function over data already on disk.

This also supersedes `TODO.md` §2 ("Time spent vs quality"), which is the same
data asking a smaller question.

### 1.6 §3.3's decision tree has a bug in branch 4

Branch 4 fires when "a *different* candidate was in the player's own top-3
shallow list". Nothing in §3.1 or §3.1a computes the player's top-3 anything —
`player_move_rank_shallow` is where the played move ranked in **Stockfish's**
shallow top-5. As written the branch cannot be evaluated from its own inputs.

**Decision:** `judgment_gap` is "the move played was itself in the shallow
top-5, at rank 2 or worse" — you were looking in the right area and picked the
wrong candidate out of it. That is what the branch was reaching for and it is
computable.

Second, branch 2 turns on `maia_gap <= 0` exactly. `maia_gap` is a difference
of two estimates that both carry deviations of 100 Elo and up; a hard sign test
on it will label a gap of −1 "hard position" and a gap of +1 a weakness.
**Decision:** widen it to a band — inside one combined deviation, the answer is
"can't tell", which is its own bucket and is excluded from the leverage score
alongside `hard_position`.

### 1.7 §8's "no training loop yet" is a non-goal that was already met

The spec defers the puzzle/practice loop to a follow-up. It is built: puzzles
are generated from your own mistakes and blunders, solved and stored with their
lines, tagged with themes, rated by the Maia measurement in 1.4, and there is a
per-theme Glicko rating and a "what to practise" panel over the top of it.

That changes the shape of this feature for the better. The report should not
end at a chart — its "highest leverage" rows should open the puzzle picker
filtered to that theme and phase. The distance between "you miss forks in the
middlegame" and practising exactly those is one link, and not taking it would
be strange.

### 1.8 What survives the spec unchanged

- §3.1's MultiPV shallow/deep pass. There is nothing like it, and it is the
  only new engine work in the feature. (See step 6: it is also the piece with
  the least evidence behind it, so it ships last and gated.)
- §3.3's failure-mode idea and four of its five branches.
- §3.2's percentile and rushed flag.
- §3.5's aggregation, the gap-over-time series, the leverage score, and the
  templated summary sentence.
- §3.5's insistence on excluding above-your-level misses from the miss rate,
  which is the sharpest thing in the document.
- §5's charts and drill-down, and §8's non-goals other than 1.7.

---

## 2. The modified spec, in one page

A **flagged move** is a Mistake, Blunder or Miss of *yours* in a position that
was not already lost — which is precisely the set `puzzles.build` already
walks, with the same `MIN_WIN_PROB_BEFORE` cut and for the same reason ("find
the best move in a lost position" is a different exercise). Inaccuracies are
counted in the totals and not classified; if the per-motif counts come out too
thin to read, relaxing `PUZZLE_CLASSIFICATIONS` is the one-line way to widen
the net, and it should be a measured decision rather than a guess made now.

Per flagged move, all of it read from rows that already exist:

| Field | Where it comes from |
|---|---|
| `fen`, `played_uci`, `ply`, `classification`, `wp_drop`, `cp_before/after` | `puzzles` |
| best line (what should have been played) | `puzzles.solution_line`, `solution_cp` |
| `motif` | `puzzle_themes` rows for the puzzle |
| `game_phase` | the same rows (`opening` / `middlegame` / `endgame`) |
| `piece_type_missed` | mover of the first move of `solution_line` |
| `maia_elo_threshold`, its deviation | `puzzles.maia_elo`, `puzzles.maia_rd` |
| `maia_gap` | player estimate (`strength.build`, long-term or per-game per config) − `maia_elo` |
| `time_spent`, `time_remaining` | `games.clocks_json` |
| `time_spent_percentile`, `rushed_flag` | new, computed per game × phase |
| `discovery_depth_bucket`, `player_move_rank_shallow` | new, step 6 only |

`classify_failure` then runs as the spec describes, with 1.6's two fixes and
one added outcome:

1. `rushed_flag` and gap clearly positive → `time_pressure`
2. gap within one combined deviation of zero → `too_close_to_call`
3. gap clearly negative → `hard_position`
4. gap positive, `discovery_depth_bucket == "deep_only"` → `calculation_gap`
5. gap positive, played move in the shallow top-5 at rank ≥ 2 → `judgment_gap`
6. otherwise → `vision_gap`

2 and 3 are logged and excluded from miss rates and from the leverage score.
Without step 6's pass, branches 4 and 5 never fire and everything lands in
`vision_gap` — which is why the aggregation must report how many records had a
depth bucket at all, rather than quietly presenting a `vision_gap` share
computed over records that were never eligible for anything else.

Aggregation is **computed on request from cached rows and not persisted**,
which is what `strength.py` and `trend.py` do — "as cheap to run as loading the
rows" is the standard, and a stored aggregate is a stored thing to invalidate.
It is sliced by the library filter (speed / time control / group), not by
`run_id`: that is the filter the Progress screen already carries and the one
the spec's own §5 asks for.

---

## 3. Answers to the spec's §9 open questions

- **Is there already a game-phase detector?** Yes — `puzzle_themes._phase_themes`.
  Use it (1.3).
- **What is the run-save/load format?** `runs` → `run_games` (one per game per
  mode, with `grid_json` and `results_json`) → `analysis_moves` (per ply) and
  `sweep_positions` (per position per side, with the encoded per-grid-point
  ranks, the optional policy block, and `think_ms`). The weakness report needs
  no new run-shaped persistence: its per-move records are `puzzles` rows, and
  its aggregates are re-derived (§2).
- **Is the MultiPV re-analysis affordable on a 1000-game dump?** Only if it
  stays scoped to flagged moves, which is roughly 1–2 plies per game rather
  than 80. That is the design, and step 6 measures it before it is turned on by
  default rather than asserting it.

---

## 4. The steps

Ordered so that something useful exists after step 3, and so that the only new
engine work is last.

### Step 1 — The record: one query, no new tables

Add `app/weakness.py`. A single function that returns the flagged-move records
of §2 for a user and a `LibraryFilter`, by joining `puzzles` → `puzzle_themes`
→ `analysis_moves` → `games`, with the player's Elo estimate from
`strength.build` (or the per-game estimate in `run_games.results_json`,
per config).

*Watch out for:* a puzzle with no `solution_line` yet (the solver is lazy) has
no motif and no `maia_elo`. Those rows are **counted and reported as
unmeasured**, never dropped silently — the share of the library that has been
measured is the first thing that makes the rest of the report trustworthy or
not. Same discipline as the trend view's "left out" line.

*Check:* `backend/sims/weakness_check.py`, on a seeded library.

### Step 2 — Time percentiles and the rushed flag

Pure functions over `games.clocks_json`: time spent per ply (already computed
at upload), time remaining, and the percentile of a move's think time within
*that player's moves in that phase of that game*. `rushed_flag` = below the
configured percentile and there was a findable improvement.

*Watch out for:* a game with no clocks yields no percentiles at all, not a
percentile of zero, and the report must say which games those were. Also: a
percentile over the eight moves of a phase is nearly meaningless — set a
minimum sample per phase below which the flag is `None` rather than `False`.
`False` says "not rushed"; there is a difference.

*Check:* fixtures with `%clk` and without, in the same sim.

### Step 3 — `classify_failure` and the aggregation

A pure function (§2's six branches), and the aggregation the spec's §3.5
describes: miss rate by motif, by phase, by piece; failure-mode distribution
cross-tabbed; **average `maia_gap` per motif and phase**, which is the ranking
signal, not the raw counts; the rolling-window gap trend; the time-percentile
vs miss-rate buckets; the top three leverage rows (frequency × average gap);
and the templated sentence.

*Watch out for:* the leverage score multiplies a count by an average of noisy
differences. A motif with two records and a huge average gap will top the list
and mean nothing — the same sparse-bucket problem the trend view solved, and it
needs the same treatment: show it, mark it, don't rank on it.

*Check:* `classify_failure` driven directly over synthetic inputs covering all
six branches, including both edges of the `too_close_to_call` band and the
`maia_gap == 0` case the spec asks about.

### Step 4 — The API

An `app/weakness.py` router, mounted in `main.py`, taking the standard
`library_filter` dependency:

- `GET /api/weakness/report` — the aggregation of step 3.
- `GET /api/weakness/moves?motif=fork&phase=middlegame` — the individual
  records, for drill-down.

No `POST /api/analyze/weakness` yet: through step 3 nothing runs an engine, so
there is no job to start. The job arrives with step 5.

### Step 5 — The report on Progress

A panel on the Progress screen, under the same speed filter the rest of that
screen now honours. Charts per the spec's §5, using the existing
`useChartTheme` palette and the `lib/quality.ts` colours so a blunder is one
colour here too.

The drill-down opens the position in the existing puzzle board rather than a
new component. And per 1.7, each leverage row links into the puzzle picker
pre-filtered to that theme and phase — the report's whole point is what to do
next, and the thing to do next is already built.

*Watch out for:* this panel is meaningless until puzzles have been solved and
Maia-rated. It needs an honest empty state that says which of the two is
missing and offers the button that starts it, not a chart of three points.

### Step 6 — The MultiPV discovery-depth pass (gated, and last)

The one piece with new engine cost. On each flagged move, re-search the
position before it at MultiPV 5 at a shallow depth and at the configured
analysis depth, and record `top5_shallow`, `top5_deep`, the played move's rank
in each, and the bucket. `engine_manager.evaluate_position` already takes a
`multipv` argument and already returns `lines`, so this is a caller, not new
engine plumbing. It runs as a WebSocket job like every other pass
(`/ws/analysis/{job_id}`), with the same progress and board animation.

New `engine_settings` columns via `db._ensure_column`, defaults from the spec's
§6: `weakness_shallow_depth` 6, `weakness_multipv` 5, `weakness_rushed_pctile`
15, `weakness_maia_elo_source` `'long_term'`. The deep depth reuses
`sf_limit_value`; there is no reason for this pass to search deeper than the
pass that flagged the move.

*Watch out for:* measure it on a real batch before defaulting it on. Two extra
searches on 1–2 plies per game is the claim; a 1000-game library is where that
claim gets tested. And be honest in the UI that a depth-6 top-5 is a rough
proxy for "would a human see this at a glance" — it is the weakest signal in
the feature, which is why the Maia gap is the primary one and this only splits
`calculation_gap` from `judgment_gap`.

### Step 7 — Nearly free, once the above is in

The spec's §6 byproduct: `puzzles.maia_elo` grouped by theme across the whole
library is an empirical "what Elo first spots a fork, versus a back-rank mate"
curve. It is a `GROUP BY` over data step 1 already assembles, it is per-user so
it raises none of §8's cross-user questions, and it is the one number in the
report that is about chess rather than about you.

---

## 5. Not doing

Everything in the spec's §8 except the training loop (1.7), plus:

- No parallel `weakness_moves` table. The per-move record is a `puzzles` row.
- No second motif registry (1.2), no second phase rule (1.3), no second Maia
  ladder (1.4).
- No persisted aggregates (§2).
- No LLM anywhere near the summary sentence, which the spec is right about.
