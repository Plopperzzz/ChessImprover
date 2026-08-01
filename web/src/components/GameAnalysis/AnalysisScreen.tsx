import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  FlipVertical2,
  Search,
  Settings2,
} from 'lucide-react';
import * as api from '../../lib/api';
import { formatEval, parsePgn, winProb, yourSide, type Ply } from '../../lib/chess';
import {
  ROOT_ID,
  addMove,
  buildTree,
  childFor,
  emptyTree,
  lineTo,
  removeVariation,
  type MoveTree,
} from '../../lib/moveTree';
import { playMoveSound, playSound } from '../../lib/sound';
import { useAnalysisJob, type JobResult } from '../../lib/useAnalysisJob';
import { useLiveEval } from '../../lib/useLiveEval';
import type {
  AnalysisMove,
  Collection,
  EngineSettings,
  GameDetail,
  GameSummary,
  Run,
  SweepResults,
  User,
} from '../../types';
import { Chess } from 'chess.js';
import { Board } from '../Board';
import { EloSweepPanel } from './EloSweepPanel';
import { EvalChart } from './EvalChart';
import { GameLibraryPanel } from './GameLibraryPanel';
import { MoveList } from './MoveList';

interface AnalysisScreenProps {
  user: User;
  settings: EngineSettings | null;
  /** Per-screen board/piece/sound choices (A7); null until they load, or if
   *  the request failed, in which case the account defaults are used. */
  prefs: api.ScreenPrefs | null;
  onOpenSettings: () => void;
}

