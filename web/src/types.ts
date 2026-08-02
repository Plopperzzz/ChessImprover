export type ScreenType = 'analysis' | 'dashboard' | 'play' | 'puzzles';

/** The classification vocabulary is the backend's -- `classify._label` plus the
 *  two Maia-dependent labels and `book`. Nothing here is invented client-side. */
export type MoveQuality =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'miss';

export interface User {
  id: number;
  username: string;
  display_name: string;
  asset_set: string;
  board_set: string;
  piece_set: string;
  sound_set: string;
  show_legal_moves: number;
  allow_premoves: number;
  eval_bar_side: string;
}

export interface Account extends User {
  game_count: number;
  analysis_count: number;
  puzzle_count: number;
}

export interface GameSummary {
  id: number;
  batch_index: number;
  source_name: string;
  white: string;
  black: string;
  result: string;
  date_header: string | null;
  utc_date_header: string | null;
  year: number | null;
  month: number | null;
  /** 'w' | 'b', or 'unassigned' when neither PGN header matched the account
   *  (`pgn_parse.match_color`) -- never guessed at. */
  your_color: 'w' | 'b' | 'unassigned' | null;
  your_color_locked: number;
  time_control: string | null;
  speed: string | null;
  has_clocks: number;
  /** 'full' | 'quick' | 'sweep' when a saved analysis exists, else null. */
  analyzed: string | null;
  /** The Elo the sweep fitted for *your* side of this game, null when no sweep
   *  has been run (or the game isn't assigned to either colour). Optional
   *  because the upload response summarises games before any of them can have
   *  one. */
  estimated_elo?: number | null;
  collection_ids: number[];
  /** 'library' | 'chesscom' | 'played', read off `source_name` server-side. */
  database: 'library' | 'chesscom' | 'played';
}

export interface GameDetail extends GameSummary {
  pgn_text: string;
  white_elo: number | null;
  black_elo: number | null;
}

export interface Collection {
  id: number;
  name: string;
  game_count: number;
}

export interface Run {
  id: number;
  name: string;
  is_default: number;
  game_count?: number;
}

/** One move as the backend classifies it (`classify.classify_moves`, plus the
 *  Maia columns that only a full run fills in). `ply` is 1-based. */
export interface AnalysisMove {
  ply: number;
  san?: string;
  uci?: string;
  cp_before: number;
  cp_after: number;
  drop: number;
  classification: MoveQuality;
  is_best?: boolean | null;
  forced?: boolean | null;
  only_move_gap?: number | null;
  maia_match_rate?: number | null;
  lowest_matching_elo?: number | null;
}

/** `elo_sweep.estimate` / `policy_likelihood.estimate` output for one side. */
export interface EloEstimate {
  estimate: number | null;
  ci_low: number | null;
  ci_high: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  n_positions: number;
  n_discriminative: number;
  n_uninformative?: number;
  n_games?: number | null;
  method?: string;
  bound?: 'lower' | 'upper' | null;
  grid?: number[];
  match_rates?: number[];
  curve_x?: number[];
  curve_y?: number[];
  ceiling?: {
    observed: number;
    expected: number;
    ratio: number;
    implied_rating: number | null;
    model: string;
    bound: 'lower' | 'upper' | null;
    reached: boolean;
  } | null;
}

/** Keyed by side: 'w' and/or 'b'. */
export type SweepResults = Record<string, EloEstimate>;

export interface SavedAnalysis {
  run_game_id: number;
  estimate_run_game_id: number;
  run_id: number;
  mode: 'full' | 'quick' | 'sweep';
  analyzed_at: string;
  grid: number[] | null;
  results: SweepResults | null;
  model_note: string | null;
  maia_model_size: string | null;
  moves: AnalysisMove[];
}

/** Events streamed over /ws/analysis/{job_id}. */
export interface JobProgress {
  type: 'progress';
  fraction?: number;
  phase?: 'stockfish' | 'maia';
  ply?: number;
  total?: number;
  done?: number;
  elo?: number;
  fen?: string;
}

export interface JobDone {
  type: 'done';
  mode?: 'full' | 'quick';
  moves?: AnalysisMove[];
  grid?: number[];
  your_color?: string;
  results?: SweepResults;
  model_note?: string;
}

export type JobEvent =
  | JobProgress
  | JobDone
  | { type: 'error'; message: string }
  | { type: 'queued'; ahead?: number }
  | { type: 'started' }
  | { type: string; [key: string]: unknown };

/** One ranked line from the live-eval websocket. */
export interface EngineLine {
  rank: number;
  cp: number | null;
  mate: number | null;
  depth: number;
  pv: string[];
  /** PV rewritten into SAN against the position it was searched from. */
  sanPv?: string[];
}

/** Mirrors `engine_settings.EngineSettings` (the PUT body) plus the resolved
 *  read-only fields `get_effective_settings` adds. PUT replaces the whole row,
 *  so an edit has to send every field back -- see `saveSettings`. */
