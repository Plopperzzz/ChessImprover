"""Persistent per-session UCI engine process management (spec section 3).

One long-lived engine process is created per live-eval connection (one browser
tab watching the board) and reused across every position change. Rapid
navigation never spawns a second process: a sequence number tracks the
latest-requested position, and if a newer request arrives while a search is
still running, we send `stop` to the *same* process and discard the stale
result rather than queuing or racing two searches.

This is deliberately separate from the batch/analysis worker pool (job queue)
-- that pool runs short-lived engine processes per job and is implemented
elsewhere; the two must never share process accounting or lifecycles.
"""

import asyncio
import re
import time


class UciProcessError(Exception):
    pass


class EngineProcess:
    """Thin async wrapper around a UCI engine subprocess: line-based I/O only,
    no protocol knowledge."""

    def __init__(self, path: str, args: list[str] | None = None):
        self.path = path
        self.args = args or []
        self.proc: asyncio.subprocess.Process | None = None
        self._stdout_queue: asyncio.Queue = asyncio.Queue()
        self._reader_task: asyncio.Task | None = None
        # {option name: type}, captured from the `uci` handshake. Engine
        # wrappers disagree about what things are called (a Maia wrapper's Elo
        # knob especially), so callers probe this instead of assuming.
        self.advertised_options: dict[str, str] = {}

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            self.path,
            *self.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                await self._stdout_queue.put(None)
                return
            await self._stdout_queue.put(line.decode(errors="replace").strip())

    async def send_line(self, cmd: str):
        if not self.proc or not self.proc.stdin or self.proc.stdin.is_closing():
            return
        self.proc.stdin.write((cmd + "\n").encode())
        await self.proc.stdin.drain()

    async def readline(self):
        return await self._stdout_queue.get()

    async def wait_for(self, token: str, timeout: float = 10.0):
        async def _loop():
            while True:
                line = await self.readline()
                if line is None:
                    raise UciProcessError(f"{self.path} exited before sending '{token}'")
                if token in line:
                    return line

        return await asyncio.wait_for(_loop(), timeout=timeout)

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def terminate(self):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    async def wait_closed(self, timeout: float = 5.0):
        if not self.proc:
            return
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self.proc.kill()
            await self.proc.wait()
        if self._reader_task:
            self._reader_task.cancel()


_CP_RE = re.compile(r"score cp (-?\d+)")
_MATE_RE = re.compile(r"score mate (-?\d+)")
_DEPTH_RE = re.compile(r"\bdepth (\d+)")
_PV_RE = re.compile(r"\bpv (.+)$")


def parse_info_line(line: str) -> dict | None:
    """Extracts score/depth/pv from a UCI `info ...` line. Returns None for
    info lines that don't carry a score (e.g. pure `currmove` chatter)."""
    if not line.startswith("info"):
        return None
    m_cp = _CP_RE.search(line)
    m_mate = _MATE_RE.search(line)
    if not m_cp and not m_mate:
        return None
    m_depth = _DEPTH_RE.search(line)
    m_pv = _PV_RE.search(line)
    return {
        "depth": int(m_depth.group(1)) if m_depth else None,
        "pv": m_pv.group(1).split() if m_pv else [],
        "cp": int(m_cp.group(1)) if m_cp else None,
        "mate": int(m_mate.group(1)) if m_mate else None,
    }


def engine_options_from_settings(engine_settings: dict) -> dict:
    """UCI setoption values shared by the live-eval session and the
    analysis-job engine, so the two never quietly disagree about what a
    user's Stockfish settings mean."""
    options = {
        "Threads": engine_settings.get("stockfish_threads", 1),
        "Hash": engine_settings.get("stockfish_hash_mb", 128),
    }
    if engine_settings.get("sf_skill_level") is not None:
        options["Skill Level"] = engine_settings["sf_skill_level"]
    return options


_OPTION_RE = re.compile(r"^option name (.+?) type (\w+)")


async def read_uci_options(engine: EngineProcess, timeout: float = 15.0) -> dict[str, str]:
    """Consumes the engine's `option name ... type ...` advertisements up to
    `uciok`, returning {name: type}."""

    async def _loop():
        options: dict[str, str] = {}
        while True:
            line = await engine.readline()
            if line is None:
                raise UciProcessError(f"{engine.path} exited during the uci handshake")
            m = _OPTION_RE.match(line)
            if m:
                options[m.group(1)] = m.group(2)
            if line.startswith("uciok"):
                return options

    return await asyncio.wait_for(_loop(), timeout=timeout)


def pick_option(advertised: dict[str, str], candidates: list[str]) -> str | None:
    """First advertised option matching one of `candidates`, case-insensitively.
    Returns the engine's own spelling (what `setoption name` needs), or None
    if the engine advertises none of them -- callers should surface that
    rather than silently carrying on with the engine's defaults."""
    lowered = {name.lower(): name for name in advertised}
    for candidate in candidates:
        real = lowered.get(candidate.lower())
        if real:
            return real
    return None


async def start_configured_engine(path: str, options: dict) -> EngineProcess:
    """Starts and UCI-handshakes a fresh engine process with the given
    setoption values. Used for short-lived analysis-job engines (section 3) --
    a separate process and lifecycle from the persistent live-eval session."""
    engine = EngineProcess(path)
    await engine.start()
    await engine.send_line("uci")
    engine.advertised_options = await read_uci_options(engine)
    for name, value in options.items():
        await engine.send_line(f"setoption name {name} value {value}")
    await engine.send_line("isready")
    await engine.wait_for("readyok")
    await engine.send_line("ucinewgame")
    return engine


