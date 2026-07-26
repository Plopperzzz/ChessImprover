"""Play vs Maia3 (spec section 14).

Deliberately separate from the analysis pipeline: this reuses the board UI
and the UCI engine wrapper, but none of the job queue, Elo-sweep, or
classification code. Each play session holds one persistent Maia process for
its lifetime (section 3) and tears it down when the socket closes.

The clock is server-authoritative -- the browser only renders what the
server reports, so a phone that sleeps mid-game can't gain or lose time by
drifting. Maia's reply is held back by a short randomised delay so it doesn't
answer instantly, and that delay is charged to Maia's own clock, since from
the player's side it is indistinguishable from thinking.
"""

import asyncio
import io
import json
import random
import time
import uuid

import chess
import chess.pgn
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from .auth import SESSION_COOKIE, _user_for_token, require_user
from .db import db_cursor
from .engine_manager import EngineProcess, pick_option, read_uci_options
from .engine_settings import get_effective_settings

router = APIRouter(tags=["play"])

# Maia is a policy network -- one node is the whole point, it's what makes it
# reproduce human move choice rather than search its way to an engine move.
MAIA_GO_COMMAND = "go nodes 1"

# Wrappers disagree on naming, so we probe the engine's advertised options for
# the first of these that exists rather than assuming one.
ELO_OPTION_CANDIDATES = ["UCI_Elo", "Elo", "MaiaElo", "Maia_Elo", "Rating", "Strength"]
LIMIT_STRENGTH_CANDIDATES = ["UCI_LimitStrength"]
MODEL_SIZE_CANDIDATES = ["ModelSize", "Model", "MaiaModel", "Weights", "WeightsFile"]

DELAY_MIN_S = 0.45
DELAY_MAX_S = 2.0
# Never let the "thinking" pause be what flags Maia on a fast time control.
DELAY_MAX_FRACTION_OF_REMAINING = 0.10

sessions: dict[str, "PlaySession"] = {}


def status() -> list[dict]:
    """Process accounting for play engines, alongside the live-eval ones."""
    now = time.monotonic()
    return [
        {
            "session_id": sid,
            "user_id": s.user_id,
            "pid": s.engine.pid if s.engine else None,
            "kind": "play-vs-maia",
            "uptime_s": round(now - s.started_at, 1),
        }
        for sid, s in sessions.items()
    ]


