"""Reading an engine's advertised UCI options, with full metadata.

Rather than hardcoding a guess at what a given build exposes (Maia's
temperature knob, a search-node cap, whatever a future version adds), the
settings dialog asks the engine. A UCI engine answers `uci` with a list of
`option name ... type ...` lines describing everything it accepts, and we
render a control per option from that.

Probing launches the engine, so results are cached per (path, mtime, size) --
a rebuilt or swapped binary re-probes, an unchanged one doesn't.
"""

import asyncio
import os

from .engine_manager import EngineProcess, UciProcessError

# Options the app drives itself and so shouldn't offer as free-form controls.
MANAGED_OPTIONS = {
    "uci_elo", "uci_limitstrength", "threads", "hash", "skill level",
    "modelsize", "model", "maiamodel", "weights", "weightsfile",
    "ponder", "multipv", "uci_chess960", "uci_analysemode", "uci_opponent",
    "uci_showwdl", "clear hash",
}

_cache: dict[tuple, list[dict]] = {}


def _parse_option_line(line: str) -> dict | None:
    """`option name Foo Bar type spin default 5 min 0 max 10` ->
    {name, type, default, min, max, vars}. The name can contain spaces, so
    this walks keywords rather than splitting on whitespace."""
    if not line.startswith("option name "):
        return None
    tokens = line.split()
    keywords = {"name", "type", "default", "min", "max", "var"}
    opt: dict = {"name": "", "type": "", "default": None, "min": None, "max": None, "vars": []}
    current = None
    buffer: list[str] = []

    def flush():
        if current is None:
            return
        value = " ".join(buffer)
        if current == "name":
            opt["name"] = value
        elif current == "type":
            opt["type"] = value
        elif current == "default":
            opt["default"] = value
        elif current == "min":
            opt["min"] = value
        elif current == "max":
            opt["max"] = value
        elif current == "var":
            opt["vars"].append(value)

    for token in tokens[1:]:  # skip the leading 'option'
        if token in keywords:
            flush()
            current = token
            buffer = []
        else:
            buffer.append(token)
    flush()
    return opt if opt["name"] and opt["type"] else None


def _cache_key(path: str):
    try:
        st = os.stat(path)
        return (path, st.st_mtime, st.st_size)
    except OSError:
        return (path, None, None)


async def probe(path: str, timeout: float = 15.0) -> dict:
    """{'options': [...], 'error': str|None}. Never raises -- a binary that
    can't run here (a Windows .exe on Linux, say) reports the reason so the
    dialog can say so instead of showing an empty list as if it succeeded."""
    key = _cache_key(path)
    if key in _cache:
        return {"options": _cache[key], "error": None}

    engine = EngineProcess(path)
    try:
        await engine.start()
        await engine.send_line("uci")

        async def read_until_uciok():
            options = []
            while True:
                line = await engine.readline()
                if line is None:
                    raise UciProcessError("engine exited during the uci handshake")
                parsed = _parse_option_line(line)
                if parsed:
                    options.append(parsed)
                if line.startswith("uciok"):
                    return options

        options = await asyncio.wait_for(read_until_uciok(), timeout=timeout)
        _cache[key] = options
        return {"options": options, "error": None}
    except (OSError, UciProcessError, asyncio.TimeoutError) as e:
        return {"options": [], "error": f"{type(e).__name__}: {e}"}
    finally:
        engine.terminate()
        try:
            await engine.wait_closed()
        except Exception:
            pass


def tunable(options: list[dict]) -> list[dict]:
    """The options worth showing: drops the ones the app sets itself and the
    pure-action buttons."""
    return [
        o for o in options
        if o["name"].lower() not in MANAGED_OPTIONS and o["type"] != "button"
    ]
