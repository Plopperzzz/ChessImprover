import { Activity, Cpu } from 'lucide-react';
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalysisMove, EngineLine } from '../../types';
import type { Ply } from '../../lib/chess';
import { formatEval, winProb } from '../../lib/chess';
import { useIsNarrow } from '../../lib/media';
import { styleFor } from '../../lib/quality';
import { useChartTheme } from '../../lib/theme';

interface EvalChartProps {
  plies: Ply[];
  moves: Map<number, AnalysisMove>;
  currentPlyIndex: number;
  onSelectPly: (index: number) => void;
  liveActive: boolean;
  engineLines: EngineLine[];
  /** The lines on screen belong to the previous position — the engine hasn't
   *  reported on this one yet (B13). */
  linesStale: boolean;
  liveError: string | null;
  /** The position's evaluation, white-relative, as the eval bar reads it —
   *  live while the engine is on, the stored analysis otherwise. Only drawn on
   *  a phone, where the plot gives way to a bar (D13). */
  evalCp: number | null;
  /** Board orientation, so the bar runs the same way the board does. */
  flipped: boolean;
}

/** Centipawns clamped to the range the plot actually shows. A mate score is
 *  ±10000 in the stored analysis, which would flatten every real move to zero. */
const CLAMP = 800;

export function EvalChart({
  plies,
  moves,
  currentPlyIndex,
  onSelectPly,
  liveActive,
  engineLines,
  linesStale,
  liveError,
  evalCp,
  flipped,
}: EvalChartProps) {
  const chart = useChartTheme();
  const narrow = useIsNarrow();

  /**
   * D13: on a phone, turning the engine on turns the plot into a bar.
   *
   * The two want the same space and only one of them is about the position in
   * front of you. With the engine's lines open, a plot of the whole game was
   * pushing the board's step buttons off the bottom of the screen; a bar says
   * the same thing about *this* position in one row, and the plot comes back
   * the moment the engine is switched off.
   */
  const asBar = narrow && liveActive;
  const whiteShare = evalCp == null ? 50 : Math.round(winProb(evalCp) * 100);

  // `cp_after` is stored from the perspective of whoever is to move in the
  // resulting position; the plot is white-relative throughout, so black's
  // moves get flipped back.
  const data = plies.map((ply) => {
    const move = moves.get(ply.ply);
    const raw = move ? (ply.color === 'w' ? -move.cp_after : move.cp_after) : null;
    return {
      index: ply.ply,
      label: `${ply.moveNumber}${ply.color === 'w' ? '.' : '…'} ${ply.san}`,
      cp: raw == null ? null : Math.max(-CLAMP, Math.min(CLAMP, raw)),
      quality: move?.classification ?? null,
    };
  });

  const analysed = data.some((d) => d.cp != null);
  // Sized by whether the engine panel is *open*, not by whether it currently
  // has lines in it: keying off the line count made the plot grow and shrink
  // between every move while Stockfish started its next search.
  //
  // The phone sizes are much shorter, because there the whole card sits above
  // the board: the plot, the engine's lines, the board and the buttons that
  // step through the game all have to fit on screen together, and the plot is
  // the one of the four that still reads at 80px.
  const chartHeight = liveActive ? 'h-20 sm:h-32 lg:h-36' : 'h-28 sm:h-44 lg:h-56';

  if (asBar) {
    return (
      <div className="flex flex-col rounded-2xl border border-line bg-surface/90 p-3 text-fg shadow-xl">
        {/* One row for the whole evaluation: the bar, and the number it draws.
            No card title and no ply counter — the bar is self-evident and the
            move list already says where in the game you are. */}
        <div className="flex items-center gap-2.5">
          <Activity className="h-3.5 w-3.5 shrink-0 text-accent" />
          <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-eval-black">
            <div
              className="absolute inset-y-0 bg-eval-white transition-[width] duration-300"
              // Anchored to whichever edge white is playing towards, so the
              // bar grows the same way the board is facing.
              style={
                flipped
                  ? { right: 0, width: `${whiteShare}%` }
                  : { left: 0, width: `${whiteShare}%` }
              }
            />
          </div>
          <span className="w-12 shrink-0 text-right font-mono text-[11px] font-bold text-fg-2">
            {formatEval(evalCp)}
          </span>
        </div>

        <EngineLines
          engineLines={engineLines}
          linesStale={linesStale}
          liveError={liveError}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface/90 p-3 text-fg shadow-xl sm:p-4">
      <div className="flex items-center justify-between border-b border-line pb-2 sm:pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <h4 className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
            Evaluation
          </h4>
        </div>
        <span className="font-mono text-[11px] text-fg-muted">
          {plies.length ? `Ply ${currentPlyIndex} / ${plies.length}` : 'no game'}
        </span>
      </div>

      <div className={`mt-2 w-full transition-all sm:mt-3 ${chartHeight}`}>
        {analysed ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 6, right: 6, left: -28, bottom: 0 }}
              onClick={(e) => {
                const idx = e?.activeTooltipIndex;
                if (typeof idx === 'number') onSelectPly(idx + 1);
              }}
            >
              <defs>
                <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chart.line} stopOpacity={0.55} />
                  <stop offset="100%" stopColor={chart.line} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis dataKey="index" hide />
              <YAxis
                domain={[-CLAMP, CLAMP]}
                tick={{ fill: chart.axis, fontSize: 10 }}
                tickFormatter={(v: number) => (v / 100).toFixed(0)}
                axisLine={false}
                tickLine={false}
              />
              <ReferenceLine y={0} stroke={chart.axis} strokeDasharray="3 3" />
              <ReferenceLine x={currentPlyIndex} stroke={chart.accent} strokeWidth={1.5} />
              <Tooltip
                contentStyle={{
                  background: chart.surface,
                  border: `1px solid ${chart.tooltipBorder}`,
                  borderRadius: 10,
                  fontSize: 12,
                }}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.label ?? ''}
                formatter={(value, _name, item) => {
                  const q = styleFor((item?.payload as { quality?: string | null })?.quality);
                  return [`${formatEval(Number(value))}${q ? `  ${q.label}` : ''}`, 'eval'];
                }}
              />
              <Area
                type="monotone"
                dataKey="cp"
                stroke={chart.line}
                strokeWidth={1.5}
                fill="url(#evalFill)"
                connectNulls
                dot={(props: { cx?: number; cy?: number; payload?: { quality?: string | null } }) => {
                  const q = styleFor(props.payload?.quality);
                  // Only the classifications worth interrupting the line for.
                  const notable =
                    q &&
                    ['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder'].includes(
                      props.payload?.quality ?? '',
                    );
                  if (!notable || props.cx == null || props.cy == null) {
                    return <g key={`${props.cx}-${props.cy}`} />;
                  }
                  return (
                    <circle
                      key={`${props.cx}-${props.cy}`}
                      cx={props.cx}
                      cy={props.cy}
                      r={3.5}
                      fill={q.color}
                      stroke={chart.surface}
                      strokeWidth={1}
                    />
                  );
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-line px-6 text-center text-xs text-fg-subtle">
            {plies.length
              ? 'Run an analysis to plot this game.'
              : 'Select a game from your library.'}
          </div>
        )}
      </div>

      {liveActive && (
        <EngineLines
          engineLines={engineLines}
          linesStale={linesStale}
          liveError={liveError}
        />
      )}
    </div>
  );
}

