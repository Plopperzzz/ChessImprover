import { Fragment, useEffect, useRef } from 'react';
import { Gauge, Loader2, Sparkles, Trash2, XCircle } from 'lucide-react';
import type { AnalysisMove, MoveQuality } from '../../types';
import type { Ply } from '../../lib/chess';
import { ROOT_ID, type MoveTree, type TreeNode } from '../../lib/moveTree';
import { QUALITY, QUALITY_ORDER, styleFor } from '../../lib/quality';
import type { JobState } from '../../lib/useAnalysisJob';

interface MoveListProps {
  plies: Ply[];
  moves: Map<number, AnalysisMove>;
  /** The game as a tree: the mainline, and the lines played off it. */
  tree: MoveTree;
  currentNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onDeleteVariation: (variationId: number) => void;
  white: string;
  black: string;
  job: JobState;
  onRunFull: () => void;
  onRunQuick: () => void;
  onCancel: () => void;
  disabled: boolean;
  savedMode: string | null;
}

function counts(plies: Ply[], moves: Map<number, AnalysisMove>, color: 'w' | 'b') {
  const out = new Map<MoveQuality, number>();
  for (const ply of plies) {
    if (ply.color !== color) continue;
    const move = moves.get(ply.ply);
    if (!move) continue;
    out.set(move.classification, (out.get(move.classification) ?? 0) + 1);
  }
  return out;
}

