import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  Database,
  FolderPlus,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import * as api from '../../lib/api';
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
  /** Estimated Elo per game id, from whatever sweep has been run for it. */
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

  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapsed}
        className="flex w-11 shrink-0 flex-col items-center gap-3 border-l border-line bg-surface/60 py-4 text-fg-muted hover:text-fg"
        title="Show game library"
      >
        <Database className="h-4 w-4" />
        <span className="font-mono text-[10px] [writing-mode:vertical-rl]">
          LIBRARY · {games.length}
        </span>
      </button>
    );
  }

  return (
    <aside className="flex w-full shrink-0 flex-col border-l border-line bg-surface/60 lg:h-full lg:w-80 xl:w-96">
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
        >
          <ChevronRight className="h-4 w-4" />
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

      {/* B12: fixed height, scrolling inside. The cap is what holds the
          stacked (narrow) layout together, where there is no row height to
          divide and a 300-game library would otherwise push the upload
          controls off the bottom of the page. */}
      <div className="thin-scroll max-h-[55vh] min-h-0 flex-1 overflow-y-auto lg:max-h-none">
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
              const estimate = estimates[game.id];
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
                    {estimate != null && (
                      <div className="mt-1 inline-flex rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent ring-1 ring-accent/20">
                        est. {estimate}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-line px-4 py-3">
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
          month-by-month import, batch runs, groups and the opening book →
        </a>
      </div>
    </aside>
  );
}
