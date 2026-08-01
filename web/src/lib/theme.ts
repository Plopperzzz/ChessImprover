import { useCallback, useEffect, useState } from 'react';

/** What the user picked. `system` follows the OS rather than pinning either. */
export type ThemeMode = 'light' | 'dark' | 'system';
/** What is actually on screen once `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark';

const THEME_KEY = 'engine-room:theme';

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
];

const prefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export function storedMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

export function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** Writes the attribute `index.css` keys its palette off. Exported because
 *  `main.tsx` calls it before the first render — doing it in an effect would
 *  paint the default theme first and flash. */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolve(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/**
 * The single owner of the theme. `App` calls it once and passes the setter to
 * the settings dialog; everything else just reads the CSS tokens.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(storedMode()));

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(THEME_KEY, next);
    setModeState(next);
  }, []);

  useEffect(() => setResolved(applyTheme(mode)), [mode]);

  // On `system`, the OS can change under us — at sunset, or when the user
  // flips it in another window.
  useEffect(() => {
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(applyTheme('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  return { mode, setMode, resolved };
}

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

/** Re-read on every theme change; `resolved` is the trigger, not the source. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(readChartTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readChartTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
