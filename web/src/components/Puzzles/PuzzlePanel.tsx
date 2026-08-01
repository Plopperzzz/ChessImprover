import { ChevronRight, SlidersHorizontal, X } from 'lucide-react';
import type { PuzzleKind, PuzzleProgress, PuzzleSource, PuzzleStats } from '../../types';
import { LichessImportPanel } from './LichessImportPanel';
import { PuzzleFilters } from './PuzzleFilters';
import { PuzzleThemeProgress } from './PuzzleRating';

interface PuzzlePanelProps {
  source: PuzzleSource;
  kinds: PuzzleKind[];
  onChangeKinds: (kinds: PuzzleKind[]) => void;
  themes: string[];
  onChangeThemes: (themes: string[]) => void;
  stats: PuzzleStats | null;
  progress: PuzzleProgress | null;
  refreshKey: number;
  onImported: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * Everything about the puzzles that isn't the puzzle.
 *
 * What to practise, how you are doing at it, and where the puzzles come from
 * — one panel rather than three cards stacked under the board, which is what
 * they were and which pushed the board and its buttons off a phone screen.
 *
 * The shell is the game library's, deliberately: beside the board from `lg`
 * up, a full-screen sheet below it, a rail down the edge or a floating pill
 * when closed. Two panels that do the same job on two tabs should not need
 * learning twice, and the library's version of this is the one that has
 * already been through a phone.
 */
export function PuzzlePanel({
  source,
  kinds,
  onChangeKinds,
  themes,
  onChangeThemes,
  stats,
  progress,
  refreshKey,
  onImported,
  collapsed,
  onToggleCollapsed,
}: PuzzlePanelProps) {
  // What the closed panel says about itself. The motifs are the filter most
  // likely to be quietly hiding puzzles from you, so they are what the label
  // reports rather than a count of anything.
  const label = themes.length
    ? `${themes.length} MOTIF${themes.length === 1 ? '' : 'S'}`
    : source === 'own'
      ? `${(stats?.by_kind.tactic ?? 0) + (stats?.by_kind.blunder_check ?? 0)} PUZZLES`
      : 'LICHESS';

  if (collapsed) {
    return (
      <>
        <button
          onClick={onToggleCollapsed}
          className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface/60 py-4 text-fg-muted hover:text-fg lg:flex"
          title="Show what to practise"
        >
          <SlidersHorizontal className="h-4 w-4" />
          <span className="font-mono text-[10px] [writing-mode:vertical-rl]">
            PRACTISE · {label}
          </span>
        </button>
        <button
          onClick={onToggleCollapsed}
          className="fixed right-4 bottom-4 z-30 flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-3 text-xs font-semibold text-fg-2 shadow-2xl lg:hidden"
          title="Show what to practise"
        >
          <SlidersHorizontal className="h-4 w-4 text-accent" />
          <span className="font-mono">{label}</span>
        </button>
      </>
    );
  }

  return (
    <aside className="fixed inset-0 z-40 flex w-full flex-col bg-canvas lg:static lg:h-full lg:w-80 lg:shrink-0 lg:border-l lg:border-line lg:bg-surface/60 xl:w-96">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-accent" />
          <h3 className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
            What to practise
          </h3>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
          title="Collapse"
          aria-label="Close the practice panel"
        >
          <ChevronRight className="hidden h-4 w-4 lg:block" />
          <X className="h-5 w-5 lg:hidden" />
        </button>
      </div>

      <div className="thin-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <PuzzleFilters
          source={source}
          kinds={kinds}
          onChangeKinds={onChangeKinds}
          themes={themes}
          onChangeThemes={onChangeThemes}
          stats={stats}
          refreshKey={refreshKey}
        />

        <PuzzleThemeProgress progress={progress} />

        {/* Only under the source it belongs to: importing the Lichess database
            is not something to offer while you are working through your own
            mistakes, and it is the largest thing in here. */}
        {source === 'lichess' && <LichessImportPanel onImported={onImported} />}
      </div>
    </aside>
  );
}
