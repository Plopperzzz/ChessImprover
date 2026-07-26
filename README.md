# Engine Room

A home-server chess analysis app for two users, built around local Stockfish
and Maia3 engines. See `docs/spec.md` for the full build spec this project
follows.

## Status

This is an early increment covering build-order steps 1-2 from the spec:
multi-user schema and auth, PGN upload/parsing, the board/move-table/FEN
viewer, and a live Stockfish eval bar backed by a persistent per-session
engine process. Move classification, the Maia Elo sweep, variations,
play-vs-Maia, persistence, batch mode, and the trend view are not yet built.

## Running it

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
STOCKFISH_PATH=/path/to/stockfish .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then open `http://<server>:8000/` from a phone or laptop on the same
network/Tailscale tailnet. The first run has no accounts -- use "Add an
account" on the login screen to create the two profiles, then configure each
user's Stockfish binary path (or rely on the `STOCKFISH_PATH` env var as a
fallback), threads, hash, and search depth/movetime from the Settings dialog.

The `assets/sets/default/` piece and board images are placeholders generated
by `assets/generate_placeholder_set.py`; drop a nicer set into
`assets/sets/<name>/` (same filenames: `board.png`, `wp.png`, `bn.png`, ...)
whenever you want -- it's picked up automatically, no code changes needed.

## Open questions still to confirm

Carried over from the spec (section 18), not yet needed for what's built so
far but will gate later steps:
- Great/Brilliant Maia-match-rate threshold and Good/Best-move closeness
  criterion (needed for move classification).
- Whether saved games preserve variations or only the mainline.
- Whether Play-vs-Maia needs a clock, and whether to simulate Maia's move
  time so it doesn't respond instantly.
