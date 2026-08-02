import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { FILES, RANKS, pieceUrl } from '../lib/chess';
import { reconcile, transition, type PlacedPiece } from '../lib/pieces';
import { styleFor } from '../lib/quality';

export interface BoardMarker {
  square: string;
  /** A classification label -- drawn as the badge for that quality. */
  quality?: string | null;
}

interface BoardProps {
  fen: string;
  flipped: boolean;
  boardSet: string;
  pieceSet: string;
  showLegalMoves: boolean;
  showCoordinates?: boolean;
  /** Squares of the move that produced this position, lit up — and, when it is
   *  the move that *just* produced it, what the pieces animate along. */
  lastMove?: { from: string; to: string } | null;
  /** Quality badge pinned to a square (the move just played). */
  marker?: BoardMarker | null;
  /** Arrow drawn for the engine's suggestion, in UCI (e.g. 'e2e4'). Only ever
   *  a move for the position on the board -- see `linesStale` at the call
   *  site, which is what keeps the previous position's move off this one. */
  hintMove?: string | null;
  /** A single square lit up -- the piece a puzzle hint says to move, without
   *  saying where it goes. */
  hintSquare?: string | null;
  /**
   * What legality, turn and promotion are worked out against, when it
   * differs from what is drawn.
   *
   * Blindfold training is the one caller that sets this: the board keeps
   * showing a frozen position (`fen`) while the puzzle underneath has moved
   * on, and clicking a square has to obey the *real* position even though
   * nothing on screen says which piece is actually there. Left unset, `fen`
   * drives both, which is every other board on the site.
   */
  logicFen?: string;
  onMove?: (from: string, to: string, promotion?: string) => void;
  interactive?: boolean;
}

/** How long a piece takes to cross. Long enough to read as a move, short
 *  enough that holding an arrow key doesn't queue up a backlog of animations. */
const GLIDE_MS = 140;

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'] as const;

/**
 * How far a piece is inset from the edge of its square, as a percentage.
 *
 * The piece is `object-contain` inside the square, so this padding is what
 * decides how big it is drawn: 3% a side left the art at 94% of the square,
 * and pieces are 3% larger than that now -- 96.8% of the square, so half of
 * the 3.2% that's left goes on each side.
 */
const PIECE_INSET = 1.6;

/**
 * The board.
 *
 * Squares are a plain CSS grid; the pieces are a separate layer of absolutely
 * positioned elements above it, each with an identity that survives a move
 * (`lib/pieces.ts`). That split is what makes movement animatable: a piece
 * arriving on a new square is the same element at new coordinates, so the
 * transition is CSS's problem rather than a re-render's.
 *
 * A piece is an <img> from the chosen set with a unicode glyph as fallback, so
 * a set that's missing art still renders a playable board rather than an empty
 * one.
 */
