import { TrendingDown, TrendingUp } from 'lucide-react';
import type { PuzzleProgress, PuzzleRatingResult } from '../../types';

interface PuzzleRatingProps {
  progress: PuzzleProgress | null;
  /** What the last graded attempt did to it, when there was one. */
  change: PuzzleRatingResult | null;
}

/**
 * Your puzzle rating, and what the last answer did to it.
 *
 * One rating across both sources, because they are one trainer: see
 * `backend/app/puzzle_ratings.py`. The deviation is shown rather than hidden
 * -- a provisional rating that looks like a measurement is the main way a
 * number like this misleads, and "±" is the cheapest possible way to say so.
 */
export function PuzzleRating({ progress, change }: PuzzleRatingProps) {
  if (!progress) return null;
  const { overall } = progress;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold text-fg">{overall.rating}</span>
          <span className="text-xs text-fg-subtle">
            ±{overall.rd}
            {overall.provisional && ' · provisional'}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-fg-subtle">
          {progress.solved}/{progress.attempts} solved
          {progress.by_source.own + progress.by_source.lichess > 0 && (
            <>
              {' · '}
              {progress.by_source.own} from your games, {progress.by_source.lichess} from Lichess
            </>
          )}
        </div>
      </div>

      {change && (
        <div className="shrink-0 text-right">
          {change.rated ? (
            <div
              className={`flex items-center gap-1 font-mono text-sm font-semibold ${
                change.delta >= 0 ? 'text-success-fg' : 'text-danger-fg'
              }`}
            >
              {change.delta >= 0 ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )}
              {change.delta >= 0 ? '+' : ''}
              {change.delta}
            </div>
          ) : (
            // Saying *why* nothing moved, because a rating that sometimes
            // doesn't respond and never explains itself reads as broken.
            <span className="text-[11px] text-fg-subtle">
              {!change.first_try
                ? 'retry — not rated'
                : change.puzzle_rating == null
                  ? 'unrated puzzle'
                  : 'not rated'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Which motifs you are actually good at, strongest first. */
export function PuzzleThemeProgress({ progress }: { progress: PuzzleProgress | null }) {
  const themes = progress?.themes ?? [];
  if (!themes.length) return null;

  const top = Math.max(...themes.map((t) => t.rating), 1);

  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="mb-2 text-xs font-semibold tracking-wide text-fg-2 uppercase">
        Your motifs
      </div>
      <div className="flex flex-col gap-1.5">
        {themes.map((theme) => (
          <div key={theme.theme} className="flex items-center gap-2 text-[11px]">
            <span className="w-28 shrink-0 truncate text-fg-2" title={theme.theme}>
              {theme.theme}
            </span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent-2"
                style={{ width: `${Math.round((theme.rating / top) * 100)}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-fg">{theme.rating}</span>
            <span className="w-14 shrink-0 text-right text-fg-subtle">
              {theme.solved}/{theme.attempts}
              {theme.provisional && '*'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
