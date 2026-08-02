import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flag, FlipVertical2, Loader2, Save, Settings2 } from 'lucide-react';
import { Chess } from 'chess.js';
import * as api from '../../lib/api';
import { playMoveSound, playSound } from '../../lib/sound';
import type { EngineSettings, User } from '../../types';
import { Board } from '../Board';

interface PlayScreenProps {
  user: User;
  settings: EngineSettings | null;
  /** Per-screen board/piece/sound choices (A7); null until they load. */
  prefs: api.ScreenPrefs | null;
  onOpenSettings: () => void;
}

type Colour = 'w' | 'b' | 'random';

interface StateMessage {
  type: 'state';
  fen: string;
  san_history: string[];
  turn: 'w' | 'b';
  human_color: 'w' | 'b';
  clock_enabled: boolean;
  white_ms: number;
  black_ms: number;
  move_count: number;
  result: string | null;
  result_reason: string | null;
  in_check: boolean;
  engine_notes: string[];
}

interface EngineMoveMessage {
  type: 'engine_move';
  from: string;
  to: string;
  promotion: string | null;
  san: string;
  uci: string;
  fen: string;
}

type PlayMessage =
  | StateMessage
  | EngineMoveMessage
  | { type: 'illegal'; uci: string }
  | { type: 'error'; message: string }
  | { type: 'saved'; game_id: number };

const START_FEN = new Chess().fen();

function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Pairs the flat SAN history up into a two-column move table, the same shape
 *  `MoveList` draws for a finished game — just without classifications, since
 *  nothing has analysed a game still being played. */
function movePairs(sanHistory: string[]): { number: number; white?: string; black?: string }[] {
  const out: { number: number; white?: string; black?: string }[] = [];
  for (let i = 0; i < sanHistory.length; i += 2) {
    out.push({ number: i / 2 + 1, white: sanHistory[i], black: sanHistory[i + 1] });
  }
  return out;
}

/**
 * Play vs Maia3 (spec §14).
 *
 * Architecturally separate from the analysis pipeline, same as the backend:
 * this talks to `/ws/play` alone, reuses the board and the sound table, and
 * touches none of the job queue, Elo-sweep or classification code.
 *
 * The clock is server-authoritative — `state` carries the real remaining
 * time on every move, and a local ticker only interpolates between those
 * messages so the display doesn't look frozen while nothing has happened.
 * A move is applied to the board immediately (the same optimism the classic
 * UI plays with) and reconciled the moment the server's own `state` or
 * `engine_move` for it arrives; an `illegal` message means the two had
 * already drifted, and snaps back to the last position the server confirmed.
 */
