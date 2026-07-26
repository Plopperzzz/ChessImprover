import os
import string
import sys

from fastapi import APIRouter, Depends, HTTPException

from .auth import require_user

router = APIRouter(prefix="/api/fs", tags=["fs"])

# Server-side directory browser backing the engine-path pickers in the settings
# dialog (browser file inputs can't expose an absolute path). This app is a
# trusted, authenticated, LAN-only home tool -- both users are meant to be able
# to see the server's filesystem to locate engine binaries.
#
# Every entry carries its own full_path so the frontend never has to guess a
# path separator -- Windows has no single filesystem root, so an empty path
# there lists drives instead of descending into one.


def _windows_drives() -> list[str]:
    return [f"{letter}:\\" for letter in string.ascii_uppercase if os.path.exists(f"{letter}:\\")]


@router.get("/browse")
def browse(path: str = "", user: dict = Depends(require_user)):
    if sys.platform == "win32" and not path:
        return {
            "path": "This PC",
            "parent": None,
            "entries": [{"name": d, "is_dir": True, "full_path": d} for d in _windows_drives()],
        }

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
                entries.append({"name": entry.name, "is_dir": is_dir, "full_path": os.path.join(target, entry.name)})
    except PermissionError:
        raise HTTPException(403, f"permission denied: {target}")
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))

    if sys.platform == "win32":
        drive, rest = os.path.splitdrive(target)
        # "" (not None) means "go back to the drive list", distinct from no-parent-at-all.
        parent = "" if rest in ("", os.sep) else os.path.dirname(target)
    else:
        parent = None if target == "/" else os.path.dirname(target)
    return {"path": target, "parent": parent, "entries": entries}
