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
import { formatEval } from '../../lib/chess';
import { styleFor } from '../../lib/quality';

interface EvalChartProps {
  plies: Ply[];
  moves: Map<number, AnalysisMove>;
  currentPlyIndex: number;
  onSelectPly: (index: number) => void;
  liveActive: boolean;
  engineLines: EngineLine[];
  liveError: string | null;
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
  liveError,
}: EvalChartProps) {
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
  const chartHeight = liveActive && engineLines.length > 0 ? 'h-36' : 'h-48 sm:h-56';

  return (
    <div className="flex flex-col rounded-2xl border border-stone-800 bg-stone-900/90 p-4 text-stone-100 shadow-xl">
      <div className="flex items-center justify-between border-b border-stone-800 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-amber-500" />
          <h4 className="text-xs font-semibold tracking-wider text-stone-300 uppercase">
            Evaluation
          </h4>
        </div>
        <span className="font-mono text-[11px] text-stone-400">
          {plies.length ? `Ply ${currentPlyIndex} / ${plies.length}` : 'no game'}
        </span>
      </div>

      <div className={`mt-3 w-full transition-all ${chartHeight}`}>
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
                  <stop offset="0%" stopColor="#e7e5e4" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#e7e5e4" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis dataKey="index" hide />
              <YAxis
                domain={[-CLAMP, CLAMP]}
                tick={{ fill: '#a8a29e', fontSize: 10 }}
                tickFormatter={(v: number) => (v / 100).toFixed(0)}
                axisLine={false}
                tickLine={false}
              />
              <ReferenceLine y={0} stroke="#57534d" strokeDasharray="3 3" />
              <ReferenceLine x={currentPlyIndex} stroke="#f59e0b" strokeWidth={1.5} />
              <Tooltip
                contentStyle={{
                  background: '#0c0a09',
                  border: '1px solid #292524',
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
                stroke="#e7e5e4"
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
                      stroke="#0c0a09"
                      strokeWidth={1}
                    />
                  );
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-stone-800 px-6 text-center text-xs text-stone-500">
            {plies.length
              ? 'Run an analysis to plot this game.'
              : 'Select a game from your library.'}
          </div>
        )}
      </div>

      {liveActive && (
        <div className="mt-3 border-t border-stone-800 pt-3">
          <div className="mb-2 flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5 text-sky-400" />
            <span className="text-[11px] font-semibold tracking-wider text-stone-400 uppercase">
              Live engine
            </span>
          </div>
          {liveError ? (
            <p className="rounded-lg bg-red-950/60 px-3 py-2 text-[11px] text-red-300">
              {liveError}
            </p>
          ) : engineLines.length === 0 ? (
            <p className="text-[11px] text-stone-500">Thinking…</p>
          ) : (
            <div className="space-y-1">
              {engineLines.map((line) => (
                <div
                  key={line.rank}
                  className="flex items-baseline gap-2 rounded-lg bg-stone-950/70 px-2.5 py-1.5 font-mono text-[11px]"
                >
                  <span className="w-14 shrink-0 font-bold text-amber-400">
                    {formatEval(line.cp, line.mate)}
                  </span>
                  <span className="w-8 shrink-0 text-stone-500">d{line.depth}</span>
                  <span className="truncate text-stone-300">
                    {(line.sanPv ?? line.pv).slice(0, 10).join(' ')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
