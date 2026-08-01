import { useCallback, useEffect, useState } from 'react';

/** What the user picked. `system` follows the OS rather than pinning either. */
export type ThemeMode = 'light' | 'dark' | 'system';
/** What is actually on screen once `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark';

/** Which neutral ramp the surfaces and text come from. Defined for both
 *  themes, so picking one is not picking a light or a dark look. */
export type Palette = 'stone' | 'slate' | 'graphite';
/** The highlight colour, chosen independently of the palette. */
export type Accent = 'amber' | 'sky' | 'emerald' | 'violet' | 'rose';

const THEME_KEY = 'engine-room:theme';
const PALETTE_KEY = 'engine-room:palette';
const ACCENT_KEY = 'engine-room:accent';

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
];

/** `swatch` is a panel colour and a text colour from the ramp, painted as a
 *  split chip. One dark circle per palette would be three near-identical dots —
 *  the difference between these is temperature, which only shows when a light
 *  and a dark value from the same ramp sit against each other. */
export const PALETTES: {
  value: Palette;
  label: string;
  note: string;
  swatch: [string, string];
}[] = [
  { value: 'stone', label: 'Stone', note: 'Warm grey', swatch: ['#1c1917', '#a8a29e'] },
  { value: 'slate', label: 'Slate', note: 'Cool grey', swatch: ['#151b26', '#94a3b8'] },
  { value: 'graphite', label: 'Graphite', note: 'Neutral grey', swatch: ['#181818', '#a3a3a3'] },
];

export const ACCENTS: { value: Accent; label: string; swatch: string }[] = [
  { value: 'amber', label: 'Amber', swatch: '#f59e0b' },
  { value: 'sky', label: 'Sky', swatch: '#38bdf8' },
  { value: 'emerald', label: 'Emerald', swatch: '#10b981' },
  { value: 'violet', label: 'Violet', swatch: '#8b5cf6' },
  { value: 'rose', label: 'Rose', swatch: '#f43f5e' },
];

const prefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export function storedMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function storedPalette(): Palette {
  const saved = localStorage.getItem(PALETTE_KEY);
  return PALETTES.some((p) => p.value === saved) ? (saved as Palette) : 'stone';
}

/** Amber is the default deliberately — it is the look the app shipped with. */
export function storedAccent(): Accent {
  const saved = localStorage.getItem(ACCENT_KEY);
  return ACCENTS.some((a) => a.value === saved) ? (saved as Accent) : 'amber';
}

export function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** Writes the three attributes `index.css` keys its palette off. Exported
 *  because `main.tsx` calls it before the first render — doing it in an effect
 *  would paint the default look first and flash. */
export function applyTheme(
  mode: ThemeMode,
  palette: Palette = storedPalette(),
  accent: Accent = storedAccent(),
): ResolvedTheme {
  const resolved = resolve(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.palette = palette;
  root.dataset.accent = accent;
  return resolved;
}

/**
 * The single owner of the look. `App` calls it once and passes the setters to
 * the settings dialog; everything else just reads the CSS tokens.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [palette, setPaletteState] = useState<Palette>(storedPalette);
  const [accent, setAccentState] = useState<Accent>(storedAccent);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(storedMode()));

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_KEY, next);
    setModeState(next);
  }, []);

  const setPalette = useCallback((next: Palette) => {
    localStorage.setItem(PALETTE_KEY, next);
    setPaletteState(next);
  }, []);

  const setAccent = useCallback((next: Accent) => {
    localStorage.setItem(ACCENT_KEY, next);
    setAccentState(next);
  }, []);

  useEffect(() => setResolved(applyTheme(mode, palette, accent)), [mode, palette, accent]);

  // On `system`, the OS can change under us — at sunset, or when the user
  // flips it in another window.
  useEffect(() => {
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(applyTheme('system', palette, accent));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode, palette, accent]);

  return { mode, setMode, palette, setPalette, accent, setAccent, resolved };
}

export type ThemeState = ReturnType<typeof useTheme>;

/** The chart tokens, as literal colours.
 *
 *  Recharts takes colours as props rather than classes, so it can't use the
 *  `var(--er-…)` utilities the rest of the UI does — SVG attributes like
 *  `stroke` accept a var, but the values recharts interpolates (tooltip styles,
 *  dot fills) don't reliably. Reading them back off the root element keeps one
 *  definition in `index.css` instead of a second copy here. */
export interface ChartTheme {
  grid: string;
  axis: string;
  /** The plotted line itself, where it isn't one of the accents. */
  line: string;
  /** The panel the chart sits on — tooltip fill, and the halo around a dot. */
  surface: string;
  tooltipBorder: string;
  accent: string;
  accent2: string;
}

const CHART_VARS: Record<keyof ChartTheme, string> = {
  grid: '--er-chart-grid',
  axis: '--er-chart-axis',
  line: '--er-chart-line',
  surface: '--er-surface',
  tooltipBorder: '--er-line-2',
  accent: '--er-accent',
  accent2: '--er-accent-2',
};

function readChartTheme(): ChartTheme {
  const styles = getComputedStyle(document.documentElement);
  const out = {} as ChartTheme;
  for (const [key, variable] of Object.entries(CHART_VARS)) {
    out[key as keyof ChartTheme] = styles.getPropertyValue(variable).trim();
  }
  return out;
}

/**
 * A lighter version of a colour, mixed towards white.
 *
 * The house rule for a plot that draws both is that the **points** carry the
 * measured colour and the **line** joining them is a lighter tint of it — one
 * hue per series, so the line reads as the same quantity rather than as a
 * second one. Recharts wants a literal colour, so this does the mix rather
 * than `color-mix()`.
 *
 * Anything that isn't a `#rgb`/`#rrggbb` (a colour token spelled some other
 * way) is handed back unchanged rather than turned into black.
 */
export function lighten(colour: string, amount = 0.4): string {
  const hex = colour.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return colour;
  const mix = (channel: number) =>
    Math.round(channel + (255 - channel) * Math.min(1, Math.max(0, amount)));
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Re-read on every theme change; `resolved` is the trigger, not the source. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(readChartTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readChartTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette', 'data-accent'],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