export function AnalysisScreen({ user, settings, prefs, onOpenSettings }: AnalysisScreenProps) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [facets, setFacets] = useState<api.Facets | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [filter, setFilter] = useState<api.GameFilter>({});
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);

  const [game, setGame] = useState<GameDetail | null>(null);
  const [plies, setPlies] = useState<Ply[]>([]);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [flipped, setFlipped] = useState(false);

  // B3: the game is a tree, not a list, so a move that isn't the one played
  // has somewhere to go. `nodeId` is where the board stands in it.
  const [tree, setTree] = useState<MoveTree>(() => emptyTree());
  const [nodeId, setNodeId] = useState<string>(ROOT_ID);
  const [variationError, setVariationError] = useState<string | null>(null);

  const [moves, setMoves] = useState<Map<number, AnalysisMove>>(new Map());
  const [sweep, setSweep] = useState<SweepResults | null>(null);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [savedMode, setSavedMode] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<Record<number, number>>({});

  const [liveActive, setLiveActive] = useState(false);
  const gameRef = useRef<GameDetail | null>(null);
  gameRef.current = game;

  // --- library ------------------------------------------------------------

  const reloadLibrary = useCallback(() => {
    setGamesLoading(true);
    api
      .listGames(filter)
      .then(setGames)
      .catch(() => setGames([]))
      .finally(() => setGamesLoading(false));
    api.gameFacets().then(setFacets).catch(() => setFacets(null));
  }, [filter]);

  useEffect(reloadLibrary, [reloadLibrary]);

  const reloadRuns = useCallback(() => {
    api.listRuns().then(setRuns).catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    reloadRuns();
    api.listCollections().then(setCollections).catch(() => setCollections([]));
  }, [reloadRuns]);

  // --- the selected game --------------------------------------------------

  const applySaved = useCallback((gameId: number) => {
    api
      .savedAnalysis(gameId)
      .then((saved) => {
        setMoves(new Map(saved.moves.map((m) => [m.ply, m])));
        setSweep(saved.results);
        setModelNote(saved.model_note);
        setSavedMode(saved.mode);
        const side = yourSide(gameRef.current?.your_color);
        const you = side ? saved.results?.[side] : undefined;
        if (you?.estimate != null) {
          setEstimates((prev) => ({ ...prev, [gameId]: you.estimate as number }));
        }
      })
      .catch(() => {
        // 404 is the normal case for a game nobody has analysed yet.
        setMoves(new Map());
        setSweep(null);
        setModelNote(null);
        setSavedMode(null);
      });
  }, []);

  const selectGame = useCallback(
    async (summary: GameSummary) => {
      try {
        const detail = await api.getGame(summary.id);
        setGame(detail);
        gameRef.current = detail;
        const parsed = parsePgn(detail.pgn_text);
        setPlies(parsed.plies);
        setHeaders(parsed.headers);
        // The saved variations come back with the game and are replayed onto
        // the mainline; a game with none is just a tree with one branch.
        const saved = await api.listVariations(detail.id).catch(() => []);
        setTree(buildTree(parsed.plies, saved));
        setNodeId(ROOT_ID);
        setVariationError(null);
        setFlipped(yourSide(detail.your_color) === 'b');
        setMoves(new Map());
        setSweep(null);
        setModelNote(null);
        setSavedMode(null);
        applySaved(detail.id);
      } catch {
        setGame(null);
        setPlies([]);
      }
    },
    [applySaved],
  );

  // Open the first game as soon as there is one, so the screen is never empty.
  useEffect(() => {
    if (!game && games.length > 0) void selectGame(games[0]);
  }, [games, game, selectGame]);

  // --- the analysis job ---------------------------------------------------

  const handleDone = useCallback((result: JobResult) => {
    if (result.moves) setMoves(new Map(result.moves.map((m) => [m.ply, m])));
    if (result.results) {
      setSweep(result.results);
      const current = gameRef.current;
      const side = yourSide(current?.your_color);
      const you = side ? result.results[side] : undefined;
      if (current && you?.estimate != null) {
        setEstimates((prev) => ({ ...prev, [current.id]: you.estimate as number }));
      }
    }
    setModelNote(result.modelNote ?? null);
    setSavedMode(null);
    // The library marks which games have a saved analysis; this one just did.
    api.listGames(filter).then(setGames).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const job = useAnalysisJob(handleDone);

  // A job started before this page was loaded is still running on the server.
  useEffect(() => {
    api
      .activeJobs()
      .then((active) => {
        const mine = active.find((j) => j.kind !== 'batch' && j.game_id === gameRef.current?.id);
        if (mine) job.attach(mine);
      })
      .catch(() => undefined);
    // Only on mount: re-attaching on every game switch would hijack the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a job runs, the board follows the position the engine is looking at.
  const jobFen = job.state.running ? job.state.fen : null;

  // --- board state --------------------------------------------------------

  const node = tree.nodes[nodeId] ?? tree.nodes[ROOT_ID];
  const boardFen = jobFen ?? node.fen;
  /** Classifications belong to the game as played, so a variation move has
   *  none — nothing analysed it. */
  const currentPly = node.mainline && node.ply > 0 ? plies[node.ply - 1] : null;
  const currentMove = currentPly ? moves.get(currentPly.ply) : undefined;
  const plyIndex = node.mainline ? node.ply : 0;

  const liveMultiPv = Math.max(1, Math.min(5, Number(settings?.maia_multipv ?? 3)));
  const live = useLiveEval(liveActive && !job.state.running, boardFen, liveMultiPv);

  // The bar prefers the live engine while it's on, and falls back to the
  // stored analysis so a finished game still shows a shape when it's off.
  const liveCp = live.lines[0]?.cp ?? null;
  const storedCp = currentMove
    ? currentPly?.color === 'w'
      ? -currentMove.cp_after
      : currentMove.cp_after
    : null;
  const barCp = liveActive && liveCp != null ? liveCp : storedCp;
  const barPercent = barCp == null ? 50 : Math.round(winProb(barCp) * 100);

  const whiteName = game?.white ?? headers.White ?? 'White';
  const blackName = game?.black ?? headers.Black ?? 'Black';
  const whiteElo = headers.WhiteElo;
  const blackElo = headers.BlackElo;

  const topName = flipped ? whiteName : blackName;
  const topElo = flipped ? whiteElo : blackElo;
  const bottomName = flipped ? blackName : whiteName;
  const bottomElo = flipped ? blackElo : whiteElo;

  const engineReady = Boolean(settings?.stockfish_binary);
  const maiaReady = Boolean(settings?.maia_binary);

  /** Stepping follows the line you are on: `children[0]` is the move that
   *  continues it, so walking forward never wanders into a variation by
   *  accident. Same rule the classic UI's tree keeps. */
  const stepForward = useCallback(() => {
    setNodeId((id) => tree.nodes[id]?.children[0] ?? id);
  }, [tree]);

  const stepBack = useCallback(() => {
    setNodeId((id) => tree.nodes[id]?.parentId ?? id);
  }, [tree]);

  const toMainlineEnd = useCallback(() => {
    setNodeId(tree.mainlineIds[tree.mainlineIds.length - 1] ?? ROOT_ID);
  }, [tree]);

  const keyNav = useCallback(
    (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      }
      if (event.key === 'ArrowLeft') stepBack();
      if (event.key === 'ArrowRight') stepForward();
      if (event.key === 'Home') setNodeId(ROOT_ID);
      if (event.key === 'End') toMainlineEnd();
    },
    [stepBack, stepForward, toMainlineEnd],
  );

  useEffect(() => {
    window.addEventListener('keydown', keyNav);
    return () => window.removeEventListener('keydown', keyNav);
  }, [keyNav]);


  const you = yourSide(game?.your_color);
  // Which colour sits on which edge of the board, given the flip.
  const topSide: 'w' | 'b' = flipped ? 'w' : 'b';

  // A7: this screen's own board, pieces and sounds, falling back to the
  // account defaults while the preferences are still in flight.
  const screen = prefs?.effective.analysis;
  const boardSet = screen?.board_set ?? user.board_set;
  const pieceSet = screen?.piece_set ?? user.piece_set;
  const soundSet = screen?.sound_set ?? user.sound_set;

  // B9/B10: the move you land on, out loud. Only ever for a move *you* moved
  // to -- never while a job is running, which walks the whole game a position
  // at a time and would make a hundred noises. Stepping back to the start has
  // no move to sound, which is why index 0 is silent rather than special.
  const soundedNode = useRef<string | null>(null);
  useEffect(() => {
    if (job.state.running) {
      soundedNode.current = nodeId;
      return;
    }
    if (soundedNode.current === nodeId) return;
    soundedNode.current = nodeId;
    const landed = tree.nodes[nodeId];
    if (!landed || landed.id === ROOT_ID) return;
    const quality = landed.mainline ? moves.get(landed.ply)?.classification : undefined;
    if (quality === 'brilliant') playSound(soundSet, 'brilliant');
    else playMoveSound(soundSet, landed.san, you != null && landed.color === you);
  }, [nodeId, tree, moves, job.state.running, soundSet, you]);

  /** Where a ply on the mainline lives in the tree, for the eval chart. */
  const goToPly = useCallback(
    (ply: number) => setNodeId(ply <= 0 ? ROOT_ID : (tree.mainlineIds[ply - 1] ?? ROOT_ID)),
    [tree],
  );

  /**
   * A move played on the board (B3).
   *
   * Replaying a move that is already there — the game's own next move, or a
   * line made earlier — navigates to it. Anything else branches, and the
   * branch is written to the server straight away: a variation you have to
   * remember to save is a variation you lose.
   *
   * Which write depends on where you are. At the tip of a saved line the move
   * extends that line (one row, rewritten); anywhere else it starts a new one,
   * hanging off the mainline or off the line you are standing in.
   */
  const playMove = useCallback(
    async (from: string, to: string, promotion?: string) => {
      if (!game || job.state.running) return;
      const parent = tree.nodes[nodeId];
      if (!parent) return;

      const existing = childFor(tree, nodeId, from, to);
      if (existing) {
        setNodeId(existing.id);
        return;
      }

      const board = new Chess();
      try {
        board.load(parent.fen);
      } catch {
        return;
      }
      let move;
      try {
        move = board.move({ from, to, promotion: promotion ?? 'q' });
      } catch {
        return;
      }
      if (!move) return;

      const line = lineTo(tree, nodeId);
      const atTipOfSavedLine =
        parent.variationId != null &&
        line.length > 0 &&
        parent.children.length === 0 &&
        parent.indexInLine === line.length - 1;

      // On screen first, saved second: the board should answer the move now,
      // and a failed write is reported rather than swallowed.
      const grown = addMove(
        tree,
        nodeId,
        { san: move.san, from: move.from, to: move.to, promotion: move.promotion, color: move.color },
        board.fen(),
        {
          variationId: atTipOfSavedLine ? parent.variationId : null,
          indexInLine: atTipOfSavedLine ? line.length : 0,
        },
      );
      setTree(grown.tree);
      setNodeId(grown.node.id);
      setVariationError(null);

      try {
        if (atTipOfSavedLine && parent.variationId != null) {
          await api.updateVariation(parent.variationId, {
            moves: [...line.map((n) => n.san), move.san],
          });
        } else {
          const saved = await api.createVariation(game.id, {
            parent_id: parent.variationId,
            // Off the mainline the branch point is the ply; inside a line it
            // is how far along that line you are.
            start_ply: parent.variationId == null ? parent.ply : parent.indexInLine + 1,
            moves: [move.san],
          });
          // Re-read rather than patching ids by hand: the tree the server
          // describes is the one that will come back next time.
          const fresh = await api.listVariations(game.id);
          const rebuilt = buildTree(plies, fresh);
          const landed = Object.values(rebuilt.nodes).find(
            (n) => n.variationId === saved.id && n.indexInLine === 0,
          );
          setTree(rebuilt);
          if (landed) setNodeId(landed.id);
        }
      } catch (e) {
        setVariationError(
          `The move is on the board but wasn't saved: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },
    [game, job.state.running, tree, nodeId, plies],
  );

  const dropVariation = useCallback(
    async (variationId: number) => {
      const after = removeVariation(tree, variationId, nodeId);
      setTree(after.tree);
      setNodeId(after.nextId);
      try {
        await api.deleteVariation(variationId);
      } catch (e) {
        setVariationError(e instanceof Error ? e.message : String(e));
        if (game) {
          // Put back whatever the server actually still has.
          const fresh = await api.listVariations(game.id).catch(() => []);
          setTree(buildTree(plies, fresh));
        }
      }
    },
    [tree, nodeId, game, plies],
  );

  const plate = (name: string, elo: string | undefined, edge: 'top' | 'bottom') => (
    <div className="flex items-center gap-2 px-1 py-2">
      <span className="text-sm font-semibold text-fg">{name}</span>
      {elo && <span className="font-mono text-xs text-fg-muted">({elo})</span>}
      {you && you === (edge === 'top' ? topSide : topSide === 'w' ? 'b' : 'w') && (
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/20">
          you
        </span>
      )}
    </div>
  );

  const missingEngine = !engineReady || !maiaReady;

  return (
    <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {missingEngine && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-xs text-fg">
            <span>
              {!engineReady && !maiaReady
                ? 'No Stockfish or Maia engine is selected.'
                : !engineReady
                  ? 'No Stockfish engine is selected — analysis will fail.'
                  : 'No Maia engine is selected — the Elo sweep will fail.'}
            </span>
            <button
              onClick={onOpenSettings}
              className="rounded-lg bg-accent-strong px-2.5 py-1 font-semibold text-on-accent hover:bg-accent"
            >
              Choose engines
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
          <div className="flex flex-col xl:col-span-6">
            <div className="flex items-center justify-between gap-2 pb-1">
              {plate(topName, topElo, 'top')}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setLiveActive((v) => !v)}
                  disabled={!engineReady || job.state.running}
                  title={
                    job.state.running
                      ? 'Paused while an analysis job is running'
                      : 'Live engine analysis of the position on the board'
                  }
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 ${
                    liveActive
                      ? 'bg-accent-strong text-on-accent ring-2 ring-accent/50'
                      : 'border border-line bg-surface text-fg-2 hover:bg-surface-2'
                  }`}
                >
                  <Search className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Analyse</span>
                </button>
                <button
                  onClick={() => setFlipped((v) => !v)}
                  title="Flip the board"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 hover:bg-surface-2"
                >
                  <FlipVertical2 className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={onOpenSettings}
                  title="Board and engine settings"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 hover:bg-surface-2"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-stretch gap-2">
              <div className="flex w-5 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-canvas">
                <div className="py-1 text-center font-mono text-[9px] font-bold text-fg-muted">
                  {formatEval(barCp)}
                </div>
                {/* White-vs-black by definition, so the bar uses its own two
                    tokens rather than the surface ones — otherwise the dark
                    half disappears into a light theme's panel. B2 restyles it. */}
                <div className="relative flex flex-1 flex-col justify-end bg-eval-black">
                  <div
                    className="w-full bg-eval-white transition-[height] duration-300"
                    style={{ height: `${flipped ? 100 - barPercent : barPercent}%` }}
                  />
                </div>
              </div>

              <div className="min-w-0 flex-1">
                <Board
                  fen={boardFen}
                  flipped={flipped}
                  boardSet={boardSet}
                  pieceSet={pieceSet}
                  showLegalMoves={Boolean(user.show_legal_moves)}
                  lastMove={
                    jobFen || node.id === ROOT_ID ? null : { from: node.from, to: node.to }
                  }
                  marker={
                    jobFen || node.id === ROOT_ID
                      ? null
                      : { square: node.to, quality: currentMove?.classification }
                  }
                  hintMove={liveActive ? (live.lines[0]?.pv[0] ?? null) : null}
                  // B3-B5: the board plays moves now. Not while a job is
                  // driving it, which would be arguing with the engine over
                  // whose position is on screen.
                  interactive={!job.state.running}
                  onMove={playMove}
                />
              </div>
            </div>

            {plate(bottomName, bottomElo, 'bottom')}

            {/* B11: these lived at the bottom of the move list, a column away
                from the board they move. The keyboard bindings above (arrows,
                Home/End) do the same thing and still work. */}
            <div className="flex items-center justify-center gap-1.5">
              {[
                { icon: <ChevronFirst className="h-4 w-4" />, go: () => setNodeId(ROOT_ID), label: 'Start' },
                { icon: <ChevronLeft className="h-4 w-4" />, go: stepBack, label: 'Previous' },
                { icon: <ChevronRight className="h-4 w-4" />, go: stepForward, label: 'Next' },
                { icon: <ChevronLast className="h-4 w-4" />, go: toMainlineEnd, label: 'End' },
              ].map((btn) => (
                <button
                  key={btn.label}
                  title={btn.label}
                  aria-label={btn.label}
                  disabled={plies.length === 0}
                  onClick={btn.go}
                  className="flex h-9 w-11 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                >
                  {btn.icon}
                </button>
              ))}
            </div>

            {variationError && (
              <p className="rounded-lg bg-danger-surface px-3 py-2 text-center text-[11px] text-danger-fg">
                {variationError}
              </p>
            )}

            {jobFen && (
              <p className="text-center font-mono text-[11px] text-fg-subtle">
                following the engine…
              </p>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-6 xl:col-span-6">
            <EvalChart
              plies={plies}
              moves={moves}
              currentPlyIndex={plyIndex}
              onSelectPly={goToPly}
              liveActive={liveActive && !job.state.running}
              engineLines={live.lines}
              linesStale={live.stale}
              liveError={live.error}
            />

            <MoveList
              plies={plies}
              moves={moves}
              tree={tree}
              currentNodeId={nodeId}
              onSelectNode={setNodeId}
              onDeleteVariation={dropVariation}
              white={whiteName}
              black={blackName}
              job={job.state}
              disabled={!game}
              savedMode={savedMode}
              onRunFull={() => game && job.start('full', game.id, runId)}
              onRunQuick={() => game && job.start('quick', game.id, runId)}
              onCancel={() => void job.cancel()}
            />

            <EloSweepPanel
              results={sweep}
              modelNote={modelNote}
              yourColor={yourSide(game?.your_color)}
              whiteName={whiteName}
              blackName={blackName}
            />
          </div>
        </div>
      </div>

      <GameLibraryPanel
        games={games}
        loading={gamesLoading}
        activeGameId={game?.id ?? null}
        onSelectGame={selectGame}
        facets={facets}
        collections={collections}
        filter={filter}
        onChangeFilter={setFilter}
        runs={runs}
        runId={runId}
        onChangeRun={setRunId}
        onRunsChanged={reloadRuns}
        onLibraryChanged={reloadLibrary}
        estimates={estimates}
        collapsed={libraryCollapsed}
        onToggleCollapsed={() => setLibraryCollapsed((v) => !v)}
        user={user}
      />
    </main>
  );
}
