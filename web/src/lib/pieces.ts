import { Chess } from 'chess.js';

/**
 * Pieces with identities that survive a move.
 *
 * The board used to rebuild its grid from the FEN on every render, which is
 * why pieces teleported (B5): nothing on screen persisted between two
 * positions, so there was nothing to animate. Here each piece keeps an id
 * across renders, and moving is the same element arriving at new coordinates —
 * which CSS can tween on its own.
 *
 * Identity is carried by matching the new position against the old one:
 *
 * 1. A piece that hasn't moved is the piece on the same square.
 * 2. The piece that moved is the one on `move.from`, now on `move.to`. A
 *    promotion keeps the id and changes type, so the pawn *becomes* a queen
 *    rather than one vanishing and another appearing.
 * 3. Castling moves a rook nobody asked about, so it is matched explicitly.
 * 4. Anything still unmatched is new, and fades in where it stands.
 *
 * Nothing here knows about the DOM: it takes two positions and returns the
 * piece list for the second one.
 */

export interface PlacedPiece {
  /** Stable across renders. Not derived from the square, which is the point. */
  id: string;
  square: string;
  colour: 'w' | 'b';
  type: string;
  /** True for the piece that has just arrived, so it can be drawn on top of
   *  whatever it captured while it crosses. */
  moving: boolean;
}

export interface BoardMove {
  from: string;
  to: string;
}

let counter = 0;
const freshId = (colour: string, type: string) => `${colour}${type}-${(counter += 1)}`;

function placement(fen: string): { square: string; colour: 'w' | 'b'; type: string }[] {
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch {
    return [];
  }
  const out: { square: string; colour: 'w' | 'b'; type: string }[] = [];
  for (const row of game.board()) {
    for (const square of row) {
      if (square) out.push({ square: square.square, colour: square.color, type: square.type });
    }
  }
  return out;
}

/** The rook's journey when the king castles, or null when it isn't castling. */
function castlingRook(move: BoardMove, type: string): BoardMove | null {
  if (type !== 'k') return null;
  const fromFile = move.from.charCodeAt(0);
  const toFile = move.to.charCodeAt(0);
  if (Math.abs(toFile - fromFile) < 2) return null;
  const rank = move.to[1];
  return toFile > fromFile
    ? { from: `h${rank}`, to: `f${rank}` }
    : { from: `a${rank}`, to: `d${rank}` };
}

/**
 * The piece list for `fen`, reusing ids from `previous` wherever the same
 * piece is still on the board.
 *
 * `move` is what produced this position, when that is known — stepping
 * forward, or a move just played. Without it (a jump to an arbitrary ply, a
 * new game) only rule 1 applies, so unrelated positions snap rather than
 * sliding pieces between squares they never travelled.
 */
export function reconcile(
  previous: PlacedPiece[],
  fen: string,
  move: BoardMove | null,
): PlacedPiece[] {
  const wanted = placement(fen);
  const byId = new Map(previous.map((piece) => [piece.id, piece]));
  const bySquare = new Map(previous.map((piece) => [piece.square, piece]));
  const claimed = new Set<string>();
  const out: PlacedPiece[] = [];

  const takeFrom = (square: string, colour: string, type: string, sameType: boolean) => {
    const candidate = bySquare.get(square);
    if (!candidate || claimed.has(candidate.id)) return null;
    if (candidate.colour !== colour) return null;
    if (sameType && candidate.type !== type) return null;
    claimed.add(candidate.id);
    return candidate;
  };

  const moved = new Map<string, string>(); // destination square -> id
  if (move) {
    // The piece that moved keeps its id even if its type changed, which is
    // what makes a promotion one piece rather than two.
    const mover = bySquare.get(move.from);
    if (mover && !claimed.has(mover.id)) {
      claimed.add(mover.id);
      moved.set(move.to, mover.id);
      const rook = castlingRook(move, mover.type);
      if (rook) {
        const castled = bySquare.get(rook.from);
        if (castled && !claimed.has(castled.id)) {
          claimed.add(castled.id);
          moved.set(rook.to, castled.id);
        }
      }
    }
  }

  for (const piece of wanted) {
    const carried = moved.get(piece.square);
    if (carried && byId.has(carried)) {
      out.push({ ...piece, id: carried, moving: true });
      continue;
    }
    const stayed = takeFrom(piece.square, piece.colour, piece.type, true);
    out.push({
      ...piece,
      id: stayed ? stayed.id : freshId(piece.colour, piece.type),
      moving: false,
    });
  }
  return out;
}
