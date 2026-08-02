# To do

Things worth building next, with enough notes to start from. Roughly ordered
by value per unit of work, not by when they were thought of.

Anything already built lives in the README; this file is only what isn't.

Fixes and polish for the React UI in `web/` are *not* here — they live in
[`web-ui-fixes.md`](web-ui-fixes.md), so a defect list can't drown out the
feature list.

One item is big enough to have its own file:
[`weakness-report-todo.md`](weakness-report-todo.md) — classifying *why* a bad
move happened (rushed / didn't see it / didn't calculate it / picked the wrong
candidate) and what kind of thing was missed, aggregated across the library.
It reconciles an external spec against what is already built, and it subsumes
§2 and much of §4 below.

---

## 0. Opening repertoire report

**Why:** the app can already say *that* you lost the game and *where*. It
can't say "you lose the Caro-Kann and you're fine in everything else", which
is the question that changes what you study next.

**What:** group analysed games by opening — the `ECO` header when the export
carries one, otherwise the first N plies as a key — and report per opening:
games, score, average win probability at move 15, and where the mistakes
cluster by move number.

**Data:** all of it is already stored. `games.headers_json` has ECO/Opening
for chess.com and lichess exports; `analysis_moves` has the per-ply
classifications and evaluations; `games.result` plus `your_color` gives the
score. No engine work, no new columns.

