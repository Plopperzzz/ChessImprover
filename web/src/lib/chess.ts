import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface Ply {
  /** 1-based, matching the backend's `ply` on every analysis move. */
  ply: number;
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  from: string;
  to: string;
  piece: string;
  /** Position the move was played from, and the one it produced. */
  fenBefore: string;
  fenAfter: string;
}

export interface ParsedGame {
  headers: Record<string, string>;
  plies: Ply[];
}

export function parsePgn(pgnText: string): ParsedGame {
  const headers: Record<string, string> = {};
  for (const line of pgnText.split('\n')) {
    const m = line.match(/^\[(\w+)\s+"(.*)"\]\s*$/);
    if (m) headers[m[1]] = m[2];
  }

  const plies: Ply[] = [];
  try {
    const loader = new Chess();
    // chess.js chokes on some real-world exports (clock comments, %eval, NAGs
    // it doesn't know). A game we can't read is worth showing headers-only
    // rather than blanking the whole screen.
    loader.loadPgn(pgnText, { strict: false });
    const history = loader.history({ verbose: true });
    const replay = new Chess();
    history.forEach((move, idx) => {
      const fenBefore = replay.fen();
      replay.move(move.san);
      plies.push({
        ply: idx + 1,
        moveNumber: Math.floor(idx / 2) + 1,
        color: move.color,
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion ?? ''}`,
        from: move.from,
        to: move.to,
        piece: move.piece,
        fenBefore,
        fenAfter: replay.fen(),
      });
    });
  } catch {
    return { headers, plies: [] };
  }
  return { headers, plies };
}

/** The position after `index` plies. index 0 is the starting position. */
export function fenAt(plies: Ply[], index: number): string {
  if (index <= 0 || plies.length === 0) return plies[0]?.fenBefore ?? START_FEN;
  const clamped = Math.min(index, plies.length);
  return plies[clamped - 1].fenAfter;
}

/** Centipawns (white's perspective) to the pawn number shown on the eval bar. */
export function cpToPawns(cp: number): number {
  return Math.round((cp / 100) * 100) / 100;
}

export function formatEval(cp: number | null | undefined, mate?: number | null): string {
  if (mate != null && mate !== 0) return `#${mate > 0 ? '' : '-'}${Math.abs(mate)}`;
  if (cp == null) return '--';
  const pawns = cp / 100;
  const sign = pawns > 0 ? '+' : pawns < 0 ? '−' : '';
  return `${sign}${Math.abs(pawns).toFixed(2)}`;
}

/** Win probability, matching `classify.win_prob` so the bar and the backend's
 *  own classification agree about what "winning" means. */
export function winProb(cp: number): number {
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

/** Rewrites a UCI principal variation into SAN against the position it was
 *  searched from. Stops at the first move that doesn't apply, which is what a
 *  PV truncated mid-stream looks like. */
export function pvToSan(fen: string, pv: string[]): string[] {
  const board = new Chess();
  try {
    board.load(fen);
  } catch {
    return pv;
  }
  const out: string[] = [];
  for (const uci of pv) {
    try {
      const move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!move) break;
      out.push(move.san);
    } catch {
      break;
    }
  }
  return out.length ? out : pv;
}

export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Which side of a game the logged-in account played, or null when the import
 *  couldn't match either header to them. Everything keyed by side -- the sweep
 *  results, the board orientation, the "you" badge -- reads this rather than
 *  defaulting an unassigned game to white. */
export function yourSide(value: string | null | undefined): 'w' | 'b' | null {
  return value === 'w' || value === 'b' ? value : null;
}

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
export const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

export function pieceUrl(pieceSet: string, color: 'w' | 'b', type: string): string {
  return `/assets/sets/${pieceSet}/${color}${type.toLowerCase()}.png`;
}
