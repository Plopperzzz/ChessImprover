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
  /** The rook's own journey when this move is a castle, for the cases where
   *  it can't be read off the king's: stepping *backwards* through one, where
   *  the king travels g1→e1 and the rook has to go f1→h1 rather than the a1→d1
   *  `castlingRook` would infer from that direction. Left undefined by callers
   *  that don't know, and inferred then. */
  rook?: BoardMove | null;
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

/** Board placement plus side to move — the part of a FEN that says which
 *  position this is. The clocks and the en-passant square are left out on
 *  purpose: two FENs for the same position written by different producers
 *  disagree about those often enough that comparing them whole would report
 *  "not the same position" about positions that are. */
const identity = (fen: string) => fen.split(' ').slice(0, 2).join(' ');

/** Where each square's occupant differs between two positions. A move only
 *  ever touches squares in here, which is what keeps the search below to a
 *  handful of candidates instead of every legal move. */
function changedSquares(a: string, b: string): Set<string> {
  const map = (fen: string) =>
    new Map(placement(fen).map((p) => [p.square, `${p.colour}${p.type}`]));
  const before = map(a);
  const after = map(b);
  const out = new Set<string>();
  for (const [square, piece] of before) if (after.get(square) !== piece) out.add(square);
  for (const [square, piece] of after) if (before.get(square) !== piece) out.add(square);
  return out;
}

/** The one legal move that turns `from` into `to`, or null if no single move
 *  does. Castling comes back with the rook's journey attached. */
function oneMoveApart(from: string, to: string): BoardMove | null {
  let game: Chess;
  try {
    game = new Chess(from);
  } catch {
    return null;
  }
  const touched = changedSquares(from, to);
  if (touched.size === 0 || touched.size > 4) return null; // 4 is a castle
  const wanted = identity(to);
  for (const candidate of game.moves({ verbose: true })) {
    if (!touched.has(candidate.from) || !touched.has(candidate.to)) continue;
    game.move(candidate);
    const reached = identity(game.fen());
    game.undo();
    if (reached !== wanted) continue;
    const rank = candidate.to[1];
    const rook = candidate.flags.includes('k')
      ? { from: `h${rank}`, to: `f${rank}` }
      : candidate.flags.includes('q')
        ? { from: `a${rank}`, to: `d${rank}` }
        : null;
    return { from: candidate.from, to: candidate.to, rook };
  }
  return null;
}

/**
 * What the pieces should travel along to get from one position to the next.
 *
 * Derived from the two positions rather than taken from the caller, because
 * the caller only knows the move that *produced* each position — which is the
 * right answer stepping forward and the wrong one stepping back, where the
 * board has to undo the move it is leaving rather than replay the one it is
 * arriving at. That asymmetry is why navigating backwards never animated.
 *
 * Returns null for anything that isn't one move away: jumping to an arbitrary
 * ply, or loading a different game. Those snap, as they should — a piece
 * cannot slide along a path it never took.
 */
export function transition(previousFen: string, fen: string): BoardMove | null {
  const forward = oneMoveApart(previousFen, fen);
  if (forward) return forward;
  // Backwards: find the move that would return us to where we were, and walk
  // it the other way. The rook goes with it, reversed too.
  const undone = oneMoveApart(fen, previousFen);
  if (!undone) return null;
  return {
    from: undone.to,
    to: undone.from,
    rook: undone.rook ? { from: undone.rook.to, to: undone.rook.from } : null,
  };
}

/**
 * The piece list for `fen`, reusing ids from `previous` wherever the same
 * piece is still on the board.
 *
 * `move` is the journey between the two positions — `transition` above works
 * it out from the positions themselves, in whichever direction the board is
 * going. Without it (a jump to an arbitrary ply, a new game) only rule 1
 * applies, so unrelated positions snap rather than sliding pieces between
 * squares they never travelled.
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
      const rook = move.rook !== undefined ? move.rook : castlingRook(move, mover.type);
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
