import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronFirst,
  ChevronLeft,
  ChevronRight,
  Eye,
  FlipVertical2,
  Ghost,
  Lightbulb,
  RefreshCw,
  Search,
  SkipForward,
} from 'lucide-react';
import { Chess } from 'chess.js';
import * as api from '../../lib/api';
import { formatEval, winProb } from '../../lib/chess';
import { ROOT_ID, addMove, childFor, emptyTree, type MoveTree } from '../../lib/moveTree';
import { playMoveSound, playSound } from '../../lib/sound';
import { useLiveEval } from '../../lib/useLiveEval';
import type {
  EngineSettings,
  LineMove,
  Puzzle,
  PuzzleKind,
  PuzzleProgress,
  PuzzleRatingResult,
  PuzzleSource,
  PuzzleStats,
  PuzzleVerdict,
  User,
} from '../../types';
import { Board } from '../Board';
import { EngineLines } from '../GameAnalysis/EvalChart';
import { PuzzlePanel } from './PuzzlePanel';
import { PuzzleRating } from './PuzzleRating';

const SOURCE_KEY = 'engine-room:puzzle-source';
const KINDS_KEY = 'engine-room:puzzle-kinds';
const themesKey = (source: PuzzleSource) => `engine-room:puzzle-themes:${source}`;
const BLINDFOLD_KEY = 'engine-room:puzzle-blindfold';
const BLINDFOLD_PLY_KEY = 'engine-room:puzzle-blindfold-ply';

/** How long the board sits on a wrong move before going back, so you see what
 *  you played rather than having it snatched away. */
const WRONG_MOVE_MS = 650;

/** How many plies back a blindfold session opens by default -- enough game
 *  to actually have to hold in your head, not so much that setting it up
 *  once means never seeing a puzzle again. */
const DEFAULT_BLINDFOLD_PLY = 10;

interface PuzzleScreenProps {
  user: User;
  settings: EngineSettings | null;
  prefs: api.ScreenPrefs | null;
  onOpenSettings: () => void;
}

/** What the board is doing. `setup` is the opponent's move being played in;
 *  `solving` accepts your moves; `over` has the answer; `explore` has handed
 *  the position to you to play with. */
type Phase = 'loading' | 'setup' | 'solving' | 'over' | 'explore';

function readList<T extends string>(key: string, allowed: readonly T[]): T[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is T => allowed.includes(v as T));
  } catch {
    return [];
  }
}