function SideSummary({ name, tally }: { name: string; tally: Map<MoveQuality, number> }) {
  const shown = QUALITY_ORDER.filter((q) => (tally.get(q) ?? 0) > 0);
  return (
    <div className="rounded-xl border border-line/80 bg-canvas/80 p-2.5">
      <div className="truncate text-xs font-semibold text-fg">{name}</div>
      {shown.length === 0 ? (
        <div className="mt-1 font-mono text-[11px] text-fg-subtle">not analysed</div>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1">
          {shown.map((q) => (
            <span
              key={q}
              title={QUALITY[q].label}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-fg-2"
            >
              <img src={QUALITY[q].icon} alt={QUALITY[q].label} className="h-4 w-4" />
              <span className="font-bold">{tally.get(q)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A variation, written the way a book would: `12… Nf6 13. O-O`, with the
 *  move number repeated at the start because a line rarely begins on white's
 *  move. Nested lines indent again. */
function VariationLine({
  tree,
  headId,
  currentNodeId,
  onSelectNode,
  onDeleteVariation,
  depth,
}: {
  tree: MoveTree;
  headId: string;
  currentNodeId: string;
  onSelectNode: (nodeId: string) => void;
  onDeleteVariation: (variationId: number) => void;
  depth: number;
}) {
  // The line runs until it forks or ends; a fork below it becomes its own
  // indented line, which is how nesting draws itself.
  const line: TreeNode[] = [];
  const branches: string[] = [];
  let node: TreeNode | undefined = tree.nodes[headId];
  while (node) {
    line.push(node);
    branches.push(...node.children.slice(1));
    node = node.children[0] ? tree.nodes[node.children[0]] : undefined;
  }
  const variationId = line[0]?.variationId ?? null;

  return (
    <div className={depth > 0 ? 'ml-3 border-l border-line pl-2' : ''}>
      <div className="group/line flex flex-wrap items-center gap-x-1 gap-y-0.5 py-0.5">
        {line.map((move, index) => {
          const current = move.id === currentNodeId;
          const showNumber = index === 0 || move.color === 'w';
          return (
            <button
              key={move.id}
              data-current={current}
              onClick={() => onSelectNode(move.id)}
              className={`rounded px-1 py-0.5 font-mono text-[11px] transition-colors ${
                current ? 'bg-accent-strong/90 text-on-accent' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {showNumber && (
                <span className="text-fg-subtle">
                  {Math.floor((move.ply - 1) / 2) + 1}
                  {move.color === 'w' ? '.' : '…'}{' '}
                </span>
              )}
              {move.san}
            </button>
          );
        })}
        {variationId != null && (
          <button
            onClick={() => onDeleteVariation(variationId)}
            title="Delete this variation"
            aria-label="Delete this variation"
            className="ml-1 rounded p-0.5 text-fg-faint opacity-0 transition-opacity group-hover/line:opacity-100 hover:text-danger-fg focus:opacity-100"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {branches.map((branchId) => (
        <VariationLine
          key={branchId}
          tree={tree}
          headId={branchId}
          currentNodeId={currentNodeId}
          onSelectNode={onSelectNode}
          onDeleteVariation={onDeleteVariation}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export function MoveList({
  plies,
  moves,
  tree,
  currentNodeId,
  onSelectNode,
  onDeleteVariation,
  white,
  black,
  job,
  onRunFull,
  onRunQuick,
  onCancel,
  disabled,
  savedMode,
}: MoveListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-current="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [currentNodeId]);

  const rows: { moveNumber: number; white?: Ply; black?: Ply }[] = [];
  for (const ply of plies) {
    let row = rows[rows.length - 1];
    if (!row || row.moveNumber !== ply.moveNumber) {
      row = { moveNumber: ply.moveNumber };
      rows.push(row);
    }
    if (ply.color === 'w') row.white = ply;
    else row.black = ply;
  }

  /** Lines that leave the mainline at this move pair, drawn under the row they
   *  branch from — where a book would put them. `children[0]` is the mainline
   *  continuing, so the branches are everything after it. */
  const branchesAfter = (row: { white?: Ply; black?: Ply }): string[] => {
    const out: string[] = [];
    for (const ply of [row.white, row.black]) {
      if (!ply) continue;
      const node = tree.nodes[tree.mainlineIds[ply.ply - 1] ?? ''];
      if (node) out.push(...node.children.slice(1));
    }
    // The root's branches -- a line played before the game's first move -- have
    // no row to sit under, so the first row adopts them.
    if (row === rows[0]) out.unshift(...(tree.nodes[ROOT_ID]?.children.slice(1) ?? []));
    return out;
  };

  const cell = (ply?: Ply) => {
    if (!ply) return <td className="px-2 py-1" />;
    const move = moves.get(ply.ply);
    const q = styleFor(move?.classification);
    const nodeId = tree.mainlineIds[ply.ply - 1] ?? ROOT_ID;
    const current = nodeId === currentNodeId;
    return (
      <td className="p-0">
        <button
          data-current={current}
          onClick={() => onSelectNode(nodeId)}
          className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs transition-colors ${
            current ? 'bg-accent-strong/90 text-on-accent' : 'text-fg-2 hover:bg-surface-2'
          }`}
        >
          <span className="truncate">{ply.san}</span>
          {q && (
            <img
              src={q.icon}
              alt={q.symbol || q.label}
              title={q.label}
              className="ml-auto h-[25px] w-[25px] shrink-0"
            />
          )}
        </button>
      </td>
    );
  };

  const phaseLabel = () => {
    if (job.queuedAhead != null) {
      return job.queuedAhead > 0
        ? `Queued — ${job.queuedAhead} job${job.queuedAhead === 1 ? '' : 's'} ahead`
        : 'Queued';
    }
    if (job.phase === 'stockfish') return 'Stockfish pass — classifying every move';
    if (job.phase === 'maia')
      return job.elo
        ? `Maia Elo sweep — asking Maia at ${job.elo}`
        : 'Maia Elo sweep';
    return 'Starting…';
  };

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface/95 p-4 text-fg shadow-xl">
      <div className="grid grid-cols-2 gap-2 border-b border-line pb-3">
        <SideSummary name={`⚪ ${white}`} tally={counts(plies, moves, 'w')} />
        <SideSummary name={`⚫ ${black}`} tally={counts(plies, moves, 'b')} />
      </div>

      <div ref={listRef} className="thin-scroll mt-3 max-h-64 overflow-y-auto pr-1">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-subtle">No moves to show.</p>
        ) : (
          <table className="w-full table-fixed">
            <tbody>
              {rows.map((row) => {
                const branches = branchesAfter(row);
                return (
                  <Fragment key={row.moveNumber}>
                    <tr>
                      <td className="w-9 py-1 pr-1 text-right font-mono text-[11px] text-fg-subtle">
                        {row.moveNumber}.
                      </td>
                      {cell(row.white)}
                      {cell(row.black)}
                    </tr>
                    {branches.length > 0 && (
                      <tr>
                        <td colSpan={3} className="pb-1 pl-2">
                          {branches.map((branchId) => (
                            <VariationLine
                              key={branchId}
                              tree={tree}
                              headId={branchId}
                              currentNodeId={currentNodeId}
                              onSelectNode={onSelectNode}
                              onDeleteVariation={onDeleteVariation}
                              depth={0}
                            />
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-3 space-y-2 border-t border-line pt-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onRunFull}
            disabled={disabled || job.running}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent-strong px-3 py-2.5 text-sm font-semibold text-on-accent shadow-md transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {job.running && job.kind === 'full' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            <span>Full analysis</span>
          </button>
          <button
            onClick={onRunQuick}
            disabled={disabled || job.running}
            title="Stockfish only — no Elo estimate"
            className="flex items-center justify-center gap-2 rounded-lg border border-line-2 bg-canvas px-3 py-2.5 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            <Gauge className="h-4 w-4" />
            <span>Quick</span>
          </button>
          {job.running && (
            <button
              onClick={onCancel}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-danger-line bg-danger-surface px-3 py-2.5 text-sm font-medium text-danger-fg hover:bg-danger/20"
            >
              <XCircle className="h-4 w-4" />
              <span>Cancel</span>
            </button>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-fg-subtle">
          Full analysis runs the Stockfish pass <em>and</em> the Maia Elo sweep — the sweep is
          what produces the estimated rating, Great and Brilliant.
        </p>

        {job.running && (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.round((job.fraction ?? 0) * 100)}%` }}
              />
            </div>
            <p className="font-mono text-[11px] text-fg-muted">
              {phaseLabel()}
              {job.fraction != null && ` · ${Math.round(job.fraction * 100)}%`}
            </p>
          </div>
        )}

        {job.error && (
          <p className="rounded-lg bg-danger-surface px-3 py-2 text-[11px] text-danger-fg">
            {job.error}
          </p>
        )}

        {!job.running && !job.error && savedMode && (
          <p className="font-mono text-[11px] text-fg-subtle">
            Showing the saved {savedMode} analysis.
          </p>
        )}
      </div>
    </div>
  );
}
