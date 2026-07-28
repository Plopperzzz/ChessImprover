/* Wraps a chess.js Chess() instance so the UI can: load a PGN, step through
   the mainline with nav buttons, and branch into variations by playing a
   different move at any point. Positions are held as a real move tree (not a
   flat list) so multiple variations -- including nested ones -- can coexist:

     nodes[id] = { id, parentId, ply, san, from, to, promotion,
                   fenBefore, fenAfter, isMainline, children: [id, ...] }

   Node 0 is a virtual root (the starting position, no move). For any node,
   children[0] is whichever move continues the line the node is already on
   (the mainline, if the node itself is on the mainline; otherwise whichever
   variation move was played first); children[1+] are additional variations
   branching at that point. isMainline is fixed at node creation and never
   changes, so the original loaded game is never mutated or lost -- only
   nodes with isMainline === false can be deleted. */

/** Matches any of the logged-in user's names -- display name or username --
    against White/Black headers (case-insensitive, trimmed). Both are tried
    because which of the two someone typed as their site handle is not
    something they should have to get right. Returns 'unassigned' rather than
    guessing if neither matches -- callers must surface that to the user, not
    drop the game or silently pick a side. */
function matchYourColor(headers, yourNames) {
  const names = (Array.isArray(yourNames) ? yourNames : [yourNames])
    .map((n) => (n || '').trim().toLowerCase())
    .filter(Boolean);
  const white = (headers.White || '').trim().toLowerCase();
  const black = (headers.Black || '').trim().toLowerCase();
  if (names.includes(white)) return 'w';
  if (names.includes(black)) return 'b';
  return 'unassigned';
}

class Explorer {
  constructor() {
    this.headers = {};
    this.yourColor = 'w';
    this.loaded = false;
    this.chess = new Chess();
    this._resetTree(this.chess.fen());
  }

  _resetTree(startFen) {
    this.nodes = {
      0: {
        id: 0, parentId: null, ply: 0, san: null, from: null, to: null, promotion: null,
        fenBefore: null, fenAfter: startFen, isMainline: true, children: [],
      },
    };
    this.mainlineNodeIds = [];
    this.nextId = 1;
    this.currentNodeId = 0;
  }

  _appendMainlineNode(moveResult, fenBefore, fenAfter) {
    const parentId = this.mainlineNodeIds.length
      ? this.mainlineNodeIds[this.mainlineNodeIds.length - 1]
      : 0;
    const id = this.nextId++;
    const node = {
      id, parentId, ply: this.nodes[parentId].ply + 1,
      san: moveResult.san, from: moveResult.from, to: moveResult.to,
      promotion: moveResult.promotion || null,
      fenBefore, fenAfter, isMainline: true, children: [],
    };
    this.nodes[id] = node;
    this.nodes[parentId].children.push(id);
    this.mainlineNodeIds.push(id);
    return node;
  }

  /** Parse raw PGN text (client-side, via chess.js) and build the mainline as
      a chain of tree nodes. Only the first game in the text is used --
      multi-game PGNs should go through "Run analysis" for the full sweep;
      this is just the explore-mode preview. */
  /** `yourColor`, when given, is the side the server already has stored for
      this game -- including a side a human assigned by hand, which no amount
      of header matching would reproduce. Header matching is only the fallback
      for PGN text that isn't in the library yet. */
  loadPGN(pgnText, yourNames, yourColor) {
    const tmp = new Chess();
    // Strict first: chess.js's "sloppy" parser is case-insensitive about the
    // piece letter, so it reads a b-pawn capture like "bxa4" as a *bishop*
    // move and rejects the whole game. Sloppy is only a fallback for PGNs
    // that strict parsing genuinely can't handle.
    let ok = tmp.load_pgn(pgnText);
    if (!ok) ok = tmp.load_pgn(pgnText, { sloppy: true });
    if (!ok) throw new Error('Could not parse that PGN (check the move text/headers)');
    const verboseMoves = tmp.history({ verbose: true });
    this.headers = tmp.header() || {};

    this._resetTree(new Chess().fen());
    const replay = new Chess();
    for (const mv of verboseMoves) {
      const fenBefore = replay.fen();
      const res = replay.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      this._appendMainlineNode(res, fenBefore, replay.fen());
    }
    this.chess = new Chess();
    this.chess.load(this.nodes[0].fenAfter);
    this.loaded = true;
    this.yourColor = yourColor || matchYourColor(this.headers, yourNames);
    return true;
  }

  /** Build directly from the server's computed move list (used once a live
      analysis run finishes, so explore mode reflects exactly what was
      analyzed rather than re-parsing PGN text). */
  loadFromServerGame(gameMeta) {
    this.headers = { White: gameMeta.white, Black: gameMeta.black, Result: gameMeta.result };
    this._resetTree(new Chess().fen());
    const replay = new Chess();
    for (const m of gameMeta.moves) {
      const fenBefore = replay.fen();
      const res = replay.move(m.san) || replay.move(m.san, { sloppy: true });
      if (!res) break;
      this._appendMainlineNode(res, fenBefore, replay.fen());
    }
    this.chess = new Chess();
    this.chess.load(this.nodes[0].fenAfter);
    this.loaded = true;
    this.yourColor = gameMeta.your_color;
  }