async def evaluate_position(engine: EngineProcess, fen: str, limit_type: str, limit_value: int) -> dict:
    """Runs one blocking `go` on an already-configured engine and returns the
    deepest info line seen before `bestmove` (mover's-perspective cp/mate)."""
    await engine.send_line(f"position fen {fen}")
    go_cmd = f"go movetime {limit_value}" if limit_type == "movetime" else f"go depth {limit_value}"
    await engine.send_line(go_cmd)
    last_info = None
    while True:
        line = await engine.readline()
        if line is None:
            raise UciProcessError("engine exited during analysis")
        if line.startswith("info"):
            info = parse_info_line(line)
            if info:
                last_info = info
        if line.startswith("bestmove"):
            break
    return last_info or {"cp": 0, "mate": None, "depth": 0, "pv": []}


class LiveEngineSession:
    """One persistent Stockfish process for one live-eval connection."""

    def __init__(self, owner_user_id, connection_id, path, options, limit_type, limit_value, on_eval):
        self.owner_user_id = owner_user_id
        self.connection_id = connection_id
        self.path = path
        self.options = options
        self.limit_type = limit_type
        self.limit_value = limit_value
        self.on_eval = on_eval
        self.engine: EngineProcess | None = None
        self._latest_fen: str | None = None
        self._latest_seq = 0
        self._wake = asyncio.Event()
        self._worker_task: asyncio.Task | None = None
        self._closed = False
        self.started_at = time.monotonic()
        self.last_active = time.monotonic()

    async def start(self):
        self.engine = await start_configured_engine(self.path, self.options)
        self._worker_task = asyncio.create_task(self._worker_loop())

    def request(self, fen: str, seq: int):
        """Called for every position the client wants evaluated. Only the
        latest (fen, seq) matters -- anything mid-flight gets interrupted."""
        self._latest_fen = fen
        self._latest_seq = seq
        self.last_active = time.monotonic()
        self._wake.set()

    async def _worker_loop(self):
        try:
            while not self._closed:
                await self._wake.wait()
                self._wake.clear()
                fen, seq = self._latest_fen, self._latest_seq
                await self.engine.send_line(f"position fen {fen}")
                go_cmd = (
                    f"go movetime {self.limit_value}"
                    if self.limit_type == "movetime"
                    else f"go depth {self.limit_value}"
                )
                await self.engine.send_line(go_cmd)
                await self._collect(seq)
        except (asyncio.CancelledError, UciProcessError):
            pass

    async def _collect(self, seq: int):
        stopped = False
        while True:
            if not stopped and (self._wake.is_set() or self._latest_seq != seq):
                await self.engine.send_line("stop")
                stopped = True
            line = await self.engine.readline()
            if line is None:
                raise UciProcessError("engine process exited")
            if line.startswith("info") and seq == self._latest_seq:
                info = parse_info_line(line)
                if info:
                    await self.on_eval(seq, info)
            if line.startswith("bestmove"):
                return

    async def close(self):
        self._closed = True
        self._wake.set()  # unstick the worker if it's waiting
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, UciProcessError):
                pass
        self.engine.terminate()
        await self.engine.wait_closed()


class LiveEngineManager:
    """Registry of active live-eval sessions, for accounting and idle cleanup.
    Distinct from the batch analysis worker pool (section 10)."""

    def __init__(self, idle_timeout_seconds: int = 600):
        self.sessions: dict[str, LiveEngineSession] = {}
        self.idle_timeout = idle_timeout_seconds
        self._sweep_task: asyncio.Task | None = None

    async def create_session(self, connection_id, user, engine_settings, on_eval) -> LiveEngineSession:
        path = engine_settings.get("stockfish_path")
        if not path:
            raise RuntimeError("Stockfish path is not configured -- set it in Settings first")
        session = LiveEngineSession(
            owner_user_id=user["id"],
            connection_id=connection_id,
            path=path,
            options=engine_options_from_settings(engine_settings),
            limit_type=engine_settings.get("sf_limit_type", "depth"),
            limit_value=engine_settings.get("sf_limit_value", 18),
            on_eval=on_eval,
        )
        await session.start()
        self.sessions[connection_id] = session
        return session

    async def destroy_session(self, connection_id: str):
        session = self.sessions.pop(connection_id, None)
        if session:
            await session.close()

    def status(self) -> list[dict]:
        now = time.monotonic()
        return [
            {
                "connection_id": cid,
                "user_id": s.owner_user_id,
                "pid": s.engine.pid,
                "uptime_s": round(now - s.started_at, 1),
                "idle_s": round(now - s.last_active, 1),
            }
            for cid, s in self.sessions.items()
        ]

    async def start_idle_sweep(self):
        self._sweep_task = asyncio.create_task(self._sweep_loop())

    async def _sweep_loop(self):
        while True:
            await asyncio.sleep(30)
            now = time.monotonic()
            stale = [cid for cid, s in self.sessions.items() if now - s.last_active > self.idle_timeout]
            for cid in stale:
                await self.destroy_session(cid)

    async def shutdown_all(self):
        if self._sweep_task:
            self._sweep_task.cancel()
        for cid in list(self.sessions.keys()):
            await self.destroy_session(cid)


manager = LiveEngineManager()
