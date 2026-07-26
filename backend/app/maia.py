"""Locating the right Maia3 binary for a chosen model size.

Maia3 ships the model size as a *separate console entry point* rather than a
UCI option -- `maia3-5m`, `maia3-23m`, `maia3-79m` are distinct executables
(pip console-script wrappers around maia3.presets:main_5m / main_23m /
main_79m), while `maia3-uci` is the generic entry point with no size in it.
That is why setting a model-size UCI option on `maia3-uci` does nothing: no
such option exists.

So the model-size setting picks a *binary*, not an option. The user
configures one Maia path (any of the binaries, or the directory holding
them) and we resolve the sibling executable for the selected size. Sizes are
discovered from disk rather than hardcoded, so whatever is actually
installed is what gets offered -- the spec said 5m/25m/79m, the real
distribution ships 23m.
"""

import os
import re

# Only used when nothing can be discovered on disk (e.g. path not set yet).
FALLBACK_SIZES = ["5m", "23m", "79m"]

_SIZE_IN_NAME = re.compile(r"^maia3[-_](\d+m)$", re.IGNORECASE)


def _search_dir(configured_path: str | None) -> str | None:
    """The directory that should hold the maia3 executables."""
    if not configured_path:
        return None
    if os.path.isdir(configured_path):
        return configured_path
    parent = os.path.dirname(configured_path)
    return parent or None


def discover_sizes(configured_path: str | None) -> list[str]:
    """Model sizes with an actual executable next to the configured path,
    smallest first. Empty if the directory can't be read."""
    directory = _search_dir(configured_path)
    if not directory or not os.path.isdir(directory):
        return []
    found: set[str] = set()
    try:
        for entry in os.listdir(directory):
            stem = os.path.splitext(entry)[0]
            m = _SIZE_IN_NAME.match(stem)
            if m:
                found.add(m.group(1).lower())
    except OSError:
        return []
    return sorted(found, key=lambda s: int(s[:-1]))


def resolve_binary(configured_path: str | None, model_size: str | None) -> tuple[str | None, str]:
    """Returns (path_to_run, note). Falls back to the configured path itself
    when no size-specific sibling exists, and says so in the note -- never
    silently runs a different model than the one selected."""
    if not configured_path:
        return None, "Maia path is not configured"
    if not model_size:
        return configured_path, f"using configured binary '{os.path.basename(configured_path)}'"

    directory = _search_dir(configured_path)
    if directory:
        # Match the extension of whatever the user pointed at (.exe on Windows).
        ext = "" if os.path.isdir(configured_path) else os.path.splitext(configured_path)[1]
        for name in (f"maia3-{model_size}{ext}", f"maia3_{model_size}{ext}"):
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate):
                return candidate, f"model {model_size} -> {name}"

    if os.path.isdir(configured_path):
        return None, (
            f"model size NOT applied: no maia3-{model_size} executable in {configured_path}"
        )
    return configured_path, (
        f"model size NOT applied: no maia3-{model_size} executable next to "
        f"'{os.path.basename(configured_path)}' -- running that binary as configured, "
        "which may be a different model"
    )
