import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  Database,
  FolderPlus,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  Upload,
  X,
} from 'lucide-react';
import * as api from '../../lib/api';
import { useBatchJob } from '../../lib/useBatchJob';
import type { Collection, GameSummary, Run, User } from '../../types';

interface GameLibraryPanelProps {
  games: GameSummary[];
  loading: boolean;
  activeGameId: number | null;
  onSelectGame: (game: GameSummary) => void;
  facets: api.Facets | null;
  collections: Collection[];
  filter: api.GameFilter;
  onChangeFilter: (filter: api.GameFilter) => void;
  runs: Run[];
  runId: number | null;
  onChangeRun: (runId: number | null) => void;
  onRunsChanged: () => void;
  onLibraryChanged: () => void;
  /** Estimated Elo per game id for sweeps that finished *this session* — the
   *  rest of the library carries its own `estimated_elo` from the server. */
  estimates: Record<number, number>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The signed-in account: its display name is the best first guess at the
   *  chess.com handle, being the name games are matched against already. */
  user: User;
}

/** The same key the classic UI stores it under, so the two agree about who
 *  you are on chess.com rather than each asking separately. */
const CC_USERNAME_KEY = 'cc:username';

/** The server caps downloads per request and hands back what it didn't reach,
 *  so a sync is a loop. This only bounds it against a server that somehow
 *  never makes progress -- five years of archive is ten passes. */
const MAX_SYNC_PASSES = 40;

const SPEED_LABEL: Record<string, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapid',
  classical: 'Classical',
  daily: 'Daily',
  unknown: 'Unknown',
};

