import asyncio
import sys

from fastapi import Depends, FastAPI
from fastapi.responses import PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from .analysis import router as analysis_router
from .batch import router as batch_router
from .chesscom import router as chesscom_router
from .collections import router as collections_router
from .analysis import ws_router as analysis_ws_router
from .auth import require_user
from .auth import router as auth_router
from .db import init_db
from .engine_manager import job_engine_status, manager
from .engine_settings import router as settings_router
from .games import router as games_router
from .jobqueue import pool
from .live_eval_ws import router as ws_router
from .mistake_check import router as mistake_check_router
from .move_quality import router as move_quality_router
from .openings import router as openings_router
from .paths import (
    ASSETS_DIR,
    FRONTEND_DIR,
    WEB_DIST_DIR,
    asset_set_details,
    list_audio_sets,
    list_board_images,
    web_built,
)
from .play import router as play_router
from .play import status as play_status
from .puzzles import router as puzzles_router
from .runs import router as runs_router
from .strength import router as strength_router
from .sweep_job import router as sweep_router
from .trend import router as trend_router
from .variations import router as variations_router

# Managing engine subprocesses via piped stdin/stdout (section 3) only works
# on Windows under the Proactor event loop -- it's the default today, but
# pin it explicitly so a future asyncio/uvicorn default change can't quietly
# break Stockfish/Maia process spawning there.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

app = FastAPI(title="ChessImprover Engine Room")


@app.on_event("startup")
async def on_startup():
    init_db()
    # Which UI is at '/' is decided by whether web/dist exists, and a checkout
    # that has never had `npm run build` run in it silently serves the classic
    # one. Silently is the problem: it looks like the fetch didn't take. Say so.
    if web_built():
        print("[engine-room] serving the React UI at /  (classic UI at /legacy/)")
    else:
        print("[engine-room] serving the CLASSIC UI at / -- web/dist not found.\n"
              "[engine-room] to get the React UI: cd web && npm install && npm run build,\n"
              "[engine-room] then restart this server.")
    await manager.start_idle_sweep()


@app.on_event("shutdown")
async def on_shutdown():
    await manager.shutdown_all()


app.include_router(auth_router)
app.include_router(settings_router)
# Before the games router: its '/{game_id}' route is a single segment and
# can't swallow these, but keeping the more specific prefix first makes that
# independent of how the other router's paths evolve.
app.include_router(chesscom_router)
app.include_router(games_router)
app.include_router(collections_router)
app.include_router(ws_router)
app.include_router(analysis_router)
app.include_router(analysis_ws_router)
app.include_router(play_router)
app.include_router(sweep_router)
app.include_router(runs_router)
app.include_router(batch_router)
app.include_router(trend_router)
app.include_router(openings_router)
app.include_router(strength_router)
app.include_router(move_quality_router)
app.include_router(mistake_check_router)
app.include_router(variations_router)
app.include_router(puzzles_router)


@app.get("/api/asset-sets")
def get_asset_sets(user: dict = Depends(require_user)):
    """Name plus what each set contains, so the board and piece pickers can
    each offer only the sets that have something for them."""
    return asset_set_details()

@app.get("/api/board-images")
def get_board_images(user: dict = Depends(require_user)):
    return list_board_images()

@app.get("/api/audio-sets")
def get_audio_sets(user: dict = Depends(require_user)):
    """The sound sets on disk, each a subdirectory of assets/audio/ holding the
    same file names. `default` is the original flat directory, moved into one
    when sets became selectable (B9)."""
    return list_audio_sets()

@app.get("/api/engines/status")
def engines_status(user: dict = Depends(require_user)):
    """Process accounting: how many engine processes are alive and who owns
    each, so runaway spawning is obvious during development (section 3).
    Covers both persistent pools -- live-eval sessions and play-vs-Maia
    sessions; analysis-job engines are short-lived and listed separately at
    /api/analysis/jobs."""
    return ([{"kind": "live-eval", **s} for s in manager.status()]
            + play_status() + job_engine_status())


@app.get("/api/jobs/pool")
def pool_status(user: dict = Depends(require_user)):
    """Worker-pool accounting (section 10): capacity, what's running and
    what's queued behind it. Deliberately not filtered to the calling user --
    the point is to see *why* your job is waiting, and a home server with two
    accounts has nothing to hide here."""
    return pool.status()


class RevalidatingStaticFiles(StaticFiles):
    """StaticFiles that always sends `Cache-Control: no-cache`.

    Starlette sends ETag/Last-Modified but no Cache-Control at all. With no
    explicit freshness directive a browser falls back to *heuristic* caching
    (RFC 9111 section 4.2.2 -- commonly 10% of the file's age) and may reuse a
    response for hours without ever asking the server about it. On a
    self-hosted app that's updated with `git pull`, that means a phone which
    already loaded the old app.js/board.js keeps running it after a redeploy,
    and a piece/board image replaced in-place at the same URL keeps rendering
    the old art.

    `no-cache` does not disable caching -- it requires revalidation, so the
    common case is a 304 with an empty body (cheap on a LAN) and an updated
    file is picked up immediately.
    """

    def file_response(self, full_path, stat_result, scope: Scope, status_code: int = 200) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "no-cache"
        return response


class AssetStaticFiles(RevalidatingStaticFiles):
    """Serves assets/ but never the Engines subdirectory. Engine binaries sit
    under assets/ for convenience, and the app launches them server-side --
    there is no reason to also hand them out over HTTP."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        first = path.replace("\\", "/").lstrip("/").split("/", 1)[0]
        if first.lower() == "engines":
            return PlainTextResponse("Not Found", status_code=404)
        return await super().get_response(path, scope)


class SpaStaticFiles(RevalidatingStaticFiles):
    """StaticFiles for a single-page app: anything that isn't a real file falls
    back to index.html so a deep link doesn't 404 on reload."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 404:
            return await super().get_response("index.html", scope)
        return response


app.mount("/assets", AssetStaticFiles(directory=ASSETS_DIR), name="assets")

# The classic UI keeps working, at its own prefix, and stays the app's front
# door until the React bundle has been built. Play vs Maia, puzzles, batch
# runs, the chess.com import and the opening explorer still live only there,
# and the React UI links across to it for them.
app.mount("/legacy", RevalidatingStaticFiles(directory=FRONTEND_DIR, html=True), name="legacy")

# Mounted last: a mount at "/" matches everything, so it has to come after the
# API routers and the two prefixed mounts above.
if web_built():
    app.mount("/", SpaStaticFiles(directory=WEB_DIST_DIR, html=True), name="web")
else:
    app.mount("/", RevalidatingStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