export function PuzzleScreen({ user, settings, prefs, onOpenSettings }: PuzzleScreenProps) {
  const [source, setSource] = useState<PuzzleSource>(
    () => (localStorage.getItem(SOURCE_KEY) as PuzzleSource) || 'own',
  );
  const [kinds, setKinds] = useState<PuzzleKind[]>(() => {
    const stored = readList<PuzzleKind>(KINDS_KEY, ['tactic', 'blunder_check']);
    return stored.length ? stored : ['tactic', 'blunder_check'];
  });
  // Kept per source: the two vocabularies barely overlap, and 'fork' is worth
  // picking against a hundred thousand Lichess puzzles and pointless against
  // the nine in your own.
  const [themes, setThemes] = useState<string[]>(() => readList(themesKey('own'), []));

  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<PuzzleStats | null>(null);
  const [progress, setProgress] = useState<PuzzleProgress | null>(null);
  const [ratingChange, setRatingChange] = useState<PuzzleRatingResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Open beside the board is the desktop default; on a phone the panel is a
  // full-screen sheet and opening on top of the puzzle would hide the thing
  // the screen is for. Same rule as the game library.
  const [panelCollapsed, setPanelCollapsed] = useState(() => window.innerWidth < 1024);

  /** The moves you have played at this puzzle, for the server to re-check. */
  const [played, setPlayed] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<PuzzleVerdict | null>(null);
  const [answer, setAnswer] = useState<LineMove[] | null>(null);
  const [busy, setBusy] = useState(false);

  // A hint names the square to move from and nothing else -- see the `Hint`
  // button below. Once one has been asked for, every grading call for this
  // puzzle says so, which is what keeps the eventual result off the rating.
  const [hintUsed, setHintUsed] = useState(false);
  const [hintSquare, setHintSquare] = useState<string | null>(null);

  // Blindfold: the board a puzzle came from, played a configurable number of
  // plies before it. `blindfoldContext` is the frozen starting position plus
  // the real moves that lead from there to the puzzle -- fetched for
  // whichever puzzle is on screen. Works for both sources: an own-game
  // puzzle replays its stored PGN, a Lichess one fetches the game live off
  // lichess.org (and caches it server-side), which is the one way this can
  // fail -- no game_url on the row, or lichess.org not answering -- so
  // `blindfoldError` is what that failure becomes on screen.
  const [blindfoldEnabled, setBlindfoldEnabled] = useState(
    () => localStorage.getItem(BLINDFOLD_KEY) === '1',
  );
  const [blindfoldPly, setBlindfoldPly] = useState(() => {
    const stored = Number(localStorage.getItem(BLINDFOLD_PLY_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_BLINDFOLD_PLY;
  });
  const [blindfoldContext, setBlindfoldContext] = useState<{
    fen: string;
    moves: string[];
  } | null>(null);
  const [blindfoldError, setBlindfoldError] = useState<string | null>(null);

  const [flipped, setFlipped] = useState(false);
  const [liveActive, setLiveActive] = useState(false);

  // The board's own position. During solving this is the puzzle's line so far;
  // in explore mode it is a node in a tree you are building.
  const [fen, setFen] = useState<string>(new Chess().fen());
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [tree, setTree] = useState<MoveTree>(() => emptyTree());
  const [nodeId, setNodeId] = useState<string>(ROOT_ID);

  const screen = prefs?.effective.puzzles;
  const boardSet = screen?.board_set ?? user.board_set;
  const pieceSet = screen?.piece_set ?? user.piece_set;
  const soundSet = screen?.sound_set ?? user.sound_set;

  const engineReady = Boolean(settings?.stockfish_binary);
  const liveMultiPv = Math.max(1, Math.min(5, Number(settings?.maia_multipv ?? 3)));
  const live = useLiveEval(liveActive && phase === 'explore', fen, liveMultiPv);

  // Solving with an engine on would be showing you the answer, so it is only
  // offered once the puzzle is over.
  useEffect(() => {
    if (phase !== 'explore' && liveActive) setLiveActive(false);
  }, [phase, liveActive]);

  useEffect(() => localStorage.setItem(SOURCE_KEY, source), [source]);
  useEffect(() => localStorage.setItem(KINDS_KEY, JSON.stringify(kinds)), [kinds]);
  useEffect(
    () => localStorage.setItem(themesKey(source), JSON.stringify(themes)),
    [source, themes],
  );
  useEffect(
    () => localStorage.setItem(BLINDFOLD_KEY, blindfoldEnabled ? '1' : '0'),
    [blindfoldEnabled],
  );
  useEffect(
    () => localStorage.setItem(BLINDFOLD_PLY_KEY, String(blindfoldPly)),
    [blindfoldPly],
  );

  const refreshStats = useCallback(() => {
    api
      .puzzleStats()
      .then((next) => {
        setStats(next);
        setProgress(next.progress);
      })
      .catch(() => undefined);
  }, []);

  useEffect(refreshStats, [refreshStats]);

  // --- loading a puzzle ----------------------------------------------------

  const previousKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    setVerdict(null);
    setAnswer(null);
    setRatingChange(null);
    setPlayed([]);
    setLiveActive(false);
    setLastMove(null);
    setHintUsed(false);
    setHintSquare(null);
    setBlindfoldContext(null);
    setBlindfoldError(null);
    try {
      const data = await api.nextPuzzle({
        source,
        kinds: source === 'own' ? kinds : undefined,
        themes,
        scope: 'all',
        exclude: previousKey.current,
      });
      const next = data.puzzle;
      previousKey.current = String(next.id);
      setPuzzle(next);
      setProgress(data.progress);
      setFlipped(next.your_color === 'b');

      if (next.setup) {
        // Shown from the position *before* their move, which is then played
        // in: seeing it land is what makes the position read as a moment from
        // a game instead of a diagram, and it is how you know what just moved.
        setPhase('setup');
        setFen(next.setup.fen);
        setLastMove(null);
        const from = next.setup.uci.slice(0, 2);
        const to = next.setup.uci.slice(2, 4);
        window.setTimeout(() => {
          playMoveSound(soundSet, next.setup?.san ?? '', false);
          setFen(next.fen);
          setLastMove({ from, to });
          setPhase('solving');
        }, 550);
      } else {
        setFen(next.fen);
        setPhase('solving');
      }
    } catch (e) {
      // Nothing to solve, so nothing should look solvable. The previous
      // puzzle's position left on the board reads as the next one, which is
      // the version of this that has you staring at a position wondering what
      // the message is about.
      setPuzzle(null);
      setTree(emptyTree());
      setNodeId(ROOT_ID);
      setFen(new Chess().fen());
      setLastMove(null);
      setPhase('over');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [source, kinds, themes, soundSet]);

  // Entering the tab, or changing what you're practising, *is* the request for
  // a puzzle -- there is no "start" button to press because there is nothing
  // else the screen could be for.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, kinds, themes]);

  // Fetched for whichever puzzle is on screen rather than folded into
  // `load()`, so tweaking the ply count or flipping blindfold on mid-puzzle
  // updates the frozen position without discarding what you've already
  // played. Both sources: a Lichess puzzle's game is fetched live and can
  // fail (see `blindfoldError`) in a way an own-game puzzle's stored PGN
  // doesn't.
  useEffect(() => {
    if (!blindfoldEnabled || !puzzle) {
      setBlindfoldContext(null);
      setBlindfoldError(null);
      return;
    }
    let cancelled = false;
    setBlindfoldError(null);
    api
      .puzzleBlindfoldContext(puzzle, blindfoldPly)
      .then((ctx) => {
        if (!cancelled) setBlindfoldContext(ctx);
      })
      .catch((e) => {
        if (cancelled) return;
        setBlindfoldContext(null);
        setBlindfoldError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [puzzle, blindfoldEnabled, blindfoldPly]);

  // A hint answers "which piece" for the position on the board right now --
  // once that position has moved on (your move, their reply), it's stale.
  useEffect(() => setHintSquare(null), [fen]);

  // --- solving -------------------------------------------------------------

  /**
   * Put the answer on the board, as a line you can walk.
   *
   * A puzzle that is over prints its answer in SAN, which tells you the moves
   * and shows you none of them -- for a four-move combination that is the
   * least useful place to stop. The line becomes the mainline of a tree
   * rooted at the puzzle's own position, so the same step buttons the
   * analysis screen uses walk back and forth through it, and playing a
   * different move from anywhere in it branches (that is `explore` below).
   */
  const layOutAnswer = useCallback(
    (startFen: string, line: LineMove[]) => {
      let built = emptyTree(startFen);
      let at = ROOT_ID;
      const board = new Chess();
      try {
        board.load(startFen);
      } catch {
        return;
      }
      for (const step of line) {
        let move;
        try {
          move = board.move({
            from: step.uci.slice(0, 2),
            to: step.uci.slice(2, 4),
            promotion: step.uci.slice(4, 5) || 'q',
          });
        } catch {
          break;
        }
        if (!move) break;
        const grown = addMove(
          built,
          at,
          {
            san: move.san,
            from: move.from,
            to: move.to,
            promotion: move.promotion,
            color: move.color,
          },
          board.fen(),
          { variationId: null, indexInLine: 0 },
        );
        built = grown.tree;
        at = grown.node.id;
      }
      setTree(built);
      setNodeId(at);
      const end = built.nodes[at];
      setFen(end.fen);
      setLastMove(at === ROOT_ID ? null : { from: end.from, to: end.to });
    },
    [],
  );

  const finish = useCallback(
    (result: PuzzleVerdict, solvedPuzzle: Puzzle) => {
      setVerdict(result);
      setProgress(result.progress);
      setRatingChange(result.rating);
      if (result.line) {
        setAnswer(result.line);
        layOutAnswer(solvedPuzzle.fen, result.line);
      }
      setPhase('over');
      playSound(soundSet, result.correct ? 'solved' : 'wrong');
      refreshStats();
      // The motifs are tagged the moment the answer is first worked out, so
      // the theme counts are stale from here until asked again.
      setRefreshKey((k) => k + 1);
      // And measure how hard it was, now that nobody is waiting on it. Best
      // effort: no Maia configured is the normal case, not an error worth
      // putting on screen.
      if (solvedPuzzle.source === 'own' && typeof solvedPuzzle.id === 'number') {
        void api.measureDifficulty(solvedPuzzle.id).catch(() => undefined);
      }
    },
    [soundSet, refreshStats, layOutAnswer],
  );

  const tryMove = useCallback(
    async (from: string, to: string, promotion?: string) => {
      if (!puzzle || phase !== 'solving' || busy) return;
      const board = new Chess();
      try {
        board.load(fen);
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

      const uci = from + to + (promotion ?? (move.promotion ? 'q' : ''));
      setBusy(true);
      setHintSquare(null);
      playMoveSound(soundSet, move.san, true);
      setFen(board.fen());
      setLastMove({ from, to });

      try {
        const result = await api.attemptPuzzle(puzzle, [...played, uci], hintUsed);
        if (!result.correct) {
          setVerdict(result);
          setProgress(result.progress);
          setRatingChange(result.rating);
          playSound(soundSet, 'wrong');
          setPhase('over');
          refreshStats();
          setRefreshKey((k) => k + 1);
          // A beat on the board showing what you played, and then the answer
          // takes its place: seeing the move you chose sit there for a moment
          // is what makes the correction land.
          window.setTimeout(() => {
            if (result.line) {
              setAnswer(result.line);
              layOutAnswer(puzzle.fen, result.line);
            } else {
              setFen(fen);
              setLastMove(null);
            }
          }, WRONG_MOVE_MS);
          return;
        }

        setPlayed((p) => [...p, uci]);

        if (!result.done && result.reply && result.fen) {
          // Right so far. Their answer lands, and the puzzle carries on.
          setVerdict(result);
          window.setTimeout(() => {
            playMoveSound(soundSet, result.reply!.san, false);
            setFen(result.fen!);
            setLastMove({
              from: result.reply!.uci.slice(0, 2),
              to: result.reply!.uci.slice(2, 4),
            });
          }, 320);
          return;
        }

        finish(result, puzzle);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setFen(fen);
      } finally {
        setBusy(false);
      }
    },
    [puzzle, phase, busy, fen, played, hintUsed, soundSet, finish, refreshStats, layOutAnswer],
  );

  const reveal = useCallback(async () => {
    if (!puzzle || phase !== 'solving' || busy) return;
    setBusy(true);
    try {
      const result = await api.revealPuzzle(puzzle, hintUsed);
      setAnswer(result.line ?? null);
      if (result.line) layOutAnswer(puzzle.fen, result.line);
      setVerdict({ ...result, correct: false, done: true });
      setProgress(result.progress);
      setRatingChange(result.rating);
      setPhase('over');
      refreshStats();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [puzzle, phase, busy, hintUsed, refreshStats, layOutAnswer]);

  const useHint = useCallback(async () => {
    if (!puzzle || phase !== 'solving' || busy) return;
    try {
      const result = await api.puzzleHint(puzzle, played);
      setHintUsed(true);
      setHintSquare(result.square);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [puzzle, phase, busy, played]);

  const rescan = useCallback(async () => {
    setBusy(true);
    try {
      await api.rebuildPuzzles();
      refreshStats();
      setRefreshKey((k) => k + 1);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load, refreshStats]);

  // --- playing on from a finished puzzle -----------------------------------

  /**
   * Carrying on from a puzzle (the ask behind this screen's second half).
   *
   * A puzzle is a position from a real game and the interesting question is
   * usually the one after it: what if they had not taken? Rather than a second
   * board, the same one changes hands -- the position on it becomes the root
   * of a tree, and from there this is the analysis screen: play any move, walk
   * back, turn the engine on.
   *
   * Deliberately not saved. A variation on the analysis screen is written to
   * the server because it belongs to a game in your library; a line played off
   * a puzzle belongs to the puzzle, which is a position you will be shown
   * again, and persisting it would mean the answer is on the board next time.
   */
  const explore = useCallback(() => {
    // The tree is already there: it is the answer, laid out by `layOutAnswer`
    // when the puzzle ended. Playing on is a change of what the board accepts,
    // not a new board -- so a move played from anywhere in the answer branches
    // off it rather than starting from nothing.
    if (!tree.nodes[nodeId]) {
      setTree(emptyTree(fen));
      setNodeId(ROOT_ID);
    }
    setPhase('explore');
  }, [tree, nodeId, fen]);

  const playInExplore = useCallback(
    (from: string, to: string, promotion?: string) => {
      const parent = tree.nodes[nodeId];
      if (!parent) return;
      const existing = childFor(tree, nodeId, from, to);
      if (existing) {
        setNodeId(existing.id);
        setFen(existing.fen);
        setLastMove({ from: existing.from, to: existing.to });
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
      const grown = addMove(
        tree,
        nodeId,
        {
          san: move.san,
          from: move.from,
          to: move.to,
          promotion: move.promotion,
          color: move.color,
        },
        board.fen(),
        { variationId: null, indexInLine: 0 },
      );
      setTree(grown.tree);
      setNodeId(grown.node.id);
      setFen(grown.node.fen);
      setLastMove({ from: move.from, to: move.to });
      playMoveSound(soundSet, move.san, true);
    },
    [tree, nodeId, soundSet],
  );

  const goTo = useCallback(
    (id: string) => {
      const node = tree.nodes[id];
      if (!node) return;
      setNodeId(id);
      setFen(node.fen);
      setLastMove(node.id === ROOT_ID ? null : { from: node.from, to: node.to });
    },
    [tree],
  );

  const exploreBack = useCallback(() => {
    const node = tree.nodes[nodeId];
    if (node?.parentId) goTo(node.parentId);
  }, [tree, nodeId, goTo]);

  const exploreForward = useCallback(() => {
    const node = tree.nodes[nodeId];
    const child = node?.children[0];
    if (child) goTo(child);
  }, [tree, nodeId, goTo]);

  // --- what the panel says -------------------------------------------------

  const yourSide = puzzle?.your_color === 'b' ? 'Black' : 'White';
  const solving = phase === 'solving';
  const interactive = solving ? !busy : phase === 'explore';

  const prompt = (() => {
    if (phase === 'loading') return 'Finding one…';
    if (phase === 'setup') return 'Watch the last move…';
    if (!puzzle) return null;
    if (phase === 'explore') return 'Play anything from here.';
    if (solving) {
      if (puzzle.kind === 'blunder_check') {
        return `${yourSide} to play. You threw this position away — find the move that holds it.`;
      }
      if (puzzle.source === 'own') return 'Find the move you should have played.';
      // Not how many moves it takes -- that's exactly the thing withheld
      // until the puzzle is over. See `PuzzleVerdict.moves_required`.
      return `${yourSide} to play and win.`;
    }
    return null;
  })();

  const barCp = liveActive ? (live.lines[0]?.cp ?? null) : null;

  // The board freezes on a position further back than the puzzle while
  // blindfold training is on: `fen` keeps tracking the real, solved-against
  // position throughout (see `tryMove`), and `boardFen` is what's drawn.
  // Board's `logicFen` then reconnects clicks and drags to the real
  // position even though nothing on screen matches it.
  const blindfoldReady = Boolean(blindfoldContext);
  const blindfoldFrozen = blindfoldReady && (phase === 'setup' || phase === 'solving');
  const boardFen = blindfoldFrozen ? blindfoldContext!.fen : fen;
  const boardLogicFen = blindfoldFrozen ? fen : undefined;

  // The puzzle's own rating and length are withheld from `puzzle` itself
  // (see `types.ts`) and arrive on the verdict once there is one -- which is
  // exactly "once the puzzle is over".
  const solvedRating = verdict?.done ? (verdict.puzzle_rating ?? null) : null;
  const solvedRatingSource = verdict?.done ? verdict.puzzle_rating_source : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="thin-scroll min-w-0 flex-1 overflow-y-auto p-3 sm:p-6">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 xl:flex-row xl:items-start">
        {/* The board, sized the way the analysis screen sizes it -- one class,
            so the two can't drift. */}
        <div className="board-column order-2 flex w-full min-w-0 flex-col xl:order-none xl:flex-1">
          <div className="flex items-center justify-between gap-2 pb-1">
            <div className="min-w-0">
              <span className="text-sm font-semibold text-fg">
                {puzzle?.source === 'own'
                  ? (puzzle.your_color === 'w' ? puzzle.black : puzzle.white) || 'Opponent'
                  : 'Lichess'}
              </span>
              {solvedRating != null && (
                <span className="ml-2 font-mono text-xs text-fg-muted">
                  rated {solvedRating}
                  {solvedRatingSource === 'maia' && (
                    <span title="Measured by asking Maia at every Elo on the grid">
                      {' '}
                      · maia
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {phase === 'explore' && (
                <button
                  onClick={() => setLiveActive((v) => !v)}
                  disabled={!engineReady}
                  title="Live engine analysis of the position on the board"
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-40 ${
                    liveActive
                      ? 'bg-accent-strong text-on-accent ring-2 ring-accent/50'
                      : 'border border-line bg-surface text-fg-2 hover:bg-surface-2'
                  }`}
                >
                  <Search className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Analyse</span>
                </button>
              )}
              <button
                onClick={() => setFlipped((v) => !v)}
                title="Flip the board"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 hover:bg-surface-2"
              >
                <FlipVertical2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="board-bleed">
            <Board
              fen={boardFen}
              logicFen={boardLogicFen}
              flipped={flipped}
              boardSet={boardSet}
              pieceSet={pieceSet}
              showLegalMoves={Boolean(user.show_legal_moves)}
              lastMove={blindfoldFrozen ? null : lastMove}
              hintMove={
                // Only ever the engine's move for the position in front of
                // you, and never while there is anything to find.
                phase === 'explore' && liveActive && !live.stale
                  ? (live.lines[0]?.pv[0] ?? null)
                  : null
              }
              hintSquare={solving ? hintSquare : null}
              interactive={interactive}
              onMove={phase === 'explore' ? playInExplore : tryMove}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-sm font-semibold text-fg">
              {puzzle?.source === 'own'
                ? (puzzle.your_color === 'w' ? puzzle.white : puzzle.black) || 'You'
                : yourSide}
            </span>
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/20">
              you
            </span>
          </div>

          {(phase === 'explore' || (phase === 'over' && puzzle)) && (tree.nodes[ROOT_ID]?.children.length ?? 0) > 0 && (
            <div className="flex items-center justify-center gap-1.5 pt-2">
              {[
                { icon: <ChevronFirst className="h-4 w-4" />, go: () => goTo(ROOT_ID), label: 'Back to the start' },
                { icon: <ChevronLeft className="h-4 w-4" />, go: exploreBack, label: 'Previous' },
                { icon: <ChevronRight className="h-4 w-4" />, go: exploreForward, label: 'Next' },
              ].map((btn) => (
                <button
                  key={btn.label}
                  title={btn.label}
                  aria-label={btn.label}
                  onClick={btn.go}
                  className="flex h-9 w-11 items-center justify-center rounded-lg border border-line bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg"
                >
                  {btn.icon}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Everything that isn't the board. */}
        <div className="contents xl:flex xl:min-w-0 xl:flex-1 xl:flex-col xl:gap-4">
          {/* Ordered individually below `xl`, not moved as one block. What
              goes above the board is the sentence telling you what to do; the
              rating and the source switch are things you read between puzzles,
              and a screen that puts them first is a screen where the board
              starts below the fold. */}
          <div className="contents">
            {/* Source: two sources, one trainer. */}
            <div className="order-5 flex flex-col gap-1.5 xl:order-none">
              <div className="flex gap-1.5 rounded-xl border border-line bg-surface p-1.5">
                {(['own', 'lichess'] as PuzzleSource[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      if (s === source) return;
                      setSource(s);
                      setThemes(readList(themesKey(s), []));
                    }}
                    className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      source === s
                        ? 'bg-accent-strong text-on-accent'
                        : 'text-fg-2 hover:bg-surface-2 hover:text-fg'
                    }`}
                  >
                    {s === 'own' ? 'From your games' : 'Lichess database'}
                  </button>
                ))}
              </div>

              {/* Blindfold: from your games, its own stored PGN; from
                  Lichess, a live fetch of the game off lichess.org, so a
                  puzzle with no game on record (or an unreachable Lichess)
                  can fail here in a way an own-game puzzle can't -- see
                  `blindfoldError` below. */}
              <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-1.5">
                <button
                  onClick={() => setBlindfoldEnabled((v) => !v)}
                  title="Play from memory: the board freezes on an earlier position and only your head tracks the rest"
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    blindfoldEnabled
                      ? 'bg-accent-strong text-on-accent'
                      : 'text-fg-2 hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  <Ghost className="h-3.5 w-3.5" />
                  Blindfold
                </button>
                {blindfoldEnabled && (
                  <label className="flex shrink-0 items-center gap-1.5 pr-1 text-[11px] text-fg-muted">
                    <input
                      type="number"
                      min={1}
                      max={40}
                      value={blindfoldPly}
                      onChange={(e) => {
                        const next = Math.round(Number(e.target.value));
                        if (Number.isFinite(next)) {
                          setBlindfoldPly(Math.max(1, Math.min(40, next)));
                        }
                      }}
                      className="w-11 rounded border border-line bg-surface-2 px-1 py-0.5 text-center font-mono text-fg"
                    />
                    plies back
                  </label>
                )}
              </div>
              {blindfoldEnabled && blindfoldError && (
                <p className="px-1 text-[11px] text-fg-subtle">
                  Blindfold isn't available for this puzzle — {blindfoldError}
                </p>
              )}
            </div>

            <div className="order-4 xl:order-none">
              <PuzzleRating progress={progress} change={ratingChange} />
            </div>

            {/* The puzzle itself: what to do, and what happened. */}
            <div className="order-1 rounded-xl border border-line bg-surface p-4 xl:order-none">
              {blindfoldFrozen && blindfoldContext && (
                <p className="mb-2 text-xs text-fg-2">
                  From this position, the following moves were made:{' '}
                  {blindfoldContext.moves.length > 0 ? (
                    <span className="font-mono text-fg">
                      {blindfoldContext.moves.join(' ')}
                    </span>
                  ) : (
                    <span className="text-fg-subtle">none — this is where the game opened.</span>
                  )}
                </p>
              )}

              {prompt && <p className="text-sm text-fg">{prompt}</p>}

              {hintUsed && phase !== 'over' && (
                <p className="mt-1 text-[11px] text-accent-2">
                  Hint used — this puzzle won't move your rating either way.
                </p>
              )}

              {puzzle && solving && puzzle.source === 'own' && (
                <p className="mt-1 text-[11px] text-fg-subtle">
                  Move {puzzle.move_number}
                  {puzzle.date ? ` · ${puzzle.date}` : ''}
                  {puzzle.wp_drop != null &&
                    ` · you gave up ${Math.round(puzzle.wp_drop * 100)}% here`}
                </p>
              )}

              {/* Mid-line, the verdict is "right so far" and not a result.
                  Rendering it with the finished-puzzle panel is how a
                  two-move answer came to announce "Solved" after one move. */}
              {verdict && puzzle && verdict.correct && !verdict.done && (
                <p className="mt-2 text-sm font-semibold text-success-fg">
                  ✓ {verdict.attempt?.san ?? verdict.attempt?.uci}
                  {verdict.moves_required != null && (
                    <span className="ml-2 font-normal text-fg-subtle">
                      {verdict.moves_played} of {verdict.moves_required}
                      {verdict.reply && ` — they reply ${verdict.reply.san}`}
                    </span>
                  )}
                </p>
              )}

              {verdict && puzzle && (phase === 'over' || phase === 'explore') && (
                <Feedback verdict={verdict} answer={answer} puzzle={puzzle} hintUsed={hintUsed} />
              )}

              {error && <p className="mt-2 text-[11px] text-danger-fg">{error}</p>}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void load()}
                  disabled={phase === 'loading'}
                  className="flex items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent disabled:opacity-50"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                  Next puzzle
                </button>
                {solving && (
                  <button
                    onClick={() => void useHint()}
                    disabled={busy}
                    title="Highlight the piece to move -- costs you nothing but the puzzle then can't move your rating"
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2 hover:text-fg disabled:opacity-50"
                  >
                    <Lightbulb className="h-3.5 w-3.5" />
                    Hint
                  </button>
                )}
                {solving && (
                  <button
                    onClick={() => void reveal()}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2 hover:text-fg disabled:opacity-50"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Show me
                  </button>
                )}
                {phase === 'over' && puzzle && (
                  <button
                    onClick={explore}
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2 hover:text-fg"
                  >
                    <Search className="h-3.5 w-3.5" />
                    Play on from here
                  </button>
                )}
                {source === 'own' && (
                  <button
                    onClick={() => void rescan()}
                    disabled={busy}
                    title="Scan your analysed games for new material"
                    className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-2 hover:text-fg disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Rescan
                  </button>
                )}
              </div>

              {source === 'own' && stats && (
                <p className="mt-2 text-[11px] text-fg-subtle">
                  {stats.total === 0
                    ? 'No puzzles yet — analyse some games (Quick is enough) and press Rescan.'
                    : `${stats.solved}/${stats.total} solved · ${stats.by_kind.tactic} tactics, ${stats.by_kind.blunder_check} blunder checks`}
                </p>
              )}
            </div>

            {phase === 'explore' && liveActive && (
              <div className="order-3 rounded-xl border border-line bg-surface p-3 xl:order-none">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold tracking-wide text-fg-2 uppercase">
                    Position
                  </span>
                  <span className="font-mono text-xs text-fg">{formatEval(barCp)}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-eval-black">
                  <div
                    className="h-full bg-eval-white transition-[width] duration-300"
                    style={{
                      width: `${barCp == null ? 50 : Math.round(winProb(barCp) * 100)}%`,
                    }}
                  />
                </div>
                <EngineLines
                  engineLines={live.lines}
                  linesStale={live.stale}
                  liveError={live.error}
                />
              </div>
            )}

            {!engineReady && source === 'own' && (
              <div className="order-6 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-xs text-fg xl:order-none">
                <span>
                  No Stockfish engine is selected — puzzles from your games can't be
                  checked without one.
                </span>
                <button
                  onClick={onOpenSettings}
                  className="rounded-lg bg-accent-strong px-2.5 py-1 font-semibold text-on-accent hover:bg-accent"
                >
                  Choose engines
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>

      <PuzzlePanel
        source={source}
        kinds={kinds}
        onChangeKinds={setKinds}
        themes={themes}
        onChangeThemes={setThemes}
        stats={stats}
        progress={progress}
        refreshKey={refreshKey}
        onImported={() => {
          refreshStats();
          setRefreshKey((k) => k + 1);
        }}
        collapsed={panelCollapsed}
        onToggleCollapsed={() => setPanelCollapsed((v) => !v)}
      />
    </main>
  );
}

/** What happened, once a puzzle is over. */
function Feedback({
  verdict,
  answer,
  puzzle,
  hintUsed,
}: {
  verdict: PuzzleVerdict;
  answer: LineMove[] | null;
  puzzle: Puzzle | null;
  hintUsed?: boolean;
}) {
  const themes = verdict.themes ?? [];
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {verdict.correct ? (
        <p className="text-sm font-semibold text-success-fg">
          ✓ {verdict.equal_move ? 'That works too.' : 'Solved.'}
        </p>
      ) : verdict.attempt ? (
        <p className="text-sm font-semibold text-danger-fg">
          ✗ {verdict.attempt.san ?? verdict.attempt.uci}
          {verdict.expected?.san ? ` — ${verdict.expected.san} was it.` : ' isn’t it.'}
        </p>
      ) : (
        <p className="text-sm font-semibold text-fg-2">Here's the answer.</p>
      )}

      {verdict.moves_required != null && verdict.moves_required > 1 && (
        <p className="text-[11px] text-fg-subtle">
          This was a {verdict.moves_required}-move puzzle.
        </p>
      )}

      {hintUsed && (
        <p className="text-[11px] text-accent-2">
          Hint used — this attempt didn't move your rating.
        </p>
      )}

      {verdict.same_as_played && (
        <p className="text-[11px] text-fg-subtle">
          That's the move you played in the game.
        </p>
      )}
      {!verdict.correct && verdict.played?.san && !verdict.same_as_played && (
        <p className="text-[11px] text-fg-subtle">
          In the game you played <b>{verdict.played.san}</b>.
        </p>
      )}

      {answer && answer.length > 0 && (
        <p className="font-mono text-[11px] text-fg-2">
          {answer.map((m, i) => (
            <span key={i} className={m.yours ? 'font-bold text-fg' : ''}>
              {m.san}{' '}
            </span>
          ))}
        </p>
      )}

      {themes.length > 0 && (
        <p className="text-[11px] text-fg-subtle">Motifs: {themes.join(', ')}.</p>
      )}

      {puzzle?.source === 'lichess' && verdict.game_url && (
        <a
          href={verdict.game_url}
          target="_blank"
          rel="noopener"
          className="text-[11px] text-accent hover:underline"
        >
          See the game it came from
        </a>
      )}
    </div>
  );
}
