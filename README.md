# Engine Room

A home-server chess analysis app for two users, built around local Stockfish
and Maia3 engines. See `docs/spec.md` for the full build spec this project
follows.

## Status

This covers build-order steps 1-3 from the spec: multi-user schema and auth,
PGN upload/parsing, the board/move-table/FEN viewer, a live Stockfish eval bar
backed by a persistent per-session engine process, and variation support (a
real move tree -- branch off the mainline by playing a different move,
delete a variation, the mainline itself is never lost). Move classification,
the Maia Elo sweep, play-vs-Maia, persistence, batch mode, and the trend view
are not yet built.

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

Carried over from the spec (section 18), not yet needed for what's built so
far but will gate later steps:
- Great/Brilliant Maia-match-rate threshold and Good/Best-move closeness
  criterion (needed for move classification).
- Whether saved games preserve variations or only the mainline.
- Whether Play-vs-Maia needs a clock, and whether to simulate Maia's move
  time so it doesn't respond instantly.