**Watch out for:** an opening with three games in it will show a 33% score and
mean nothing — the same sparse-bucket problem the trend view already solved,
and it needs the same treatment (show it, mark it, don't rank on it). Group by
colour too: your Caro-Kann as Black and the games you faced it as White are
different repertoires.

---

## 1. When do you play best? (time-of-day bins)

**Why:** the plausible answer ("I'm worse after 11pm") is worth knowing and
nobody's memory is reliable about it.

**What:** bin games by local time of day — four-hour blocks, or named
(morning / afternoon / evening / night / late night) — and per bin show:
estimated Elo with its interval, win/draw/loss record, and the *opponents'*
estimated Elo for the same games. Chart it the way the trend view now does:
one panel per quantity, shared axis, each on its own scale.

**Data:** mostly there.

* Time of day: `games.headers_json` carries `UTCTime` (and often `StartTime` /
  `EndTime`) on chess.com and lichess exports. Nothing new to import — but the
  column doesn't exist yet, so this needs a `games.utc_time` column plus a
  backfill from the stored headers.
* **Timezone is the catch.** `UTCTime` is UTC and "late night" is local, so
  binning UTC directly would be wrong for everyone not on UTC. This needs a
  per-user timezone (an IANA name or a fixed offset) in `users`, defaulting to
  the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone` on first
  load. Games with no time header sit the view out and are counted in a
  "left out" line, exactly as the trend view does for undated games.
* Your estimated Elo per bin: pool that bin's `sweep_positions` and fit, the
  same as `trend.build` does per date bucket — the code is nearly identical
  and should be shared rather than copied.
* **The opponents' estimate is already computed.** A full analysis sweeps both
  sides, and `run_games.results_json` holds a per-side estimate; the trend view
  simply ignores the opponent's. Pooling the opponent side per bin answers "am
  I playing worse at midnight, or just drawing stronger opponents?" — which is
  the confound that would otherwise make this whole view unreadable.

**Watch out for:** with a hundred games spread over five bins each bin is
twenty games, and the interval will be wide. Report the intervals honestly and
say plainly when two bins can't be told apart, rather than declaring a best
time of day off a 40-Elo gap with ±90 on each end. The win/loss record has the
same problem and is worse, because a 12-8 record feels like evidence and
isn't.

---

## 2. Time spent vs quality — *folded into the weakness report*

Kept here for the note below, but the work now lives as step 2 of
[`weakness-report-todo.md`](weakness-report-todo.md), where the same clock data
answers a sharper question: not "do you blunder when you move fast" but
"was time the limiting factor on *this* miss, given the position was one a
player of your strength usually finds".


**Why:** most players have a sharp cliff below about five seconds a move, and
seeing your own is more convincing than being told.

**What:** blunder and mistake rate against time spent on the move, bucketed by
think time.

**Data:** already stored. `sweep_positions.think_ms` is read from the `%clk`
comments at upload, and the Elo fit already uses it to drop instant moves.
`analysis_moves.classification` is the other half. No engine work.

**Watch out for:** think time and position difficulty are tangled — you think
longer in sharp positions, which are also where you blunder. The honest
version reports the association without claiming the direction.

---

## 3. Batches don't survive a restart of the *server*

Running jobs live in the process, so `Ctrl-C`, a crash or a reboot ends the
run. Every game it had finished is already saved, and re-running with "Not yet
analysed" picks up where it stopped, but the run itself is gone — the browser
is told so rather than left watching a bar that will never move.

Surviving a restart means persisting the queued game list and the run's
progress to the database and resuming it on startup. Closing the tab, locking
the phone and switching apps are all fine already.

---

## 4. Phase breakdown

Opening / middlegame / endgame accuracy separately, and — since the sweep
stores per-position scores — three separate Elo fits rather than one. "Your
endgame is 200 points behind your opening" is directly actionable in a way
that a single number never is.

The phase boundary has to be defined and stated, not improvised — and it
already is: `puzzle_themes._phase_themes` draws Lichess's line (endgame at six
or fewer non-pawn, non-king pieces; opening below move 10). Counting pieces
rather than summing material is deliberate and the reason is in that file. Use
it here rather than picking a second rule, the same way
[`weakness-report-todo.md`](weakness-report-todo.md) does.

The per-phase *miss* breakdown is part of that report; what stays here is the
part it doesn't cover — three separate Elo fits from the per-position sweep
scores.

---

## 5. Drag-and-drop pieces

Click-click works everywhere and is what the board does now. Dragging is the
expected gesture on a phone, and it pairs naturally with pre-moves. Pointer
events, and the existing `_handleClick` path stays as the fallback — dragging
must not become the only way to move.

---

## 6. Jump between mistakes in an analysed game

`n` / `p` to step from one mistake or blunder to the next, instead of
scrubbing the eval plot for the cliffs. Small, and it is what you actually do
after an analysis finishes.

---

## 7. Puzzle scheduling

The puzzle set has no notion of *when* to show you one again. Right now a
solved puzzle drops to the back and a revealed one stays unsolved, which is
enough to be useful but isn't spaced repetition. If the puzzles get used
enough to want it, the columns to add are a next-due date and an ease factor,
and the thing to avoid is a scheduler so eager that it shows you the same
position every day until you resent it.

Now that there's a rating (`puzzle_ratings`) and an attempt history
(`puzzle_attempts`) with the puzzle's difficulty on every row, the scheduler
has more to go on than "solved / not solved": the interesting signal is a
theme whose rating is *below* your overall one, which is the honest answer to
what to practise next. A Lichess puzzle you have attempted is currently gone
for good — a scheduler is what would bring the ones you failed back.

---

## 8. Themes the tagger can't see

`app/puzzle_themes.derive_themes` labels puzzles from your own games off the
position, the solution move and the stored evaluation. Seven Lichess themes
are out of reach that way and are never applied to a home-grown puzzle:
`deflection`, `attraction`, `interference`, `clearance`, `zugzwang`,
`intermezzo` and `xRayAttack`. Each needs to know *why the alternatives fail*,
which means engine lines, not one move.

The material is already there to do it: the solution is computed and stored
per puzzle anyway, and asking Stockfish for a few plies of PV at the same time
would cost nothing extra. The reason not to do it yet is that a
half-implemented motif detector is worse than none — the theme picker would
offer `deflection` and hand back a pile of positions that aren't. Whatever
does this should be driven over known positions in
`backend/sims/puzzle_themes_check.py`, where every case asserts what must
*not* be tagged as well as what must.
