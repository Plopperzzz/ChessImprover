# web/ — the React UI

A React + Vite + Tailwind front end for the same FastAPI backend the classic UI
talks to. There is no second server and no second database: every screen here
calls `/api/...` and the two websockets, exactly as `frontend/js/app.js` does.

## Running it

```
cd web
npm install
npm run build      # -> web/dist, which the FastAPI app serves at /
```

Then start the backend as usual. `backend/app/main.py` mounts `web/dist` at `/`
**if it has been built**, and falls back to the classic UI otherwise — so a
fresh checkout still boots into a working app before anyone runs npm.

The classic UI is always served at `/legacy/`, whether or not this one is built.

For development against a running backend on port 8000:

```
npm run dev        # vite on :5173, proxying /api, /assets, /legacy and /ws
```

## What is here

| Screen | Backed by |
| --- | --- |
| **Game Analysis** | `/api/games`, `/api/analysis/*`, `/api/sweep/*`, `/ws/analysis/{job}`, `/ws/live-eval` |
| **Progress** | `/api/strength`, `/api/trend` |
| **Play Maia**, **Puzzles** | not rebuilt yet — these link across to `/legacy/` |

### Full analysis

The **Full analysis** button posts to `POST /api/sweep/full` and follows the job
over `/ws/analysis/{job_id}`. That endpoint is the Stockfish pass *and* the Maia
Elo sweep in one job (`sweep_job.run_full`): the progress bar names which of the
two passes is running and, during the sweep, which Elo on the grid Maia is being
asked at. When it finishes the panel below the move list shows the fitted
estimate per side with its confidence interval, the reasons the fit gives for
its own confidence, and the observed-vs-fitted match rate across the grid.

**Quick** is the Stockfish-only pass (`POST /api/analysis/quick`) — it classifies
moves but produces no rating, because there is no sweep in it.

## Not ported from the classic UI

These still work, at `/legacy/`, and are not duplicated here:

- Play vs Maia3, and puzzles (own-mistakes and the Lichess database)
- Batch analysis over many games
- The chess.com import and collection/group management
- The opening database explorer
- Bulk delete, colour re-matching, and the per-engine UCI option editor

The React UI links to `/legacy/` from the library panel and from the two screens
that have not been rebuilt.
