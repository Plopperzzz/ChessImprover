# Engine Room

A home-server chess analysis app for two users, built around local Stockfish
and Maia3 engines. See `docs/spec.md` for the full build spec this project
follows.

## Status

This covers build-order steps 1-12 from the spec: multi-user schema and auth,
PGN upload/parsing, the board/move-table/FEN viewer, a live Stockfish eval bar
backed by a persistent per-session engine process, variation support (a real
move tree -- branch off the mainline by playing a different move, delete a
variation, the mainline itself is never lost), Quick-mode analysis (a
Stockfish-only pass classifying every mainline move as Good/Inaccuracy/
Mistake/Blunder, with the board animating through positions as they're
evaluated), Play vs Maia3 with a configurable time control, the Maia Elo
sweep, Great/Brilliant classification with the blunder-Elo correlation,
saved analysis runs, batch mode, the bounded worker pool that lets both of
you analyse at once, the trend-over-time view, and the polish pass. That is
the whole build order from the spec.

Beyond the spec: the page is split into four tabs rather than one long column,
puzzles built from your own mistakes, pre-moves, looking back through a game
while you're playing it, separate board/piece sets, and an opening database
built from a PGN library that answers the board as you move. What's next is in
[`docs/TODO.md`](docs/TODO.md).

### The four tabs

Everything used to sit on one page, which meant scrolling past a batch runner
and a trend chart to reach the game you wanted to look at. It's four tabs now,
with the board, the move list and the Settings dialog shared between them:

| Tab | What lives there |
| --- | --- |
| **Analyse a game** | Load games, the game list, the single-game Quick/Full analysis, batch analysis, and the per-game Elo sweep. Everything that runs an engine over games you already have. |
| **Progress** | Your pooled strength across all games, and the trend over time. No board — these are aggregates, so the panels take the full width in columns. |
| **Play** | Play vs Maia3. |
| **Puzzles** | Your own mistakes, handed back (below). |

Batch analysis stays beside the board rather than moving to Progress: it drives
the same two passes as the single-game panel and steps the board through each
game as it goes. What it produces is what Progress reads.

Switching tabs is the only thing that hands the board between its three modes,
so what's on the board can't disagree with what the panels say, and it's also
the one place that decides which of the board's neighbours make sense — the
eval bar and the whole-game plot would be cheating during a game and would be
the answer during a puzzle, so they're analysis-only. This replaces the old
"Back to analysis" / "Puzzle board" / "Game board" buttons. The step buttons
stay live while playing, because they walk the game in progress; a puzzle is one
position, so there they go rather than sit greyed out.

Which tab you were on is remembered across reloads. Leaving Play with a game in
progress asks first — the session lives on the server only as long as the socket
does. Analysis jobs keep running while you're on another tab (a batch finishes
whether or not you watch it) but no longer animate over a board someone else is
using; the move list still follows along, so coming back to **Analyse a game**
lands wherever the job got to.

The **Games** list is collapsible and remembers whether you left it open.
Folded, its header still says which game is loaded, which is all you want from
it once a game is on the board. **Load games** is collapsible too, and starts
open only while your library is empty.

### Sharing the machine (worker pool)

Every piece of engine work -- a quick pass, a full analysis, a sweep, each
game of a batch -- takes a slot from a pool sized to the server's CPU cores
before it starts, so two people analysing at once share the hardware instead
of each spawning as many Stockfish threads as they like. A job reserves as
many slots as the Threads it is configured for, which is what keeps "two jobs
running" from meaning "twelve threads on four cores". `WORKER_SLOTS=n`
overrides the size if you want to keep cores back for something else.

Three properties, all verified with two accounts against a live server:

- **Neither of you gets shut out.** Waiters are ordered by how many slots
  their owner already holds, so whoever is running nothing goes first;
  beyond a first job, a user is capped at their share while anyone else
  waits.
- **A long batch yields.** The batch takes its lease *per game*, not for the
  whole run, so its slots go back to the pool at every game boundary. In the
  test, one user's 3-game batch handed over after game 1, the other user's
  analysis ran to completion, and the batch picked the slots back up — rather
  than the second user waiting out the entire run. The batch's engine
  processes stay open across that gap (they're idle, so they cost nothing,
  and reopening them per game is what batch mode exists to avoid).
- **A big job isn't starved.** Admission stops at the first waiter that
  doesn't fit rather than letting cheap jobs leapfrog it forever.

