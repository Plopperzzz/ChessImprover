import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
REPO_ROOT = os.path.dirname(BASE_DIR)
ASSETS_DIR = os.path.join(REPO_ROOT, "assets")
FRONTEND_DIR = os.path.join(REPO_ROOT, "frontend")


def list_asset_sets() -> list[str]:
    sets_dir = os.path.join(ASSETS_DIR, "sets")
    if not os.path.isdir(sets_dir):
        return []
    return sorted(name for name in os.listdir(sets_dir) if os.path.isdir(os.path.join(sets_dir, name)))