export function PlayScreen({ user, settings, prefs, onOpenSettings }: PlayScreenProps) {
  const screen = prefs?.effective.play;
  const boardSet = screen?.board_set ?? user.board_set;
  const pieceSet = screen?.piece_set ?? user.piece_set;
  const soundSet = screen?.sound_set ?? user.sound_set;

  const maiaReady = Boolean(settings?.maia_binary);
  const eloMin = settings?.maia_elo_min ?? 600;
  const eloMax = settings?.maia_elo_max ?? 2000;

  // --- setup form -----------------------------------------------------------
  const [elo, setElo] = useState(1500);
  const [colour, setColour] = useState<Colour>('w');
  const [baseMinutes, setBaseMinutes] = useState(10);
  const [incrementSeconds, setIncrementSeconds] = useState(0);

  useEffect(() => {
    setElo((e) => Math.min(eloMax, Math.max(eloMin, e)));
  }, [eloMin, eloMax]);

  // --- session ----------------------------------------------------------------
  const [connecting, setConnecting] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flipped, setFlipped] = useState(false);

  const [fen, setFen] = useState(START_FEN);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [sanHistory, setSanHistory] = useState<string[]>([]);
  const [turn, setTurn] = useState<'w' | 'b'>('w');
  const [humanColor, setHumanColor] = useState<'w' | 'b'>('w');
  const [result, setResult] = useState<string | null>(null);
  const [resultReason, setResultReason] = useState<string | null>(null);
  const [inCheck, setInCheck] = useState(false);
  const [engineNotes, setEngineNotes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const [clockEnabled, setClockEnabled] = useState(false);
  const [whiteMs, setWhiteMs] = useState(0);
  const [blackMs, setBlackMs] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  // The server's own last word on the position, for `illegal` to snap back
  // to -- `fen` itself may be ahead of that by one optimistic local move.
  const authoritativeFen = useRef(START_FEN);
  const tickRef = useRef<number | null>(null);
  const greeted = useRef(false);

  // The ticker's interval closure needs the *current* turn without being
  // torn down and rebuilt every time it changes.
  const turnRef = useRef<'w' | 'b'>('w');
  turnRef.current = turn;
  // Whether an 'error' means "the new game never started" (reopen the setup
  // form so the fields are editable again) or "something went wrong mid-game"
  // (leave the board and move list alone). `sanHistory` isn't a dependency of
  // the message handler, so this is what it reads instead.
  const sanHistoryRef = useRef<string[]>([]);
  sanHistoryRef.current = sanHistory;

  const stopTicker = useCallback(() => {
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const startTicker = useCallback(() => {
    stopTicker();
    tickRef.current = window.setInterval(() => {
      if (turnRef.current === 'w') setWhiteMs((v) => Math.max(0, v - 200));
      else setBlackMs((v) => Math.max(0, v - 200));
    }, 200);
  }, [stopTicker]);

  const applyState = useCallback((msg: StateMessage) => {
    // Confirmation that the game the setup form asked for is actually live —
    // opening the socket only means the server said hello, and (unlike the
    // socket opening) this can't happen without `new_game` having succeeded,
    // so it's what actually retires the setup form.
    setStarted(true);
    setConnecting(false);
    if (msg.move_count === 0 && !greeted.current) {
      greeted.current = true;
      playSound(soundSet, 'start');
    }
    setSanHistory(msg.san_history);
    setTurn(msg.turn);
    setHumanColor(msg.human_color);
    setClockEnabled(msg.clock_enabled);
    setWhiteMs(msg.white_ms);
    setBlackMs(msg.black_ms);
    setInCheck(msg.in_check);
    setEngineNotes(msg.engine_notes);
    if (msg.result && !result) playSound(soundSet, 'end');
    setResult(msg.result);
    setResultReason(msg.result_reason);
    authoritativeFen.current = msg.fen;
    setFen(msg.fen);
    if (msg.result || !msg.clock_enabled) stopTicker();
    else startTicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundSet, result, stopTicker, startTicker]);

  const handleMessage = useCallback(
    (msg: PlayMessage) => {
      switch (msg.type) {
        case 'state':
          applyState(msg);
          break;
        case 'engine_move':
          authoritativeFen.current = msg.fen;
          setFen(msg.fen);
          setLastMove({ from: msg.from, to: msg.to });
          playMoveSound(soundSet, msg.san, false);
          break;
        case 'illegal':
          playSound(soundSet, 'illegal');
          setFen(authoritativeFen.current);
          break;
        case 'error':
          setError(msg.message);
          setConnecting(false);
          // A `new_game` that failed (no Maia configured, the engine wouldn't
          // start) never sent a `state`, so nothing actually began -- reopen
          // the setup form rather than leaving it disabled with no way to
          // change engine or try again.
          if (sanHistoryRef.current.length === 0) setStarted(false);
          break;
        case 'saved':
          setSaved(true);
          break;
      }
    },
    [applyState, soundSet],
  );

  const send = useCallback((body: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(body));
  }, []);

  const startGame = useCallback(() => {
    setError(null);
    setSaved(false);
    greeted.current = false;
    const newGameMsg = {
      type: 'new_game',
      elo,
      color: colour,
      base_minutes: baseMinutes,
      increment_seconds: incrementSeconds,
    };

    setConnecting(true);
    if (ws.current?.readyState === WebSocket.OPEN) {
      send(newGameMsg);
      return;
    }

    const socket = new WebSocket(api.wsUrl('/ws/play'));
    ws.current = socket;
    socket.onopen = () => socket.send(JSON.stringify(newGameMsg));
    socket.onmessage = (raw) => {
      try {
        handleMessage(JSON.parse(raw.data));
      } catch {
        /* ignore a malformed frame rather than tearing the session down */
      }
    };
    socket.onclose = () => {
      ws.current = null;
      setConnecting(false);
    };
    socket.onerror = () => {
      setError('Could not reach the play session.');
      setConnecting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elo, colour, baseMinutes, incrementSeconds, send, handleMessage]);

  useEffect(() => {
    return () => {
      stopTicker();
      ws.current?.close();
      ws.current = null;
    };
  }, [stopTicker]);

  useEffect(() => setFlipped(humanColor === 'b'), [humanColor]);

  const board = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);

  const interactive = started && !result && turn === humanColor;

  const onMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (!board || !interactive) return;
      const trial = new Chess(fen);
      let move;
      try {
        move = trial.move({ from, to, promotion: promotion ?? 'q' });
      } catch {
        return;
      }
      if (!move) return;
      // Optimistic: the board answers now, `state`/`illegal` reconciles.
      playMoveSound(soundSet, move.san, true);
      setFen(trial.fen());
      setLastMove({ from, to });
      send({ type: 'move', uci: from + to + (promotion ?? (move.promotion ? 'q' : '')) });
    },
    [board, interactive, fen, soundSet, send],
  );

  const resign = useCallback(() => send({ type: 'resign' }), [send]);
  const saveGame = useCallback(() => send({ type: 'save' }), [send]);

  const you = user.display_name;
  const maiaLabel = `Maia3${started ? ` (${elo})` : ''}`;
  const whiteName = humanColor === 'w' ? you : maiaLabel;
  const blackName = humanColor === 'w' ? maiaLabel : you;
  const topName = flipped ? whiteName : blackName;
  const bottomName = flipped ? blackName : whiteName;
  const topIsYou = (flipped ? 'w' : 'b') === humanColor;
  const bottomIsYou = !topIsYou;
  const topMs = flipped ? whiteMs : blackMs;
  const bottomMs = flipped ? blackMs : whiteMs;

  const statusText = (() => {
    if (!started) return 'Set up a game and press Start.';
    if (connecting) return 'Connecting to Maia…';
    if (result) return `Game over — ${result}${resultReason ? ` (${resultReason})` : ''}.`;
    if (turn === humanColor) return inCheck ? 'Your move — check!' : 'Your move.';
    return 'Maia is thinking…';
  })();

  const pairs = movePairs(sanHistory);
  const lowOnTime = clockEnabled && result == null && (humanColor === 'w' ? whiteMs : blackMs) <= 10000;

  const plate = (name: string, isYou: boolean, ms: number) => (
    <div className="flex items-center justify-between gap-2 px-1 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-fg">{name}</span>
        {isYou && (
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/20">
            you
          </span>
        )}
      </div>
      {clockEnabled && (
        <span
          className={`rounded-lg px-2 py-1 font-mono text-sm font-semibold tabular-nums ${
            ms <= 10000 && result == null
              ? 'bg-danger/15 text-danger-fg'
              : 'bg-canvas text-fg-2'
          }`}
        >
          {formatClock(ms)}
        </span>
      )}
    </div>
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto p-3 sm:p-6">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 xl:flex-row xl:items-start">
          <div className="board-column order-2 flex w-full min-w-0 flex-col xl:order-none xl:flex-1">
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-sm font-semibold text-fg">Play vs Maia</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setFlipped((v) => !v)}
                  title="Flip the board"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 hover:bg-surface-2"
                >
                  <FlipVertical2 className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={onOpenSettings}
                  title="Board and engine settings"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 hover:bg-surface-2"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {plate(topName, topIsYou, topMs)}

            <div className="board-bleed">
              <Board
                fen={fen}
                flipped={flipped}
                boardSet={boardSet}
                pieceSet={pieceSet}
                showLegalMoves={Boolean(user.show_legal_moves)}
                lastMove={lastMove}
                interactive={interactive}
                onMove={onMove}
              />
            </div>

            {plate(bottomName, bottomIsYou, bottomMs)}

            <div
              className={`mt-1 rounded-lg px-3 py-2 text-center text-sm font-medium ${
                result
                  ? 'bg-accent/10 text-accent'
                  : lowOnTime
                    ? 'bg-danger/15 text-danger-fg'
                    : 'text-fg-2'
              }`}
            >
              {statusText}
            </div>
          </div>

          <aside className="order-1 flex w-full shrink-0 flex-col gap-4 xl:order-none xl:w-80">
            {!maiaReady && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-xs text-fg">
                <span>No Maia engine is selected.</span>
                <button
                  onClick={onOpenSettings}
                  className="rounded-lg bg-accent-strong px-2.5 py-1 font-semibold text-on-accent hover:bg-accent"
                >
                  Choose one
                </button>
              </div>
            )}

            {/* A finished game leaves both panels up: this one to set up a
                rematch (editable again, since nothing is being played right
                now), and the one below to resign-that-was/save/read the
                engine's notes on the game that just ended. */}
            {(!started || result) && (
              <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
                <h3 className="text-xs font-semibold tracking-wider text-accent uppercase">
                  New game
                </h3>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium tracking-wide text-fg-muted uppercase">
                    Maia Elo
                  </span>
                  <input
                    type="number"
                    min={eloMin}
                    max={eloMax}
                    value={elo}
                    onChange={(e) => setElo(Number(e.target.value))}
                    className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent-strong disabled:opacity-50"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium tracking-wide text-fg-muted uppercase">
                    Your colour
                  </span>
                  <select
                    value={colour}
                    onChange={(e) => setColour(e.target.value as Colour)}
                    className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent-strong disabled:opacity-50"
                  >
                    <option value="w">White</option>
                    <option value="b">Black</option>
                    <option value="random">Random</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium tracking-wide text-fg-muted uppercase">
                      Base (min)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={180}
                      value={baseMinutes}
                      onChange={(e) => setBaseMinutes(Number(e.target.value))}
                      className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent-strong disabled:opacity-50"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium tracking-wide text-fg-muted uppercase">
                      Increment (s)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={60}
                      value={incrementSeconds}
                      onChange={(e) => setIncrementSeconds(Number(e.target.value))}
                      className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent-strong disabled:opacity-50"
                    />
                  </label>
                </div>
                <p className="text-[11px] text-fg-subtle">
                  0 minutes base plays with no clock.
                </p>
                <button
                  onClick={startGame}
                  disabled={!maiaReady || connecting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-strong px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent disabled:opacity-50"
                >
                  {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {started ? 'New game' : 'Start game'}
                </button>
                {error && <p className="text-xs text-danger-fg">{error}</p>}
              </div>
            )}

            {started && (
              <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
                <div className="flex gap-2">
                  <button
                    onClick={resign}
                    disabled={!!result}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-danger-line px-3 py-2 text-xs font-medium text-danger-fg hover:bg-danger/10 disabled:opacity-40"
                  >
                    <Flag className="h-3.5 w-3.5" />
                    Resign
                  </button>
                  <button
                    onClick={saveGame}
                    disabled={sanHistory.length === 0 || saved}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-xs font-medium text-fg-2 hover:bg-surface-2 disabled:opacity-40"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saved ? 'Saved' : 'Save to library'}
                  </button>
                </div>
                {!result && error && <p className="text-xs text-danger-fg">{error}</p>}
                {engineNotes.length > 0 && (
                  <details className="text-[11px] text-fg-subtle">
                    <summary className="cursor-pointer select-none">Engine notes</summary>
                    <pre className="mt-1 whitespace-pre-wrap font-mono">
                      {engineNotes.join('\n')}
                    </pre>
                  </details>
                )}
              </div>
            )}

            <div className="thin-scroll min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-surface p-2">
              {pairs.length === 0 ? (
                <p className="p-3 text-center text-xs text-fg-subtle">No moves yet.</p>
              ) : (
                <table className="w-full border-separate border-spacing-y-0.5 text-xs">
                  <tbody>
                    {pairs.map((pair) => (
                      <tr key={pair.number}>
                        <td className="w-8 py-1 pl-2 font-mono text-fg-subtle">{pair.number}.</td>
                        <td className="py-1 font-mono text-fg">{pair.white ?? ''}</td>
                        <td className="py-1 font-mono text-fg">{pair.black ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
