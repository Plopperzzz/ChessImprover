import { useState } from 'react';
import { AlertTriangle, Gauge, Info, Loader2, TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import * as api from '../../lib/api';
import type { EloEstimate, SweepResults } from '../../types';
import { lighten, useChartTheme } from '../../lib/theme';
import { styleFor } from '../../lib/quality';

interface EloSweepPanelProps {
  results: SweepResults | null;
  modelNote: string | null;
  /** Which side of this game the logged-in account played, or null when the
   *  import couldn't match either header to them. */
  yourColor: 'w' | 'b' | null;
  whiteName: string;
  blackName: string;
  /** Null while no game is loaded -- the check has nothing to run against. */
  gameId: number | null;
  /** Jumps the board to a ply, the same way clicking the eval chart does. */
  onSelectPly: (ply: number) => void;
}

const CONFIDENCE: Record<string, string> = {
  high: 'bg-positive/15 text-positive ring-positive/30',
  medium: 'bg-accent/15 text-accent ring-accent/30',
  low: 'bg-danger/15 text-danger-fg ring-danger/30',
};

function SideEstimate({
  estimate,
  name,
  isYou,
}: {
  estimate: EloEstimate;
  name: string;
  isYou: boolean;
}) {
  const bound = estimate.bound;
  // B14: the caveats are a wall of text next to a three-digit number, and they
  // are read once. `group-hover` rather than state, so the card also reveals
  // them on keyboard focus without a second code path.
  return (
    <div
      className={`group relative rounded-xl border p-3 ${
        isYou ? 'border-accent-deep/60 bg-accent/10' : 'border-line bg-canvas/70'
      }`}
      tabIndex={estimate.reasons.length > 0 ? 0 : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-fg-2">
          {name}
          {isYou && <span className="ml-1.5 text-[10px] text-accent">you</span>}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${
            CONFIDENCE[estimate.confidence] ?? CONFIDENCE.low
          }`}
        >
          {estimate.confidence}
        </span>
      </div>

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-mono text-3xl font-black text-accent">
          {estimate.estimate ?? '—'}
        </span>
        {bound && (
          <span className="text-[11px] text-fg-muted">
            {bound === 'lower' ? 'at least' : 'at most'}
          </span>
        )}
      </div>

      <div className="mt-1 font-mono text-[11px] text-fg-muted">
        {estimate.ci_low != null && estimate.ci_high != null
          ? `95% CI ${estimate.ci_low} – ${estimate.ci_high}`
          : 'no interval'}
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">
        {estimate.n_discriminative} of {estimate.n_positions} positions carried signal
      </div>

      {estimate.ceiling?.implied_rating != null && (
        <div className="mt-2 rounded-lg bg-surface/80 px-2 py-1.5 font-mono text-[10px] text-fg-muted">
          match rate {(estimate.ceiling.observed * 100).toFixed(1)}% vs{' '}
          {(estimate.ceiling.expected * 100).toFixed(1)}% expected ({estimate.ceiling.model}) →
          implies ~{estimate.ceiling.implied_rating}
        </div>
      )}

      {estimate.reasons.length > 0 && (
        <>
          <p className="mt-2 flex items-center gap-1.5 text-[10px] text-fg-subtle transition-opacity group-hover:opacity-0 group-focus:opacity-0">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {estimate.reasons.length} thing{estimate.reasons.length === 1 ? '' : 's'} the fit is
            unsure about
          </p>
          <ul className="pointer-events-none absolute inset-x-0 bottom-0 z-20 space-y-1 rounded-xl border border-line bg-surface p-3 opacity-0 shadow-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus:pointer-events-auto group-focus:opacity-100">
            {estimate.reasons.map((reason) => (
              <li key={reason} className="flex gap-1.5 text-[11px] leading-snug text-fg-2">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-fg-faint" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Observed match rate per grid point with the fitted bump over it. The peak of
 *  that curve is the estimate, which is the only way to see whether the number
 *  came off a real hump or off a flat line. */
function SweepCurve({ estimate }: { estimate: EloEstimate }) {
  const chart = useChartTheme();
  if (!estimate.grid?.length || !estimate.match_rates?.length) return null;

  // One dataset for both series: the dense fit and the sparse observations
  // share an x axis, and recharts only lines up a Line and a Scatter when they
  // read from the same rows. Each row carries whichever of the two it has.
  const rows = new Map<number, { elo: number; rate?: number; fit?: number }>();
  const at = (elo: number) => {
    let row = rows.get(elo);
    if (!row) {
      row = { elo };
      rows.set(elo, row);
    }
    return row;
  };
  (estimate.curve_x ?? []).forEach((x, i) => {
    at(x).fit = (estimate.curve_y?.[i] ?? 0) * 100;
  });
  estimate.grid.forEach((elo, i) => {
    at(elo).rate = (estimate.match_rates?.[i] ?? 0) * 100;
  });
  const data = [...rows.values()].sort((a, b) => a.elo - b.elo);

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
          <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="elo"
            domain={['dataMin', 'dataMax']}
            tick={{ fill: chart.axis, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: chart.axis, fontSize: 10 }}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            axisLine={false}
            tickLine={false}
          />
          <ZAxis range={[26, 26]} />
          <Tooltip
            cursor={{ stroke: chart.axis }}
            contentStyle={{
              background: chart.surface,
              border: `1px solid ${chart.tooltipBorder}`,
              borderRadius: 10,
              fontSize: 12,
            }}
            labelFormatter={(v) => `Maia ${Math.round(Number(v))}`}
            formatter={(v, name) => [
              `${Number(v).toFixed(1)}%`,
              name === 'fit' ? 'fitted' : 'observed',
            ]}
          />
          {/* Fitted curve in a lighter tint of the accent the observations
              below are drawn in: the same split the trend charts use —
              measured points in full strength, the drawn line joining them
              lightened, so both read as the one series. */}
          <Line
            type="monotone"
            dataKey="fit"
            stroke={lighten(chart.accent)}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Scatter dataKey="rate" fill={chart.accent} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** "Would a player at your own strength have played this?" -- for every
 *  Mistake/Blunder/Miss, the probability Maia's policy gives the move you
 *  actually played, at the Elo your header rating in *this* game converts to
 *  on Maia's scale (the same calibration `/api/strength` computes, reversed).
 *
 *  A button rather than automatic: the calibration query pools the account's
 *  whole library (scoped to this game's database) to measure the offset, and
 *  that is worth asking for rather than paying on every game load. Once run
 *  it costs no engine time either way -- everything it reads was already
 *  stored by the Full analysis that swept this game. */
function MistakeCheckSection({
  gameId,
  onSelectPly,
}: {
  gameId: number | null;
  onSelectPly: (ply: number) => void;
}) {
  const [state, setState] = useState<
    | { phase: 'idle' }
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'done'; result: api.MistakeCheck }
  >({ phase: 'idle' });

  const run = () => {
    if (!gameId) return;
    setState({ phase: 'loading' });
    api
      .mistakeCheck(gameId)
      .then((result) => setState({ phase: 'done', result }))
      .catch((e) => setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) }));
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] tracking-wider text-fg-subtle uppercase">
          <Gauge className="h-3.5 w-3.5" />
          Would you have found it?
        </p>
        {state.phase !== 'loading' && (
          <button
            onClick={run}
            disabled={!gameId}
            className="rounded-lg border border-line bg-canvas px-2.5 py-1 text-[11px] font-medium text-fg-2 hover:bg-surface-2 disabled:opacity-40"
          >
            {state.phase === 'done' ? 'Re-check' : 'Check my mistakes'}
          </button>
        )}
      </div>

      {state.phase === 'loading' && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading the sweep…
        </p>
      )}
      {state.phase === 'error' && (
        <p className="mt-2 text-[11px] text-danger-fg">{state.message}</p>
      )}
      {state.phase === 'done' && !state.result.available && (
        <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">{state.result.reason}</p>
      )}
      {state.phase === 'done' && state.result.available && (
        <>
          <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
            Your recorded rating in this game, {state.result.header_elo}, converts to{' '}
            <span className="font-mono font-semibold text-fg-2">{state.result.target_elo}</span> on
            Maia's scale ({state.result.offset >= 0 ? '+' : ''}
            {state.result.offset} from the calibration on {state.result.database} games).
          </p>
          {state.result.moves.length === 0 ? (
            <p className="mt-2 text-[11px] text-fg-subtle">
              No Mistakes, Blunders or Misses on your side of this game — nothing to check.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {state.result.moves.map((move) => {
                const style = styleFor(move.classification);
                const pct = move.probability * 100;
                return (
                  <li key={move.ply}>
                    <button
                      onClick={() => onSelectPly(move.ply)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-2"
                    >
                      {style && (
                        <img src={style.icon} alt={style.label} className="h-4 w-4 shrink-0" />
                      )}
                      <span className="font-mono text-fg-2">{move.san}</span>
                      <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px]">
                        <span
                          className={
                            pct < 5
                              ? 'font-semibold text-danger-fg'
                              : pct < 20
                                ? 'text-accent'
                                : 'text-fg-muted'
                          }
                        >
                          {pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%
                        </span>
                        {move.clamped && (
                          <span
                            className="text-fg-faint"
                            title={`Outside the swept range -- reading Maia's opinion at ${move.nearest_grid_elo} instead`}
                          >
                            ⚠
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-[10px] text-fg-faint">
            {state.result.moves.some((m) => m.exact_policy)
              ? "Maia's own reported policy, where the engine gave one."
              : "Estimated from Maia's ranking of the move, not its raw policy."}
          </p>
        </>
      )}
    </div>
  );
}

