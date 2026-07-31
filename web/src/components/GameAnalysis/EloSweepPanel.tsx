import { AlertTriangle, Info, TrendingUp } from 'lucide-react';
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
import type { EloEstimate, SweepResults } from '../../types';

interface EloSweepPanelProps {
  results: SweepResults | null;
  modelNote: string | null;
  /** Which side of this game the logged-in account played, or null when the
   *  import couldn't match either header to them. */
  yourColor: 'w' | 'b' | null;
  whiteName: string;
  blackName: string;
}

const CONFIDENCE: Record<string, string> = {
  high: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  low: 'bg-red-500/15 text-red-300 ring-red-500/30',
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
  return (
    <div
      className={`rounded-xl border p-3 ${
        isYou ? 'border-amber-700/60 bg-amber-950/20' : 'border-stone-800 bg-stone-950/70'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-stone-200">
          {name}
          {isYou && <span className="ml-1.5 text-[10px] text-amber-400">you</span>}
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
        <span className="font-mono text-3xl font-black text-amber-400">
          {estimate.estimate ?? '—'}
        </span>
        {bound && (
          <span className="text-[11px] text-stone-400">
            {bound === 'lower' ? 'at least' : 'at most'}
          </span>
        )}
      </div>

      <div className="mt-1 font-mono text-[11px] text-stone-400">
        {estimate.ci_low != null && estimate.ci_high != null
          ? `95% CI ${estimate.ci_low} – ${estimate.ci_high}`
          : 'no interval'}
      </div>
      <div className="mt-0.5 font-mono text-[11px] text-stone-500">
        {estimate.n_discriminative} of {estimate.n_positions} positions carried signal
      </div>

      {estimate.ceiling?.implied_rating != null && (
        <div className="mt-2 rounded-lg bg-stone-900/80 px-2 py-1.5 font-mono text-[10px] text-stone-400">
          match rate {(estimate.ceiling.observed * 100).toFixed(1)}% vs{' '}
          {(estimate.ceiling.expected * 100).toFixed(1)}% expected ({estimate.ceiling.model}) →
          implies ~{estimate.ceiling.implied_rating}
        </div>
      )}

      {estimate.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {estimate.reasons.map((reason) => (
            <li key={reason} className="flex gap-1.5 text-[11px] leading-snug text-stone-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-stone-600" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Observed match rate per grid point with the fitted bump over it. The peak of
 *  that curve is the estimate, which is the only way to see whether the number
 *  came off a real hump or off a flat line. */
function SweepCurve({ estimate }: { estimate: EloEstimate }) {
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
          <CartesianGrid stroke="#292524" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="elo"
            domain={['dataMin', 'dataMax']}
            tick={{ fill: '#a8a29e', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#a8a29e', fontSize: 10 }}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            axisLine={false}
            tickLine={false}
          />
          <ZAxis range={[26, 26]} />
          <Tooltip
            cursor={{ stroke: '#57534d' }}
            contentStyle={{
              background: '#0c0a09',
              border: '1px solid #292524',
              borderRadius: 10,
              fontSize: 12,
            }}
            labelFormatter={(v) => `Maia ${Math.round(Number(v))}`}
            formatter={(v, name) => [
              `${Number(v).toFixed(1)}%`,
              name === 'fit' ? 'fitted' : 'observed',
            ]}
          />
          <Line
            type="monotone"
            dataKey="fit"
            stroke="#38bdf8"
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
          <Scatter dataKey="rate" fill="#f59e0b" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function EloSweepPanel({
  results,
  modelNote,
  yourColor,
  whiteName,
  blackName,
}: EloSweepPanelProps) {
  const white = results?.w;
  const black = results?.b;
  // With no side assigned there is no "your" curve to single out, so the panel
  // shows white's rather than claiming one of them is yours.
  const yours = yourColor ? results?.[yourColor] : white;

  return (
    <div className="flex flex-col rounded-2xl border border-stone-800 bg-stone-900/90 p-4 text-stone-100 shadow-xl">
      <div className="flex items-center gap-2 border-b border-stone-800 pb-3">
        <TrendingUp className="h-4 w-4 text-amber-500" />
        <h4 className="text-xs font-semibold tracking-wider text-stone-300 uppercase">
          Maia Elo sweep
        </h4>
      </div>

      {!results ? (
        <p className="py-6 text-center text-xs leading-relaxed text-stone-500">
          Run <span className="font-semibold text-stone-300">Full analysis</span> to sweep this
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
            <div className="mt-3 border-t border-stone-800 pt-3">
              <p className="mb-1 text-[11px] tracking-wider text-stone-500 uppercase">
                Match rate by Maia Elo ({yourColor === 'b' ? 'black' : 'white'})
              </p>
              <SweepCurve estimate={yours} />
            </div>
          )}

          {modelNote && (
            <p className="mt-3 flex gap-1.5 border-t border-stone-800 pt-3 text-[11px] leading-snug text-stone-500">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{modelNote}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
