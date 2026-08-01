import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import { pvToSan } from './chess';
import type { EngineLine } from '../types';

interface Info {
  type: 'info';
  seq: number;
  depth: number | null;
  pv: string[];
  cp: number | null;
  mate: number | null;
  multipv: number;
}

/**
 * The persistent live-eval session (/ws/live-eval).
 *
 * The server streams a message per UCI `info` line and tags it with the
 * sequence number of the position it belongs to, so this keeps the newest line
 * per MultiPV rank and throws away anything still arriving for a position the
 * board has already moved off. Scores come back mover-relative, and are
 * flipped here into white's perspective -- the eval bar has to mean the same
 * thing regardless of whose turn it is.
 *
 * Asking for a new position does *not* clear the lines (B13). Stockfish takes
 * a moment to produce its first `info`, and emptying the list in the meantime
 * collapsed the panel and jumped the whole column on every arrow key. The
 * previous position's lines stay up, flagged `stale`, and are replaced when the
 * first line of the new search lands -- which is what the sequence number was
 * already there to tell us.
 */
export function useLiveEval(active: boolean, fen: string | null, multipv: number) {
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const seq = useRef(0);
  const byRank = useRef(new Map<number, EngineLine>());
  const searchFen = useRef<string | null>(null);
  /** Which sequence the lines in `byRank` belong to. Not the same as `seq`,
   *  which is the search that has been *asked for*. */
  const shown = useRef<number | null>(null);

  const publish = useCallback(() => {
    setLines([...byRank.current.values()].sort((a, b) => a.rank - b.rank));
  }, []);

  useEffect(() => {
    if (!active) {
      socket.current?.close();
      socket.current = null;
      setConnected(false);
      setLines([]);
      setStale(false);
      byRank.current.clear();
      shown.current = null;
      return;
    }

    const ws = new WebSocket(api.wsUrl('/ws/live-eval'));
    socket.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };
    ws.onmessage = (raw) => {
      let msg: Info | { type: 'error'; message: string };
      try {
        msg = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (msg.type === 'error') {
        setError(msg.message);
        return;
      }
      if (msg.type !== 'info' || msg.seq !== seq.current) return;

      // First line of the search we asked for: now, and not before, the
      // previous position's lines are replaced rather than shown alongside.
      if (shown.current !== msg.seq) {
        byRank.current.clear();
        shown.current = msg.seq;
        setStale(false);
      }

      // Mover-relative -> white-relative.
      const flip = searchFen.current ? searchFen.current.split(' ')[1] === 'b' : false;
      byRank.current.set(msg.multipv, {
        rank: msg.multipv,
        cp: msg.cp == null ? null : flip ? -msg.cp : msg.cp,
        mate: msg.mate == null ? null : flip ? -msg.mate : msg.mate,
        depth: msg.depth ?? 0,
        pv: msg.pv,
        sanPv: searchFen.current ? pvToSan(searchFen.current, msg.pv) : msg.pv,
      });
      publish();
    };
    ws.onclose = () => setConnected(false);

    return () => {
      ws.onclose = null;
      ws.close();
      socket.current = null;
      setConnected(false);
    };
  }, [active, publish]);

  // New position: bump the sequence and ask for it. What is on screen belongs
  // to the previous one until the engine says otherwise, so it is marked stale
  // rather than thrown away.
  useEffect(() => {
    const ws = socket.current;
    if (!active || !fen || !ws || ws.readyState !== WebSocket.OPEN) return;
    seq.current += 1;
    searchFen.current = fen;
    setStale(byRank.current.size > 0);
    ws.send(JSON.stringify({ type: 'position', fen, seq: seq.current }));
  }, [active, fen, connected]);

  useEffect(() => {
    const ws = socket.current;
    if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
    seq.current += 1;
    setStale(byRank.current.size > 0);
    ws.send(JSON.stringify({ type: 'multipv', lines: multipv, seq: seq.current }));
  }, [active, multipv, connected]);

  return { lines, stale, error, connected };
}
