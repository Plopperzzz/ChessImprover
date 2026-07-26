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


# Stockfish ships one binary per instruction set. Prefer widely-supported
# builds over exotic ones: picking avx512 on a CPU without it crashes on
# launch, and the speed difference is small next to that. The user can
# override per family if they want the fastest their CPU actually supports.
BUILD_PREFERENCE = [
    "avx2", "bmi2", "sse41-popcnt", "popcnt", "modern",
    "ssse3", "sse3", "x86-64", "vnni512", "avx512", "vnni256",
]

# Support tools shipped alongside an engine that aren't the engine itself.
NON_ENGINE_STEMS = {"maia3-cache"}


def _build_rank(name: str) -> int:
    """Rank by the instruction-set suffix, which is always at the end of a
    Stockfish filename. Matching anywhere in the string would be wrong --
    every name contains 'x86-64', so 'stockfish-...-x86-64-avx512' would
    match the generic build rather than avx512."""
    stem = os.path.splitext(name)[0].lower()
    tokens = stem.split("-")
    for i, candidate in enumerate(BUILD_PREFERENCE):
        parts = candidate.split("-")
        if tokens[-len(parts):] == parts:
            return i
    return len(BUILD_PREFERENCE)  # unknown build: after all known ones


def _family_of(rel_path: str, name: str) -> tuple[str, str]:
    """(family id, variant label) for a discovered binary.

    A binary inside a subfolder belongs to that folder (a Stockfish release
    folder is the product). A binary at the top level is grouped by its name
    with any trailing -<variant> stripped, which is what collapses
    maia3-5m / maia3-23m / maia3-79m / maia3-uci into one 'maia3' entry.
    """
    parts = rel_path.split("/")
    if len(parts) > 1:
        return parts[0], os.path.splitext(name)[0]
    stem = os.path.splitext(name)[0]
    base, _, variant = stem.rpartition("-")
    if base:
        return base, variant
    return stem, ""


def _pretty(family_id: str) -> str:
    return family_id[:1].upper() + family_id[1:] if family_id.islower() else family_id


def _kind_of(family_id: str) -> str:
    lowered = family_id.lower()
    if "maia" in lowered:
        return "maia"
    if "stockfish" in lowered:
        return "stockfish"
    return "generic"


def discover_families() -> list[dict]:
    """Engines grouped by product, which is what the settings dropdown shows.

    The user picks 'Stockfish-18' or 'Maia3', not one of a dozen
    near-identical executables -- for Stockfish those differ only by
    instruction set, and for Maia the variant is the model size, which has
    its own dropdown already.
    """
    families: dict[str, dict] = {}
    for entry in discover():
        if os.path.splitext(entry["name"])[0].lower() in NON_ENGINE_STEMS:
            continue
        family_id, variant = _family_of(entry["value"], entry["name"])
        fam = families.setdefault(family_id, {
            "id": family_id,
            "label": _pretty(family_id),
            "kind": _kind_of(family_id),
            "members": [],
        })
        fam["members"].append({"value": entry["value"], "name": entry["name"], "variant": variant})

    result = []
    for fam in families.values():
        fam["members"].sort(key=lambda m: (_build_rank(m["name"]), m["name"]))
        # For Maia the concrete binary comes from the model-size dropdown, so
        # any member works as the stored selection; for everything else this
        # is the build that will actually run.
        fam["default_member"] = fam["members"][0]["value"]
        result.append(fam)
    result.sort(key=lambda f: f["label"].lower())
    return result


def family_for_selection(selection: str | None) -> dict | None:
    """The family a stored selection belongs to, so the dialog can show the
    product name rather than the raw binary the user never chose."""
    if not selection:
        return None
    for fam in discover_families():
        if any(m["value"] == selection for m in fam["members"]):
            return fam
    return None


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
