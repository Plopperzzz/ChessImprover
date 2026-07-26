"""Engine registry: the only place the app is allowed to launch binaries from.

Engines live under assets/Engines/ (drop a whole release folder in, e.g.
assets/Engines/Stockfish-18/...). The browser never sees or supplies an
absolute path -- it picks a name from a discovered list, and what gets
stored is a path *relative to* the Engines directory. Every use of that
value is re-resolved through resolve() below, which refuses anything that
escapes the sandbox.

This replaces the old /api/fs/browse endpoint, which let any logged-in
session enumerate the whole filesystem. Given the login is a passwordless
profile pick, that was effectively "anyone who can reach the page can read
the drive layout".
"""

import os

from .paths import ENGINES_DIR

# Depth/count caps so a stray huge tree can't turn discovery into a stall.
MAX_DEPTH = 5
MAX_RESULTS = 400

# Things that live in engine release folders but are never the engine.
NON_BINARY_EXTS = {
    ".txt", ".md", ".pdf", ".html", ".htm", ".json", ".yml", ".yaml", ".xml",
    ".nnue", ".gz", ".zip", ".tar", ".7z", ".dll", ".so", ".dylib", ".lib",
    ".cfg", ".ini", ".log", ".csv", ".png", ".jpg", ".svg", ".epd", ".pgn",
    ".bin", ".pb", ".h", ".c", ".cpp", ".hpp", ".py", ".pyc",
}
WINDOWS_EXECUTABLE_EXTS = {".exe", ".bat", ".cmd", ".com"}


def _looks_executable(path: str, name: str) -> bool:
    ext = os.path.splitext(name)[1].lower()
    if ext in WINDOWS_EXECUTABLE_EXTS:
        # Trust the extension: a Windows binary checked out on Linux (or via
        # git, which only tracks one exec bit) won't have the mode set.
        return True
    if ext in NON_BINARY_EXTS:
        return False
    return os.access(path, os.X_OK) and os.path.isfile(path)


def discover() -> list[dict]:
    """Every plausible engine binary under the Engines directory, as paths
    relative to it. Sorted for a stable dropdown."""
    base = ENGINES_DIR
    if not os.path.isdir(base):
        return []
    found: list[dict] = []
    for root, dirs, files in os.walk(base):
        rel_root = os.path.relpath(root, base)
        depth = 0 if rel_root == "." else rel_root.count(os.sep) + 1
        if depth >= MAX_DEPTH:
            dirs[:] = []
            continue
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            if not _looks_executable(full, name):
                continue
            rel = os.path.relpath(full, base)
            found.append({
                "value": rel.replace(os.sep, "/"),  # stable across platforms
                "name": name,
                "folder": "" if rel_root == "." else rel_root.replace(os.sep, "/"),
            })
            if len(found) >= MAX_RESULTS:
                return found
    return found


def resolve(relative: str | None) -> str | None:
    """Turn a stored selection into an absolute path, or None if it isn't a
    real file inside the Engines directory. Uses realpath on both sides so
    `..` segments and symlinks can't be used to point outside the sandbox."""
    if not relative:
        return None
    base = os.path.realpath(ENGINES_DIR)
    target = os.path.realpath(os.path.join(base, relative))
    if target != base and not target.startswith(base + os.sep):
        return None
    if not os.path.isfile(target):
        return None
    return target


def is_valid_selection(relative: str | None) -> bool:
    return relative is None or relative == "" or resolve(relative) is not None