export function GameLibraryPanel({
  games,
  loading,
  activeGameId,
  onSelectGame,
  facets,
  collections,
  filter,
  onChangeFilter,
  runs,
  runId,
  onChangeRun,
  onRunsChanged,
  onLibraryChanged,
  estimates,
  collapsed,
  onToggleCollapsed,
  user,
}: GameLibraryPanelProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [ccUsername, setCcUsername] = useState(
    () => localStorage.getItem(CC_USERNAME_KEY) || user.display_name || user.username,
  );
  const [ccBusy, setCcBusy] = useState(false);
  const [ccNote, setCcNote] = useState<string | null>(null);
  const [ccError, setCcError] = useState(false);

  useEffect(() => {
    if (!uploadNote) return;
    const timer = setTimeout(() => setUploadNote(null), 6000);
    return () => clearTimeout(timer);
  }, [uploadNote]);

  // --- full analysis over the rest of the library ---------------------------

  /**
   * The batch, over exactly the games the panel is currently showing.
   *
   * The filters above the list go to the server with it, so "full analysis on
   * the remaining games" means the remaining games *of this selection* --
   * pressing it while filtered to rapid does not quietly start a run over
   * every bullet game as well. `scope: 'unanalyzed'` is the "remaining" part:
   * a game that already has a full result is skipped, so this is also how you
   * resume a run that was cancelled or interrupted.
   */
  const batch = useBatchJob(onLibraryChanged);
  const [remaining, setRemaining] = useState<number | null>(null);

  const batchScope = useCallback(
    (): api.BatchScope => ({
      mode: 'full',
      scope: 'unanalyzed',
      run_id: runId,
      speed: filter.speed ?? null,
      time_control: filter.time_control ?? null,
      collection_id: filter.collection_id ?? null,
    }),
    [runId, filter.speed, filter.time_control, filter.collection_id],
  );

  // How many games the button would cover, so it can say so before committing
  // to a run that is measured in hours. Re-asked whenever the selection
  // changes or a game finishes -- `games` moves when the library reloads.
  useEffect(() => {
    let live = true;
    api
      .batchPreview(batchScope())
      .then((r) => live && setRemaining(r.count))
      .catch(() => live && setRemaining(null));
    return () => {
      live = false;
    };
  }, [batchScope, games]);

  // A run outlives the page that started it -- a locked phone or a discarded
  // tab doesn't touch it -- so on mount, ask whether one is still going rather
  // than offering to start a second one on the same games.
  useEffect(() => {
    let live = true;
    api
      .activeJobs()
      .then((jobs) => {
        const running = jobs.find((job) => job.kind === 'batch' && !job.finished);
        if (live && running) batch.reattach(running);
      })
      .catch(() => {
        /* offline; the button still works, and the server will reattach */
      });
    return () => {
      live = false;
    };
    // Once, on mount: `batch.reattach` is stable and re-running this would
    // re-join a run it is already following.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadNote(null);
    try {
      const result = await api.uploadGames([...files], '');
      setUploadNote(`Imported ${result.created} game${result.created === 1 ? '' : 's'}.`);
      onLibraryChanged();
    } catch (e) {
      setUploadNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  /**
   * Download whatever chess.com has that the library doesn't.
   *
   * Every month goes to the server rather than being filtered here: it knows
   * which ones are settled -- over and already read, so incapable of gaining a
   * game -- and skips those without a request. On a library that is up to date
   * this is one archive lookup and one import call that fetches only the month
   * in progress.
   *
   * The loop is the server's per-request download cap, not pagination. It
   * hands back the months it didn't reach and this asks again, so a five-year
   * archive is a handful of requests instead of one that sits past any sane
   * HTTP timeout.
   */
  const syncChesscom = async () => {
    const username = ccUsername.trim();
    if (!username) {
      setCcError(true);
      setCcNote('Type your chess.com username first.');
      return;
    }
    localStorage.setItem(CC_USERNAME_KEY, username);
    setCcBusy(true);
    setCcError(false);
    setCcNote('Asking chess.com which months you have games in…');
    try {
      const archives = await api.chesscomArchives(username);
      if (archives.months.length === 0) {
        setCcNote(`chess.com has no games for '${archives.username}'.`);
        return;
      }

      let months = archives.months.map((m) => m.label);
      let added = 0;
      let skipped = 0;
      let downloaded = 0;
      let passes = 0;

      while (months.length > 0 && passes < MAX_SYNC_PASSES) {
        passes += 1;
        setCcNote(
          downloaded === 0
            ? `Checking ${months.length} month${months.length === 1 ? '' : 's'}…`
            : `Checked ${downloaded}, ${months.length} to go — ${added} new so far…`,
        );
        const result = await api.chesscomImport({ username, months, mode: 'new' });
        added += result.added;
        skipped += result.skipped;
        downloaded += result.downloaded;
        if (result.remaining.length >= months.length) break; // no progress
        months = result.remaining;
        if (result.added > 0) onLibraryChanged();
      }

      setCcNote(
        added > 0
          ? `Added ${added} new game${added === 1 ? '' : 's'}.` +
              (skipped ? ` ${skipped} were already in your library.` : '')
          : 'Nothing new — your library already has everything chess.com does.',
      );
      onLibraryChanged();
    } catch (e) {
      setCcError(true);
      setCcNote(e instanceof Error ? e.message : String(e));
    } finally {
      setCcBusy(false);
    }
  };

  const newRun = async () => {
    const name = window.prompt('Name this run');
    if (!name?.trim()) return;
    try {
      const run = await api.createRun(name.trim());
      onRunsChanged();
      onChangeRun(run.id);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  };

  // Collapsed reads differently on the two layouts. Beside the board it is a
  // rail down the edge, which is where it came from; on a phone the panel is a
  // sheet over the whole screen, and what's left of it when closed is a button
  // floating over the board rather than a 44px column stealing the width.
  if (collapsed) {
    return (
      <>
        <button
          onClick={onToggleCollapsed}
          className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface/60 py-4 text-fg-muted hover:text-fg lg:flex"
          title="Show game library"
        >
          <Database className="h-4 w-4" />
          <span className="font-mono text-[10px] [writing-mode:vertical-rl]">
            LIBRARY · {games.length}
          </span>
        </button>
        <button
          onClick={onToggleCollapsed}
          className="fixed right-4 bottom-4 z-30 flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-3 text-xs font-semibold text-fg-2 shadow-2xl lg:hidden"
          title="Show game library"
        >
          <Database className="h-4 w-4 text-accent" />
          <span className="font-mono">LIBRARY · {games.length}</span>
        </button>
      </>
    );
  }

  return (
    // Open, the panel is the whole screen on a phone — a fixed sheet, not a
    // block appended under the board that you have to scroll past to get back
    // to the game. From `lg` up it is the column beside the board it always
    // was, and nothing about that layout changes.
    <aside className="fixed inset-0 z-40 flex w-full flex-col bg-canvas lg:static lg:h-full lg:w-80 lg:shrink-0 lg:border-l lg:border-line lg:bg-surface/60 xl:w-96">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-accent" />
          <h3 className="text-xs font-semibold tracking-wider text-fg-2 uppercase">
            Game library
          </h3>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
          title="Collapse"
          aria-label="Close the game library"
        >
          <ChevronRight className="hidden h-4 w-4 lg:block" />
          <X className="h-5 w-5 lg:hidden" />
        </button>
      </div>

      <div className="space-y-3 border-b border-line px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[10px] tracking-wider text-fg-subtle uppercase">
            Save results into
          </span>
          <div className="flex gap-1.5">
            <select
              value={runId ?? ''}
              onChange={(e) => onChangeRun(e.target.value ? Number(e.target.value) : null)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs text-fg-2 outline-none focus:border-accent-strong"
            >
              <option value="">Default run</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name}
                  {run.game_count != null ? ` (${run.game_count})` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={newRun}
              title="New run"
              className="rounded-lg border border-line bg-canvas px-2 text-fg-muted hover:text-fg"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </label>

        <div>
          <span className="mb-1 block text-[10px] tracking-wider text-fg-subtle uppercase">
            Time control
          </span>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onChangeFilter({ ...filter, speed: null })}
              className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                !filter.speed
                  ? 'bg-accent-strong text-on-accent'
                  : 'bg-canvas text-fg-muted ring-1 ring-line hover:text-fg-2'
              }`}
            >
              All {facets ? `(${facets.total})` : ''}
            </button>
            {facets?.speeds.map((speed) => (
              <button
                key={speed.speed}
                onClick={() => onChangeFilter({ ...filter, speed: speed.speed })}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  filter.speed === speed.speed
                    ? 'bg-accent-strong text-on-accent'
                    : 'bg-canvas text-fg-muted ring-1 ring-line hover:text-fg-2'
                }`}
              >
                {SPEED_LABEL[speed.speed] ?? speed.speed} ({speed.games})
              </button>
            ))}
          </div>
        </div>

        {collections.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-[10px] tracking-wider text-fg-subtle uppercase">
              Group
            </span>
            <select
              value={filter.collection_id ?? ''}
              onChange={(e) =>
                onChangeFilter({
                  ...filter,
                  collection_id: e.target.value ? Number(e.target.value) : null,
                })
              }
              className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs text-fg-2 outline-none focus:border-accent-strong"
            >
              <option value="">Every group</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name} ({collection.game_count})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* B12: the list is what gives, so the filters above it and the upload
          controls below it are always on screen — on the phone sheet as much
          as in the column, since both are a fixed height with the list
          scrolling inside. */}
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-fg-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading games…
          </div>
        ) : games.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-fg-subtle">
            No games match this filter. Upload a PGN below to get started.
          </p>
        ) : (
          <ul className="divide-y divide-line/70">
            {games.map((game) => {
              const active = game.id === activeGameId;
              const you = game.your_color;
              // The list carries the saved estimate for every row; `estimates`
              // only holds sweeps that finished since this list was fetched,
              // so it wins where it has one.
              const estimate = estimates[game.id] ?? game.estimated_elo ?? null;
              return (
                <li key={game.id}>
                  <button
                    onClick={() => onSelectGame(game)}
                    className={`w-full px-4 py-2.5 text-left transition-colors ${
                      active ? 'bg-accent-strong/15 ring-1 ring-inset ring-accent-strong/40' : 'hover:bg-surface-2/50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-fg">
                        {game.white} — {game.black}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-fg-subtle">
                        {game.result}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-fg-subtle">
                      <span>{game.date_header ?? game.utc_date_header ?? '—'}</span>
                      {game.speed && <span>{game.speed}</span>}
                      {(you === 'w' || you === 'b') && (
                        <span className="text-fg-muted">as {you === 'w' ? 'white' : 'black'}</span>
                      )}
                      {game.analyzed && (
                        <span className="ml-auto flex items-center gap-1 text-positive">
                          <CheckCircle2 className="h-3 w-3" />
                          {game.analyzed}
                        </span>
                      )}
                    </div>
                    {/* Always drawn, so a row's height doesn't depend on
                        whether it has been swept and the estimates line up
                        down the list. A game with no sweep says so with
                        dashes rather than by leaving a gap. */}
                    <div
                      className={`mt-1 inline-flex rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${
                        estimate != null
                          ? 'bg-accent/10 text-accent ring-accent/20'
                          : 'bg-canvas/60 text-fg-faint ring-line'
                      }`}
                      title={
                        estimate != null
                          ? 'Estimated Elo from the Maia sweep'
                          : 'No Elo sweep has been run on this game yet'
                      }
                    >
                      est. {estimate ?? '———'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-line px-4 py-3">
        {/* Full analysis over everything left. Above the import controls
            because it is the thing you do with a library, not to it. */}
        {batch.state.running ? (
          <div className="space-y-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-medium text-fg">
                {batch.state.queuedAhead != null
                  ? `Waiting for a free worker — ${batch.state.queuedAhead} ahead`
                  : batch.state.index != null && batch.state.total != null
                    ? `Game ${batch.state.index + 1} of ${batch.state.total}`
                    : 'Starting…'}
              </span>
              <button
                onClick={() => void batch.cancel()}
                title="Stop after the game in flight — everything already finished stays saved"
                className="flex shrink-0 items-center gap-1 rounded border border-line bg-canvas px-1.5 py-0.5 text-[10px] text-fg-2 hover:text-fg"
              >
                <Square className="h-2.5 w-2.5" />
                Stop
              </button>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full bg-accent-strong transition-[width] duration-300"
                style={{ width: `${Math.round((batch.state.fraction ?? 0) * 100)}%` }}
              />
            </div>
            {batch.state.current && (
              <p className="truncate text-[10px] text-fg-muted">{batch.state.current}</p>
            )}
          </div>
        ) : (
          <button
            onClick={() => void batch.start(batchScope())}
            disabled={remaining === 0}
            title="Run the Stockfish pass and the Maia Elo sweep over every game in this selection that hasn't had one"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 text-xs font-medium text-fg hover:bg-accent/20 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            {/* The count is left out until the preview lands, rather than
                shown as a blank where a number goes. */}
            {remaining === 0
              ? 'Every game here is analysed'
              : remaining == null
                ? 'Full analysis on the remaining games'
                : `Full analysis on ${remaining} remaining game${remaining === 1 ? '' : 's'}`}
          </button>
        )}
        {(batch.state.note || batch.state.error) && !batch.state.running && (
          <button
            onClick={batch.dismiss}
            title="Dismiss"
            className={`block w-full text-left text-[11px] ${
              batch.state.error ? 'text-danger-fg' : 'text-fg-muted'
            }`}
          >
            {batch.state.error ?? batch.state.note}
          </button>
        )}
        {batch.state.failures.length > 0 && (
          // One bad game shouldn't stop a long run, but it shouldn't vanish
          // either.
          <ul className="max-h-20 space-y-0.5 overflow-y-auto text-[10px] text-danger-fg">
            {batch.state.failures.map((failure) => (
              <li key={failure.index} className="truncate">
                Game {failure.index + 1} failed: {failure.message}
              </li>
            ))}
          </ul>
        )}

        <input
          ref={fileInput}
          type="file"
          accept=".pgn"
          multiple
          hidden
          onChange={(e) => upload(e.target.files)}
        />
        <div className="flex gap-2">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-fg-2 hover:text-fg disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload PGN
          </button>
          <button
            onClick={onLibraryChanged}
            title="Reload the library"
            className="rounded-lg border border-line bg-canvas px-2.5 text-fg-muted hover:text-fg"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {uploadNote && <p className="text-[11px] text-fg-muted">{uploadNote}</p>}

        {/* Only what's new. Three layers server-side stop a game being fetched
            or stored twice -- a settled month isn't requested, everything else
            is requested conditionally, and a game already held is matched on
            chess.com's permanent link -- so pressing this on an up-to-date
            library costs one request and adds nothing. */}
        <div className="flex gap-1.5">
          <input
            value={ccUsername}
            onChange={(e) => setCcUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !ccBusy && syncChesscom()}
            placeholder="chess.com username"
            aria-label="chess.com username"
            className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 py-2 text-xs text-fg-2 outline-none focus:border-accent-strong"
          />
          <button
            onClick={syncChesscom}
            disabled={ccBusy}
            title="Download the games chess.com has and your library doesn't"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-2 text-xs text-fg-2 hover:text-fg disabled:opacity-50"
          >
            {ccBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CloudDownload className="h-3.5 w-3.5" />
            )}
            Get new
          </button>
        </div>
        {ccNote && (
          <p className={`text-[11px] ${ccError ? 'text-danger-fg' : 'text-fg-muted'}`}>{ccNote}</p>
        )}

        <a
          href="/legacy/"
          className="block text-center text-[11px] text-fg-subtle underline-offset-2 hover:text-fg-2 hover:underline"
        >
          month-by-month import, quick-mode batches, groups and the opening book →
        </a>
      </div>
    </aside>
  );
}