When a job is waiting, the panel says so and why ("Queued — 1 job(s) ahead of
it, needs 4 of 4 worker slot(s)") instead of showing a progress bar that never
moves, and Cancel withdraws it from the queue. `GET /api/jobs/pool` shows
capacity, what's running and what's queued.

This pool is deliberately **not** the same thing as the persistent live-eval
engines: those are one per open board, idle almost all the time, and cleaned
up by their own idle timeout. Charging them a worker slot would leave the pool
permanently short. `/api/engines/status` covers those and any job-owned
engines; `/api/jobs/pool` covers the queue.

### The board

The board faces the side **you** played: open a game you had as Black and it
opens flipped, with your pieces at the bottom. A line of bold text above and below
the board names the two players with their header ratings, marks which one is
you, shows the result once the game is over, and carries the clocks during a
game against Maia -- text rather than a bordered card, which boxed in the
board it belonged to. The plates follow the board, so the name under the board
is always whoever is at the bottom.

`⇅` (or the `f` key) flips it manually; selecting another game clears that
and goes back to facing you. Where neither of your names matches a PGN header
the board takes the conventional White-at-bottom view and no plate claims to
be you, rather than guessing -- and the game is listed with a `⚠ set side`
chip, because an unassigned game is skipped by the strength fit, the trend
view and the puzzle generator. Clicking the chip assigns the side by hand
(and that choice then survives a later rename); "Re-check my side" under the
Games list re-runs the header match over the whole library at once.

The two squares of the move that produced the position are tinted, so "what
just moved" never needs working out from the move list. They follow the board
when it's flipped, and they're cleared by a jump to a bare FEN -- a position
with no known route into it has no last move to point at. Stepping *backwards*
lights the move before the one you undid, which is the move that made the
position you're now looking at.

**⇅ and ⚙ sit at the top right of the board.** ⚙ opens the board's own settings, separate from Engine
Settings: which board, which pieces, where the evaluation bar goes, and whether
picking a piece up shows dots on its legal destinations. The **evaluation bar**
runs along the top of the board (the default) or stands beside it on either
hand; standing, it is as tall as the board and fills from the bottom for White,
which is the shape most sites use. The **copyable FEN** of whatever is on the
board is in here too, since it is a thing you want occasionally rather than a
thing you want taking up space under the board every day. Board and pieces are
chosen **separately** -- they
are independent art, and the pairing you want is rarely both halves of one set
-- and each dropdown offers only the sets that actually contain that half, so
a set holding just a `board.png` can't leave you with invisible pieces. It
also holds the pre-move toggle. Every control previews on the real board while
the dialog is open; Cancel puts back what was saved. The choices live on your
account, not in the browser, so they follow you to the phone. With the dots
turned off the square you picked up from is still marked -- otherwise clicking
a piece looks like nothing happened.

**Moving a piece** works either way round. Click it and click where it goes,
or press it and drag: the piece comes up under the cursor and the square it is
over is outlined as the one it would land on, so letting go there plays the
move and letting go anywhere else puts it back. Picking a piece up sweeps a
circle out over its square, and its destinations arrive by growing rather than
appearing all at once -- a dot on an empty square, and for a piece you could
take, the square tinted around a hole cut for the piece itself. All of it is
drawn *under* the pieces: a marker is about a piece, and covering the piece
with it is backwards.

The board takes as much height as the window leaves it, down to the plates and
the nav buttons under it, and it resizes with the window rather than at fixed
breakpoints -- drag the edge and it follows. The FEN boxes at the bottom of the
column are the first thing to fall past the fold on a short screen.

Once a game has been analysed, the move that produced the position on the board
carries its **classification badge** on the corner of the square it landed on,
and the same badge sits beside the move in the move table. They live in
`assets/icons/classification/<name>.svg`, reached by the classifier's own name
for the move.

Only the ones worth stopping at are badged: Brilliant, Great, Best,
Inaccuracy, Mistake, Miss and Blunder. Excellent, Good and Book are the moves
you were always going to play, and a badge on nearly every move is a badge on
none of them -- those three keep their colour in the move table and say nothing
else. `BADGED_CLASSIFICATIONS` in `app.js` is the whole list.

Only **brilliant** gets a sound of its own. Every move already says what it did
-- a capture, a check, a castle -- and a second noise stacked on every one of
them turns stepping through a game into a slot machine; a brilliancy is rare
enough to be worth interrupting for.

On a wide screen the layout is three columns -- board, move table, then
everything else -- putting the move table beside the board as section 5 asks.
They wrap in that order on anything narrower, so a phone gets board, moves,
then the panels.

The move table is **White on the left, Black on the right**, always. Section 5
asked for your moves in the left column whichever colour you played; a table
whose columns swap between games turns out to be one you have to read the
header of every time anyway, so the header carries that instead -- both
columns are labelled with the player's name, and yours says `(you)`.

Above the move table sits the whole-game evaluation curve, so a dip and the
move that caused it are one glance apart. Under it are the four step buttons,
directly below the moves they walk. The whole column stops where the board
does: the plot and the buttons take what they need and the move list gets the
rest, scrolling inside itself rather than running on past the board.

**Analyse live** in the Analysis panel shows what the eval bar's engine is
actually looking at -- the top one, two or three moves it is considering, each
with its score, its line as SAN and the depth it has reached. It doesn't start
anything: the live-eval process has been running on the position in front of
you the whole time (spec section 3), and this asks that same process for more
ranked lines. Switching it off asks for one line again, which is what the bar
needed anyway.

**Pasting a FEN** lives in **Load games** and does exactly one thing: it puts
that position on the board. It doesn't load a game, doesn't clear the one you
have selected, and doesn't touch the analysis panel.

### Opening database

Beside the board on **Analyse a game**: what a large reference library
actually played from the position in front of you. Every move seen from here,
most-played first, with how many games took it, how those games finished as a
white/draw/black bar from the side-to-move's point of view, and the players'
average rating. Clicking a row plays that move, which is the quick way to walk
a line; pushing pieces around on the board does the same thing from the other
direction, and the panel follows either way. No engine and no opponent are
involved -- the analysis board has always let you move both sides freely, and
this is that board with the library's answer beside it. Past the last position
anyone reached, it says so rather than showing an empty table.

The database is not shipped: point it at a PGN library and build it once. From
`backend/`:

```bash
python -m app.opening_import /path/to/LumbrasGigaBase.pgn
```

`.pgn`, `.pgn.gz`, `.pgn.bz2` and `.pgn.zst` all work. It writes
`backend/data/openings.db` (override with `CHESSIMPROVER_OPENING_DB`), which
is a separate file from `chessimprover.db` on purpose: it is a rebuildable
derived thing that no account owns, and deleting it costs you nothing but the
rebuild. The running server picks it up without a restart.

| Option | What it does |
| --- | --- |
| `--max-plies 24` | How deep to index, in half-moves. Past the opening, positions stop repeating between games, so deeper mostly adds rows that will be seen once and can't tell you anything. |
| `--min-elo 2200` | Skip games whose two players average below this. |
| `--since 2015` | Skip games played before this year. |
| `--limit 50000` | Stop early — for a trial run before committing to the whole file. |
| `--reset` | Start from empty instead of adding to what's there. Without it a second file is merged into the same database. |

Budget roughly an hour per three million games; the two filters and
`--max-plies` are the levers if that's too long, since a game rejected by a
filter is never parsed at all. A giga-base is an afternoon, once.

**Use the PGN, not the `.db3`/`.ecsi` copy of the same library.** PGN is a
documented text format that python-chess reads directly, and either way the
games have to be walked once and re-indexed by position -- a database built
for a different program's queries doesn't answer "which moves were played
here" any faster than the text does.

### Evaluation plot

Above the move table, once a game has been analysed: the whole game's evaluation,
with the mistakes and blunders marked on the curve, hover for the move and
its win probability, click anywhere to jump the board there.

The curve is smoothed with a **monotone cubic** spline (Fritsch–Carlson), and
that choice is the whole of it. The usual Catmull-Rom overshoots between
points: on a win-probability curve it would draw probabilities above 100% or
below 0, and on either side of a blunder it would round the cliff into a dip
that never happened. The monotone variant provably cannot overshoot — between
two points the curve stays within their two values — and it passes through
every point exactly. So it rounds the corners and changes nothing you could
read off the chart. Same spline on the trend lines, for the same reason.

Two choices worth stating. It plots **win probability, not centipawns** --
+3 and +9 are both simply "winning", and on a centipawn axis the second
dwarfs the first and squashes the whole opening into a flat line. It is also
always from **White's** point of view, the convention every chess site uses,
so the shape doesn't invert between a game you had as White and one you had
as Black. Because it is the same win-probability curve the classifications
are computed from, a blunder marker always sits on a visible cliff rather
than somewhere the line looks level.

Sound effects (from `assets/audio/`) play for moves, captures, castling,
check, promotion, an illegal move, game start and end, and a ten-second
warning on your own clock. They follow things *you* did — never the analysis
animation, which steps through a hundred positions. The speaker button in the
top bar mutes them, and the choice survives a reload.


### Trend over time

Estimated Elo per date bucket, plotted against the rating in your PGN
headers, bucketed by ISO week, month or year, optionally scoped to one run,
and optionally narrowed to a **timespan** -- the last 4 weeks, 6 months,
year, or any count and unit you type. Switching any of those **re-fits the
cached per-position sweep scores and never touches an engine** -- that is the
whole reason section 13 stores the score matrices rather than just the final
numbers.

The timespan ends at your **most recent analysed game, not at today**. A
stretch where you didn't play is not a decline, and anchoring to today would
empty the chart for anyone coming back after a couple of months off -- which
is exactly when they're most likely to look. Because that reading isn't the
obvious one, the status line always spells out the dates the window actually
covered, and how many older games it left out. Narrowing the window also
narrows the trend fit, so the rate is re-quoted in a unit that suits the
shorter span (see below) rather than extrapolating six weeks out to a year.

Three things about it are deliberate:

- **The two series are stacked panels, not one chart.** They shared a y-axis
  and the interval ruined it: a 95% band 400 Elo wide forces a range that
  flattens a header rating moving over 80 into a straight line, so the series
  you can actually read week to week became the unreadable one. A second axis
  on the same frame would fix the scale and introduce a worse problem — two
  axes invite reading a crossing as an event, when the gap between them is an
  arbitrary constant (they are different scales; see below). Stacked panels
  give each series its own scale, keep the x-positions aligned so the shapes
  can still be compared vertically, and never draw the two in a relationship
  they don't have.
- **A bucket is one fit over every position played in it**, not the average
  of the per-game estimates. A month with four games gets an honestly wide
  interval instead of the falsely tidy mean of four noisy numbers.
- **The trend is checked against those intervals.** "Improving by X Elo a
  year" is meaningless if X is smaller than the noise in each bucket, so the
  slope is a weighted fit whose weights come from the buckets' own 95%
  intervals, and it's reported with its own interval and a plain statement of
  whether it survives. If the buckets disagree with each other by more than
  their intervals allow, the slope's interval is widened to match rather than
  reporting false precision. A flat player gets "not distinguishable from the
  noise", not a trend line.
- **The rate is quoted in a unit the games can support.** The fit is per year
  internally, but three weeks of games turn 30 Elo of drift into "+1500 Elo a
  year" -- arithmetically true and completely useless. So it reports per week,
  per month or per year depending on how long a stretch the games actually
  cover, always alongside the total change across that stretch, and under
  three weeks it drops the rate entirely and says only how much moved over how
  many days.

The error bars on the header-rating line come from the spread of the ratings
in each bucket, not a fixed guess.

Sparse buckets are shown rather than dropped, flagged as sparse and drawn
with a smaller marker. Games that can't contribute are counted and named --
no Full analysis, no usable date, your name not matching White or Black --
so a short trend never looks like games silently vanished. If a bucket mixes
Elo grids (a single-game sweep at step 100 and a batch at step 200), it pools
on the Elos they share rather than interpolating: every score used is one the
engine actually produced.

The Maia estimate and your header rating are different scales, so a constant
offset between the two lines is expected. The shape is the signal, not the gap.

### Batch mode

Runs Quick or Full across many games, either everything or only games not yet
analysed in that mode -- so a cancelled run resumes where it stopped instead
of redoing work. The button says how many games it would cover before you
commit to a long run.

**Full mode in batch runs the Maia Elo sweep on every game**, exactly as the
single-game Elo estimate panel does -- same sweep, same per-position scores
stored, just applied across the whole selection. That is what populates the
trend view; the standalone Elo sweep panel is the one-game version of it. The
only difference is the Elo step, below.

Three choices come from the 1000-game target in the spec:

- **Engine processes are opened once per batch, not per game.** At that scale
  the process startup and UCI handshake would otherwise be a real share of
  the wall clock. Verified: the engine PID stays constant across a whole run,
  and batch engines now appear in `/api/engines/status` alongside the
  live-eval and play pools.
- **Each game is saved the moment it finishes.** Cancelling or crashing keeps
  everything done so far rather than losing the lot.
- **The sweep uses a separate, coarser Elo step in batch** (default 200 vs
  100), since a fine grid is affordable for one game and not for a thousand.

**The run belongs to the server, not to the page that started it.** Locking
the phone, switching apps or closing the tab doesn't touch it -- a mobile
browser that discards the tab while you're elsewhere used to come back to an
idle-looking panel over a run that had never stopped, which then invited a
second run to be started on top of the first. A browser now asks
`GET /api/analysis/active` on load and reattaches to whatever is still going,
progress bar and Cancel button included, and pressing Start while a batch is
already running hands back the run in progress rather than starting another.
Coming back to the foreground also reconnects the event socket immediately,
since a backgrounded tab can be handed back one that looks open and isn't.
(Restarting the *server* is a different matter — see To do.)

The event log a reconnecting client is caught up with is *compacted*: one
`game_start`, one `progress`, one `game_done`, and the failures. Replaying the
real transcript would walk the board through all thousand games again on every
reconnect -- which looks exactly like the batch having restarted -- and would
grow a per-position event log without bound for the length of the run.

Cancel is checked per *position*, not per game, so it takes effect within one
evaluation rather than waiting out a 200-ply game. Everything finished by then
is already saved. A game that fails to parse is recorded and skipped rather
than sinking the run.

The board follows whichever game is being processed, per section 6.

Games run sequentially within a batch, but the batch releases its worker-pool
slots between games -- see above.

### Puzzles from your own games

Every position where you gave something away, handed back as a puzzle. Opening
the tab hands the board to its puzzle mode and asks for one straight away —
there's nothing to set up first — giving you the position you faced, oriented to
the side you had, with the opponent's name and the date, and asking for the move
you should have played.

Four decisions, all of them the difference between a useful set and a pile of
positions:

- **Building them runs no engine.** The position and the move you played come
  from replaying the stored PGN to that ply, so Rescan over a thousand
  analysed games is a few seconds of parsing. What needs an engine is the
  *answer*, and that is computed the first time a puzzle is actually attempted
  and then stored — a library with 4000 blunders in it must not cost 4000
  searches for the dozen you look at.
- **Being right is not "you found Stockfish's move".** Several moves are often
  equally good, and a set that fails you for finding the other winning rook
  teaches nothing. An attempt is graded by evaluating it and comparing win
  probability with the best move; anything within 3% counts, and the feedback
  talks about what a move gave up rather than whether it matched.
- **The move you played is hidden until you've tried.** Knowing it turns "find
  the move" into "find the other move". It's revealed with the verdict, which
  is where the lesson is — and if you play it again the panel says so by name.
- **Positions that were already lost are skipped.** "You were down a rook and
  this made it worse" is not a lesson, and it is the largest source of junk in
  a naive generator. Rescan says how many it left out on those grounds.

Blunders only by default, or blunders and mistakes; random order or worst
first. Show me plays the answer on the board and leaves the puzzle unsolved —
a revealed answer isn't one you found, so it comes round again. The eval bar is
hidden for the duration, for the obvious reason.

### Saved analyses

Every completed analysis is written to the database, so **selecting a
different game no longer throws the result away** -- come back to a game and
its analysis is restored, with the move badges, the summary counts and (for
a full analysis) the Elo estimate and blunder-Elo panel. The game list marks
which games already have one.

Analyses live inside named *runs*, which is the shape batch mode needs: the
Analysis panel has a run picker so new work lands where you want it, and an
existing analysis can be appended into another run without re-running the
engines. Re-analysing a game in the same mode replaces its previous result
rather than accumulating duplicates; a full analysis takes precedence over a
quick one when both exist, since it is a superset.

The standalone Elo sweep is saved too, and it is the one mode that carries an
estimate but no per-move classifications. So the three modes are loaded back
in halves rather than winner-takes-all: the move badges come from the best
run that has moves, the Elo estimate from the most recent run that has one.
Running a sweep after a quick analysis can't blank the badges, and a quick
analysis after a sweep can't blank the estimate. A sweep on its own also
feeds the strength and trend fits, since it produces exactly the same swept
grid a full run does -- it just skips the Stockfish pass.

Per-*position* sweep scores are stored, not just the final labels, which is
what lets the trend view re-bucket without re-running any engine. They are
kept as one character per grid point, which keeps a 1000-game batch to a
sane row count.

A run can be deleted from the picker (🗑), which throws away every analysis in
it -- moves and per-position sweep rows included, so the trend and strength
fits stop counting it immediately. The *games* stay in your library: it's the
analysis that goes, so a run swept with settings you've since changed can be
redone rather than lived with. The default run is emptied rather than removed,
since something has to catch the next analysis and most work lands there.

Games can be deleted from the picker. Deleting cascades to any saved
analysis of that game, and drops the uploaded PGN blob once its last game is
gone.

### Analysis modes

**Quick** is the Stockfish-only pass, which labels every move from what it gave
up against the engine's own best play:

| Label | What it means |
|---|---|
| **Best** | the move the engine picked |
| **Excellent** | under 2% win probability given up |
| **Good** | under 5% |
| **Book** | theory: the opening database has this move played from this position at least five times. Only ever replaces Best/Excellent/Good — a move being popular is not a defence, so if the engine says it dropped the game, the label that says so wins |
| **Inaccuracy** | 5% or more given up |
| **Mistake** | 10% or more |
| **Miss** | a mistake or blunder of a particular shape: the position was winning (80%) and after the move it isn't (55% or less). Losing a won game is a different mistake from drifting from equal to slightly worse, and it's the one worth practising -- so Misses become puzzles alongside mistakes and blunders |
| **Blunder** | 20% or more |

**Full** adds the Maia sweep, and with it two things that need Maia:

- **Great / Brilliant.** A **Great** is the *only* move: it gave up essentially
  nothing, the second-best move the engine could find was far worse, the
  position had more than one legal move to choose between, and players around
  your estimated strength mostly wouldn't have played it. **Brilliant** is a
  Great that also gives up material.
- **Blunder to Elo correlation.** For each mistake or blunder, the weakest
  swept Elo whose Maia choice was the move you actually played -- "a player
  even this weak would have been expected to avoid it". If no swept Elo plays
  it, that's reported as no correlation rather than as a number.

The only-move test is the load-bearing one, and it is why the analysis pass
searches two lines per position rather than one. Without it, "gave up nothing"
is true of most moves in a quiet position, and a sacrifice detector on its own
awards a Brilliant every time something happens to be hanging -- a king
stepping out of a knight fork read as sacrificing the forked rook, which the
fork had already won. The sacrifice test now also compares what the opponent
can take *after* the move against what they could have taken anyway, so
material that was already lost isn't credited to the move that didn't save it.

The spec asked for the Great/Brilliant criteria to be pinned down rather than
improvised. They're settings, defaulting to:

| Setting | Default | Meaning |
|---|---|---|
| Max win-prob given up vs best | `0.02` | near-lossless; allows for the engine having several equal best moves |
| Min win-prob gap to the second-best move | `0.15` | "there was nothing else". +7.0 falling to +2.0 is a gap of `0.25`; a rook for nothing from level material is about `0.4` |
| Max share of players who'd find it | `0.20` | roughly a 1-in-5 move |
| Brilliant | on | Great + a material sacrifice |

A raw centipawn gap would be the obvious way to say "the alternative was much
worse" and is the wrong one: +20 against +15 is 500 centipawns between two
moves that both win trivially. Win probability is what the rest of the
classifier already speaks, and it says the two are the same move.

**When no setting explains the play at all**, the panel now says so rather
than describing the player. The models cover 600 up and match about 47% of a
600-rated player's moves, so a best-case match rate far under that is not the
grid being too narrow -- it is a player no setting predicts, or too few moves
to tell one setting from another. When the best match rate anywhere on the grid
comes in under 70% of what the model manages at the fitted rating, the panel
says the number is where the fit landed rather than a strength. It shows up
alongside a wide interval and a low confidence, and all three mean the same
thing.

**Top-1 matching is the weak part of this method, not the grid.** Asking only
"was this the model's single favourite move" throws away everything else it
believed: a move it ranked second with 30% probability and a move it never
considered both score zero. That is why this needs a hundred positions to
settle when a likelihood over the model's policy -- the probability it gave the
move actually played, at each rating, multiplied across the game -- gets a
usable answer from a couple of dozen. The sweep already stores *where* the
played move ranked (1-9, not just hit/miss), so a rank-weighted likelihood is
available from the cached scores with no extra engine time; the full policy
would need the wrapper to expose per-candidate probabilities. Both are in
[`docs/TODO.md`](docs/TODO.md).

Note the "share who'd find it" is read off the cached sweep matrix as Maia's
match rate in a band around your estimated Elo, not from a single grid point,
so one noisy value can't award a Great on its own. If your Maia build turns
out to expose per-candidate policy probabilities, that would be a more direct
measure and worth switching to.

### Elo estimate

Maia is asked to move in each of your positions at every Elo on the grid.
Where its choice matches the move you actually played, that Elo "explains"
the move; the Elo where the match rate peaks is the estimate.

**Use the "Your strength (all games)" panel, not the per-game one.** A single
game is about 25 of your moves, half of them uninformative, and at that size
the estimate has a standard deviation near 90 Elo — it is a coin flip with an
Elo label. The per-game panel is there to show the shape of one game's curve;
the pooled panel fits one curve to every position from every game with a
stored sweep, and that is the number to act on. Both re-fit cached scores, so
neither runs an engine.

Five things about it are deliberate, and worth knowing before trusting a
number:

- **The peak comes from a parametric fit, not from smoothing.** The curve is
  a broad hump on a baseline — some share of your moves are the obvious move
  every Elo finds, and on top sits a bump centred on your strength — so that
  is what gets fitted (baseline, height, centre, width) and the centre *is*
  the estimate. This replaced a smoothing spline whose argmax was taken as
  the peak, which was measurably biased: on a noiseless symmetric test curve
  peaking at 1300 it returned 1288 over a 1100–1900 grid and **1211** over
  600–2600, because smoothing drags the apex toward the flat tails, worse the
  wider the grid. Simulated at ~1300 discriminative positions the spline gave
  bias −61 / sd 30 Elo where the bump fit gives −1 / sd 10.
- **Positions where Maia's choice never changes across the grid are split
  out.** They carry no information about strength and only add noise. Both
  counts are reported.
- **The interval resamples games, not moves, when games are pooled.** Moves
  from one game share an opponent, an opening and a sitting. With realistic
  between-game variation, resampling moves reported ±18 Elo where resampling
  games reported ±31 — the move-level figure is simply wrong.
- **The noise test is the interval, and it is measured rather than guessed.**
  The obvious alternative — "is the fitted bump tall enough" — is worthless:
  a free-centre fit spikes through a single high point, so under pure noise
  the fitted height reaches 10–90 standard errors, taller than real signal
  ever needs. The bootstrap separates them cleanly, because noise puts the
  peak somewhere else every resample (noise: 5th percentile 0.60 of the swept
  range, median 0.90; real signal with 100+ positions: 95th percentile 0.12).
  An interval covering more than 55% of the range forces Low confidence
  however large the sample — a big sample that still can't locate the peak is
  more evidence there is nothing to locate, not less.
- **A match rate that barely moves across the grid is called out by name.**
  That is what a mis-named Elo option looks like: the engine plays the same
  move at 600 and at 2600. The panel says so and names the likely cause
  instead of reporting the meaningless number that falls out.

**A finer Elo step does not buy a better estimate.** Tempting, since the step
is the most obvious knob, but the estimate is a *fitted* peak, not the best
grid point: the fit returns a continuous centre from all the points at once,
so a 200-Elo grid can and does return 1487. Simulated against the real fitting
code, with the same positions sampled on each grid (120 replicates, true Elo
1500, 600–2600):

| positions | step 200 | step 100 | step 50 | step 25 | engine calls at 25 vs 100 |
|---|---|---|---|---|---|
| 30 (one game) | rmse 62 | 70 | 59 | 61 | 3.9× |
| 400 (~15 games) | rmse 15.2 | 13.7 | 15.8 | 13.7 | 3.9× |
| 2000 (~70 games) | rmse 6.4 | 6.0 | 6.7 | 5.7 | 3.9× |

The step column is flat — the ±10% wobble is the simulation's own noise at
120 replicates, and it isn't even monotonic. What moves the error is the
number of positions: 62 → 15 → 6 Elo. Eleven grid points already
over-determine a four-parameter bump, and adjacent Elos give near-identical
Maia policies, so extra points are nearly-duplicate rows bought at one engine
call per position each. **Pool more games; don't sweep finer.** The step does
control one real thing: `lowest_matching_elo` in the blunder panel ("first
played by Maia at 1400") is reported at grid resolution, so a finer step gives
a finer answer *there*.

**What counts as a match is now a choice you can change for free.** The sweep
records *where* your move ranked in Maia's ordering, not just whether it was
Maia's own first pick — at `go nodes 1` the policy net has already ordered
every legal move, so asking for several ranked candidates (MultiPV, default 3)
costs no extra engine time. The rank goes into the same one-character-per-grid-
point encoding the old sweeps used, so `1`/`0` still means exactly what it did
and nothing needed migrating. The strength panel can then re-fit against "Maia's
top move", "its top 2" or "its top 3" with no engine work at all.

Top-1 stays the default and is the objective the Great/Brilliant rules use —
"a player at this Elo would have played exactly this" is a top-1 question.
The wider objectives are offered because they use more of the information per
position, but they are not verified against a real Maia3 build here, so they
are yours to try rather than the default. A sweep run before MultiPV was
recorded only stored rank 1; the panel says so rather than showing you the
same number under a different label.

**Moves you didn't think about are left out.** Chess.com and lichess exports
carry `%clk` comments, so the time spent on each move is read at upload —
it has to be read then, because the stored PGN drops comments and the clocks
would be unrecoverable — and stored against each swept position. A move played
in under two seconds (configurable) is a premove or an automatic recapture and
says nothing about how well you play, so it doesn't go into the fit. Positions
with no clock recorded are always kept: unknown is not instant, and every game
uploaded before this existed has no clock at all.

The filter refuses to run when it would remove more than 60% of your timed
moves, and says so — point it at a bullet library and it would leave you a
different, much smaller dataset rather than a cleaner one. Whatever it does,
the panel reports it ("Left out 32 of 56 timed moves played in under 2s"). The
opposition is filtered on the same rule so the calibration compares like with
like, and the trend uses it too, so a bucket and the overall number are never
built from different sets of moves.

Every estimate carries a High/Medium/Low label with the reasons spelled out.
A peak on the edge of the swept range caps the label at Medium however clean
the fit looks — the player is probably outside the grid, so the number is a
bound, not a measurement. Widen the range and re-run.

The default grid is **600–2600 step 100**. It used to be 1100–1900, which is
too narrow to locate a peak reliably; anyone still on that exact pair is
widened once automatically, and a range you set deliberately is left alone.

### Which scale is that number on?

Maia-3's SelfElo is calibrated to **Lichess** ratings, which sit a few hundred
points above Chess.com or FIDE at club level. So a raw estimate of 1290 next
to a Chess.com rating of 900 is not a contradiction.

Rather than make you remember a conversion, the panel measures it from your
own games. The sweep already scores your opponents' moves as well as yours,
and the PGN headers say what those opponents were actually rated — so the
same run estimates the field you played, and the gap between the field's
estimate and the field's real average rating *is* the offset between the two
scales. Your estimate is then reported on your opponents' scale too:

> **On your opponents' scale: 944** (95% 916–969)
> Your 104 opponents are rated 908 on average and this sweep estimates them
> at 1255, so the Maia scale sits +347 above the rating pool you play in.

The conversion is withheld — with the reason given — when the opposition
estimate isn't firm enough to anchor it (low confidence, or a peak pinned to
the edge of the grid). Subtracting an offset measured off a curve that isn't
there would produce a confident-looking figure built on nothing.

The full per-(position, Elo) score matrix is kept, so re-fitting later never
re-runs the engine.

### Play vs Maia3 — how the model size is chosen

Maia3 ships the model size as a **separate executable**, not a UCI option:
`maia3-5m`, `maia3-23m` and `maia3-79m` are distinct pip console-script
entry points (`maia3.presets:main_5m` / `main_23m` / `main_79m`), while
`maia3-uci` is the generic entry point. That is why pointing the app at
`maia3-uci.exe` and choosing a size did nothing -- there is no model-size
option on that binary to set.

So the model-size setting picks a **binary**. Select any maia3 executable in
Settings and the app resolves the sibling `maia3-<size>` for the chosen size,
matching the extension (`.exe` on Windows). The dialog lists only the sizes it
can actually find on disk and shows which binary will be launched;
`/api/engines/status` reports the running binary too, so there's no guessing
about which model actually played. If no matching executable exists alongside
the selected one, it says so in amber and runs the selected binary unchanged
rather than pretending the setting took effect.

Sizes are discovered from disk rather than hardcoded: the spec named
5m/25m/79m, but the shipped distribution is 5m/**23m**/79m.

Maia is asked for its move with `go nodes 1`, which is what makes a Maia
policy net reproduce human move choice instead of searching. Its reply is
held back by a randomised ~0.5-2s pause so it doesn't answer instantly, and
that pause is charged to Maia's own clock (capped so it can never be the
thing that flags it).

