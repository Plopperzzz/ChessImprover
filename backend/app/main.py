import asyncio
import sys

from fastapi import Depends, FastAPI
from fastapi.responses import PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from .analysis import router as analysis_router
from .analysis import ws_router as analysis_ws_router
from .auth import require_user
from .auth import router as auth_router
from .db import init_db
from .engine_manager import manager
from .engine_settings import router as settings_router
from .games import router as games_router
from .live_eval_ws import router as ws_router
from .paths import ASSETS_DIR, FRONTEND_DIR, list_asset_sets
from .play import router as play_router
from .play import status as play_status
from .sweep_job import router as sweep_router

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
    await manager.start_idle_sweep()


@app.on_event("shutdown")
async def on_shutdown():
    await manager.shutdown_all()


app.include_router(auth_router)
app.include_router(settings_router)
app.include_router(games_router)
app.include_router(ws_router)
app.include_router(analysis_router)
app.include_router(analysis_ws_router)
app.include_router(play_router)
app.include_router(sweep_router)


@app.get("/api/asset-sets")
def get_asset_sets(user: dict = Depends(require_user)):
    return list_asset_sets()


@app.get("/api/engines/status")
def engines_status(user: dict = Depends(require_user)):
    """Process accounting: how many engine processes are alive and who owns
    each, so runaway spawning is obvious during development (section 3).
    Covers both persistent pools -- live-eval sessions and play-vs-Maia
    sessions; analysis-job engines are short-lived and listed separately at
    /api/analysis/jobs."""
    return [{"kind": "live-eval", **s} for s in manager.status()] + play_status()


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


app.mount("/assets", AssetStaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/", RevalidatingStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