  /** Abandons whatever game/variation was loaded and sets an arbitrary FEN as
      a fresh, moveable position with no mainline (used by the FEN-jump box). */
  loadFEN(fen) {
    const probe = new Chess();
    if (!probe.load(fen)) return false;
    this.headers = {};
    this._resetTree(fen);
    this.chess = new Chess();
    this.chess.load(fen);
    this.loaded = true;
    return true;
  }

  get fen() { return this.nodes[this.currentNodeId].fenAfter; }
  get moverColor() { return this.fen.split(' ')[1]; }
  get onMainline() { return this.nodes[this.currentNodeId].isMainline; }
  get plyCount() { return this.nodes[this.currentNodeId].ply; }

  atStart() { return this.currentNodeId === 0; }

  atMainlineEnd() {
    const tip = this.mainlineNodeIds.length ? this.mainlineNodeIds[this.mainlineNodeIds.length - 1] : 0;
    return this.currentNodeId === tip;
  }

  /** Jumps (snaps, no animation) to an arbitrary node -- the mainline table,
      a variation move, or goToStart/goToMainlineEnd all go through this. */
  goToNode(nodeId) {
    if (!this.nodes[nodeId]) return false;
    this.currentNodeId = nodeId;
    this.chess.load(this.nodes[nodeId].fenAfter);
    return true;
  }

  goToStart() { this.goToNode(0); }

  goToMainlineEnd() {
    const tip = this.mainlineNodeIds.length ? this.mainlineNodeIds[this.mainlineNodeIds.length - 1] : 0;
    this.goToNode(tip);
  }

  /** n=0 -> start; n>=1 -> the n-th mainline move (1-indexed). */
  goToPly(n) {
    if (n <= 0) { this.goToStart(); return; }
    const id = this.mainlineNodeIds[n - 1];
    if (id !== undefined) this.goToNode(id);
  }

  /** Steps to the line's next move (whatever children[0] is), returning the
      move (with from/to) so the caller can animate it, or false at a leaf. */
  stepForward() {
    const node = this.nodes[this.currentNodeId];
    if (!node.children.length) return false;
    const child = this.nodes[node.children[0]];
    this.goToNode(child.id);
    return child;
  }

  /** Steps back to the parent, returning the move that was just undone (so
      the caller animates from child.to back to child.from), or false at the
      start of the tree. */
  stepBackward() {
    const node = this.nodes[this.currentNodeId];
    if (node.parentId === null) return false;
    const undone = node;
    this.goToNode(node.parentId);
    return undone;
  }

  /** Legal destination squares for a piece on `square`, collapsed so a
      promotion (which chess.js reports as 4 separate moves) shows as one
      target with promotion:true -- the board prompts for the piece after
      the square is clicked. */
  getLegalTargets(square) {
    const moves = this.chess.moves({ square, verbose: true });
    const byTo = new Map();
    for (const m of moves) {
      if (!byTo.has(m.to)) byTo.set(m.to, { to: m.to, promotion: !!m.promotion });
    }
    return Array.from(byTo.values());
  }

  /** Attempts a move at the current node. If it already exists as a child
      (replaying the mainline or a previously-created variation) we just
      navigate there instead of creating a duplicate branch; otherwise it
      becomes a new variation node. Returns the resulting node, or null if
      the move was illegal. */
  makeMove(from, to, promotion) {
    const res = this.chess.move({ from, to, promotion: promotion || 'q' });
    if (!res) return null;
    const current = this.nodes[this.currentNodeId];
    const existing = current.children
      .map((id) => this.nodes[id])
      .find((n) => n.from === res.from && n.to === res.to && (n.promotion || null) === (res.promotion || null));
    if (existing) {
      this.goToNode(existing.id);
      return existing;
    }
    const id = this.nextId++;
    const node = {
      id, parentId: current.id, ply: current.ply + 1,
      san: res.san, from: res.from, to: res.to, promotion: res.promotion || null,
      fenBefore: current.fenAfter, fenAfter: this.chess.fen(),
      isMainline: false, children: [],
    };
    this.nodes[id] = node;
    current.children.push(id);
    this.currentNodeId = id;
    return node;
  }

  /** Deletes a variation subtree. Refuses to delete mainline nodes -- the
      mainline is always preserved. If the current position was inside the
      deleted subtree, moves the current position back to its parent. */
  deleteVariation(nodeId) {
    const node = this.nodes[nodeId];
    if (!node || node.isMainline) return false;
    const parent = this.nodes[node.parentId];
    const toRemove = [];
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      toRemove.push(id);
      stack.push(...this.nodes[id].children);
    }
    const wasCurrentInside = toRemove.includes(this.currentNodeId);
    for (const id of toRemove) delete this.nodes[id];
    parent.children = parent.children.filter((id) => id !== nodeId);
    if (wasCurrentInside) this.goToNode(parent.id);
    return true;
  }
}
