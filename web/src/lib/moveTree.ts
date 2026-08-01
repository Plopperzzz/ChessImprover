import { Chess } from 'chess.js';
import type { Variation } from './api';
import { START_FEN, type Ply } from './chess';

/**
 * The game as a tree, so a move that isn't the one played has somewhere to go.
 *
 * Modelled on the classic UI's `frontend/js/explorer.js`, which has had a real
 * move tree since the beginning, and deliberately keeps its two load-bearing
 * rules:
 *
 * - **`children[0]` continues the line.** For a mainline node that is the next
 *   mainline move, so stepping forward never wanders into a variation by
 *   accident; the branches hang off it in the order they were made.
 * - **`mainline` is fixed when the node is made and never changes.** The game
 *   as played cannot be edited or deleted, only added to — which is what makes
 *   "delete this variation" a safe button.
 *
 * The one difference is that the lines here have identities on the server:
 * `variationId` is the row a node belongs to, and `indexInLine` where it sits
 * inside it, which is what lets a move played at the tip of a line extend that
 * row rather than start another.
 */

export const ROOT_ID = 'root';

export interface TreeNode {
  id: string;
  parentId: string | null;
  /** Half-moves from the start of the game, counting through the line. */
  ply: number;
  san: string;
  from: string;
  to: string;
  promotion?: string;
  color: 'w' | 'b';
  /** The position this move produced. */
  fen: string;
  mainline: boolean;
  /** Which saved line this move belongs to; null on the mainline, and on a
   *  branch that hasn't been written yet. */
  variationId: number | null;
  /** 0-based position within that line. */
  indexInLine: number;
  children: string[];
}

export interface MoveTree {
  nodes: Record<string, TreeNode>;
  /** Mainline node ids in order, so `mainlineIds[n - 1]` is ply n. */
  mainlineIds: string[];
  startFen: string;
}

const rootNode = (startFen: string): TreeNode => ({
  id: ROOT_ID,
  parentId: null,
  ply: 0,
  san: '',
  from: '',
  to: '',
  color: 'b', // so that ply 1 is white's, by the same parity as everywhere else
  fen: startFen,
  mainline: true,
  variationId: null,
  indexInLine: -1,
  children: [],
});

export function emptyTree(startFen: string = START_FEN): MoveTree {
  const root = rootNode(startFen);
  return { nodes: { [ROOT_ID]: root }, mainlineIds: [], startFen };
}

/** Where a saved line hangs: a node id, or the root. */
function anchorId(variation: Variation, byVariation: Map<number, string[]>): string | null {
  if (variation.parent_id == null) {
    return variation.start_ply === 0 ? ROOT_ID : `m${variation.start_ply}`;
  }
  const parent = byVariation.get(variation.parent_id);
  if (!parent) return null;
  // start_ply counts moves *of the parent line*, so 0 is the parent's own
  // anchor and n is after its n-th move.
  if (variation.start_ply === 0) return null; // handled by the caller's ordering
  return parent[variation.start_ply - 1] ?? null;
}

/**
 * The mainline from the parsed PGN, with every saved line replayed onto it.
 *
 * A line that no longer plays out is skipped rather than throwing: the server
 * validates on the way in, so this only happens to a row written against a
 * game whose PGN was later replaced — and one unreadable line must not take
 * the board down with it.
 */
export function buildTree(plies: Ply[], variations: Variation[] = []): MoveTree {
  const startFen = plies[0]?.fenBefore ?? START_FEN;
  const tree = emptyTree(startFen);

  let parent = tree.nodes[ROOT_ID];
  for (const ply of plies) {
    const node: TreeNode = {
      id: `m${ply.ply}`,
      parentId: parent.id,
      ply: ply.ply,
      san: ply.san,
      from: ply.from,
      to: ply.to,
      color: ply.color,
      fen: ply.fenAfter,
      mainline: true,
      variationId: null,
      indexInLine: ply.ply - 1,
      children: [],
    };
    tree.nodes[node.id] = node;
    parent.children.push(node.id);
    tree.mainlineIds.push(node.id);
    parent = node;
  }

  // Parents before children: a nested line needs its parent's nodes to exist
  // before it can find the one it hangs off. The server returns them oldest
  // first, and a line is always created after the one it branches from, so a
  // single pass with a retry queue is enough.
  const byVariation = new Map<number, string[]>();
  let pending = [...variations];
  for (let pass = 0; pass < 8 && pending.length > 0; pass += 1) {
    const stillPending: Variation[] = [];
    for (const variation of pending) {
      const anchor =
        variation.parent_id == null
          ? anchorId(variation, byVariation)
          : variation.start_ply === 0
            ? // Branching at a parent line's own anchor means branching from
              // wherever *that* line starts.
              (byVariation.has(variation.parent_id)
                ? (tree.nodes[byVariation.get(variation.parent_id)![0]]?.parentId ?? null)
                : null)
            : anchorId(variation, byVariation);
      if (anchor == null || !tree.nodes[anchor]) {
        stillPending.push(variation);
        continue;
      }
      const ids = attachLine(tree, anchor, variation);
      if (ids) byVariation.set(variation.id, ids);
    }
    if (stillPending.length === pending.length) break; // no progress
    pending = stillPending;
  }

  return tree;
}

