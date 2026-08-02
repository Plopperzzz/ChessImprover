import type { MoveQuality } from '../types';

export interface QualityStyle {
  label: string;
  /** The icon in `assets/icons/classification/`, served at this URL. The file
   *  names are the backend's classification labels one-to-one, which is why
   *  this is derived rather than listed. */
  icon: string;
  /** Short glyph. Every classification is drawn as its icon now, so this is
   *  the icon's `alt` — what a browser shows if the SVG fails to load, and
   *  what a screen reader reads. */
  symbol: string;
  /** Hex, for the chart dots and the move-quality pie. Taken from the icon's
   *  own fill, so a blunder is the same red wherever it is drawn. */
  color: string;
}

const iconUrl = (name: MoveQuality) => `/assets/icons/classification/${name}.svg`;

/** One table for every place a classification is drawn -- move list, board
 *  badge, eval chart dot, the summary counts, the Progress pie. The labels are
 *  the backend's; only the presentation lives here.
 *
 *  Keeping this as the single source is what stops the four from drifting: the
 *  icon and the colour beside it are the same classification's, because they
 *  come from the same row. */
export const QUALITY: Record<MoveQuality, QualityStyle> = {
  brilliant: { label: 'Brilliant', icon: iconUrl('brilliant'), symbol: '!!', color: '#26c2a3' },
  great: { label: 'Great', icon: iconUrl('great'), symbol: '!', color: '#749bbf' },
  // Best used to be #81b64c, the same green as Excellent and a shade off Good's
  // -- three greens that were one colour in a pie chart. It is now brighter and
  // far more saturated than either, and `best.svg`'s own fill was changed with
  // it so the icon beside the slice is still the slice's colour.
  best: { label: 'Best', icon: iconUrl('best'), symbol: '★', color: '#5bd44a' },
  excellent: { label: 'Excellent', icon: iconUrl('excellent'), symbol: '✓', color: '#81b64c' },
  good: { label: 'Good', icon: iconUrl('good'), symbol: '', color: '#95b776' },
  book: { label: 'Book', icon: iconUrl('book'), symbol: '📖', color: '#d5a47d' },
  inaccuracy: { label: 'Inaccuracy', icon: iconUrl('inaccuracy'), symbol: '?!', color: '#f7c631' },
  mistake: { label: 'Mistake', icon: iconUrl('mistake'), symbol: '?', color: '#ffa459' },
  miss: { label: 'Miss', icon: iconUrl('miss'), symbol: '✖', color: '#ff7769' },
  blunder: { label: 'Blunder', icon: iconUrl('blunder'), symbol: '??', color: '#fa412d' },
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
