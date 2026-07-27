"""Recovering which Maia model swept an already-analysed game.

Nothing today records the model size against a run, which is what stops an
old sweep from being scored against that model's published accuracy (see
`docs/elo-accuracy-prior.md`). But `run_games.engine_note` holds the note
`maia.resolve_binary` produced at sweep time, and for every case where the
size is knowable at all, the note names the binary that actually ran.

This is both the proposed parser and its test. Run it with
`python backend/sims/model_size_from_note.py` -- it builds fake binary
directories in a temp dir, drives the real `resolve_binary` through every
branch it has, and checks the parser against the note each one produces.

The point of the exercise is the negative cases as much as the positive ones.
A note saying the size was NOT applied means the sweep fell back to whatever
binary was configured, which may be any size or none; the honest answer there
is "unknown", not the user's current setting -- that setting may have changed
since the sweep ran.
"""

import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app.maia import resolve_binary  # noqa: E402

_SIZE = re.compile(r"\bmaia3[-_](\d+m)\b", re.IGNORECASE)
_NOT_APPLIED = "model size NOT applied"

# `open_maia` may append this to the note before it is stored.
MULTIPV_SUFFIX = (" this build advertises no MultiPV option, so the sweep "
                  "records top-1 matches only")


def model_size_from_note(note: str | None) -> str | None:
    """The model size that actually ran, or None when the note can't say."""
    if not note:
        return None

    def size_in(name: str) -> str | None:
        m = _SIZE.search(os.path.splitext(name)[0])
        return m.group(1).lower() if m else None

    if _NOT_APPLIED in note:
        # "... next to 'maia3-uci' -- running that binary as configured"
        quoted = re.search(r"next to '([^']+)'", note)
        return size_in(quoted.group(1)) if quoted else None
    resolved = re.search(r"->\s*(\S+)", note)            # "model 79m -> maia3-79m"
    if resolved:
        found = size_in(resolved.group(1))
        if found:
            return found
    configured = re.search(r"using configured binary '([^']+)'", note)
    if configured:
        return size_in(configured.group(1))
    return None


def main() -> int:
    full = tempfile.mkdtemp()
    for name in ("maia3-5m", "maia3-23m", "maia3-79m", "maia3-uci"):
        open(os.path.join(full, name), "w").close()
    bare = tempfile.mkdtemp()
    open(os.path.join(bare, "maia3-uci"), "w").close()

    # (configured path, requested size, the size that really ran)
    cases = [
        (os.path.join(full, "maia3-uci"), "79m", "79m"),
        (os.path.join(full, "maia3-uci"), "23m", "23m"),
        (os.path.join(full, "maia3-uci"), "5m", "5m"),
        (full, "79m", "79m"),                             # path is the directory
        (os.path.join(full, "maia3-5m"), None, "5m"),     # no size requested
        (os.path.join(full, "maia3-uci"), None, None),    # generic, unknowable
        (os.path.join(bare, "maia3-uci"), "79m", None),   # fell back, unknowable
        (bare, "79m", None),                              # nothing to run
    ]

    print(f"{'recovered':>10}  {'truth':>6}  stored note")
    print("-" * 96)
    ok = True
    for path, size, truth in cases:
        _, note = resolve_binary(path, size)
        for suffix in ("", MULTIPV_SUFFIX):
            got = model_size_from_note(note + suffix)
            good = got == truth
            ok &= good
            print(f"{str(got):>10}  {str(truth):>6}  {note[:70]!r}"
                  f"{'' if good else '   <-- MISMATCH'}")
    print()
    print("all cases recovered correctly" if ok else "PARSER FAILS SOME CASES")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
