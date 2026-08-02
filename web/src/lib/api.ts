import type {
  Account,
  Collection,
  EloEstimate,
  EngineSettings,
  GameDetail,
  GameSummary,
  LichessImportStatus,
  MoveQuality as MoveQualityLabel,
  Puzzle,
  PuzzleKind,
  PuzzleProgress,
  PuzzleSource,
  PuzzleStats,
  PuzzleVerdict,
  Run,
  SavedAnalysis,
  ThemeGroup,
  User,
} from '../types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    // FastAPI puts the message in `detail`; anything else (a proxy error page)
    // falls back to the status text rather than throwing while parsing.
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// --- auth -----------------------------------------------------------------

export const listAccounts = () => request<Account[]>('/api/auth/accounts');
export const login = (username: string) =>
  request<User>('/api/auth/login', json({ username }));
export const logout = () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
export const me = () => request<User>('/api/auth/me');
export const createAccount = (username: string, display_name: string) =>
  request<User>('/api/auth/accounts', json({ username, display_name }));

/** Renaming is not cosmetic: the display name is what decides which side of
 *  each game was yours, so the backend re-matches the whole library against
 *  the new names and reports which games moved. This is the documented fix for
 *  a library that imported as `unassigned`.
 *
 *  `rematched` is the tally from `pgn_parse.reassign_your_colors`: `changed` is
 *  every game whose side moved, of which `assigned` are now yours and
 *  `unassigned` no longer match either name. Games you set by hand are left
 *  alone and counted in none of them. */
export const renameAccount = (
  id: number,
  patch: { username?: string; display_name?: string },
) =>
  request<User & { rematched: { changed: number; assigned: number; unassigned: number } }>(
    `/api/auth/accounts/${id}`,
    { ...json(patch), method: 'PATCH' },
  );

/** Takes the games, analyses and puzzles with it, by the schema's cascades.
 *  Deleting the account you are signed into logs you out server-side. */
export const deleteAccount = (id: number) =>
  request<{
    ok: boolean;
    display_name: string;
    deleted: { games: number; analyses: number; puzzles: number };
    logged_out: boolean;
  }>(`/api/auth/accounts/${id}`, { method: 'DELETE' });

// --- library --------------------------------------------------------------

export interface GameFilter {
  speed?: string | null;
  time_control?: string | null;
  collection_id?: number | null;
}

export function listGames(filter: GameFilter = {}) {
  const params = new URLSearchParams();
  if (filter.speed) params.set('speed', filter.speed);
  if (filter.time_control) params.set('time_control', filter.time_control);
  if (filter.collection_id != null) params.set('collection_id', String(filter.collection_id));
  const qs = params.toString();
  return request<GameSummary[]>(`/api/games${qs ? `?${qs}` : ''}`);
}

export interface SpeedFacet {
  speed: string;
  games: number;
  controls: { time_control: string; games: number }[];
}

export interface Facets {
  speeds: SpeedFacet[];
  total: number;
}

export const gameFacets = () => request<Facets>('/api/games/facets');
export const getGame = (id: number) => request<GameDetail>(`/api/games/${id}`);
export const listCollections = () => request<Collection[]>('/api/collections');

export const uploadGames = (files: File[], pasted: string) => {
  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  if (pasted.trim()) form.append('pasted_pgn', pasted);
  return request<{ created: number; games: GameSummary[] }>('/api/games/upload', {
    method: 'POST',
    body: form,
  });
};

// --- chess.com ------------------------------------------------------------

export interface ChesscomMonth {
  year: number;
  month: number;
  /** 'YYYY-MM', which is also what `chesscomImport` takes back. */
  label: string;
  /** How many of that month's games are already in the library. */
  imported: number;
  /** Over, and already read — nothing can be added to it, so an import in
   *  `new` mode skips it without a request. */
  settled: boolean;
  checked_at: string | null;
}

