import os

from fastapi import APIRouter, Depends, HTTPException

from .auth import require_user

router = APIRouter(prefix="/api/fs", tags=["fs"])

# Server-side directory browser backing the engine-path pickers in the settings
# dialog (browser file inputs can't expose an absolute path). This app is a
# trusted, authenticated, LAN-only home tool -- both users are meant to be able
# to see the server's filesystem to locate engine binaries.


@router.get("/browse")
def browse(path: str = "/", user: dict = Depends(require_user)):
    target = os.path.abspath(path or "/")
    if not os.path.isdir(target):
        raise HTTPException(400, f"not a directory: {target}")
    entries = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir(follow_symlinks=True)
                except OSError:
                    continue
                entries.append({"name": entry.name, "is_dir": is_dir})
    except PermissionError:
        raise HTTPException(403, f"permission denied: {target}")
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    parent = os.path.dirname(target) if target != "/" else None
    return {"path": target, "parent": parent, "entries": entries}