/** The engine's ranked lines, under whichever of the two the card is drawing
 *  above them — the plot on a desktop, the bar on a phone. */
export function EngineLines({
  engineLines,
  linesStale,
  liveError,
}: {
  engineLines: EngineLine[];
  linesStale: boolean;
  liveError: string | null;
}) {
  return (
    <div className="mt-2 border-t border-line pt-2 sm:mt-3 sm:pt-3">
      <div className="mb-1.5 flex items-center gap-2 sm:mb-2">
        <Cpu className="h-3.5 w-3.5 text-accent-2" />
        <span className="text-[11px] font-semibold tracking-wider text-fg-muted uppercase">
          Live engine
        </span>
        {linesStale && engineLines.length > 0 && (
          <span className="font-mono text-[10px] text-fg-subtle">searching…</span>
        )}
      </div>
      {liveError ? (
        <p className="rounded-lg bg-danger-surface px-3 py-2 text-[11px] text-danger-fg">
          {liveError}
        </p>
      ) : engineLines.length === 0 ? (
        // Only before the first search of a session lands. The rows are
        // drawn empty rather than skipped so the card is already the height
        // it will be, and nothing below it moves when they fill.
        <div className="space-y-1">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-[26px] rounded-lg bg-canvas/40" />
          ))}
          <p className="pt-0.5 text-[11px] text-fg-subtle">Thinking…</p>
        </div>
      ) : (
        <div className={`space-y-1 transition-opacity ${linesStale ? 'opacity-60' : ''}`}>
          {engineLines.map((line) => (
            <div
              key={line.rank}
              className="flex items-baseline gap-2 rounded-lg bg-canvas/70 px-2.5 py-1.5 font-mono text-[11px]"
            >
              <span className="w-14 shrink-0 font-bold text-accent">
                {formatEval(line.cp, line.mate)}
              </span>
              <span className="w-8 shrink-0 text-fg-subtle">d{line.depth}</span>
              <span className="truncate text-fg-2">
                {(line.sanPv ?? line.pv).slice(0, 10).join(' ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