export const chesscomArchives = (username: string) =>
  request<{
    username: string;
    months: ChesscomMonth[];
    settled: number;
    to_check: number;
  }>('/api/games/chesscom/archives', json({ username }));

export interface ChesscomImport {
  username: string;
  added: number;
  /** Games the archive carried that the library already had, matched on
   *  chess.com's permanent `Link` (`games.external_id`). */
  skipped: number;
  with_clocks: number;
  /** Months actually downloaded, as against skipped or answered 304. */
  downloaded: number;
  settled: number;
  unchanged: number;
  /** Months the server's per-request cap didn't reach. Ask again with these:
   *  only the server knows which months cost a request. */
  remaining: string[];
  months: { month: string; added: number; skipped: number; state: string }[];
}

/** `mode: 'new'` is the everyday one — finished months already read are not
 *  requested, everything else is requested conditionally, and a game already
 *  held is never stored twice. `'refetch'` turns the first two off, which is
 *  how you get back games deleted from the library. */
export const chesscomImport = (body: {
  username: string;
  months: string[];
  collection_id?: number | null;
  mode?: 'new' | 'refetch';
}) => request<ChesscomImport>('/api/games/chesscom/import', json(body));

// --- variations -----------------------------------------------------------

/** A line you played that the game didn't. One row is a whole line, in SAN,
 *  from where it leaves its parent to wherever it ends. `parent_id` null means
 *  it branches off the mainline after `start_ply` half-moves; otherwise off
 *  another line after `start_ply` moves of that line. */
export interface Variation {
  id: number;
  game_id: number;
  parent_id: number | null;
  start_ply: number;
  moves: string[];
  label: string | null;
  created_at: string;
}

export const listVariations = (gameId: number) =>
  request<Variation[]>(`/api/games/${gameId}/variations`);

export const createVariation = (
  gameId: number,
  body: { parent_id?: number | null; start_ply: number; moves: string[]; label?: string },
) => request<Variation>(`/api/games/${gameId}/variations`, json(body));

/** Replaces the line — which is how a variation grows, rather than each move
 *  becoming a row of its own. */
export const updateVariation = (id: number, body: { moves?: string[]; label?: string }) =>
  request<Variation>(`/api/variations/${id}`, { ...json(body), method: 'PUT' });

/** Takes the lines nested inside it too. */
export const deleteVariation = (id: number) =>
  request<{ ok: boolean; deleted: number }>(`/api/variations/${id}`, { method: 'DELETE' });

// --- runs -----------------------------------------------------------------

export const listRuns = () => request<Run[]>('/api/runs');
export const createRun = (name: string) => request<Run>('/api/runs', json({ name }));

// --- analysis -------------------------------------------------------------

export const savedAnalysis = (gameId: number) =>
  request<SavedAnalysis>(`/api/analysis/saved/${gameId}`);

export const startQuick = (game_id: number, run_id?: number | null) =>
  request<{ job_id: string }>('/api/analysis/quick', json({ game_id, run_id: run_id ?? null }));

/** Full mode: the Stockfish pass *and* the Maia Elo sweep, joined server-side
 *  (`sweep_job.run_full`). This is what the Full Analysis button runs. */
export const startFull = (game_id: number, run_id?: number | null) =>
  request<{ job_id: string }>('/api/sweep/full', json({ game_id, run_id: run_id ?? null }));

/** The sweep on its own, without the Stockfish pass. */
export const startSweep = (game_id: number, run_id?: number | null) =>
  request<{ job_id: string }>('/api/sweep', json({ game_id, run_id: run_id ?? null }));

export const cancelJob = (jobId: string) =>
  request<{ ok: boolean }>(`/api/analysis/${jobId}/cancel`, { method: 'POST' });

export interface JobSummary {
  job_id: string;
  kind: 'quick' | 'full' | 'sweep' | 'batch';
  game_id: number;
  run_id: number | null;
  total: number;
  finished: boolean;
  cancelled: boolean;
  fraction: number | null;
  running_s: number;
}

