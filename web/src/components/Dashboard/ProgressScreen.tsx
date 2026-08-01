import { useEffect, useState } from 'react';
import { Gauge, LayoutDashboard, Loader2, Sparkles, Target, TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import * as api from '../../lib/api';
import { QUALITY, QUALITY_ORDER } from '../../lib/quality';
import { useChartTheme } from '../../lib/theme';
import { InfoPopover } from '../InfoPopover';

/** The buckets `trend.GRANULARITIES` accepts. Quarterly used to be offered
 *  here and the backend rejects it with a 400 — there is no quarter bucket. */
const GRANULARITIES = [
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
];

/** Windows are spelled in the same unit as the bucket, so every option is a
 *  whole number of buckets rather than a range that cuts one in half.
 *  `/api/trend` parses them as '<count><unit>' (`trend.WINDOW_RE`). */
const WINDOWS: Record<string, { value: string; label: string }[]> = {
  week: [
    { value: '4w', label: 'Last 4 weeks' },
    { value: '12w', label: 'Last 12 weeks' },
    { value: '26w', label: 'Last 26 weeks' },
    { value: 'all', label: 'All time' },
  ],
  month: [
    { value: '3m', label: 'Last 3 months' },
    { value: '6m', label: 'Last 6 months' },
    { value: '12m', label: 'Last 12 months' },
    { value: 'all', label: 'All time' },
  ],
  year: [
    { value: '2y', label: 'Last 2 years' },
    { value: '5y', label: 'Last 5 years' },
    { value: 'all', label: 'All time' },
  ],
};

const GRANULARITY_KEY = 'engine-room:trend-granularity';
const WINDOW_KEY = 'engine-room:trend-window';

function storedGranularity(): string {
  const saved = localStorage.getItem(GRANULARITY_KEY);
  return GRANULARITIES.some((g) => g.value === saved) ? (saved as string) : 'month';
}

function storedWindow(granularity: string): string {
  const saved = localStorage.getItem(WINDOW_KEY);
  return WINDOWS[granularity].some((w) => w.value === saved) ? (saved as string) : 'all';
}

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

function Picker({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${
            value === option.value
              ? 'bg-accent-strong text-on-accent'
              : 'bg-canvas text-fg-muted ring-1 ring-line hover:text-fg-2'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One chart per series (C8). They were on a single axis, which flattened
 *  whichever of the two had the smaller range — an estimate that moved 300
 *  points and a rating that moved 40 are both worth seeing move. */
function TrendChart({
  data,
  dataKey,
  name,
  colour,
  palette,
  showAxis,
}: {
  data: { label: string; estimated: number | null; actual: number | null }[];
  dataKey: 'estimated' | 'actual';
  name: string;
  colour: string;
  palette: ReturnType<typeof useChartTheme>;
  showAxis: boolean;
}) {
  const empty = data.every((row) => row[dataKey] == null);
  return (
    <div className="h-32 w-full sm:h-36">
      {empty ? (
        <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-line text-center text-[11px] text-fg-subtle">
          No {name.toLowerCase()} in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
            <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={showAxis ? { fill: palette.axis, fontSize: 10 } : false}
              height={showAxis ? 20 : 4}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={['dataMin - 40', 'dataMax + 40']}
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
            <Line
              type="monotone"
              dataKey={dataKey}
              name={name}
              stroke={colour}
              strokeWidth={2}
              connectNulls
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** The move-quality pie (C6). Colours come from `lib/quality.ts`, the same
 *  table the board badges and the move list read, so a blunder is one colour
 *  everywhere. */
function QualityPie({
  quality,
  palette,
}: {
  quality: api.MoveQualityCounts;
  palette: ReturnType<typeof useChartTheme>;
}) {
  const slices = QUALITY_ORDER.filter((q) => quality.counts[q] > 0).map((q) => ({
    key: q,
    name: QUALITY[q].label,
    value: quality.counts[q],
    colour: QUALITY[q].color,
  }));

  if (slices.length === 0) {
    return (
      <p className="py-10 text-center text-xs leading-relaxed text-fg-subtle">
        No classified moves yet — run an analysis on a game or two.
      </p>
    );
  }

  const share = (value: number) => ((value / quality.moves) * 100).toFixed(1);

  return (
    <>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="55%"
              outerRadius="85%"
              paddingAngle={1}
              stroke={palette.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.key} fill={slice.colour} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: palette.surface,
                border: `1px solid ${palette.tooltipBorder}`,
                borderRadius: 10,
                fontSize: 12,
              }}
              formatter={(value) => [`${value} moves · ${share(Number(value))}%`, '']}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-2 space-y-1">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center gap-2 text-[11px]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: slice.colour }}
            />
            <span className="truncate text-fg-2">{slice.name}</span>
            <span className="ml-auto shrink-0 font-mono text-fg-muted">
              {slice.value} · {share(slice.value)}%
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Progress: the pooled strength fit and the trend over time, both served
 *  straight from the backend's own re-fits of cached sweep data. */
export function ProgressScreen() {
  const palette = useChartTheme();
  const [granularity, setGranularity] = useState(storedGranularity);
  const [window_, setWindow] = useState(() => storedWindow(storedGranularity()));
  const [strength, setStrength] = useState<api.Strength | null>(null);
  const [trend, setTrend] = useState<api.Trend | null>(null);
  const [quality, setQuality] = useState<api.MoveQualityCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // C7: the screen used to reset to Monthly on every mount, the same way it
  // would have reset the current screen without App.tsx's localStorage.
  useEffect(() => localStorage.setItem(GRANULARITY_KEY, granularity), [granularity]);
  useEffect(() => localStorage.setItem(WINDOW_KEY, window_), [window_]);

  /** Changing the bucket size snaps the window to one this bucket has an
   *  option for: '26 weeks' has no meaning on a yearly axis. */
  const changeGranularity = (next: string) => {
    setGranularity(next);
    setWindow((current) => (WINDOWS[next].some((w) => w.value === current) ? current : 'all'));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.strength(), api.trend({ granularity, window: window_ }), api.moveQuality()])
      .then(([s, t, q]) => {
        if (cancelled) return;
        setStrength(s);
        setTrend(t);
        setQuality(q);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [granularity, window_]);

  const you = strength?.you;
  const calibration = strength?.calibration;
  const chart = (trend?.buckets ?? []).map((bucket) => ({
    label: bucket.label,
    estimated: bucket.estimate,
    actual: bucket.actual_elo,
  }));

  const rate = trend?.trend?.rate;
  const windowNote =
    trend?.window?.applied && trend.window.end
      ? `${trend.window.start} – ${trend.window.end}, ending at your most recent analysed game`
      : null;

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
          {/* C4: the confidence card is gone; what it meant lives here, beside
              the number it qualifies. */}
          <p className="flex items-center justify-end gap-1.5 text-[10px] font-semibold text-fg-muted uppercase">
            Estimated Elo
            <InfoPopover label="What the confidence means">
              <p className="mb-2">
                <span className="font-semibold text-fg">
                  {you?.confidence ?? 'no'} confidence
                </span>
                , from {you?.n_discriminative ?? 0} discriminative positions across{' '}
                {strength?.games ?? 0} games.
              </p>
              <p>
                A position is discriminative when Maia's answer changes across the swept Elo
                range — positions every rating plays the same way carry no signal about yours,
                however many of them there are. Confidence is that count together with how
                pronounced the peak of the fitted curve is, so it climbs with games analysed
                and falls when your play is spread across strengths.
              </p>
            </InfoPopover>
          </p>
          <p className="font-mono text-3xl font-black text-accent">{you?.estimate ?? '—'}</p>
          {you?.ci_low != null && you.ci_high != null && (
            <p className="font-mono text-[11px] text-fg-subtle">
              {you.ci_low} – {you.ci_high}
            </p>
          )}

          {/* C3: the calibrated estimate. `/api/strength` has always returned
              it — nothing on this screen read it. */}
          {calibration?.available ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="flex items-center justify-end gap-1.5 text-[10px] font-semibold text-fg-muted uppercase">
                Calibrated
                <InfoPopover label="What the calibrated estimate is">
                  <p className="mb-2">
                    Maia-3's SelfElo is on the Lichess scale, a few hundred points above
                    Chess.com at club level. Rather than asking you to remember the
                    conversion, the same sweep estimates the opponents you played and compares
                    that to their header ratings.
                  </p>
                  <p>
                    Your field estimated {calibration.field_estimate} and was actually rated{' '}
                    {calibration.field_actual} over {calibration.field_actual_n} games — an
                    offset of {calibration.offset}, which is what has been taken off your
                    estimate.
                  </p>
                </InfoPopover>
              </p>
              <p className="font-mono text-2xl font-black text-accent-2">
                {calibration.your_calibrated}
              </p>
              {calibration.your_calibrated_low != null &&
                calibration.your_calibrated_high != null && (
                  <p className="font-mono text-[11px] text-fg-subtle">
                    {calibration.your_calibrated_low} – {calibration.your_calibrated_high}
                  </p>
                )}
            </div>
          ) : (
            calibration && (
              <p className="mt-2 max-w-[16rem] border-t border-line pt-2 text-[10px] leading-snug text-fg-subtle">
                No calibrated figure: {calibration.reason}.
              </p>
            )
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
            {/* C5: this slot held a Confidence card, which said in a number
                what the popover above now says in words. */}
            <Stat
              icon={<Sparkles className="h-5 w-5" />}
              label="Brilliant moves"
              value={quality ? String(quality.counts.brilliant) : '—'}
              sub={
                quality
                  ? quality.games_quick_only > 0
                    ? `${quality.games_quick_only} games quick-analysed — no Brilliant possible`
                    : `over ${quality.moves} of your moves`
                  : undefined
              }
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

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="rounded-2xl border border-line bg-surface p-4 shadow-xl xl:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-fg-2 uppercase">
                  Estimated vs actual Elo
                  {/* C1: this was a card at the bottom of the screen. */}
                  {you?.reasons && you.reasons.length > 0 && (
                    <InfoPopover label="What the fit is unsure about" align="left">
                      <p className="mb-2 font-semibold text-fg">What the fit is unsure about</p>
                      <ul className="list-inside list-disc space-y-1">
                        {you.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    </InfoPopover>
                  )}
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  {/* C2: the window the backend has always accepted, offered
                      in the unit the buckets are drawn in. */}
                  <Picker options={WINDOWS[granularity]} value={window_} onChange={setWindow} />
                  <span className="h-4 w-px bg-line" aria-hidden />
                  <Picker
                    options={GRANULARITIES}
                    value={granularity}
                    onChange={changeGranularity}
                  />
                </div>
              </div>

              {chart.length === 0 ? (
                <div className="flex h-64 items-center justify-center text-center text-xs text-fg-subtle">
                  Nothing to plot yet — run a Full analysis on a few games first.
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  <div>
                    <p className="mb-1 text-[10px] tracking-wider text-fg-subtle uppercase">
                      Maia estimate
                    </p>
                    <TrendChart
                      data={chart}
                      dataKey="estimated"
                      name="Maia estimate"
                      colour={palette.accent}
                      palette={palette}
                      showAxis={false}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] tracking-wider text-fg-subtle uppercase">
                      Actual rating
                    </p>
                    <TrendChart
                      data={chart}
                      dataKey="actual"
                      name="Actual rating"
                      colour={palette.accent2}
                      palette={palette}
                      showAxis
                    />
                  </div>
                </div>
              )}

              {windowNote && (
                <p className="mt-3 border-t border-line pt-3 font-mono text-[11px] text-fg-subtle">
                  {windowNote}
                  {trend?.window?.excluded
                    ? ` · ${trend.window.excluded} older game${
                        trend.window.excluded === 1 ? '' : 's'
                      } outside it`
                    : ''}
                </p>
              )}

              {trend?.offset?.mean != null && (
                <p className="mt-2 font-mono text-[11px] text-fg-subtle">
                  Estimate sits {trend.offset.mean > 0 ? '+' : ''}
                  {trend.offset.mean} Elo from your actual rating on average, over{' '}
                  {trend.offset.n} bucket{trend.offset.n === 1 ? '' : 's'}.
                </p>
              )}
            </div>

            {/* C6 */}
            <div className="rounded-2xl border border-line bg-surface p-4 shadow-xl">
              <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
                <h3 className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
                  Move quality
                </h3>
                {quality && (
                  <span className="font-mono text-[10px] text-fg-subtle">
                    {quality.games} game{quality.games === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {quality ? (
                <QualityPie quality={quality} palette={palette} />
              ) : (
                <p className="py-10 text-center text-xs text-fg-subtle">No counts yet.</p>
              )}
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-fg-subtle">{strength.scale_note}</p>
        </>
      )}
    </div>
  );
}