**Pre-moves.** Queue your reply while Maia is still thinking and it plays the
instant its move lands — the point being the obvious reply, a recapture or a
check you'd already decided on, where waiting for the board costs you seconds
you didn't need to spend. The squares offered are the piece's *movement
pattern*, not its legal moves: at pre-move time the opponent hasn't moved, so
what's legal isn't knowable yet — a rook can be pre-moved through a square its
blocker is about to leave, and a capture aimed at a square nothing is on yet is
the usual case. Legality is settled when it's played, and a pre-move that
doesn't fit the position that arrives is dropped rather than forced. Touching
the board withdraws it, the marks are a different colour from the last move
(it might never happen), and the whole thing can be turned off in the board
settings.

**You can look back through the game while you're playing it.** The nav
buttons, the arrow keys and the move list all work mid-game: they walk the
board through the game so far without pausing anything. The game carries on
underneath -- a reply arriving while you're looking back goes into the move
list but does not drag the board back to it, and it can't be undone by an
animation landing a fifth of a second after you tapped away from it. While
the board is behind the game a note under it says so and takes you back in
one tap, and moving is refused until you are: a move from a position the game
has left behind is a move in a different game. The clock never stops for any
of this, which is the honest behaviour -- looking back at your own game is
your time to spend.

Still not verified against a real Maia3 build: the binaries in
`assets/Engines/` are Windows executables and the dev environment is Linux,
so the game loop was exercised with Stockfish and a scripted UCI stand-in.
The Elo option is still probed rather than assumed (`UCI_Elo`, `Elo`,
`MaiaElo`, ...); if the Play panel reports "Elo NOT applied", tell me what
your build advertises.