export function Board({
  fen,
  flipped,
  boardSet,
  pieceSet,
  showLegalMoves,
  showCoordinates = true,
  lastMove,
  marker,
  hintMove,
  hintSquare,
  logicFen,
  onMove,
  interactive = true,
}: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [brokenArt, setBrokenArt] = useState(false);
  /** Whether the chosen board's own art actually loaded. Squares only paint
   *  their own fallback colour when it hasn't (or has none): painting it
   *  unconditionally, as this used to, sat a near-opaque tint over every
   *  board image, so picking a different board changed nothing on screen. */
  const [artLoaded, setArtLoaded] = useState(false);
  const [promoting, setPromoting] = useState<{ from: string; to: string } | null>(null);
  /** The piece under the pointer, and where the pointer is, while dragging. */
  const [drag, setDrag] = useState<{
    square: string;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  /** The 8x8 grid itself, for anything measuring where a square actually is.
   *  `board-frame`'s own box is bigger than that by its border, and on a
   *  phone that border is asymmetric (dropped on the sides, kept top and
   *  bottom -- see the JSX below), so measuring the frame instead of the
   *  grid drags every pointer-to-square calculation off by a few pixels in
   *  exactly the cases a border is there to be seen at all. */
  const gridRef = useRef<HTMLDivElement>(null);

  // Legality, turn and promotion are worked out here -- and only here.
  // Everywhere else in this file that used to read `fen` for that purpose
  // now reads `game`, so the one board with a hidden position (blindfold
  // training) only had to change this line.
  const game = useMemo(() => {
    try {
      return new Chess(logicFen ?? fen);
    } catch {
      return null;
    }
  }, [fen, logicFen]);

  // --- pieces, with identity ------------------------------------------------

  const pieces = useRef<PlacedPiece[]>([]);
  const previousFen = useRef<string | null>(null);

  // During render rather than in an effect: the piece list *is* the render's
  // input, and computing it afterwards would paint one frame of the old
  // position on top of the new one.
  if (previousFen.current !== fen) {
    // Worked out from the two positions rather than taken from `lastMove`,
    // which is the move that produced the position on the board. That is the
    // right journey stepping forward and the wrong one stepping back — going
    // back one ply, `lastMove` describes a move played earlier still, whose
    // origin square is empty in both positions, so nothing was carried and
    // every piece snapped. `transition` answers in either direction, and
    // returns null for a jump of more than one move, which still snaps.
    const step = previousFen.current ? transition(previousFen.current, fen) : null;
    pieces.current = reconcile(pieces.current, fen, step);
    previousFen.current = fen;
  }

  useEffect(() => {
    setSelected(null);
    setTargets([]);
    setPromoting(null);
  }, [fen, logicFen]);

  useEffect(() => setBrokenArt(false), [pieceSet]);
  useEffect(() => setArtLoaded(false), [boardSet]);

  const files = flipped ? [...FILES].reverse() : FILES;
  const ranks = flipped ? [...RANKS].reverse() : RANKS;

  /** Percentage coordinates of a square's top-left corner, in drawn order. */
  const coords = (square: string) => {
    const file = files.indexOf(square[0]);
    const rank = ranks.indexOf(square[1]);
    return { left: file * 12.5, top: rank * 12.5 };
  };

  const squareAt = (clientX: number, clientY: number): string | null => {
    const box = gridRef.current?.getBoundingClientRect();
    if (!box) return null;
    const file = Math.floor(((clientX - box.left) / box.width) * 8);
    const rank = Math.floor(((clientY - box.top) / box.height) * 8);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return `${files[file]}${ranks[rank]}`;
  };

  // --- moving ---------------------------------------------------------------

  const legalTargets = (square: string): string[] => {
    if (!game) return [];
    try {
      return game.moves({ square: square as never, verbose: true }).map((m) => m.to);
    } catch {
      return [];
    }
  };

  const select = (square: string) => {
    if (!game) return;
    const piece = game.get(square as never);
    if (!piece || piece.color !== game.turn()) {
      setSelected(null);
      setTargets([]);
      return;
    }
    setSelected(square);
    setTargets(showLegalMoves ? legalTargets(square) : []);
  };

  /** Plays a move if it is legal, asking which piece first when it promotes. */
  const attempt = (from: string, to: string): boolean => {
    if (!game) return false;
    const legal = game
      .moves({ square: from as never, verbose: true })
      .filter((m) => m.to === to);
    if (legal.length === 0) return false;
    setSelected(null);
    setTargets([]);
    // chess.js reports a promotion as four moves to the same square; the board
    // asks which one rather than assuming a queen.
    if (legal.some((m) => m.promotion)) {
      setPromoting({ from, to });
      return true;
    }
    onMove?.(from, to);
    return true;
  };

  const handleClick = (square: string) => {
    if (!interactive || !game) return;
    if (selected && selected !== square && attempt(selected, square)) return;
    select(square);
  };

  // --- dragging -------------------------------------------------------------

  const onPointerDown = (event: React.PointerEvent, square: string) => {
    if (!interactive || !game || event.button !== 0) return;
    const piece = game.get(square as never);
    if (!piece || piece.color !== game.turn()) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setSelected(square);
    setTargets(showLegalMoves ? legalTargets(square) : []);
    setDrag({ square, x: event.clientX, y: event.clientY, moved: false });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    // A click is a press and a release on one square; only once the pointer has
    // actually travelled does this become a drag, so click-to-move still works
    // through the same handlers.
    const travelled =
      drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4;
    setDrag({ ...drag, x: event.clientX, y: event.clientY, moved: travelled });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!drag) return;
    const dropped = drag;
    setDrag(null);
    if (!dropped.moved) return; // a click: `handleClick` deals with it
    const target = squareAt(event.clientX, event.clientY);
    if (!target || target === dropped.square) {
      setSelected(null);
      setTargets([]);
      return;
    }
    if (!attempt(dropped.square, target)) {
      setSelected(null);
      setTargets([]);
    }
  };

  const markerStyle = styleFor(marker?.quality);
  const dragOver = drag?.moved ? squareAt(drag.x, drag.y) : null;

  /**
   * The engine's suggestion, as an arrow.
   *
   * It used to be a ring around each of the two squares, which is the same
   * decoration selection and drag-over use: with the engine on, stepping
   * through a game lit up two unrelated squares and read as the board having
   * selected something by itself. An arrow can only mean "play this".
   *
   * Drawn in the 8x8 square grid's own coordinates, so the flip is already
   * accounted for by `files`/`ranks`, and shortened at both ends -- off the
   * centre of the piece it leaves, short of the centre of the square it
   * points at -- so the head sits on the target square rather than under
   * whatever is standing there.
   */
  const hint = (() => {
    if (!hintMove || hintMove.length < 4) return null;
    const centre = (square: string) => {
      const file = files.indexOf(square[0]);
      const rank = ranks.indexOf(square[1]);
      return file < 0 || rank < 0 ? null : { x: file + 0.5, y: rank + 0.5 };
    };
    const from = centre(hintMove.slice(0, 2));
    const to = centre(hintMove.slice(2, 4));
    if (!from || !to) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return null;
    const unit = { x: dx / length, y: dy / length };
    return {
      x1: from.x + unit.x * 0.3,
      y1: from.y + unit.y * 0.3,
      x2: to.x - unit.x * 0.38,
      y2: to.y - unit.y * 0.38,
    };
  })();

  return (
    <div
      // `board-frame` is not styling, it is a handle: `index.css` squares off
      // the corners and drops the side borders when a phone puts the board
      // against the edges of the screen.
      className={`board-frame relative aspect-square w-full overflow-hidden rounded-xl border-2 border-line bg-surface shadow-2xl select-none ${
        drag?.moved ? 'cursor-grabbing' : ''
      }`}
      style={{
        backgroundImage: `url(/assets/boards/${boardSet}.png), url(/assets/sets/${boardSet}/board.png)`,
        // Not `cover`. `board-frame` is exactly square in its *border* box
        // (`aspect-square`), but the phone layout below drops the left/right
        // border and keeps the top/bottom one (see the comment above), which
        // makes the *padding* box -- what a background paints into, and what
        // the grid of squares fills with `w-full h-full` -- a few pixels
        // taller than it is wide. `cover` preserves the image's own aspect
        // ratio and crops to fill, so on that non-square box it drifts from
        // the grid a little more with every row; `100% 100%` stretches to
        // the box exactly the same way the grid does, so the two can never
        // disagree regardless of what shape the box ends up being.
        backgroundSize: '100% 100%',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {/* Invisible probes, not the board's own background-image: CSS gives no
          load/error event for a `background-image`, so there is no other way
          to know whether either candidate URL actually painted anything.
          Either one succeeding is enough to stop drawing the fallback tint. */}
      <img
        src={`/assets/boards/${boardSet}.png`}
        alt=""
        aria-hidden="true"
        className="hidden"
        onLoad={() => setArtLoaded(true)}
      />
      <img
        src={`/assets/sets/${boardSet}/board.png`}
        alt=""
        aria-hidden="true"
        className="hidden"
        onLoad={() => setArtLoaded(true)}
      />
      <div ref={gridRef} className="grid h-full w-full grid-cols-8 grid-rows-8">
        {ranks.map((rank, rankIdx) =>
          files.map((file, fileIdx) => {
            const square = `${file}${rank}`;
            const light = (rankIdx + fileIdx) % 2 === 0;
            const piece = game?.get(square as never);
            const isTarget = targets.includes(square);
            const isLastMove = lastMove?.from === square || lastMove?.to === square;
            const grabbable = interactive && piece && piece.color === game?.turn();

            return (
              <div
                key={square}
                onClick={() => handleClick(square)}
                onPointerDown={(event) => onPointerDown(event, square)}
                className={`relative flex items-center justify-center ${
                  interactive ? (grabbable ? 'cursor-grab' : 'cursor-pointer') : ''
                }`}
                style={{
                  // The board's own image is behind this square (painted on
                  // `board-frame`) and shows through once it has loaded; this
                  // flat colour is only the fallback for a board with none, so
                  // it stops painting the moment real art is confirmed on
                  // screen -- otherwise it sat on top of every board at
                  // 92% opacity and no choice of board ever looked different.
                  // Squares, coordinates and the fallback glyphs below are the
                  // one part of the UI that doesn't follow the theme: they
                  // read against the board's own colours, not the page's.
                  backgroundColor: artLoaded
                    ? undefined
                    : light
                      ? 'rgba(240,217,181,0.92)'
                      : 'rgba(140,100,64,0.92)',
                  // Dragging, on a touch screen.
                  //
                  // A finger on a square the browser is allowed to pan with is
                  // a scroll gesture: the browser claims the pointer as soon as
                  // it moves and fires `pointercancel`, which killed every drag
                  // before it started -- the piece lit up as selected and then
                  // stayed put. Taking the gesture away fixes that, and doing
                  // it *only* on a square holding a piece you could move keeps
                  // the phone able to scroll the page with the other sixty:
                  // the board is most of that screen, and a board you cannot
                  // scroll past is its own bug.
                  touchAction: grabbable ? 'none' : undefined,
                }}
              >
                {isLastMove && <div className="absolute inset-0 bg-accent/30" />}
                {hintSquare === square && (
                  <div className="absolute inset-0 z-10 animate-pulse ring-4 ring-inset ring-accent-2" />
                )}
                {selected === square && (
                  <div className="absolute inset-0 ring-4 ring-inset ring-accent" />
                )}
                {dragOver === square && dragOver !== drag?.square && (
                  <div className="absolute inset-0 ring-4 ring-inset ring-accent/70" />
                )}

                {showCoordinates && fileIdx === 0 && (
                  <span
                    className={`pointer-events-none absolute top-0.5 left-1 z-20 font-mono text-[9px] font-semibold ${
                      light ? 'text-stone-700' : 'text-stone-100'
                    }`}
                  >
                    {rank}
                  </span>
                )}
                {showCoordinates && rankIdx === 7 && (
                  <span
                    className={`pointer-events-none absolute right-1 bottom-0.5 z-20 font-mono text-[9px] font-semibold ${
                      light ? 'text-stone-700' : 'text-stone-100'
                    }`}
                  >
                    {file}
                  </span>
                )}

                {isTarget && (
                  <div
                    className={`pointer-events-none absolute z-20 rounded-full ${
                      piece
                        ? 'inset-1 border-4 border-accent/60'
                        : 'h-1/3 w-1/3 bg-accent/60'
                    }`}
                  />
                )}

                {markerStyle && marker?.square === square && (
                  <img
                    src={markerStyle.icon}
                    alt={markerStyle.symbol || markerStyle.label}
                    title={markerStyle.label}
                    draggable={false}
                    className="pointer-events-none absolute z-30 drop-shadow-md"
                    style={{
                      // Straddling the corner rather than inset in it: the icon
                      // is centred on the square's top-right corner, which is
                      // where a move badge is expected to sit.
                      //
                      // Except on the board's own edges. The board clips to its
                      // rounded border, so an icon hanging over the top rank or
                      // the h file would be sliced in half; those tuck inside
                      // instead. Which rank and file that is depends on the
                      // flip, and `rankIdx`/`fileIdx` are already in drawn
                      // order rather than board order.
                      top: rankIdx === 0 ? '4%' : 0,
                      right: fileIdx === 7 ? '4%' : 0,
                      transform: `translate(${fileIdx === 7 ? '0' : '50%'}, ${
                        rankIdx === 0 ? '0' : '-50%'
                      })`,
                      // 35px is the size asked for; the cap keeps it under half
                      // a square on a phone-sized board, where 35px would sit
                      // across three of them.
                      width: 'min(35px, 52%)',
                      height: 'min(35px, 52%)',
                    }}
                  />
                )}
              </div>
            );
          }),
        )}
      </div>

      {/* The pieces, over the squares. Positioned rather than placed in the
          grid so that moving one is a change of coordinates — which animates —
          instead of a different cell rendering it. */}
      <div className="pointer-events-none absolute inset-0">
        {pieces.current.map((piece) => {
          const { left, top } = coords(piece.square);
          const dragging = drag?.moved && drag.square === piece.square;
          const box = gridRef.current?.getBoundingClientRect();
          const offset =
            dragging && box
              ? {
                  x: drag.x - box.left - (left / 100) * box.width - box.width / 16,
                  y: drag.y - box.top - (top / 100) * box.height - box.height / 16,
                }
              : { x: 0, y: 0 };

          return (
            <div
              key={piece.id}
              className="absolute flex items-center justify-center"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: '12.5%',
                height: '12.5%',
                // The dragged piece follows the pointer with no transition —
                // a tween would put it behind the cursor — and everything else
                // glides.
                transform: dragging ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
                transition: dragging ? 'none' : `left ${GLIDE_MS}ms, top ${GLIDE_MS}ms`,
                zIndex: dragging ? 40 : piece.moving ? 12 : 10,
                opacity: dragging ? 0.85 : 1,
              }}
            >
              {brokenArt ? (
                <span
                  className={`text-[min(7vw,2.6rem)] leading-none ${
                    piece.colour === 'w' ? 'text-stone-50' : 'text-stone-900'
                  }`}
                  style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
                >
                  {UNICODE[piece.type as keyof typeof UNICODE]?.[piece.colour]}
                </span>
              ) : (
                <img
                  src={pieceUrl(pieceSet, piece.colour, piece.type)}
                  alt=""
                  draggable={false}
                  onError={() => setBrokenArt(true)}
                  className="h-full w-full object-contain"
                  style={{ padding: `${PIECE_INSET}%` }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* The engine's suggestion. Over the pieces, because an arrow that
          disappears behind the piece it starts from doesn't point at anything. */}
      {hint && (
        <svg
          viewBox="0 0 8 8"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 z-[45] h-full w-full"
        >
          <defs>
            <marker
              id="board-hint-head"
              viewBox="0 0 4 4"
              refX="2.4"
              refY="2"
              markerWidth="3.2"
              markerHeight="3.2"
              orient="auto"
            >
              <path d="M0,0 L4,2 L0,4 z" className="fill-accent-2" />
            </marker>
          </defs>
          <line
            x1={hint.x1}
            y1={hint.y1}
            x2={hint.x2}
            y2={hint.y2}
            strokeWidth={0.14}
            strokeLinecap="round"
            markerEnd="url(#board-hint-head)"
            className="stroke-accent-2"
            opacity={0.85}
          />
        </svg>
      )}

      {/* Promotion: asked, not assumed. A knight is the right answer often
          enough that defaulting to a queen would quietly lose games. */}
      {promoting && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPromoting(null)}
        >
          <div
            className="flex gap-1 rounded-xl border border-line bg-surface p-2 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            {PROMOTION_PIECES.map((type) => (
              <button
                key={type}
                title={`Promote to ${type.toUpperCase()}`}
                onClick={() => {
                  const { from, to } = promoting;
                  setPromoting(null);
                  onMove?.(from, to, type);
                }}
                className="h-12 w-12 rounded-lg p-1 hover:bg-surface-2"
              >
                <img
                  src={pieceUrl(pieceSet, game?.turn() ?? 'w', type)}
                  alt={type}
                  className="h-full w-full object-contain"
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const UNICODE = {
  p: { w: '♙', b: '♟' },
  n: { w: '♘', b: '♞' },
  b: { w: '♗', b: '♝' },
  r: { w: '♖', b: '♜' },
  q: { w: '♕', b: '♛' },
  k: { w: '♔', b: '♚' },
} as const;
