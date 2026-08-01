import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ShieldAlert, Swords } from 'lucide-react';
import * as api from '../../lib/api';
import type { PuzzleKind, PuzzleSource, PuzzleStats, ThemeGroup } from '../../types';

interface PuzzleFiltersProps {
  source: PuzzleSource;
  kinds: PuzzleKind[];
  onChangeKinds: (kinds: PuzzleKind[]) => void;
  themes: string[];
  onChangeThemes: (themes: string[]) => void;
  stats: PuzzleStats | null;
  /** Bumped by the screen when something happened that changes the counts --
   *  a rescan, or a puzzle finishing and getting its motifs tagged. */
  refreshKey: number;
}

const KIND_LABELS: Record<PuzzleKind, { label: string; hint: string; icon: ReactNode }> = {
  tactic: {
    label: 'Tactics',
    hint: 'Positions where there was something to win, and you missed it',
    icon: <Swords className="h-3.5 w-3.5" />,
  },
  blunder_check: {
    label: 'Blunder checks',
    hint: 'Positions you were holding and then threw away — find the move that holds',
    icon: <ShieldAlert className="h-3.5 w-3.5" />,
  },
};

/**
 * What to practise: which kinds of exercise, and which motifs.
 *
 * The two are independent and intersect, which is what makes "blunder checks,
 * but only the forks" expressible without a mode for it. Turning every theme
 * off means every theme, not none -- a filter you have to fill in before it
 * returns anything is a worse default than no filter, and "All" says so out
 * loud rather than leaving an empty row looking broken.
 *
 * Kinds only apply to your own games. A Lichess puzzle is always the first
 * kind, so offering the toggle there would be offering a filter that does
 * nothing.
 */
export function PuzzleFilters({
  source,
  kinds,
  onChangeKinds,
  themes,
  onChangeThemes,
  stats,
  refreshKey,
}: PuzzleFiltersProps) {
  const [groups, setGroups] = useState<ThemeGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .puzzleThemes(source, source === 'own' ? kinds : undefined)
      .then((data) => {
        setGroups(data.groups);
        setError(null);
      })
      .catch((e) => {
        setGroups([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [source, kinds, refreshKey]);

  const toggleKind = (kind: PuzzleKind) => {
    // Never both off: that is a request for no puzzles, and the useful reading
    // of "turn the last one off" is "turn the other one on".
    const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
    onChangeKinds(next.length ? next : (Object.keys(KIND_LABELS) as PuzzleKind[]).filter(
      (k) => k !== kind,
    ));
  };

  const toggleTheme = (theme: string) =>
    onChangeThemes(
      themes.includes(theme) ? themes.filter((t) => t !== theme) : [...themes, theme],
    );

  const total = groups.reduce((n, group) => n + group.themes.length, 0);

  return (
    <div className="rounded-xl border border-line bg-surface">
      {source === 'own' && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          {(Object.keys(KIND_LABELS) as PuzzleKind[]).map((kind) => {
            const on = kinds.includes(kind);
            const count = stats?.by_kind?.[kind];
            return (
              <button
                key={kind}
                onClick={() => toggleKind(kind)}
                title={KIND_LABELS[kind].hint}
                aria-pressed={on}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  on
                    ? 'bg-accent-strong text-on-accent'
                    : 'border border-line bg-surface-2 text-fg-2 hover:text-fg'
                }`}
              >
                {KIND_LABELS[kind].icon}
                {KIND_LABELS[kind].label}
                {count != null && (
                  <span className={on ? 'text-on-accent/70' : 'text-fg-subtle'}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold tracking-wide text-fg-2 uppercase"
      >
        <span>
          Motifs{' '}
          <span className="font-normal text-fg-subtle normal-case">
            {themes.length ? `${themes.length} chosen` : 'all'}
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-line p-3 thin-scroll">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              onClick={() => onChangeThemes([])}
              disabled={themes.length === 0}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                themes.length === 0
                  ? 'bg-accent-strong text-on-accent'
                  : 'border border-line bg-surface-2 text-fg-2 hover:text-fg'
              }`}
            >
              All
            </button>
            <span className="text-[11px] text-fg-subtle">
              {source === 'own'
                ? 'Motifs are tagged once an engine has worked a puzzle out'
                : `${total} with puzzles behind them`}
            </span>
          </div>

          {error && <p className="text-[11px] text-danger-fg">{error}</p>}
          {!error && groups.length === 0 && (
            <p className="text-[11px] text-fg-subtle">
              {source === 'own'
                ? 'No motifs yet — solve a few and they appear here.'
                : 'Import the database below and the motifs appear here.'}
            </p>
          )}

          {groups.map((group) => (
            <div key={group.key} className="mb-3 last:mb-0">
              <div className="mb-1 text-[10px] font-semibold tracking-wide text-fg-subtle uppercase">
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.themes.map((theme) => {
                  const on = themes.includes(theme.key);
                  return (
                    <button
                      key={theme.key}
                      onClick={() => toggleTheme(theme.key)}
                      title={theme.description}
                      aria-pressed={on}
                      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
                        on
                          ? 'bg-accent-strong text-on-accent'
                          : 'border border-line bg-surface-2 text-fg-2 hover:text-fg'
                      }`}
                    >
                      {theme.label}
                      <span className={on ? 'text-on-accent/70' : 'text-fg-subtle'}>
                        {theme.count}
                      </span>
                      {/* What you are rated at this motif, when there is a
                          record. The point of per-theme ratings is to answer
                          "what am I bad at", which only works if the answer is
                          visible where you pick what to practise. */}
                      {theme.progress && (
                        <span
                          className={`font-mono ${on ? 'text-on-accent' : 'text-accent-2'}`}
                          title={`Your rating at ${theme.label}`}
                        >
                          {theme.progress.rating}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