export const activeJobs = () => request<JobSummary[]>('/api/analysis/active');

// --- batch ----------------------------------------------------------------

export interface BatchScope {
  mode: 'quick' | 'full';
  /** 'unanalyzed' covers only the games with no result for that mode yet,
   *  which is what "the remaining games" means -- and what makes restarting
   *  after a cancel pick up where it stopped instead of redoing the lot. */
  scope: 'unanalyzed' | 'all';
  run_id?: number | null;
  speed?: string | null;
  time_control?: string | null;
  collection_id?: number | null;
}

/** How many games a batch would cover, so the button can say so before
 *  committing to a run measured in hours. */
export const batchPreview = (scope: BatchScope) =>
  request<{ count: number }>(
    `/api/batch/preview${query({
      mode: scope.mode,
      scope: scope.scope,
      speed: scope.speed,
      time_control: scope.time_control,
      collection_id: scope.collection_id,
    })}`,
  );

/** `attached` is true when the server handed back a run that was already
 *  going rather than starting one -- a batch outlives the page that started
 *  it, so pressing Start over a run you'd lost sight of reattaches. */
export const startBatch = (scope: BatchScope) =>
  request<{ job_id: string; total: number; attached: boolean }>('/api/batch', json(scope));

export const cancelBatch = (jobId: string) =>
  request<{ ok: boolean }>(`/api/batch/${jobId}/cancel`, { method: 'POST' });

// --- settings & assets ----------------------------------------------------

export const getSettings = () => request<EngineSettings>('/api/settings');

/** PUT /api/settings replaces the whole row -- an omitted field is reset to its
 *  pydantic default, not left alone. Every caller therefore edits a copy of the
 *  settings it last read and sends all of it back. */
export const saveSettings = (settings: EngineSettings) =>
  request<EngineSettings>('/api/settings', { ...json(settings), method: 'PUT' });

export const putProfile = (patch: Record<string, unknown>) =>
  request<User>('/api/settings/profile', { ...json(patch), method: 'PUT' });

export interface EngineFamily {
  id: string;
  label: string;
  kind: 'stockfish' | 'maia' | string;
  members: { value: string; name: string; variant: string | null }[];
  default_member: string;
}

export const listEngines = () =>
  request<{ families: EngineFamily[]; engines_dir_exists: boolean }>('/api/settings/engines');

export interface AssetSet {
  name: string;
  has_pieces: boolean;
  has_board: boolean;
}
export const assetSets = () => request<AssetSet[]>('/api/asset-sets');

/** The standalone board images in `assets/boards/`, which are boards and
 *  nothing else -- a flat .png per board rather than a directory with pieces
 *  in it. They outnumber the full sets by an order of magnitude, and a picker
 *  that only reads `/api/asset-sets` offers three boards out of two dozen. */
export const boardImages = () => request<{ name: string; has_board: boolean }[]>(
  '/api/board-images',
);

export interface AudioSet {
  name: string;
  /** Which of the named sounds this set actually ships. */
  sounds: string[];
  /** False when it carries the board sounds but not the puzzle/clock ones,
   *  which fall back to the default set's copies. */
  complete: boolean;
}
export const audioSets = () => request<AudioSet[]>('/api/audio-sets');

/** Which screen draws with what (A7). `defaults` are the account's, `screens`
 *  are the per-screen overrides where `null` means "follow the default", and
 *  `effective` is the two resolved — computed server-side so both front ends
 *  can't disagree about what a screen should look like. */
export interface ScreenPrefs {
  defaults: { board_set: string; piece_set: string; sound_set: string };
  screens: Record<
    ScreenPrefName,
    { board_set: string | null; piece_set: string | null; sound_set: string | null }
  >;
  effective: Record<
    ScreenPrefName,
    { board_set: string; piece_set: string; sound_set: string }
  >;
}

