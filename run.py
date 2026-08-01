#!/usr/bin/env python3
"""Start the server.

    python run.py                       # http://0.0.0.0:8000
    python run.py --port 8080
    python run.py --reload              # restart on a backend source change
    python run.py --stockfish C:\\engines\\stockfish.exe

Uses the interpreter in `backend/.venv`, which `build.py` creates — not the one
running this script — so it works the same whether or not a virtualenv is
active in the shell.

Both UIs are served by this one process, off one database: the React UI at `/`
when `web/dist` exists (`python build.py`), and the classic UI at `/legacy/`
always.
"""

from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(REPO, "backend")
VENV = os.path.join(BACKEND, ".venv")

WINDOWS = platform.system() == "Windows"


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"\nrun.py: {message}", file=sys.stderr)
    sys.exit(1)


def interpreter(override: str | None) -> str:
    if override:
        if not os.path.isfile(override):
            fail(f"no interpreter at {override}")
        python, where = override, override
    else:
        python = os.path.join(VENV, "Scripts", "python.exe") if WINDOWS else os.path.join(VENV, "bin", "python")
        where = "backend/.venv"
        if not os.path.isfile(python):
            fail("backend/.venv doesn't exist yet. Create it with:\n    python build.py --backend")

    # An environment that predates a dependency being added is the usual cause
    # of a server that won't boot, and the ImportError it raises names whichever
    # module happened to be imported first rather than the fix.
    check = subprocess.run([python, "-c", "import uvicorn, fastapi, chess"], capture_output=True, text=True)
    if check.returncode != 0:
        missing = check.stderr.strip().splitlines()[-1] if check.stderr.strip() else "an import failed"
        fail(
            f"{where} is missing dependencies ({missing}).\n"
            "Install them with:\n    python build.py --backend"
        )
    return python


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="0.0.0.0", help="default 0.0.0.0 — reachable from your LAN/tailnet")
    parser.add_argument("--port", type=int, default=8000, help="default 8000")
    parser.add_argument("--reload", action="store_true", help="restart the server when backend/ changes")
    parser.add_argument("--stockfish", help="sets STOCKFISH_PATH for this run")
    parser.add_argument("--python", help="use this interpreter instead of backend/.venv's")
    args = parser.parse_args()

    python = interpreter(args.python)

    env = os.environ.copy()
    if args.stockfish:
        env["STOCKFISH_PATH"] = args.stockfish

    if not os.path.isfile(os.path.join(REPO, "web", "dist", "index.html")):
        print(
            "run.py: web/dist not found — the classic UI will be served at / instead\n"
            "        of the React one. Build it with: python build.py --web\n",
            file=sys.stderr,
        )

    command = [python, "-m", "uvicorn", "app.main:app", "--host", args.host, "--port", str(args.port)]
    if args.reload:
        command += ["--reload", "--reload-dir", BACKEND]

    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"run.py: http://{shown}:{args.port}/   (classic UI at /legacy/)   Ctrl-C to stop\n", flush=True)

    # Run from backend/ so `app.main:app` resolves; everything the app reads
    # (the database, assets, both UIs) is found relative to its own file.
    try:
        sys.exit(subprocess.call(command, cwd=BACKEND, env=env))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