## Running it

**Linux / macOS:**

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
STOCKFISH_PATH=/path/to/stockfish .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Windows (PowerShell):**

```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
$env:STOCKFISH_PATH = "C:\path\to\stockfish.exe"
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Setting `STOCKFISH_PATH` is optional -- it's simpler to drop the engines into
`assets/Engines/` (see below) and pick them in Settings.

The stack is plain Python/FastAPI/SQLite plus vanilla JS in the browser, so
Windows works the same way as Linux -- this has been exercised against a real
Stockfish binary and a real browser on Linux, but not (yet) on an actual
Windows machine. For always-on hosting you'll want to run it as a Windows
service (e.g. via NSSM or Task Scheduler) rather than a terminal window,
which isn't set up here yet.

Then open `http://<server>:8000/` from a phone or laptop on the same
network/Tailscale tailnet. The first run has no accounts -- use "Add an
account" on the login screen to create the two profiles, then pick your
engines and set threads/hash/depth from the Settings dialog.

The **display name is what decides which side of each game was yours**: it is
matched against the `White`/`Black` headers of everything you upload, so make
it your chess.com or Lichess handle. The account name is tried as well, so
getting only one of the two right still works.

Each account on the login screen has a pencil and a cross next to it. The
pencil renames it -- and re-matches every game already uploaded against the
new names, which is the fix if a library came in as "unassigned". The cross
deletes the account and everything filed under it (games, uploads, saved
analyses, puzzles, engine settings); it says how much that is first, and asks
for the account name to be typed when there are games at stake. Neither
needs you to be logged in, since an account with the wrong name typed into
it is exactly the one you may not be able to get into.

