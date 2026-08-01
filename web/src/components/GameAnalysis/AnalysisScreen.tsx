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
  /** Take the top bar away (D12). Answers whether it applies at this width,
   *  which is also the answer to "is this the stacked layout?". */
  onHideHeader: () => boolean;
}

export function AnalysisScreen({
  user,
  settings,
  prefs,
  onOpenSettings,
  onHideHeader,
}: AnalysisScreenProps) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [facets, setFacets] = useState<api.Facets | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<number | null>(null);
  const [filter, setFilter] = useState<api.GameFilter>({});
  // Open beside the board is the desktop default it has always been; on a
  // phone the panel is a full-screen sheet, and opening on top of the board
  // would hide the thing the screen is for.
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => window.innerWidth < 1024);

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

  /**
   * Put focus back where the game is (B11 follow-up).
   *
   * Every control that moves the board — the four step buttons, a move in the
   * list, a click on the eval plot — is a button, and a clicked button keeps
   * focus. That left the board looking at a control instead of at itself: the
   * next Space or Enter re-fired whatever was last pressed, and on a phone the
   * browser scrolled to the focused button rather than to the position that
   * had just changed. `preventScroll` because the point is *not* to move the
   * page; the board is already where the reader is looking.
   */
  const boardRef = useRef<HTMLDivElement>(null);
  const focusBoard = useCallback(() => {
    boardRef.current?.focus({ preventScroll: true });
  }, []);

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

  const evalCardRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  /**
   * Whether the reader has moved the page since the game was last put in
   * place. This is what decides whether a step button is allowed to move
   * anything (D12a).
   *
   * Set by scrolling, cleared by the realign below — which has to not count
   * its own scroll, and a smooth one goes on firing events for a few hundred
   * milliseconds after the call that started it. So the realign says where it
   * is going: events are its own until the scroller lands there, and a second
   * is the longest that can be true for, in case it never quite arrives
   * (a target past the end of the content, or a reader who grabs the page
   * mid-animation).
   */
  const hasScrolled = useRef(false);
  const ourScroll = useRef<{ top: number; until: number } | null>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const ours = ourScroll.current;
      if (ours && Date.now() <= ours.until) {
        // Landed: everything after this is the reader again. Short of the
        // target it is still the animation, and neither counts as scrolling.
        if (Math.abs(scroller.scrollTop - ours.top) <= 2) ourScroll.current = null;
        return;
      }
      // A claim that outlived its window was never collected — the scroll it
      // expected never happened. This one is the reader's.
      ourScroll.current = null;
      hasScrolled.current = true;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * Stepping through a game, on a phone (D12).
   *
   * Pressing a step button says what you are doing: reading the game, not the
   * page around it. So the top bar goes, and the column scrolls until the eval
   * card is against the top — which, at the sizes D11 and D13 fixed, puts the
   * evaluation, the engine's lines, the board and these buttons on screen
   * together and nothing else.
   *
   * **Only if the page has drifted since it was last put there** (D12a).
   * Pressing Next should move the pieces, not the page: doing this on a view
   * that is already in place is a jump for nothing, which is what it felt
   * like. So a step realigns exactly once after each time the reader scrolls,
   * and every press after that leaves the screen alone.
   *
   * And only where the header hides at all, which is the stacked layout; on a
   * desktop everything is already on screen and there would be no scroll left
   * to bring the header back with.
   */
  const showTheGame = useCallback(() => {
    if (!hasScrolled.current) return;
    if (!onHideHeader()) return;
    const scroller = scrollerRef.current;
    const card = evalCardRef.current;
    if (!scroller || !card) return;
    hasScrolled.current = false;
    // Measured against the scroller rather than the page: the header's own
    // margin is mid-animation, and both boxes move with it together.
    const offset = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const target = Math.abs(offset) > 4 ? scroller.scrollTop + offset : scroller.scrollTop;
    const moving = target !== scroller.scrollTop;
    // Claimed even when the target is where we already are: taking the header
    // away can shorten the scroll range enough to clamp the position, and that
    // is this scroll's doing too. Only for a moment in that case, though —
    // there is no animation to wait out, and the claim must not sit there
    // swallowing the reader's next scroll.
    ourScroll.current = { top: target, until: Date.now() + (moving ? 1000 : 120) };
    if (moving) scroller.scrollTo({ top: target, behavior: 'smooth' });
  }, [onHideHeader]);

  /** A step taken by pressing something, as against by the keyboard: the same
   *  move, then focus back on the board and the game filling the screen. */
  const step = useCallback(
    (go: () => void) => () => {
      go();
      focusBoard();
      showTheGame();
    },
    [focusBoard, showTheGame],
  );

  const selectNode = useCallback(
    (id: string) => {
      setNodeId(id);
      focusBoard();
    },
    [focusBoard],
  );

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
    (ply: number) => selectNode(ply <= 0 ? ROOT_ID : (tree.mainlineIds[ply - 1] ?? ROOT_ID)),
    [tree, selectNode],
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
        selectNode(existing.id);
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
      selectNode(grown.node.id);
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
    [game, job.state.running, tree, nodeId, plies, selectNode],
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
      <div ref={scrollerRef} className="thin-scroll min-w-0 flex-1 overflow-y-auto p-3 sm:p-6">
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

        {/* Two columns from `xl`, one below it. The single column is not just
            the two stacked: the eval plot comes *first* there, above the board
            (D10), which is why the second column is `display: contents` on a
            narrow screen — its children become items of this flex column and
            can be ordered individually, instead of the whole column having to
            move as one block. */}
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 xl:flex-row xl:items-start">
          <div
            className="order-2 flex w-full min-w-0 flex-col xl:order-none xl:flex-1"
            style={{
              // The board is square, so its width is also its height. On an
              // ultrawide monitor half the page is far taller than the screen,
              // and the board has to be bounded by the *short* side of the
              // viewport instead: 15rem is what the plates above and below it
              // and the step buttons under those take. `min()` keeps this from
              // ever widening the column on a phone, where 100svh is the long
              // side and the width is what binds.
              maxWidth: 'min(100%, calc(100svh - 15rem))',
            }}
          >
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
              {/* No bar on a phone: it is 20px of a screen the board wants all
                  of, and the number it draws is the same number the engine
                  lines above the board already print (D6). */}
              <div className="hidden w-5 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-canvas lg:flex">
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

              {/* Focusable, so there is somewhere for focus to *be* that isn't
                  a button that moves the board. Never tabbed to: -1 keeps it
                  out of the tab order while still accepting `focus()`. */}
              <div ref={boardRef} tabIndex={-1} className="min-w-0 flex-1 outline-none">
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
                  // Never while the lines are stale. They are deliberately kept
                  // up between positions (B13), and pointing at the previous
                  // position's best move on this one is worse than pointing at
                  // nothing: it is a suggestion that isn't for the board.
                  hintMove={liveActive && !live.stale ? (live.lines[0]?.pv[0] ?? null) : null}
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
                  onClick={step(btn.go)}
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

          <div className="contents xl:flex xl:min-w-0 xl:flex-1 xl:flex-col xl:gap-6">
            <div ref={evalCardRef} className="order-1 min-w-0 xl:order-none">
              <EvalChart
                plies={plies}
                moves={moves}
                currentPlyIndex={plyIndex}
                onSelectPly={goToPly}
                liveActive={liveActive && !job.state.running}
                engineLines={live.lines}
                linesStale={live.stale}
                liveError={live.error}
                // The same number the bar beside the board draws, so the two
                // shapes of this card can't disagree with it (D13).
                evalCp={barCp}
                flipped={flipped}
              />
            </div>

            <div className="order-3 min-w-0 xl:order-none">
              <MoveList
                plies={plies}
                moves={moves}
                tree={tree}
                currentNodeId={nodeId}
                onSelectNode={selectNode}
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
            </div>

            <div className="order-4 min-w-0 xl:order-none">
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