class PlaySession:
    def __init__(self, session_id: str, user_id: int, display_name: str):
        self.session_id = session_id
        self.user_id = user_id
        self.display_name = display_name
        self.engine: EngineProcess | None = None
        self.board = chess.Board()
        self.human_color = chess.WHITE
        self.elo = 1500
        self.started_at = time.monotonic()

        self.clock_ms = {chess.WHITE: 0.0, chess.BLACK: 0.0}
        self.base_ms = 0.0
        self.increment_ms = 0.0
        self.clock_enabled = False
        self.turn_started_at: float | None = None
        self.elo_option: str | None = None

        self.result: str | None = None      # '1-0' | '0-1' | '1/2-1/2'
        self.result_reason: str | None = None
        # What we could and couldn't actually configure on this engine. Setup
        # notes come from the one-time handshake and must outlive a new game
        # (that's where "your Maia build ignores model size" shows up); game
        # notes are reset per game.
        self.setup_notes: list[str] = []
        self.game_notes: list[str] = []
        self.san_history: list[str] = []
        self._lock = asyncio.Lock()

    def fen(self) -> str:
        """Always spell out the en-passant square, the way chess.js does.
        python-chess defaults to the 'legal' convention and omits it when no
        ep capture is actually available -- the two disagree after every
        double pawn push, which the browser would otherwise read as a desync."""
        return self.board.fen(en_passant="fen")

    @property
    def engine_notes(self) -> list[str]:
        return self.setup_notes + self.game_notes

    # ---------- engine ----------

    async def start_engine(self, settings: dict):
        path = settings.get("maia_path")
        if not path:
            raise RuntimeError("Maia path is not configured -- set it in Settings first")

        engine = EngineProcess(path)
        await engine.start()
        await engine.send_line("uci")
        engine.advertised_options = await read_uci_options(engine)
        self.engine = engine

        model_opt = pick_option(engine.advertised_options, MODEL_SIZE_CANDIDATES)
        if model_opt:
            await engine.send_line(f"setoption name {model_opt} value {settings.get('maia_model_size')}")
            self.setup_notes.append(f"model size -> '{model_opt}'")
        else:
            self.setup_notes.append(
                "model size NOT applied: engine advertises no recognised model/weights option"
            )

        limit_opt = pick_option(engine.advertised_options, LIMIT_STRENGTH_CANDIDATES)
        if limit_opt:
            await engine.send_line(f"setoption name {limit_opt} value true")

        self.elo_option = pick_option(engine.advertised_options, ELO_OPTION_CANDIDATES)
        if not self.elo_option:
            self.setup_notes.append(
                "Elo NOT applied: engine advertises none of "
                + ", ".join(ELO_OPTION_CANDIDATES)
                + " -- it will play at its own default strength"
            )

        await engine.send_line("isready")
        await engine.wait_for("readyok")

    async def apply_elo(self, elo: int):
        self.elo = elo
        if self.engine and self.elo_option:
            await self.engine.send_line(f"setoption name {self.elo_option} value {elo}")
            self.game_notes.append(f"Elo {elo} -> '{self.elo_option}'")

    async def close(self):
        if self.engine:
            self.engine.terminate()
            await self.engine.wait_closed()
            self.engine = None

    # ---------- clock ----------

    def start_clock_turn(self):
        self.turn_started_at = time.monotonic()

    def _charge_clock(self, color) -> bool:
        """Deducts elapsed time from `color` and adds the increment. Returns
        False if they flagged."""
        if not self.clock_enabled or self.turn_started_at is None:
            return True
        elapsed_ms = (time.monotonic() - self.turn_started_at) * 1000.0
        self.clock_ms[color] -= elapsed_ms
        if self.clock_ms[color] <= 0:
            self.clock_ms[color] = 0.0
            return False
        self.clock_ms[color] += self.increment_ms
        return True

    def remaining_ms(self, color) -> float:
        """Live value: the mover's displayed clock has to count down between
        moves, not just at move time."""
        base = self.clock_ms[color]
        if self.clock_enabled and self.turn_started_at is not None and self.board.turn == color and not self.result:
            base -= (time.monotonic() - self.turn_started_at) * 1000.0
        return max(0.0, base)

    def flagged_color(self):
        if not self.clock_enabled or self.result or self.turn_started_at is None:
            return None
        if self.remaining_ms(self.board.turn) <= 0:
            return self.board.turn
        return None

    # ---------- game state ----------

    def check_natural_end(self):
        if self.result:
            return
        outcome = self.board.outcome(claim_draw=True)
        if outcome is not None:
            self.result = outcome.result()
            self.result_reason = outcome.termination.name.lower().replace("_", " ")

    def set_result(self, result: str, reason: str):
        self.result = result
        self.result_reason = reason

    def state_message(self) -> dict:
        return {
            "type": "state",
            "fen": self.fen(),
            "san_history": list(self.san_history),
            "turn": "w" if self.board.turn == chess.WHITE else "b",
            "human_color": "w" if self.human_color == chess.WHITE else "b",
            "clock_enabled": self.clock_enabled,
            "white_ms": round(self.remaining_ms(chess.WHITE)),
            "black_ms": round(self.remaining_ms(chess.BLACK)),
            "move_count": len(self.board.move_stack),
            "result": self.result,
            "result_reason": self.result_reason,
            "in_check": self.board.is_check(),
            "engine_notes": self.engine_notes,
        }

    # ---------- moves ----------

    async def engine_reply(self) -> dict | None:
        """Asks Maia for a move, pauses a human-like moment, then plays it.
        Returns a dict describing the move, or None if the game is over."""
        if self.result or self.engine is None:
            return None

        self.start_clock_turn()
        await self.engine.send_line(f"position fen {self.fen()}")
        await self.engine.send_line(MAIA_GO_COMMAND)

        best = None
        while True:
            line = await self.engine.readline()
            if line is None:
                raise RuntimeError("Maia process exited mid-game")
            if line.startswith("bestmove"):
                parts = line.split()
                if len(parts) >= 2:
                    best = parts[1]
                break
        if not best or best == "(none)":
            self.check_natural_end()
            return None

        delay = random.uniform(DELAY_MIN_S, DELAY_MAX_S)
        if self.clock_enabled:
            delay = min(delay, max(0.0, self.remaining_ms(self.board.turn) / 1000.0 * DELAY_MAX_FRACTION_OF_REMAINING))
        if delay > 0:
            await asyncio.sleep(delay)

        engine_color = self.board.turn
        move = chess.Move.from_uci(best)
        if move not in self.board.legal_moves:
            raise RuntimeError(f"Maia returned an illegal move: {best}")
        san = self.board.san(move)
        self.board.push(move)
        self.san_history.append(san)

        described = {
            "from": chess.square_name(move.from_square),
            "to": chess.square_name(move.to_square),
            "promotion": chess.piece_symbol(move.promotion) if move.promotion else None,
            "san": san,
            "uci": best,
            "fen": self.fen(),
        }

        if not self._charge_clock(engine_color):
            self.set_result("1-0" if engine_color == chess.BLACK else "0-1", "maia flagged")
            return described

        self.check_natural_end()
        if not self.result:
            self.start_clock_turn()
        return described

    def apply_human_move(self, uci: str) -> dict:
        move = chess.Move.from_uci(uci)
        if move not in self.board.legal_moves:
            raise ValueError("illegal move")
        human = self.board.turn
        san = self.board.san(move)
        self.board.push(move)
        self.san_history.append(san)
        if not self._charge_clock(human):
            self.set_result("1-0" if human == chess.BLACK else "0-1", "you flagged")
            return {"san": san}
        self.check_natural_end()
        if not self.result:
            self.start_clock_turn()
        return {"san": san}

    # ---------- persistence ----------

    def to_pgn(self) -> str:
        game = chess.pgn.Game()
        white = self.display_name if self.human_color == chess.WHITE else f"Maia3 ({self.elo})"
        black = f"Maia3 ({self.elo})" if self.human_color == chess.WHITE else self.display_name
        game.headers["Event"] = "Play vs Maia3"
        game.headers["Site"] = "Engine Room"
        game.headers["Date"] = time.strftime("%Y.%m.%d")
        game.headers["UTCDate"] = time.strftime("%Y.%m.%d", time.gmtime())
        game.headers["UTCTime"] = time.strftime("%H:%M:%S", time.gmtime())
        game.headers["White"] = white
        game.headers["Black"] = black
        game.headers["Result"] = self.result or "*"
        if self.human_color == chess.WHITE:
            game.headers["BlackElo"] = str(self.elo)
        else:
            game.headers["WhiteElo"] = str(self.elo)
        if self.clock_enabled:
            game.headers["TimeControl"] = f"{int(self.base_ms // 1000)}+{int(self.increment_ms // 1000)}"

        node = game
        for move in self.board.move_stack:
            node = node.add_variation(move)
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=False)
        return game.accept(exporter)

    def save_to_library(self) -> int:
        """Writes the game into the same games table the analysis viewer reads,
        so a played game loads exactly like an imported one."""
        pgn_text = self.to_pgn()
        parsed = chess.pgn.read_game(io.StringIO(pgn_text))
        headers = dict(parsed.headers)
        now = time.gmtime()
        with db_cursor() as conn:
            cur = conn.execute(
                "INSERT INTO uploads (user_id, source_name, raw_text) VALUES (?, ?, ?)",
                (self.user_id, "play-vs-maia", pgn_text),
            )
            upload_id = cur.lastrowid
            cur = conn.execute(
                """INSERT INTO games (
                    user_id, upload_id, batch_index, source_name, game_index_in_source,
                    white, black, result, event, date_header, utc_date_header,
                    year, month, your_color, pgn_text, headers_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    self.user_id, upload_id, 0, "play-vs-maia", 0,
                    headers.get("White"), headers.get("Black"), headers.get("Result"),
                    headers.get("Event"), headers.get("Date"), headers.get("UTCDate"),
                    now.tm_year, now.tm_mon,
                    "w" if self.human_color == chess.WHITE else "b",
                    pgn_text, json.dumps(headers),
                ),
            )
            return cur.lastrowid


@router.websocket("/ws/play")
async def play_ws(websocket: WebSocket):
    token = websocket.cookies.get(SESSION_COOKIE)
    user_row = _user_for_token(token)
    if not user_row:
        await websocket.close(code=4401)
        return
    user = dict(user_row)

    await websocket.accept()
    session_id = uuid.uuid4().hex
    session = PlaySession(session_id, user["id"], user["display_name"])
    sessions[session_id] = session
    flag_task: asyncio.Task | None = None

    async def send_state():
        await websocket.send_json(session.state_message())

    async def watch_flag():
        """The clock has to be able to end the game while nobody is moving."""
        while True:
            await asyncio.sleep(1)
            if session.result or not session.clock_enabled:
                continue
            flagged = session.flagged_color()
            if flagged is not None:
                loser_is_human = flagged == session.human_color
                # Bank the zero before setting the result -- remaining_ms()
                # stops applying elapsed time once the game is over, so
                # without this the final state reports their starting time.
                session.clock_ms[flagged] = 0.0
                session.set_result(
                    "0-1" if flagged == chess.WHITE else "1-0",
                    "you flagged" if loser_is_human else "maia flagged",
                )
                await send_state()

    try:
        while True:
            msg = await websocket.receive_json()
            kind = msg.get("type")

            if kind == "new_game":
                async with session._lock:
                    if session.engine is None:
                        settings = get_effective_settings(user["id"])
                        try:
                            await session.start_engine(settings)
                        except Exception as e:
                            await websocket.send_json({"type": "error", "message": str(e)})
                            continue

                    session.board = chess.Board()
                    session.san_history = []
                    session.result = None
                    session.result_reason = None
                    session.game_notes = []

                    colour = msg.get("color", "w")
                    if colour == "random":
                        colour = random.choice(["w", "b"])
                    session.human_color = chess.WHITE if colour == "w" else chess.BLACK

                    await session.apply_elo(int(msg.get("elo", 1500)))
                    await session.engine.send_line("ucinewgame")
                    await session.engine.send_line("isready")
                    await session.engine.wait_for("readyok")

                    base_minutes = float(msg.get("base_minutes", 0) or 0)
                    increment_seconds = float(msg.get("increment_seconds", 0) or 0)
                    session.clock_enabled = base_minutes > 0
                    session.base_ms = base_minutes * 60_000.0
                    session.increment_ms = increment_seconds * 1000.0
                    session.clock_ms = {chess.WHITE: session.base_ms, chess.BLACK: session.base_ms}
                    session.start_clock_turn()

                    if flag_task is None:
                        flag_task = asyncio.create_task(watch_flag())

                    await send_state()
                    if session.board.turn != session.human_color:
                        mv = await session.engine_reply()
                        if mv:
                            await websocket.send_json({"type": "engine_move", **mv})
                        await send_state()

            elif kind == "move":
                async with session._lock:
                    if session.result or session.board.turn != session.human_color:
                        await send_state()
                        continue
                    uci = msg.get("uci", "")
                    try:
                        session.apply_human_move(uci)
                    except (ValueError, chess.InvalidMoveError):
                        await websocket.send_json({"type": "illegal", "uci": uci})
                        await send_state()
                        continue
                    await send_state()
                    if not session.result:
                        mv = await session.engine_reply()
                        if mv:
                            await websocket.send_json({"type": "engine_move", **mv})
                        await send_state()

            elif kind == "resign":
                async with session._lock:
                    if not session.result:
                        session.set_result(
                            "0-1" if session.human_color == chess.WHITE else "1-0", "you resigned"
                        )
                    await send_state()

            elif kind == "save":
                async with session._lock:
                    if not session.board.move_stack:
                        await websocket.send_json({"type": "error", "message": "nothing to save yet"})
                        continue
                    game_id = session.save_to_library()
                    await websocket.send_json({"type": "saved", "game_id": game_id})

    except WebSocketDisconnect:
        pass
    finally:
        if flag_task:
            flag_task.cancel()
        sessions.pop(session_id, None)
        await session.close()


@router.get("/api/play/status")
def play_status(user: dict = Depends(require_user)):
    return status()