## Engines

Engines live under `assets/Engines/`. Drop a whole release folder in and it
is picked up automatically:

```
assets/Engines/
  Stockfish-18/stockfish-windows-x86-64-avx2.exe
  maia3-5m.exe  maia3-23m.exe  maia3-79m.exe  maia3-uci.exe
```

The Settings dialog then offers those binaries by name in a dropdown. **The
browser never sees or supplies a filesystem path** -- it sends back one of
the names the server discovered, and every use of that name is re-resolved
against the Engines directory, rejecting anything that escapes it (`..`
segments, absolute paths, and symlinks are all checked via `realpath`).

This is deliberate: the login is a passwordless profile pick, so anything
the page can do, anyone who reaches the page can do. An earlier build had a
`/api/fs/browse` endpoint backing a file picker, which let any session
enumerate the whole drive -- that endpoint is gone. The Engines directory is
also excluded from the static file mount, so the binaries can't be
downloaded over HTTP either.

`STOCKFISH_PATH` / `MAIA_PATH` still override, and may point anywhere --
they're set by whoever starts the server, never by the browser.

Note the `.gitignore` keeps engine *subfolders* out of the repo (a Stockfish
release is ~40MB); the small Maia console-script wrappers at the top level
are tracked. Install the big engines on each machine.

