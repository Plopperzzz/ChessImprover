import { useEffect, useState } from 'react';
import { Activity, Gauge, LayoutDashboard, Loader2, Target, TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import * as api from '../../lib/api';
import { useChartTheme } from '../../lib/theme';

const GRANULARITIES = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'quarter', label: 'Quarterly' },
];

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-lg">
      <div className="rounded-xl bg-accent/10 p-3 text-accent">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">{label}</p>
        <p className="font-mono text-lg font-bold text-fg">{value}</p>
        {sub && <p className="truncate font-mono text-[11px] text-fg-subtle">{sub}</p>}
      </div>
    </div>
  );
}

/** Progress: the pooled strength fit and the trend over time, both served
 *  straight from the backend's own re-fits of cached sweep data. */
export function ProgressScreen() {
  const palette = useChartTheme();
  const [granularity, setGranularity] = useState('month');
  const [strength, setStrength] = useState<api.Strength | null>(null);
  const [trend, setTrend] = useState<api.Trend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.strength(), api.trend({ granularity })])
      .then(([s, t]) => {
        if (cancelled) return;
        setStrength(s);
        setTrend(t);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [granularity]);

  const you = strength?.you;
  const chart = (trend?.buckets ?? []).map((bucket) => ({
    label: bucket.label,
    estimated: bucket.estimate,
    actual: bucket.actual_elo,
  }));

  const rate = trend?.trend?.rate;

  return (
    <div className="thin-scroll mx-auto w-full max-w-6xl flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
      <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-line bg-surface p-6 shadow-xl sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
            <LayoutDashboard className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-fg">Progress</h2>
            <p className="text-xs text-fg-muted">
              Pooled over every game with a Maia Elo sweep — no engine is re-run.
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold text-fg-muted uppercase">Estimated Elo</p>
          <p className="font-mono text-3xl font-black text-accent">
            {you?.estimate ?? '—'}
          </p>
          {you?.ci_low != null && you.ci_high != null && (
            <p className="font-mono text-[11px] text-fg-subtle">
              {you.ci_low} – {you.ci_high}
            </p>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" /> Fitting…
        </div>
      )}

      {error && (
        <p className="rounded-xl bg-danger-surface px-4 py-3 text-sm text-danger-fg">{error}</p>
      )}

      {!loading && strength && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              icon={<Target className="h-5 w-5" />}
              label="Games pooled"
              value={String(strength.games)}
              sub={
                strength.skipped?.no_full_analysis
                  ? `${strength.skipped.no_full_analysis} not swept yet`
                  : undefined
              }
            />
            <Stat
              icon={<Gauge className="h-5 w-5" />}
              label="Your actual rating"
              value={
                strength.your_rating_mean != null
                  ? String(Math.round(strength.your_rating_mean))
                  : '—'
              }
              sub={`${strength.your_rating_n} games with a header rating`}
            />
            <Stat
              icon={<Activity className="h-5 w-5" />}
              label="Confidence"
              value={you?.confidence ?? '—'}
              sub={`${you?.n_discriminative ?? 0} discriminative positions`}
            />
            <Stat
              icon={<TrendingUp className="h-5 w-5" />}
              label="Trend"
              value={
                rate != null
                  ? `${rate > 0 ? '+' : ''}${rate.toFixed(0)} / ${trend?.trend?.per ?? granularity}`
                  : '—'
              }
              sub={trend?.trend?.significant ? 'distinguishable from flat' : 'not significant'}
            />
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <h3 className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
                Estimated vs actual Elo
              </h3>
              <div className="flex gap-1">
                {GRANULARITIES.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setGranularity(option.value)}
                    className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
                      granularity === option.value
                        ? 'bg-accent-strong text-on-accent'
                        : 'bg-canvas text-fg-muted ring-1 ring-line hover:text-fg-2'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 h-64 w-full">
              {chart.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center text-xs text-fg-subtle">
                  Nothing to plot yet — run a Full analysis on a few games first.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                    <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: palette.axis, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      domain={['dataMin - 100', 'dataMax + 100']}
                      tick={{ fill: palette.axis, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: palette.surface,
                        border: `1px solid ${palette.tooltipBorder}`,
                        borderRadius: 10,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="estimated"
                      name="Maia estimate"
                      stroke={palette.accent}
                      strokeWidth={2}
                      connectNulls
                      dot={{ r: 3 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="actual"
                      name="Actual rating"
                      stroke={palette.accent2}
                      strokeWidth={2}
                      connectNulls
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            {trend?.offset?.mean != null && (
              <p className="mt-3 border-t border-line pt-3 font-mono text-[11px] text-fg-subtle">
                Estimate sits {trend.offset.mean > 0 ? '+' : ''}
                {trend.offset.mean} Elo from your actual rating on average, over{' '}
                {trend.offset.n} bucket{trend.offset.n === 1 ? '' : 's'}.
              </p>
            )}
          </div>

          {you?.reasons && you.reasons.length > 0 && (
            <div className="rounded-2xl border border-line bg-surface p-4 text-xs text-fg-muted shadow-xl">
              <h3 className="mb-2 text-xs font-semibold tracking-wider text-fg-2 uppercase">
                What the fit is unsure about
              </h3>
              <ul className="list-inside list-disc space-y-1">
                {you.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-fg-subtle">{strength.scale_note}</p>
        </>
      )}
    </div>
  );
}
