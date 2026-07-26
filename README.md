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

### Play vs Maia3 — read this before your first game

The Maia integration is written against the UCI protocol and **has not been
run against a real Maia3 build** -- there is no Maia binary in the
development environment, so the game loop, clock, legality, and save-to-
library were verified with Stockfish standing in as the UCI engine.

Because wrappers disagree about option names, the app does not assume any:
on connect it reads the engine's advertised `option` lines and looks for an
Elo knob (`UCI_Elo`, `Elo`, `MaiaElo`, ...) and a model-size knob
(`ModelSize`, `Model`, `Weights`, ...). Whatever it did or could not apply
is reported in the Play panel, in amber when something was skipped -- e.g.
"model size NOT applied: engine advertises no recognised model/weights
option". If you see that with real Maia3, tell me the option names your
build advertises and I'll wire them up; the app will never silently pretend
a setting took effect.

Maia is asked for its move with `go nodes 1`, which is what makes a Maia
policy net reproduce human move choice instead of searching. Its reply is
held back by a randomised ~0.5-2s pause so it doesn't answer instantly, and
that pause is charged to Maia's own clock (capped so it can never be the
thing that flags it).

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

The stack is plain Python/FastAPI/SQLite plus vanilla JS in the browser, so
Windows works the same way as Linux -- this has been exercised against a real
Stockfish binary and a real browser on Linux, but not (yet) on an actual
Windows machine. The engine settings dialog's "Browse..." file picker lists
drives (`C:\`, `D:\`, ...) instead of a single `/` root when running on
Windows. For always-on hosting you'll want to run it as a Windows service
(e.g. via NSSM or Task Scheduler) rather than a terminal window, which isn't
set up here yet.

Then open `http://<server>:8000/` from a phone or laptop on the same
network/Tailscale tailnet. The first run has no accounts -- use "Add an
account" on the login screen to create the two profiles, then configure each
user's Stockfish binary path (or rely on the `STOCKFISH_PATH` env var as a
fallback), threads, hash, and search depth/movetime from the Settings dialog.

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
