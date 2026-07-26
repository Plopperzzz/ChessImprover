import asyncio
import sys

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles

from .auth import require_user
from .auth import router as auth_router
from .db import init_db
from .engine_manager import manager
from .engine_settings import router as settings_router
from .fs_browse import router as fs_router
from .games import router as games_router
from .live_eval_ws import router as ws_router
from .paths import ASSETS_DIR, FRONTEND_DIR, list_asset_sets

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
app.include_router(fs_router)
app.include_router(games_router)
app.include_router(ws_router)


@app.get("/api/asset-sets")
def get_asset_sets(user: dict = Depends(require_user)):
    return list_asset_sets()


@app.get("/api/engines/status")
def engines_status(user: dict = Depends(require_user)):
    """Process accounting: how many engine processes are alive and who owns
    each, so runaway spawning is obvious during development (section 3)."""
    return manager.status()


app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
