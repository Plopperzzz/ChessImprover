# Engine Room

A home-server chess analysis app for two users, built around local Stockfish
and Maia3 engines. See `docs/spec.md` for the full build spec this project
follows.

## Status

This covers build-order steps 1-5 from the spec: multi-user schema and auth,
PGN upload/parsing, the board/move-table/FEN viewer, a live Stockfish eval bar
backed by a persistent per-session engine process, variation support (a real
move tree -- branch off the mainline by playing a different move, delete a
variation, the mainline itself is never lost), Quick-mode analysis (a
Stockfish-only pass classifying every mainline move as Good/Inaccuracy/
Mistake/Blunder, with the board animating through positions as they're
evaluated), and Play vs Maia3 with a configurable time control. The Maia Elo
sweep, Great/Brilliant classification, saved analysis runs, batch mode, and
the trend view are not yet built.

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
- Great/Brilliant Maia-match-rate threshold and Good/Best-move closeness
  criterion (gates step 7).
- Whether saved games preserve variations or only the mainline (gates step 8).

Answered, and now built:
- Play-vs-Maia clock: yes, configurable base + increment.
- Maia move timing: yes, a brief randomised delay rather than instant replies.
