/* Wraps a chess.js Chess() instance so the UI can: load a PGN, step through
   the mainline with nav buttons, and make new legal moves at any point to
   branch into a variation (chess.js supplies legality/SAN/FEN; we just track
   whether we're still walking the original mainline or have diverged). */

/** Matches the logged-in user's display name against White/Black headers
    (case-insensitive, trimmed). Returns 'unassigned' rather than guessing if
    neither matches -- callers must surface that to the user, not drop the
    game or silently pick a side. */
function matchYourColor(headers, yourName) {
  const name = (yourName || '').trim().toLowerCase();
  const white = (headers.White || '').trim().toLowerCase();
  const black = (headers.Black || '').trim().toLowerCase();
  if (name && name === white) return 'w';
  if (name && name === black) return 'b';
  return 'unassigned';
}

class Explorer {
  constructor() {
    this.chess = new Chess();
    this.mainlineSAN = [];
    this.headers = {};
    this.pointer = 0;
    this.onMainline = true;
    this.yourColor = 'w';
    this.loaded = false;
  }

  /** Parse raw PGN text (client-side, via chess.js). Only the first game in
      the text is used -- multi-game PGNs should go through "Run analysis"
      for the full sweep; this is just the explore-mode preview. */
  loadPGN(pgnText, yourName) {
    const tmp = new Chess();
    const ok = tmp.load_pgn(pgnText, { sloppy: true });
    if (!ok) throw new Error('Could not parse that PGN (check the move text/headers)');
    this.mainlineSAN = tmp.history();
    this.headers = tmp.header() || {};
    this.chess = new Chess();
    this.pointer = 0;
    this.onMainline = true;
    this.loaded = true;
    this.yourColor = matchYourColor(this.headers, yourName);
    return true;
  }

  /** Build directly from the server's computed move list (used once a live
      analysis run finishes, so explore mode reflects exactly what was
      analyzed rather than re-parsing PGN text). */
  loadFromServerGame(gameMeta) {
    this.mainlineSAN = gameMeta.moves.map((m) => m.san);
    this.headers = { White: gameMeta.white, Black: gameMeta.black, Result: gameMeta.result };
    this.chess = new Chess();
    this.pointer = 0;
    this.onMainline = true;
    this.loaded = true;
    this.yourColor = gameMeta.your_color;
  }

  get fen() { return this.chess.fen(); }
  get moverColor() { return this.chess.turn(); }
  get plyCount() { return this.chess.history().length; }

  atStart() { return this.plyCount === 0; }
  atMainlineEnd() { return this.onMainline && this.pointer >= this.mainlineSAN.length; }

  /** Returns the chess.js move result (so callers can animate from/to), or
      false if there's no next mainline move. */
  stepForward() {
    if (!this.onMainline || this.pointer >= this.mainlineSAN.length) return false;
    const res = this.chess.move(this.mainlineSAN[this.pointer], { sloppy: true });
    if (!res) return false;
    this.pointer++;
    return res;
  }

  /** Returns the undone move (from/to refer to the original direction, so
      callers animate to.->from.), or false if already at the start. */
  stepBackward() {
    const res = this.chess.undo();
    if (!res) return false;
    if (this.onMainline && this.pointer > 0) this.pointer--;
    return res;
  }

  /** Jumps to the position after the n-th mainline ply (0 = start position). */
  goToPly(n) {
    this.goToStart();
    for (let i = 0; i < n; i++) {
      if (!this.stepForward()) break;
    }
  }

  /** Abandons whatever game/variation was loaded and sets an arbitrary FEN as
      a fresh, moveable position with no mainline (used by the FEN-jump box). */
  loadFEN(fen) {
    const ok = this.chess.load(fen);
    if (!ok) return false;
    this.mainlineSAN = [];
    this.headers = {};
    this.pointer = 0;
    this.onMainline = false;
    this.loaded = true;
    return true;
  }

  goToStart() {
    while (this.chess.undo()) { /* keep undoing */ }
    this.pointer = 0;
    this.onMainline = true;
  }

  /** Jumps back to the mainline and plays it to the end, abandoning any
      variation you'd branched into. */
  goToMainlineEnd() {
    this.goToStart();
    while (this.stepForward()) { /* keep stepping */ }
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

  /** Attempts a move. Returns the chess.js move result (with .san) or null
      if illegal. If it matches the next mainline move we stay "on
      mainline"; otherwise this starts (or continues) a variation. */
  makeMove(from, to, promotion) {
    const res = this.chess.move({ from, to, promotion: promotion || 'q' });
    if (!res) return null;
    const newLen = this.chess.history().length;
    if (this.onMainline && newLen <= this.mainlineSAN.length && this.mainlineSAN[newLen - 1] === res.san) {
      this.pointer = newLen;
    } else {
      this.onMainline = false;
    }
    return res;
  }
}