export type ScreenPrefName = 'analysis' | 'puzzles' | 'play';

export const screenPrefs = () => request<ScreenPrefs>('/api/settings/screens');

/** An empty string clears an override, putting that kind back on the default;
 *  an omitted field leaves it alone. */
export const putScreenPrefs = (
  screen: ScreenPrefName,
  patch: { board_set?: string; piece_set?: string; sound_set?: string },
) => request<ScreenPrefs>(`/api/settings/screens/${screen}`, { ...json(patch), method: 'PUT' });

// --- progress -------------------------------------------------------------

export interface Strength {
  you: EloEstimate & { policy_source?: string };
  field: EloEstimate;
  /** `strength._calibrate`. Your estimate moved onto the scale your opponents'
   *  header ratings are on, by measuring the gap on the field you played.
   *  `available: false` carries the reason instead — a fit that couldn't be
   *  calibrated says why rather than showing a number built on nothing. */
  calibration:
    | { available: false; reason: string }
    | {
        available: true;
        field_estimate: number;
        field_actual: number;
        field_actual_n: number;
        offset: number;
        your_calibrated: number;
        your_calibrated_low: number | null;
        your_calibrated_high: number | null;
      };
  predictability: {
    available: boolean;
    model?: string;
    observed?: number;
    expected?: number;
    implied_rating?: number | null;
    gap?: number | null;
    gap_significant?: boolean;
    note?: string;
  };
  your_rating_mean: number | null;
  your_rating_n: number;
  games: number;
  skipped: Record<string, number>;
  scale_note: string;
}

export interface TrendBucket {
  key: string;
  label: string;
  x: number;
  games: number;
  positions: number;
  estimate: number | null;
  ci_low: number | null;
  ci_high: number | null;
  confidence: string;
  reasons: string[];
  actual_elo: number | null;
  actual_n: number;
  sparse: boolean;
}

export interface Trend {
  granularity: string;
  buckets: TrendBucket[];
  trend: { rate: number | null; per: string; significant?: boolean; [k: string]: unknown } | null;
  actual_trend: { rate: number | null; per: string; [k: string]: unknown } | null;
  offset: { n: number; mean: number | null };
  total_games: number;
  skipped: Record<string, number>;
  /** What `window` actually covered. It ends at the most recent analysed game
   *  rather than today (`trend._apply_window`), so the panel can say so. */
  window: {
    requested: string | null;
    applied: boolean;
    excluded: number;
    start: string | null;
    end: string | null;
  };
}

/** `/api/move-quality` — your moves by classification, over the same slice of
 *  the library the pooled estimate is fitted on. */
