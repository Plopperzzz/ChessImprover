# Engine Room

A home-server chess analysis app for two users, built around local Stockfish
and Maia3 engines. See `docs/spec.md` for the full build spec this project
follows.

## Status

This covers build-order steps 1-8 from the spec: multi-user schema and auth,
PGN upload/parsing, the board/move-table/FEN viewer, a live Stockfish eval bar
backed by a persistent per-session engine process, variation support (a real
move tree -- branch off the mainline by playing a different move, delete a
variation, the mainline itself is never lost), Quick-mode analysis (a
Stockfish-only pass classifying every mainline move as Good/Inaccuracy/
Mistake/Blunder, with the board animating through positions as they're
evaluated), Play vs Maia3 with a configurable time control, the Maia Elo
sweep, Great/Brilliant classification with the blunder-Elo correlation, and
saved analysis runs. Batch mode and the trend view are not yet built.

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

Per-*position* sweep scores are stored, not just the final labels, so the
trend view will be able to re-bucket without re-running any engine. They are
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