export function EloSweepPanel({
  results,
  modelNote,
  yourColor,
  whiteName,
  blackName,
  gameId,
  onSelectPly,
}: EloSweepPanelProps) {
  const white = results?.w;
  const black = results?.b;
  // With no side assigned there is no "your" curve to single out, so the panel
  // shows white's rather than claiming one of them is yours.
  const yours = yourColor ? results?.[yourColor] : white;

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface/90 p-4 text-fg shadow-xl">
      <div className="flex items-center gap-2 border-b border-line pb-3">
        <TrendingUp className="h-4 w-4 text-accent" />
        <h4 className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
          Maia Elo sweep
        </h4>
      </div>

      {!results ? (
        <p className="py-6 text-center text-xs leading-relaxed text-fg-subtle">
          Run <span className="font-semibold text-fg-2">Full analysis</span> to sweep this
          game against Maia at every Elo on the grid and fit an estimated rating for both
          players.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {white && (
              <SideEstimate estimate={white} name={whiteName} isYou={yourColor === 'w'} />
            )}
            {black && (
              <SideEstimate estimate={black} name={blackName} isYou={yourColor === 'b'} />
            )}
          </div>

          {yours && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="mb-1 text-[11px] tracking-wider text-fg-subtle uppercase">
                Match rate by Maia Elo ({yourColor === 'b' ? 'black' : 'white'})
              </p>
              <SweepCurve estimate={yours} />
            </div>
          )}

          {yourColor && <MistakeCheckSection key={gameId} gameId={gameId} onSelectPly={onSelectPly} />}

          {modelNote && (
            <p className="mt-3 flex gap-1.5 border-t border-line pt-3 text-[11px] leading-snug text-fg-subtle">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{modelNote}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