export interface MoveQualityCounts {
  counts: Record<MoveQualityLabel, number>;
  other: number;
  moves: number;
  games: number;
  /** Great and Brilliant only come out of a swept game, so a library that is
   *  mostly Quick analyses reads low on both by construction. */
  games_swept: number;
  games_quick_only: number;
  skipped: Record<string, number>;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const strength = (params: Record<string, string | number | undefined | null> = {}) =>
  request<Strength>(`/api/strength${query(params)}`);

export const trend = (params: Record<string, string | number | undefined | null> = {}) =>
  request<Trend>(`/api/trend${query(params)}`);

export const moveQuality = (params: Record<string, string | number | undefined | null> = {}) =>
  request<MoveQualityCounts>(`/api/move-quality${query(params)}`);

// --- puzzles --------------------------------------------------------------

/** What the picker is being asked for.
 *
 * `kinds` and `themes` are independent filters that intersect, which is the
 * point: "blunder checks, but only the forks" is a sensible thing to practise
 * and needs no special case. An empty `themes` means every motif, and an empty
 * `kinds` is refused by the server rather than silently meaning "all" -- a
 * solver who has turned both toggles off asked for nothing.
 */
export interface PuzzleQuery {
  source: PuzzleSource;
  kinds?: PuzzleKind[];
  themes?: string[];
  scope?: 'blunder' | 'all';
  order?: 'random' | 'worst';
  exclude?: string | null;
}

const puzzleParams = (q: PuzzleQuery) => ({
  source: q.source,
  scope: q.scope ?? 'all',
  order: q.order ?? 'random',
  kinds: q.kinds?.length ? q.kinds.join(',') : undefined,
  themes: q.themes?.length ? q.themes.join(',') : undefined,
  exclude: q.exclude ?? undefined,
});

export const puzzleStats = () => request<PuzzleStats>('/api/puzzles/stats');

export const puzzleThemes = (source: PuzzleSource, kinds?: PuzzleKind[]) =>
  request<{ source: PuzzleSource; groups: ThemeGroup[] }>(
    `/api/puzzles/themes${query({ source, kinds: kinds?.length ? kinds.join(',') : undefined })}`,
  );

export const nextPuzzle = (q: PuzzleQuery) =>
  request<{ puzzle: Puzzle; progress: PuzzleProgress } & Omit<PuzzleStats, 'progress'>>(
    `/api/puzzles/next${query(puzzleParams(q))}`,
  );

/** Every move you have played at this puzzle, newest last.
 *
 * The whole prefix rather than just the new move, for both sources: the
 * server holds no per-solver state and re-checks the line each time, so
 * nothing can be skipped by lying about where you are. */
export const attemptPuzzle = (puzzle: Puzzle, moves: string[]) =>
  request<PuzzleVerdict>(
    puzzle.source === 'lichess'
      ? `/api/puzzles/lichess/${puzzle.id}/attempt`
      : `/api/puzzles/${puzzle.id}/attempt`,
    json({ moves }),
  );

export const revealPuzzle = (puzzle: Puzzle) =>
  request<PuzzleVerdict>(
    puzzle.source === 'lichess'
      ? `/api/puzzles/lichess/${puzzle.id}/reveal`
      : `/api/puzzles/${puzzle.id}/reveal`,
    { method: 'POST' },
  );

export const rebuildPuzzles = () =>
  request<
    PuzzleStats & {
      added: number;
      considered: number;
      skipped_already_lost: number;
      /** Puzzles built before the evaluations were stored on them, repaired by
       *  this rescan -- which is what lets them be filed as blunder checks. */
      evals_filled: number;
      kinds_fixed: number;
    }
  >('/api/puzzles/rebuild', { method: 'POST' });

export const resetPuzzles = () => request<PuzzleStats>('/api/puzzles/reset', { method: 'POST' });
export const resetPuzzleRating = () =>
  request<PuzzleProgress>('/api/puzzles/rating/reset', { method: 'POST' });

/** Measure a puzzle's difficulty with Maia, for next time.
 *
 * Asked for after a puzzle is over, never before: the measurement is a sweep
 * across the whole Elo grid and putting it in front of a verdict would mean
 * waiting seconds to be told whether the move you already played was right. */
export const measureDifficulty = (puzzleId: number) =>
  request<{ elo: number | null; rd: number | null; rating: number | null; reason?: string }>(
    `/api/puzzles/${puzzleId}/difficulty`,
    { method: 'POST' },
  );

export const lichessStatus = () => request<LichessImportStatus>('/api/puzzles/lichess/status');

export interface LichessImportRequest {
  min_rating?: number | null;
  max_rating?: number | null;
  max_puzzles?: number | null;
  source_path?: string | null;
  replace?: boolean;
}

export const startLichessImport = (body: LichessImportRequest) =>
  request<LichessImportStatus>('/api/puzzles/lichess/import', json(body));

export const cancelLichessImport = () =>
  request<{ stopping: boolean }>('/api/puzzles/lichess/cancel', { method: 'POST' });

// --- websockets -----------------------------------------------------------

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}
