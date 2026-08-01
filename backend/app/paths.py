import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
REPO_ROOT = os.path.dirname(BASE_DIR)
ASSETS_DIR = os.path.join(REPO_ROOT, "assets")
# The classic (vanilla JS) UI. Still served in full, at /legacy.
FRONTEND_DIR = os.path.join(REPO_ROOT, "frontend")
# The React UI's build output. Absent until `npm run build` has been run in
# web/, which is why the mount in main.py is conditional -- a fresh checkout
# has to boot into *something*, and that something is the classic UI.
WEB_DIST_DIR = os.path.join(REPO_ROOT, "web", "dist")


def web_built() -> bool:
    return os.path.isfile(os.path.join(WEB_DIST_DIR, "index.html"))

# The only directory engine binaries may be launched from. It lives under
# assets/ for convenience, but is explicitly *not* served over HTTP -- see
# the assets mount in main.py.
ENGINES_DIR = os.path.join(ASSETS_DIR, "Engines")


PIECE_FILES = [f"{colour}{piece}.png" for colour in "wb" for piece in "kqrbnp"]


def list_asset_sets() -> list[str]:
    sets_dir = os.path.join(ASSETS_DIR, "sets")
    if not os.path.isdir(sets_dir):
        return []
    return sorted(name for name in os.listdir(sets_dir) if os.path.isdir(os.path.join(sets_dir, name)))


def asset_set_details() -> list[dict]:
    """Each set with what it actually contains. Board and pieces are picked
    separately, so a set holding only a board.png belongs in one dropdown and
    not the other -- and offering it in both is how you end up with an empty
    board or invisible pieces."""
    sets_dir = os.path.join(ASSETS_DIR, "sets")
    out = []
    for name in list_asset_sets():
        directory = os.path.join(sets_dir, name)
        out.append({
            "name": name,
            "has_board": os.path.isfile(os.path.join(directory, "board.png")),
            # A set that's missing a piece or two would render gaps, so it only
            # counts as a piece set if it has the full twelve.
            "has_pieces": all(os.path.isfile(os.path.join(directory, f)) for f in PIECE_FILES),
        })
    return out

# The sounds every set has to carry to be offered as one. Named for the event
# rather than the file, and both UIs reach them through the same names.
AUDIO_FILES = {
    "move": "move-self.webm",
    "opponent": "move-opponent.webm",
    "capture": "capture.webm",
    "castle": "castle.webm",
    "check": "move-check.webm",
    "promote": "promote.webm",
    "illegal": "illegal.webm",
    "start": "game-start.webm",
    "end": "game-end.webm",
    "lowtime": "tenseconds.webm",
    "brilliant": "brilliant-86fb4d6.mp3",
    "correct": "correct-c1411f4.mp3",
    "wrong": "fail-blip-hi-2b78df0.mp3",
    "solved": "puzzle-solved-fee614d.mp3",
}

# Which of those a set must actually contain. The board sounds are the ones a
# missing file would be noticed for; the puzzle and clock sounds are allowed to
# fall through to the default set rather than disqualifying a set that only
# wanted to restyle the pieces landing.
AUDIO_REQUIRED = ("move", "opponent", "capture", "check")

AUDIO_SET_DEFAULT = "default"


def list_audio_sets() -> list[dict]:
    """Sound sets are subdirectories of assets/audio/, each holding the same
    file names. They were one flat directory until per-screen sound sets
    (A7/B9); `default/` is that original set, moved rather than copied.

    A set that is missing one of the non-core sounds is still offered -- the
    player falls back to the default set's copy of that one file, so a set can
    restyle the move sounds without having to ship a puzzle jingle.
    """
    audio_dir = os.path.join(ASSETS_DIR, "audio")
    if not os.path.isdir(audio_dir):
        return []
    out = []
    for name in sorted(os.listdir(audio_dir)):
        directory = os.path.join(audio_dir, name)
        if not os.path.isdir(directory):
            continue
        present = {
            key for key, filename in AUDIO_FILES.items()
            if os.path.isfile(os.path.join(directory, filename))
        }
        if not all(key in present for key in AUDIO_REQUIRED):
            continue
        out.append({
            "name": name,
            "sounds": sorted(present),
            # So a picker can say "restyles the board only" rather than the
            # user finding out when a puzzle solves silently.
            "complete": len(present) == len(AUDIO_FILES),
        })
    return out


def list_board_images() -> list[dict]:
    boards_dir = os.path.join(ASSETS_DIR, "boards")
    if not os.path.isdir(boards_dir):
        return []
    out = []
    for name in sorted(os.listdir(boards_dir)):
        if name.lower().endswith(".png"):
            out.append({
                "name": name[:-4],  # strip .png extension
                "has_board": True,
            })
    return out
