import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { FILES, RANKS, pieceUrl } from '../lib/chess';
import { reconcile, type PlacedPiece } from '../lib/pieces';
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
  /** Arrow drawn for the engine's suggestion, in UCI (e.g. 'e2e4'). */
  hintMove?: string | null;
  onMove?: (from: string, to: string, promotion?: string) => void;
  interactive?: boolean;
}

/** How long a piece takes to cross. Long enough to read as a move, short
 *  enough that holding an arrow key doesn't queue up a backlog of animations. */
const GLIDE_MS = 140;

const PROMOTION_PIECES = ['q', 'r', 'b', 'n'] as const;

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
  onMove,
  interactive = true,
}: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [brokenArt, setBrokenArt] = useState(false);
  const [promoting, setPromoting] = useState<{ from: string; to: string } | null>(null);
  /** The piece under the pointer, and where the pointer is, while dragging. */
  const [drag, setDrag] = useState<{
    square: string;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);

  const game = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);

  // --- pieces, with identity ------------------------------------------------

  const pieces = useRef<PlacedPiece[]>([]);
  const previousFen = useRef<string | null>(null);

  // During render rather than in an effect: the piece list *is* the render's
  // input, and computing it afterwards would paint one frame of the old
  // position on top of the new one.
  if (previousFen.current !== fen) {
    // A move is only carried when the board is walking one position to the
    // next; jumping to an arbitrary ply matches by square alone, so pieces
    // snap instead of sliding along paths they never took.
    const step = lastMove && previousFen.current ? lastMove : null;
    pieces.current = reconcile(pieces.current, fen, step);
    previousFen.current = fen;
  }

  useEffect(() => {
    setSelected(null);
    setTargets([]);
    setPromoting(null);
  }, [fen]);

  useEffect(() => setBrokenArt(false), [pieceSet]);

  const files = flipped ? [...FILES].reverse() : FILES;
  const ranks = flipped ? [...RANKS].reverse() : RANKS;

  /** Percentage coordinates of a square's top-left corner, in drawn order. */
  const coords = (square: string) => {
    const file = files.indexOf(square[0]);
    const rank = ranks.indexOf(square[1]);
    return { left: file * 12.5, top: rank * 12.5 };
  };

  const squareAt = (clientX: number, clientY: number): string | null => {
    const box = boardRef.current?.getBoundingClientRect();
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
  const hintFrom = hintMove ? hintMove.slice(0, 2) : null;
  const hintTo = hintMove ? hintMove.slice(2, 4) : null;
  const dragOver = drag?.moved ? squareAt(drag.x, drag.y) : null;

  return (
    <div
      ref={boardRef}
      className={`relative aspect-square w-full overflow-hidden rounded-xl border-2 border-line bg-surface shadow-2xl select-none ${
        drag?.moved ? 'cursor-grabbing' : ''
      }`}
      style={{
        backgroundImage: `url(/assets/boards/${boardSet}.png), url(/assets/sets/${boardSet}/board.png)`,
        backgroundSize: 'cover',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="grid h-full w-full grid-cols-8 grid-rows-8">
        {ranks.map((rank, rankIdx) =>
          files.map((file, fileIdx) => {
            const square = `${file}${rank}`;
            const light = (rankIdx + fileIdx) % 2 === 0;
            const piece = game?.get(square as never);
            const isTarget = targets.includes(square);
            const isLastMove = lastMove?.from === square || lastMove?.to === square;
            const isHint = hintFrom === square || hintTo === square;
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
                  // A board image, when the set has one, shows through; the tint
                  // is what keeps the squares readable if it doesn't. Squares,
                  // coordinates and the fallback glyphs below are the one part
                  // of the UI that doesn't follow the theme: they read against
                  // the board's own colours, not the page's.
                  backgroundColor: light ? 'rgba(240,217,181,0.92)' : 'rgba(140,100,64,0.92)',
                }}
              >
                {isLastMove && <div className="absolute inset-0 bg-accent/30" />}
                {isHint && (
                  <div className="absolute inset-0 ring-2 ring-inset ring-accent-2/80" />
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
          const box = boardRef.current?.getBoundingClientRect();
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
                  className="h-full w-full object-contain p-[3%]"
                />
              )}
            </div>
          );
        })}
      </div>

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
