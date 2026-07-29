"""Getting Maia3 to report the policy it already computes.

The likelihood objective in `policy_likelihood` wants `P(move | position,
rating)`. Maia3 computes exactly that -- `maia3/uci.py` builds a softmax over
the legal moves, takes the top MultiPV of it, and carries each candidate's
probability in a dict field it calls `policy` -- and then never prints it. What
`cmd_go` emits per candidate is `score cp` and `wdl`, and both come from the
*value* head: they are its guess at how the game ends after that move, not the
probability it would play it. They are frequently identical across every
candidate in the list. Section 9 of the spec warns about precisely this trap.

So the probabilities are one `print` away, on the far side of a process
boundary. This module reaches across it.

How
---

`assets/Engines/maia3-23m` and its siblings are pip console scripts, not
engines: each is a stub that runs one specific Python interpreter and calls
`maia3.presets:main_<size>`. That interpreter has maia3 importable, by
construction -- otherwise the engine the user already configured would not
start. So this module is run *by that interpreter*, as a script, and subclasses
the engine it imports:

    <the console script's own python>  maia_policy.py  --model maia3-23m ...

`interpreter_for` recovers the interpreter from the stub. On Linux and macOS
that is an ordinary `#!` line. On Windows the `.exe` is a launcher with a zip
of `__main__.py` appended and the shebang stored as text just before it, which
is why this reads the tail of the file rather than only the first line.

It is entirely optional. `probe` returns None for anything it cannot drive this
way -- a different engine, a frozen binary with no interpreter to find, an
interpreter that cannot import maia3 -- and the sweep carries on with the
ordinary binary and scores moves by rank instead. Nothing here is on the path
of a normal analysis except as an attempt that is allowed to fail.
"""

import asyncio
import os
import re
import sys

SHEBANG = re.compile(rb"#!\s*(.+?)\s*[\r\n]")
# The Windows launcher stores the interpreter path just before the appended
# zip; 4 KiB from the end of the file reaches it comfortably.
TAIL_BYTES = 4096


def interpreter_for(path: str) -> str | None:
    """The Python that a maia3 console script runs, or None if `path` isn't one.

    Quoted on Windows ("#!"C:\\Program Files\\...\\python.exe"") often enough to
    be worth stripping, and the `w` variants are the windowed build of the same
    interpreter -- unusable for a console engine, so they are normalised back.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(TAIL_BYTES)
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if size > TAIL_BYTES:
                fh.seek(max(size - TAIL_BYTES, 0))
                tail = fh.read(TAIL_BYTES)
            else:
                tail = b""
    except OSError:
        return None

    for blob in (head, tail):
        for match in SHEBANG.finditer(blob):
            raw = match.group(1).decode("utf-8", "replace").strip().strip('"')
            if "python" not in os.path.basename(raw).lower():
                continue
            candidate = raw.replace("pythonw", "python")
            if os.path.isfile(candidate):
                return candidate
    return None


def model_argument(path: str) -> str | None:
    """The `--model` a preset console script hardcodes, read off its name.

    `maia3-uci` takes the model as an argument and has no size in its name, so
    it returns None and the caller passes nothing -- the shim then needs the
    user's own arguments, exactly as the plain binary would.
    """
    stem = os.path.splitext(os.path.basename(path))[0].lower()
    match = re.match(r"^maia3[-_](\d+m(?:-ablation)?)$", stem)
    return f"maia3-{match.group(1)}" if match else None


def shim_command(path: str) -> list[str] | None:
    """The argv that runs this file as a policy-reporting Maia3, or None."""
    interpreter = interpreter_for(path)
    if not interpreter:
        return None
    argv = [interpreter, os.path.abspath(__file__)]
    model = model_argument(path)
    if model:
        # The preset scripts pin temperature 0 as well; matched here so the
        # shim and the plain binary answer `bestmove` identically.
        argv += ["--model", model, "--temperature", "0"]
    return argv


async def probe(path: str, timeout: float = 120.0) -> list[str] | None:
    """The shim command if it really works on this machine, else None.

    Actually starts it and reads a `uciok` back rather than trusting that the
    interpreter can import maia3, because the failure that matters -- a console
    script left behind by an uninstalled package, a virtualenv that has moved --
    looks fine right up until the process exits. The timeout is generous
    because the first run loads a checkpoint, occasionally downloading it.
    """
    command = shim_command(path)
    if not command:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            *command, "--probe",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return None
    try:
        out = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return command if b"maia3-policy-ok" in (out[0] or b"") else None
    except (asyncio.TimeoutError, OSError):
        return None
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


# --- the shim itself, which runs under the *engine's* interpreter -----------
#
# Everything below this line executes in a different process, under a Python
# that has maia3 installed. It must not import anything from this application.

POLICY_SCALE = 1000  # permille, the same convention UCI uses for `wdl`


def _main() -> int:
    if "--probe" in sys.argv:
        # Import only; loading a checkpoint here would make the probe cost as
        # much as a sweep.
        try:
            import maia3.uci  # noqa: F401
        except Exception:
            return 1
        print("maia3-policy-ok", flush=True)
        return 0

    from maia3.uci import Maia3UCIEngine, parse_args
    from maia3.utils import seed_everything

    class PolicyReportingEngine(Maia3UCIEngine):
        """Maia3, plus the one field the likelihood needs.

        `score cp` and `wdl` are left exactly as the stock engine writes them,
        so anything already reading this output keeps working; `policy` is
        added alongside. It is the softmax probability over legal moves that
        `score_moves` already computed for its own ranking and then dropped.
        """

        def cmd_go(self, line):
            self.ensure_model_loaded()
            move, top_moves = self.score_moves()
            for rank, item in enumerate(top_moves, start=1):
                win, draw, loss = item["wdl"]
                policy = int(round(float(item.get("policy") or 0.0) * POLICY_SCALE))
                print(
                    f"info depth 1 multipv {rank} "
                    f"score cp {win - loss} wdl {win} {draw} {loss} "
                    f"policy {policy} pv {item['move'].uci()}",
                    flush=True,
                )
            if "infinite" in line.split():
                self.pending_bestmove, self.pending_search = move, True
                return
            self.print_bestmove(move)

    cfg = parse_args(sys.argv[1:])
    seed_everything(cfg.seed)
    PolicyReportingEngine(cfg).run()
    return 0


if __name__ == "__main__":
    sys.exit(_main())
