/**
 * Piece animation, checked without a browser.
 *
 * The board animates by giving each piece an identity that survives a move
 * (`src/lib/pieces.ts`), so "does it animate" is really "did the piece on the
 * new square keep the id it had on the old one" — which is answerable here,
 * with no DOM and no engine. The same shape as `backend/sims/*_check.py`.
 *
 *     cd web && node --experimental-strip-types checks/animation_check.ts
 */
import { Chess } from 'chess.js';
import { reconcile, transition, type PlacedPiece } from '../src/lib/pieces.ts';

let failures = 0;
const ok = (cond: boolean, what: string) => {
  if (!cond) {
    failures += 1;
    console.log(`FAIL  ${what}`);
  } else {
    console.log(`ok    ${what}`);
  }
};

/** Walk a game, collecting a FEN per ply. */
function fens(sans: string[]): string[] {
  const game = new Chess();
  const out = [game.fen()];
  for (const san of sans) {
    game.move(san);
    out.push(game.fen());
  }
  return out;
}

const line = [
  'e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6',
  'Bg5', 'h6', 'Bxf6', 'Qxf6', 'Nc3', 'O-O',
];
const positions = fens(line);

// --- forward and backward both find a journey -----------------------------
for (let i = 0; i < positions.length - 1; i += 1) {
  const fwd = transition(positions[i], positions[i + 1]);
  ok(fwd != null, `forward ${i} -> ${i + 1} (${line[i]})`);
  const back = transition(positions[i + 1], positions[i]);
  ok(back != null, `back ${i + 1} -> ${i} (undo ${line[i]})`);
}

// --- a jump of several plies snaps ----------------------------------------
ok(transition(positions[0], positions[6]) === null, 'a six-ply jump has no single move');

// --- castling, both ways ---------------------------------------------------
const castleFwd = transition(positions[6], positions[7])!; // white O-O
ok(castleFwd.from === 'e1' && castleFwd.to === 'g1', 'white O-O is e1g1');
ok(castleFwd.rook?.from === 'h1' && castleFwd.rook?.to === 'f1', 'O-O carries h1->f1');
const castleBack = transition(positions[7], positions[6])!;
ok(castleBack.from === 'g1' && castleBack.to === 'e1', 'undoing O-O is g1e1');
ok(castleBack.rook?.from === 'f1' && castleBack.rook?.to === 'h1', 'undo carries f1->h1');

/** Piece ids on a board walked along `path`, applying transition each step. */
function walk(path: string[]): PlacedPiece[] {
  let pieces: PlacedPiece[] = reconcile([], path[0], null);
  for (let i = 1; i < path.length; i += 1) {
    pieces = reconcile(pieces, path[i], transition(path[i - 1], path[i]));
  }
  return pieces;
}

// --- ids survive a step back, which is what makes it animate ---------------
const atSeven = walk(positions.slice(0, 8)); // after white O-O
const kingId = atSeven.find((p) => p.type === 'k' && p.colour === 'w')!.id;
const rookId = atSeven.find((p) => p.square === 'f1')!.id;
const backToSix = reconcile(atSeven, positions[6], transition(positions[7], positions[6]));
ok(
  backToSix.find((p) => p.square === 'e1')?.id === kingId,
  'the king keeps its id stepping back over a castle',
);
ok(
  backToSix.find((p) => p.square === 'h1')?.id === rookId,
  'the rook keeps its id stepping back over a castle',
);

// --- a capture, undone: the capturing piece glides back --------------------
const atThirteen = walk(positions.slice(0, 14)); // after 7.Bxf6
const bishopId = atThirteen.find((p) => p.square === 'f6')!.id;
const undone = reconcile(atThirteen, positions[12], transition(positions[13], positions[12]));
ok(undone.find((p) => p.square === 'g5')?.id === bishopId, 'Bxf6 undone glides g5');
ok(undone.find((p) => p.square === 'f6')?.type === 'n', 'the captured knight is back on f6');

// --- promotion and en passant, both directions ----------------------------
const ep = new Chess('4k3/8/8/8/5p2/8/4P3/4K3 w - - 0 1');
const epBefore = ep.fen();
ep.move('e4');
const epMid = ep.fen();
ep.move('fxe3');
const epAfter = ep.fen();
ok(transition(epMid, epAfter)?.to === 'e3', 'en passant found going forward');
ok(transition(epAfter, epMid)?.from === 'e3', 'en passant found going back');
ok(transition(epBefore, epMid)?.to === 'e4', 'the double step before it');

const promo = new Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
const promoBefore = promo.fen();
promo.move('a8=Q');
const promoAfter = promo.fen();
const beforeIds = reconcile([], promoBefore, null);
const pawnId = beforeIds.find((p) => p.square === 'a7')!.id;
const promoted = reconcile(beforeIds, promoAfter, transition(promoBefore, promoAfter));
ok(promoted.find((p) => p.square === 'a8')?.id === pawnId, 'the pawn becomes the queen');
ok(transition(promoAfter, promoBefore)?.to === 'a7', 'promotion undone walks back to a7');

if (failures > 0) throw new Error(`${failures} failure(s)`);
console.log('\nall good');
