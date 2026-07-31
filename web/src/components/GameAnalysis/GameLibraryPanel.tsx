import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Database,
  FolderPlus,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import * as api from '../../lib/api';
import type { Collection, GameSummary, Run } from '../../types';

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
}

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
}: GameLibraryPanelProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
        className="flex w-11 shrink-0 flex-col items-center gap-3 border-l border-stone-800 bg-stone-900/60 py-4 text-stone-400 hover:text-stone-100"
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
    <aside className="flex w-full shrink-0 flex-col border-l border-stone-800 bg-stone-900/60 lg:w-80 xl:w-96">
      <div className="flex items-center justify-between border-b border-stone-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-amber-500" />
          <h3 className="text-xs font-semibold tracking-wider text-stone-300 uppercase">
            Game library
          </h3>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="rounded p-1 text-stone-400 hover:bg-stone-800 hover:text-stone-100"
          title="Collapse"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 border-b border-stone-800 px-4 py-3">
        <label className="block">
          <span className="mb-1 block text-[10px] tracking-wider text-stone-500 uppercase">
            Save results into
          </span>
          <div className="flex gap-1.5">
            <select
              value={runId ?? ''}
              onChange={(e) => onChangeRun(e.target.value ? Number(e.target.value) : null)}
              className="min-w-0 flex-1 rounded-lg border border-stone-800 bg-stone-950 px-2 py-1.5 text-xs text-stone-200 outline-none focus:border-amber-600"
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
              className="rounded-lg border border-stone-800 bg-stone-950 px-2 text-stone-400 hover:text-stone-100"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>
        </label>

        <div>
          <span className="mb-1 block text-[10px] tracking-wider text-stone-500 uppercase">
            Time control
          </span>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onChangeFilter({ ...filter, speed: null })}
              className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                !filter.speed
                  ? 'bg-amber-600 text-white'
                  : 'bg-stone-950 text-stone-400 ring-1 ring-stone-800 hover:text-stone-200'
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
                    ? 'bg-amber-600 text-white'
                    : 'bg-stone-950 text-stone-400 ring-1 ring-stone-800 hover:text-stone-200'
                }`}
              >
                {SPEED_LABEL[speed.speed] ?? speed.speed} ({speed.games})
              </button>
            ))}
          </div>
        </div>

        {collections.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-[10px] tracking-wider text-stone-500 uppercase">
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
              className="w-full rounded-lg border border-stone-800 bg-stone-950 px-2 py-1.5 text-xs text-stone-200 outline-none focus:border-amber-600"
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

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-stone-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading games…
          </div>
        ) : games.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-stone-500">
            No games match this filter. Upload a PGN below to get started.
          </p>
        ) : (
          <ul className="divide-y divide-stone-800/70">
            {games.map((game) => {
              const active = game.id === activeGameId;
              const you = game.your_color;
              const estimate = estimates[game.id];
              return (
                <li key={game.id}>
                  <button
                    onClick={() => onSelectGame(game)}
                    className={`w-full px-4 py-2.5 text-left transition-colors ${
                      active ? 'bg-amber-600/15 ring-1 ring-inset ring-amber-600/40' : 'hover:bg-stone-800/50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-stone-100">
                        {game.white} — {game.black}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-stone-500">
                        {game.result}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-stone-500">
                      <span>{game.date_header ?? game.utc_date_header ?? '—'}</span>
                      {game.speed && <span>{game.speed}</span>}
                      {(you === 'w' || you === 'b') && (
                        <span className="text-stone-400">as {you === 'w' ? 'white' : 'black'}</span>
                      )}
                      {game.analyzed && (
                        <span className="ml-auto flex items-center gap-1 text-emerald-500">
                          <CheckCircle2 className="h-3 w-3" />
                          {game.analyzed}
                        </span>
                      )}
                    </div>
                    {estimate != null && (
                      <div className="mt-1 inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-400 ring-1 ring-amber-500/20">
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

      <div className="space-y-2 border-t border-stone-800 px-4 py-3">
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
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-xs text-stone-300 hover:text-stone-100 disabled:opacity-50"
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
            className="rounded-lg border border-stone-800 bg-stone-950 px-2.5 text-stone-400 hover:text-stone-100"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {uploadNote && <p className="text-[11px] text-stone-400">{uploadNote}</p>}
        <a
          href="/legacy/"
          className="block text-center text-[11px] text-stone-500 underline-offset-2 hover:text-stone-300 hover:underline"
        >
          chess.com import, batch runs, groups and the opening book →
        </a>
      </div>
    </aside>
  );
}