The `assets/sets/default/` piece and board images are placeholders generated
by `assets/generate_placeholder_set.py`; drop a nicer set into
`assets/sets/<name>/` (same filenames: `board.png`, `wp.png`, `bn.png`, ...)
whenever you want -- no code changes needed, it shows up as another option in
the Settings dialog's "Board / piece set" picker (each user can choose their
own, with a live preview before saving).

## To do

In [`docs/TODO.md`](docs/TODO.md), with notes on what data each one already
has and what it would need. The shortest version: an opening repertoire
report, a "when do you play best" view binned by time of day, think-time vs
quality, phase-by-phase Elo, drag-and-drop, and making a batch survive a
restart of the server itself.

## Open questions still to confirm

Carried over from the spec (section 18):
- Whether saved games preserve variations or only the mainline (gates step 8).

Answered by defaulting, not by asking -- change them in Settings if the feel
is wrong:
- Great/Brilliant closeness and match-rate thresholds (see the table above).

Answered, and now built:
- Play-vs-Maia clock: yes, configurable base + increment.
- Maia move timing: yes, a brief randomised delay rather than instant replies.

The trend view needs `WhiteElo`/`BlackElo` and a date in the PGN headers, and
needs a side assigned to the game -- by a name match or by hand. Chess.com and
lichess exports carry all three; a hand-written PGN may not, and the panel
says how many games it had to leave out and why.