/** Replays one saved line onto the tree, returning its node ids. */
function attachLine(tree: MoveTree, anchor: string, variation: Variation): string[] | null {
  let parent = tree.nodes[anchor];
  const board = new Chess();
  try {
    board.load(parent.fen);
  } catch {
    return null;
  }
  const ids: string[] = [];
  variation.moves.forEach((san, index) => {
    let move;
    try {
      move = board.move(san);
    } catch {
      move = null;
    }
    if (!move) return;
    const existing = parent.children
      .map((id) => tree.nodes[id])
      .find((child) => child.from === move.from && child.to === move.to);
    if (existing) {
      // The mainline already plays this move, or another line does. Adopt it
      // rather than drawing the same move twice.
      ids.push(existing.id);
      parent = existing;
      return;
    }
    const node: TreeNode = {
      id: `v${variation.id}-${index}`,
      parentId: parent.id,
      ply: parent.ply + 1,
      san: move.san,
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      color: move.color,
      fen: board.fen(),
      mainline: false,
      variationId: variation.id,
      indexInLine: index,
      children: [],
    };
    tree.nodes[node.id] = node;
    parent.children.push(node.id);
    ids.push(node.id);
    parent = node;
  });
  return ids.length > 0 ? ids : null;
}

/** The node reached by playing `from`-`to` at `nodeId`, if it is already
 *  there. Replaying the game, or a line you have already made, must navigate
 *  rather than branch — otherwise stepping forward by hand slowly fills the
 *  table with duplicates of the game. */
export function childFor(
  tree: MoveTree,
  nodeId: string,
  from: string,
  to: string,
): TreeNode | null {
  const node = tree.nodes[nodeId];
  if (!node) return null;
  return (
    node.children
      .map((id) => tree.nodes[id])
      .find((child) => child.from === from && child.to === to) ?? null
  );
}

/** Adds a move to the tree in memory, returning the new node. The caller
 *  decides what that means on the server. */
export function addMove(
  tree: MoveTree,
  nodeId: string,
  move: { san: string; from: string; to: string; promotion?: string; color: 'w' | 'b' },
  fen: string,
  line: { variationId: number | null; indexInLine: number },
): { tree: MoveTree; node: TreeNode } {
  const parent = tree.nodes[nodeId];
  const id = `n${Object.keys(tree.nodes).length}-${parent.ply + 1}`;
  const node: TreeNode = {
    id,
    parentId: parent.id,
    ply: parent.ply + 1,
    san: move.san,
    from: move.from,
    to: move.to,
    promotion: move.promotion,
    color: move.color,
    fen,
    mainline: false,
    variationId: line.variationId,
    indexInLine: line.indexInLine,
    children: [],
  };
  const nodes = {
    ...tree.nodes,
    [id]: node,
    [parent.id]: { ...parent, children: [...parent.children, id] },
  };
  return { tree: { ...tree, nodes }, node };
}

/** The line a node sits in, from its first move to the node itself — what a
 *  save has to send, since a row holds a whole line. */
export function lineTo(tree: MoveTree, nodeId: string): TreeNode[] {
  const out: TreeNode[] = [];
  let node = tree.nodes[nodeId];
  while (node && !node.mainline && node.id !== ROOT_ID) {
    out.unshift(node);
    const parent = node.parentId ? tree.nodes[node.parentId] : null;
    if (!parent || parent.variationId !== node.variationId) break;
    node = parent;
  }
  return out;
}

/** Every node from the root down to `nodeId`, which is what the move table
 *  highlights and what "where am I" means. */
export function pathTo(tree: MoveTree, nodeId: string): TreeNode[] {
  const out: TreeNode[] = [];
  let node: TreeNode | undefined = tree.nodes[nodeId];
  while (node && node.id !== ROOT_ID) {
    out.unshift(node);
    node = node.parentId ? tree.nodes[node.parentId] : undefined;
  }
  return out;
}

/** Removes a variation's nodes, and everything hanging off them. Returns the
 *  node to stand on afterwards — the branch point, which by construction
 *  survives. */
export function removeVariation(
  tree: MoveTree,
  variationId: number,
  currentId: string,
): { tree: MoveTree; nextId: string } {
  const doomed = new Set<string>();
  const stack = Object.values(tree.nodes)
    .filter((node) => node.variationId === variationId)
    .map((node) => node.id);
  let anchor: string = ROOT_ID;
  for (const id of stack) {
    const node = tree.nodes[id];
    if (node.indexInLine === 0 && node.parentId) anchor = node.parentId;
  }
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (doomed.has(id)) continue;
    doomed.add(id);
    stack.push(...(tree.nodes[id]?.children ?? []));
  }

  const nodes: Record<string, TreeNode> = {};
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (doomed.has(id)) continue;
    nodes[id] = { ...node, children: node.children.filter((child) => !doomed.has(child)) };
  }
  return {
    tree: { ...tree, nodes },
    nextId: doomed.has(currentId) ? anchor : currentId,
  };
}
