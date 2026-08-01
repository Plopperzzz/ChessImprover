import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Download, Square } from 'lucide-react';
import * as api from '../../lib/api';
import type { LichessImportStatus } from '../../types';

type Status = LichessImportStatus;

/** How often to ask while an import is running. The import writes in batches
 *  and takes minutes; a second is responsive without being a poll loop. */
const POLL_MS = 1000;

/**
 * Getting the Lichess puzzle database in.
 *
 * Several million rows and about a gigabyte, so the filters exist to let you
 * take a band around your own rating instead. The import runs on the server
 * and survives this page closing, which is why this polls a status rather than
 * holding a request open.
 */
export function LichessImportPanel({ onImported }: { onImported: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minRating, setMinRating] = useState('');
  const [maxRating, setMaxRating] = useState('');
  const [limit, setLimit] = useState('');
  const [path, setPath] = useState('');
  const [replace, setReplace] = useState(false);
  const [starting, setStarting] = useState(false);

  // So the poll can tell "it finished" from "it is still going" without
  // re-rendering itself into a new interval on every tick.
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = (await api.lichessStatus()) as Status;
      setStatus(next);
      if (wasRunning.current && !next.running) onImported();
      wasRunning.current = Boolean(next.running);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onImported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [status?.running, refresh]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.startLichessImport({
        min_rating: minRating ? Number(minRating) : null,
        max_rating: maxRating ? Number(maxRating) : null,
        max_puzzles: limit ? Number(limit) : null,
        source_path: path.trim() || null,
        replace,
      });
      wasRunning.current = true;
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    try {
      await api.cancelLichessImport();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = status?.running;
  const percent =
    running && running.total_bytes
      ? Math.min(100, Math.round((running.bytes_read / running.total_bytes) * 100))
      : null;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wide text-fg-2 uppercase">
        <Database className="h-4 w-4 text-accent" />
        Lichess puzzle database
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-fg-subtle">
        Several million puzzles, each with motifs and a rating measured against real
        solvers. Importing all of it takes a while and about a gigabyte, so the filters
        below let you take a band around your own rating instead. Re-importing later adds
        to what you have. It runs on the server and keeps going if you close this page.
      </p>

      {status && (
        <div className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-fg-2">
          {status.puzzles > 0 ? (
            <>
              <span className="font-mono text-fg">{status.puzzles.toLocaleString()}</span>{' '}
              puzzles imported
              {status.min_rating != null && status.max_rating != null && (
                <> · rated {status.min_rating}–{status.max_rating}</>
              )}
            </>
          ) : (
            'Nothing imported yet.'
          )}
        </div>
      )}

      {running && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-fg-2">
            <span>{running.message || running.state}</span>
            <span className="font-mono">
              {running.rows_kept.toLocaleString()} kept / {running.rows_read.toLocaleString()} read
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full rounded-full bg-accent transition-[width] ${
                percent == null ? 'w-1/3 animate-pulse' : ''
              }`}
              style={percent == null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="text-[11px] text-fg-subtle">
          Rating from
          <input
            type="number"
            value={minRating}
            onChange={(e) => setMinRating(e.target.value)}
            placeholder="any"
            className="mt-0.5 w-full rounded-lg border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg"
          />
        </label>
        <label className="text-[11px] text-fg-subtle">
          to
          <input
            type="number"
            value={maxRating}
            onChange={(e) => setMaxRating(e.target.value)}
            placeholder="any"
            className="mt-0.5 w-full rounded-lg border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg"
          />
        </label>
        <label className="text-[11px] text-fg-subtle">
          Most to import
          <input
            type="number"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="all"
            className="mt-0.5 w-full rounded-lg border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg"
          />
        </label>
        <label
          className="text-[11px] text-fg-subtle"
          title="A path on the machine running the app. .csv, .zst, .zip, .gz, .bz2 and .xz all work."
        >
          Already downloaded?
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/lichess_db_puzzle.csv.zst"
            className="mt-0.5 w-full rounded-lg border border-line bg-canvas px-2 py-1 font-mono text-xs text-fg"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-fg-2">
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
            className="accent-[var(--color-accent-strong)]"
          />
          Replace what's already imported
        </label>
        <div className="flex-1" />
        {running ? (
          <button
            onClick={stop}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2 hover:text-fg"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </button>
        ) : (
          <button
            onClick={start}
            disabled={starting}
            className="flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {starting ? 'Starting…' : 'Import'}
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-danger-fg">{error}</p>}
    </div>
  );
}
