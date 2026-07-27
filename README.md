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
opens flipped, with your pieces at the bottom. A plate above and below the
board names the two players with their header ratings, marks which one is
you, shows the result once the game is over, and carries the clocks during a
game against Maia. The plates follow the board, so the name under the board
is always whoever is at the bottom.

`⇅` (or the `f` key) flips it manually; selecting another game clears that
and goes back to facing you. Where your display name matches neither PGN
header the board takes the conventional White-at-bottom view and no plate
claims to be you, rather than guessing.

On a wide screen the layout is three columns -- board, move table, then
everything else -- putting the move table beside the board as section 5 asks.
They wrap in that order on anything narrower, so a phone gets board, moves,
then the panels.

The move table keeps your moves in the left column whichever colour you
played (section 5), which is confusing without a header saying so — so the
columns are labelled with the two players' names.

### Evaluation plot

Under the board, once a game has been analysed: the whole game's evaluation,
with the mistakes and blunders marked on the curve, hover for the move and
its win probability, click anywhere to jump the board there.

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
headers, bucketed by ISO week, month or year and optionally scoped to one
run. Switching granularity **re-fits the cached per-position sweep scores and
never touches an engine** -- that is the whole reason section 13 stores the
score matrices rather than just the final numbers.

Two things about it are deliberate:

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

Cancel is checked per *position*, not per game, so it takes effect within one
evaluation rather than waiting out a 200-ply game. A game that fails to parse
is recorded and skipped rather than sinking the run.

The board follows whichever game is being processed, per section 6.

Games run sequentially within a batch, but the batch releases its worker-pool
slots between games -- see above.

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

Per-*position* sweep scores are stored, not just the final labels, which is
what lets the trend view re-bucket without re-running any engine. They are
kept as one character per grid point, which keeps a 1000-game batch to a
sane row count.

Games can be deleted from the picker. Deleting cascades to any saved
analysis of that game, and drops the uploaded PGN blob once its last game is
gone.

### Analysis modes

**Quick** is the Stockfish-only pass. **Full** adds the Maia sweep, and with
it two things that need Maia:

- **Great / Brilliant.** A move qualifies when it gave up essentially nothing
  against the engine's own best play *and* players around your estimated
  strength mostly wouldn't have found it. Brilliant is Great plus a material
  sacrifice, detected with a static exchange evaluation (both a capture into
  a losing exchange and a quiet move that leaves something hanging count).
- **Blunder to Elo correlation.** For each mistake or blunder, the weakest
  swept Elo whose Maia choice was the move you actually played -- "a player
  even this weak would have been expected to avoid it". If no swept Elo plays
  it, that's reported as no correlation rather than as a number.

The spec asked for the two Great/Brilliant criteria to be pinned down rather
than improvised. They're settings, defaulting to:

| Setting | Default | Meaning |
|---|---|---|
| Max win-prob given up vs best | `0.02` | near-lossless; allows for the engine having several equal best moves |
| Max share of players who'd find it | `0.20` | roughly a 1-in-5 move |
| Brilliant | on | Great + a material sacrifice |

Note the "share who'd find it" is read off the cached sweep matrix as Maia's
match rate in a band around your estimated Elo, not from a single grid point,
so one noisy value can't award a Great on its own. If your Maia build turns
out to expose per-candidate policy probabilities, that would be a more direct
measure and worth switching to.

### Elo sweep

Maia is asked to move in each of your positions at every Elo on the
configured grid; the Elo whose match rate peaks is the estimate, shown per
player with a fitted curve and a 95% interval.

Three things about it are deliberate, and worth knowing before trusting a
number:

- Positions where Maia's choice never changes across the whole grid carry no
  information about strength, so they're split out and only the
  discriminative ones are fitted. Both counts are reported.
- The same positions are scored at every grid point, so errors are
  correlated along the grid rather than independent. The usual i.i.d.
  smoothing heuristic under-smooths badly here and lets the fitted peak get
  captured by boundary overshoot, so smoothing starts above that heuristic
  and escalates until the curve stops overshooting, falling back to a
  heavily smoothed weighted polynomial if a spline can't be tamed.
- The bootstrap resamples *positions*, the independent sampling unit, and
  rebuilds the curve from the cached score matrix -- so no engine work is
  repeated, and the interval reflects the real sampling noise.

Every estimate carries a High/Medium/Low label with the reasons spelled out
(sample size, peak prominence, interval width). A peak sitting on the edge
of the swept range caps the label at Medium however clean the fit looks: it
means the player is probably outside the grid, so the number is a bound, not
a measurement -- widen the Elo range and re-run.

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
needs your display name to match the White or Black header. Chess.com and
lichess exports carry all three; a hand-written PGN may not, and the panel
says how many games it had to leave out and why.
