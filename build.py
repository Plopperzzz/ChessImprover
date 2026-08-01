#!/usr/bin/env python3
"""Build everything the server needs, from a clean checkout or after a pull.

    python build.py             # backend virtualenv + dependencies, then the React UI
    python build.py --web       # only the React UI
    python build.py --backend   # only the virtualenv and its dependencies
    python build.py --clean     # throw away web/node_modules first (see below)

Two things go stale in ways that are not obvious:

*   `backend/requirements.txt` gains entries — the server then refuses to start
    with an ImportError rather than anything helpful, so the pip step runs every
    time rather than only when the virtualenv is missing.
*   `web/dist` is the *built* React UI and is not in git. Pulling a branch that
    changes `web/src` changes nothing you can see until this script has run;
    `backend/app/main.py` keeps serving whatever was built last, or falls back
    to the classic UI when nothing has been.

Standard library only, so it runs before the virtualenv exists.
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(REPO, "backend")
WEB = os.path.join(REPO, "web")
VENV = os.path.join(BACKEND, ".venv")

# Tailwind v4's compiler (`@tailwindcss/oxide`) will not load on Node 18, and
# the npm that ships with it has the optional-dependency bug described in
# web/README.md. `web/package.json` says the same in its `engines` field.
MIN_NODE = (20, 19)

WINDOWS = platform.system() == "Windows"


def step(message: str) -> None:
    print(f"\n\033[1m==> {message}\033[0m" if not WINDOWS else f"\n==> {message}", flush=True)


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"\nbuild.py: {message}", file=sys.stderr)
    sys.exit(1)


def run(command: list[str], cwd: str) -> None:
    print(f"    $ {' '.join(command)}   (in {os.path.relpath(cwd, REPO)}/)", flush=True)
    result = subprocess.run(command, cwd=cwd)
    if result.returncode != 0:
        fail(f"`{' '.join(command)}` exited with {result.returncode}.")


def venv_python() -> str:
    """The interpreter inside backend/.venv, whether or not it exists yet."""
    if WINDOWS:
        return os.path.join(VENV, "Scripts", "python.exe")
    return os.path.join(VENV, "bin", "python")


# --- backend ---------------------------------------------------------------


def build_backend() -> None:
    python = venv_python()
    if os.path.isfile(python):
        step("Backend virtualenv already exists")
    else:
        step("Creating backend/.venv")
        run([sys.executable, "-m", "venv", ".venv"], cwd=BACKEND)
        if not os.path.isfile(python):
            fail(
                "the virtualenv was created but has no interpreter in it.\n"
                "On Debian/Ubuntu this usually means python3-venv is missing:\n"
                "    sudo apt install python3-venv"
            )

    step("Installing backend dependencies")
    # Upgrading pip first: the wheels for numpy/scipy need a pip new enough to
    # understand the manylinux tags they are published under.
    run([python, "-m", "pip", "install", "--upgrade", "pip"], cwd=BACKEND)
    run([python, "-m", "pip", "install", "-r", "requirements.txt"], cwd=BACKEND)


# --- web -------------------------------------------------------------------


def node_version(node: str) -> tuple[int, ...] | None:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", out.stdout)
    return tuple(int(part) for part in match.groups()) if match else None


def build_web(clean: bool) -> None:
    node = shutil.which("node")
    npm = shutil.which("npm")
    if not node or not npm:
        fail(
            "node and npm are not on PATH, so the React UI can't be built.\n"
            "Install Node 20 LTS or newer, or run with --backend to skip this step.\n"
            "Without web/dist the server still boots — it serves the classic UI at / instead."
        )

    version = node_version(node)
    if version and version[:2] < MIN_NODE:
        fail(
            f"Node {'.'.join(map(str, version))} is too old — {'.'.join(map(str, MIN_NODE))}"
            " or newer is required.\nTailwind's compiler will not load on Node 18."
        )
    step(f"Building the React UI with Node {'.'.join(map(str, version)) if version else '?'}")

    if clean:
        # The npm optional-dependency bug (npm/cli#4828): the tree is there but
        # the platform binary for Tailwind/Vite/Lightning CSS isn't, which shows
        # up as "Cannot find native binding". Both files are regenerated below.
        for name in ("node_modules", "package-lock.json"):
            target = os.path.join(WEB, name)
            if os.path.exists(target):
                print(f"    removing web/{name}", flush=True)
                shutil.rmtree(target) if os.path.isdir(target) else os.remove(target)

    run([npm, "install"], cwd=WEB)
    run([npm, "run", "build"], cwd=WEB)

    index = os.path.join(WEB, "dist", "index.html")
    if not os.path.isfile(index):
        fail("npm run build finished but web/dist/index.html is missing.")


# --- entry point -----------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--backend", action="store_true", help="only the virtualenv and its dependencies")
    parser.add_argument("--web", action="store_true", help="only the React UI")
    parser.add_argument(
        "--clean",
        action="store_true",
        help="delete web/node_modules and package-lock.json before installing",
    )
    args = parser.parse_args()

    # Neither flag means both, which is what a plain `python build.py` should do.
    do_backend = args.backend or not args.web
    do_web = args.web or not args.backend

    if do_backend:
        build_backend()
    if do_web:
        build_web(args.clean)

    step("Done")
    print("Start the server with:\n    python run.py\n")


if __name__ == "__main__":
    main()
