import type { MoveQuality } from '../types';

export interface QualityStyle {
  label: string;
  /** Short glyph shown on the board badge and beside the move. */
  symbol: string;
  /** Tailwind classes for the filled badge. */
  badge: string;
  /** Hex, for the chart and anything that needs a raw colour. */
  color: string;
}

/** One table for every place a classification is drawn -- move list, board
 *  badge, eval chart dot, the summary counts. The labels are the backend's;
 *  only the presentation lives here. */
export const QUALITY: Record<MoveQuality, QualityStyle> = {
  brilliant: { label: 'Brilliant', symbol: '!!', badge: 'bg-cyan-500 text-white', color: '#06b6d4' },
  great: { label: 'Great', symbol: '!', badge: 'bg-blue-500 text-white', color: '#3b82f6' },
  best: { label: 'Best', symbol: '★', badge: 'bg-emerald-500 text-white', color: '#10b981' },
  excellent: { label: 'Excellent', symbol: '✓', badge: 'bg-teal-500 text-white', color: '#14b8a6' },
  good: { label: 'Good', symbol: '', badge: 'bg-stone-600 text-white', color: '#78716c' },
  book: { label: 'Book', symbol: '📖', badge: 'bg-amber-700 text-amber-100', color: '#b45309' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', badge: 'bg-amber-500 text-stone-950', color: '#f59e0b' },
  mistake: { label: 'Mistake', symbol: '?', badge: 'bg-orange-600 text-white', color: '#ea580c' },
  miss: { label: 'Miss', symbol: '✖', badge: 'bg-rose-700 text-white', color: '#be123c' },
  blunder: { label: 'Blunder', symbol: '??', badge: 'bg-red-600 text-white', color: '#dc2626' },
};

/** Display order for the per-side summary, best first. */
export const QUALITY_ORDER: MoveQuality[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

export function styleFor(quality?: string | null): QualityStyle | null {
  if (!quality) return null;
  return QUALITY[quality as MoveQuality] ?? null;
}
