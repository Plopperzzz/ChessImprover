import { useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { FILES, RANKS, pieceUrl } from '../lib/chess';
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
  /** Squares of the move that produced this position, lit up. */
  lastMove?: { from: string; to: string } | null;
  /** Quality badge pinned to a square (the move just played). */
  marker?: BoardMarker | null;
  /** Arrow drawn for the engine's suggestion, in UCI (e.g. 'e2e4'). */
  hintMove?: string | null;
  onMove?: (from: string, to: string, promotion?: string) => void;
  interactive?: boolean;
}

/**
 * The board.
 *
 * Squares are laid out as a plain CSS grid rather than a canvas so a piece can
 * be an <img> from the user's chosen set with a unicode glyph behind it -- a
 * set that's missing art still renders a playable board instead of an empty
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

  const game = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);

  useEffect(() => {
    setSelected(null);
    setTargets([]);
  }, [fen]);

  useEffect(() => setBrokenArt(false), [pieceSet]);

  const files = flipped ? [...FILES].reverse() : FILES;
  const ranks = flipped ? [...RANKS].reverse() : RANKS;

  const select = (square: string) => {
    if (!game) return;
    const piece = game.get(square as never);
    if (!piece) {
      setSelected(null);
      setTargets([]);
      return;
    }
    setSelected(square);
    setTargets(
      showLegalMoves
        ? game.moves({ square: square as never, verbose: true }).map((m) => m.to)
        : [],
    );
  };

  const handleClick = (square: string) => {
    if (!interactive || !game) return;
    if (selected && selected !== square) {
      const legal = game
        .moves({ square: selected as never, verbose: true })
        .find((m) => m.to === square);
      if (legal) {
        onMove?.(selected, square, legal.promotion);
        setSelected(null);
        setTargets([]);
        return;
      }
    }
    select(square);
  };

  const markerStyle = styleFor(marker?.quality);
  const hintFrom = hintMove ? hintMove.slice(0, 2) : null;
  const hintTo = hintMove ? hintMove.slice(2, 4) : null;

  return (
    <div
      className="relative aspect-square w-full overflow-hidden rounded-xl border-2 border-line bg-surface shadow-2xl select-none"
      style={{
        backgroundImage: `url(/assets/boards/${boardSet}.png), url(/assets/sets/${boardSet}/board.png)`,
        backgroundSize: 'cover',
      }}
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

            return (
              <div
                key={square}
                onClick={() => handleClick(square)}
                className={`relative flex items-center justify-center ${
                  interactive ? 'cursor-pointer' : ''
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

                {showCoordinates && fileIdx === 0 && (
                  <span
                    className={`pointer-events-none absolute top-0.5 left-1 font-mono text-[9px] font-semibold ${
                      light ? 'text-stone-700' : 'text-stone-100'
                    }`}
                  >
                    {rank}
                  </span>
                )}
                {showCoordinates && rankIdx === 7 && (
                  <span
                    className={`pointer-events-none absolute right-1 bottom-0.5 font-mono text-[9px] font-semibold ${
                      light ? 'text-stone-700' : 'text-stone-100'
                    }`}
                  >
                    {file}
                  </span>
                )}

                {isTarget && (
                  <div
                    className={`pointer-events-none absolute z-10 rounded-full ${
                      piece
                        ? 'inset-1 border-4 border-accent/60'
                        : 'h-1/3 w-1/3 bg-accent/60'
                    }`}
                  />
                )}

                {piece &&
                  (brokenArt ? (
                    <span
                      className={`pointer-events-none text-[min(7vw,2.6rem)] leading-none ${
                        piece.color === 'w' ? 'text-stone-50' : 'text-stone-900'
                      }`}
                      style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
                    >
                      {UNICODE[piece.type as keyof typeof UNICODE]?.[piece.color]}
                    </span>
                  ) : (
                    <img
                      src={pieceUrl(pieceSet, piece.color, piece.type)}
                      alt=""
                      draggable={false}
                      onError={() => setBrokenArt(true)}
                      className="pointer-events-none h-full w-full object-contain p-[3%]"
                    />
                  ))}

                {markerStyle && marker?.square === square && markerStyle.symbol && (
                  <div
                    title={markerStyle.label}
                    className={`absolute top-0.5 right-0.5 z-20 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold shadow ring-1 ring-white/40 sm:h-5 sm:w-5 sm:text-[10px] ${markerStyle.badge}`}
                  >
                    {markerStyle.symbol}
                  </div>
                )}
              </div>
            );
          }),
        )}
      </div>
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