export interface EngineSettings {
  stockfish_path: string | null;
  stockfish_threads: number;
  stockfish_hash_mb: number;
  sf_limit_type: 'depth' | 'movetime';
  sf_limit_value: number;
  sf_skill_level: number | null;
  maia_path: string | null;
  maia_model_size: string;
  maia_elo_min: number;
  maia_elo_max: number;
  maia_elo_step: number;
  maia_elo_step_batch: number;
  maia_multipv: number;
  maia_policy: boolean;
  min_think_ms: number;
  maia_accuracy_offset: number;
  great_max_drop: number;
  great_max_match_rate: number;
  brilliant_enabled: boolean;
  maia_options: Record<string, string>;
  stockfish_options: Record<string, string>;
  /** Read-only, added by the server: the absolute binaries it will launch. */
  stockfish_binary?: string | null;
  maia_binary?: string | null;
  [key: string]: unknown;
}

export interface BoardPrefs {
  board_set: string;
  piece_set: string;
  show_legal_moves: number;
  allow_premoves: number;
  eval_bar_side: string;
}

// --- puzzles --------------------------------------------------------------

/** Which source a puzzle came from. They share a board, a theme vocabulary,
 *  a picker and a rating; what differs is where the answer lives. */
export type PuzzleSource = 'own' | 'lichess';

/** Tactic: there is something here, find it. Blunder check: you were fine and
 *  threw it away, find the move that holds. Only puzzles from your own games
 *  have a kind -- a Lichess puzzle is always the first. */
export type PuzzleKind = 'tactic' | 'blunder_check';

export interface PuzzleSetup {
  /** The position *before* the opponent's move. */
  fen: string;
  uci: string;
  san: string | null;
}

export interface Puzzle {
  key: string;
  source: PuzzleSource;
  /** Own-game puzzles are numbered; Lichess ones carry their published id. */
  id: number | string;
  fen: string;
  /** Lichess puzzles open on the move before, which is played in so the
   *  position reads as a moment from a game rather than a diagram. */
  setup: PuzzleSetup | null;
  your_color: 'w' | 'b';
  themes: string[];
  rating: number | null;
  rating_rd: number | null;
  /** How many of your moves the answer is. 0 means the line has never been
   *  worked out, which is not the same as one. */
  moves_required: number;
  attempts: number;
  solved: boolean;

  // Own-game puzzles only.
  kind?: PuzzleKind;
  rating_source?: 'maia' | 'themes' | null;
  game_id?: number;
  ply?: number;
  classification?: string;
  wp_drop?: number | null;
  move_number?: number;
  white?: string | null;
  black?: string | null;
  date?: string | null;

  // Lichess puzzles only.
  game_url?: string | null;
  opening_tags?: string | null;
  popularity?: number | null;
  nb_plays?: number | null;
}

export interface PuzzleRatingResult {
  rated: boolean;
  first_try: boolean;
  puzzle_rating: number | null;
  before: number;
  after: number;
  delta: number;
  rd: number;
  provisional: boolean;
}

export interface ThemeRating {
  theme: string;
  rating: number;
  rd: number;
  provisional: boolean;
  interval: [number, number];
  attempts: number;
  solved: number;
  best: number | null;
}

export interface PuzzleProgress {
  overall: ThemeRating;
  themes: ThemeRating[];
  attempts: number;
  solved: number;
  by_source: { lichess: number; own: number };
  history: {
    at: string;
    solved: boolean;
    puzzle_rating: number | null;
    rating: number | null;
    source: string;
  }[];
}

export interface PuzzleStats {
  total: number;
  solved: number;
  attempted: number;
  blunders: number;
  rated: number;
  maia_rated: number;
  unsolved: number;
  by_kind: Record<PuzzleKind, number>;
  multi_move: number;
  progress: PuzzleProgress;
  lichess?: LichessImportStatus;
}

export interface LichessImportStatus {
  available?: boolean;
  puzzles: number;
  imported_at?: string | null;
  source?: string | null;
  min_rating?: number;
  max_rating?: number;
  /** Present only while an import is going; see `LichessImportPanel`. */
  running?: LichessImportProgress;
  last_run?: LichessImportProgress;
  [key: string]: unknown;
}

export interface LichessImportProgress {
  state: string;
  rows_read: number;
  rows_kept: number;
  bytes_read: number;
  total_bytes: number | null;
  message: string | null;
  elapsed_s: number;
  finished: boolean;
}

export interface ThemeEntry {
  key: string;
  label: string;
  description: string;
  derivable: boolean;
  count: number;
  progress: ThemeRating | null;
}

export interface ThemeGroup {
  key: string;
  label: string;
  themes: ThemeEntry[];
}

/** One move of a revealed or completed answer. */
export interface LineMove {
  uci: string;
  san: string;
  yours: boolean;
}

/** What the server says about a move you tried. `done` is the one that
 *  matters: a correct move in a multi-move line is not the end of it. */
export interface PuzzleVerdict {
  correct: boolean;
  done: boolean;
  equal_move?: boolean;
  attempt?: { uci: string; san: string | null; cp?: number | null };
  expected?: { uci: string; san: string | null };
  best?: { uci: string; san: string | null; cp?: number | null };
  reply?: { uci: string; san: string };
  fen?: string;
  line?: LineMove[];
  played?: { uci: string | null; san: string | null };
  given_up?: number | null;
  same_as_played?: boolean;
  moves_played?: number;
  moves_required?: number;
  themes?: string[];
  game_url?: string | null;
  rating: PuzzleRatingResult | null;
  progress: PuzzleProgress;
}
