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
 */
export function useLiveEval(active: boolean, fen: string | null, multipv: number) {
  const [lines, setLines] = useState<EngineLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const socket = useRef<WebSocket | null>(null);
  const seq = useRef(0);
  const byRank = useRef(new Map<number, EngineLine>());
  const searchFen = useRef<string | null>(null);

  const publish = useCallback(() => {
    setLines([...byRank.current.values()].sort((a, b) => a.rank - b.rank));
  }, []);

  useEffect(() => {
    if (!active) {
      socket.current?.close();
      socket.current = null;
      setConnected(false);
      setLines([]);
      byRank.current.clear();
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

  // New position: bump the sequence, clear the stale lines, ask for this one.
  useEffect(() => {
    const ws = socket.current;
    if (!active || !fen || !ws || ws.readyState !== WebSocket.OPEN) return;
    seq.current += 1;
    searchFen.current = fen;
    byRank.current.clear();
    setLines([]);
    ws.send(JSON.stringify({ type: 'position', fen, seq: seq.current }));
  }, [active, fen, connected]);

  useEffect(() => {
    const ws = socket.current;
    if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
    seq.current += 1;
    byRank.current.clear();
    setLines([]);
    ws.send(JSON.stringify({ type: 'multipv', lines: multipv, seq: seq.current }));
  }, [active, multipv, connected]);

  return { lines, error, connected };
}
