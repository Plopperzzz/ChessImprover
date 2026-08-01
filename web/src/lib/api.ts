import type {
  Account,
  Collection,
  EloEstimate,
  EngineSettings,
  GameDetail,
  GameSummary,
  MoveQuality as MoveQualityLabel,
  Run,
  SavedAnalysis,
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

// --- websockets -----------------------------------------------------------

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}
