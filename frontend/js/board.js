const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

class Board {
  /** opts: { board, pieces, showLegalMoves }. The board and the pieces are
      separate sets -- they're independent art, and the pairing someone wants
      is rarely both halves of one set. */
  constructor(el, opts = {}) {
    this.el = el;
    this.boardSet = opts.board || 'default';
    this.pieceSet = opts.pieces || opts.board || 'default';
    this.showLegalMoves = opts.showLegalMoves !== false;
    this.orientation = 'w'; // 'w' -> white at bottom (standard), 'b' -> flipped
    this.currentFEN = START_FEN;
    this.pieceEls = {};
    // Interactivity state lives for the life of the Board instance, not just
    // one _build() -- setSets() rebuilds the DOM layers on every switch
    // and must not silently drop click-to-move handlers set up earlier.
    this.interactive = false;
    this.handlers = {};
    this.selected = null;
    this.legalTargets = [];
    this.lastMove = null;   // {from, to} of the move that produced this position
    // Bumped on every position change. A slide finishes ~235ms after it
    // starts, and whatever the board was asked to show in the meantime must
    // win -- see animateMove.
    this._renderSeq = 0;
    this._clickHandler = (ev) => this._handleClick(ev);
    this.el.addEventListener('click', this._clickHandler);
    this._build();
    this.renderFEN(START_FEN);
  }

  /** Switch board and/or piece art (directories under /assets/sets/) and
      redraw the current position with it. Either may be omitted to leave that
      half alone, which is what the live preview in the board dialog does. */
  setSets({ board, pieces } = {}) {
    if (board) this.boardSet = board;
    if (pieces) this.pieceSet = pieces;
    const last = this.lastMove;
    this._build();
    this.renderFEN(this.currentFEN);
    if (last) this.setLastMove(last.from, last.to);
  }

  /** Whether clicking a piece shows dots on its legal destinations. The
      selected square is always marked -- without it, clicking a piece with
      the dots off looks like nothing happened. */
  setShowLegalMoves(enabled) {
    this.showLegalMoves = !!enabled;
    if (this.selected) this._showHighlights(this.selected, this.legalTargets);
  }

  _build() {
    this.el.innerHTML = '';
    const bg = document.createElement('img');
    bg.src = `/assets/sets/${this.boardSet}/board.png`;
    bg.className = 'board-bg';
    bg.draggable = false;
    bg.alt = '';
    bg.onerror = () => {
      this.el.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 25% 25%';
    };
    this.el.appendChild(bg);

    // Under the pieces: the last-move squares tint the board, they don't sit
    // on top of the piece standing on them.
    this.lastMoveLayer = document.createElement('div');
    this.lastMoveLayer.className = 'last-move-layer';
    this.el.appendChild(this.lastMoveLayer);

    this.pieceLayer = document.createElement('div');
    this.pieceLayer.className = 'piece-layer';
    this.el.appendChild(this.pieceLayer);

    this.highlightLayer = document.createElement('div');
    this.highlightLayer.className = 'highlight-layer';
    this.el.appendChild(this.highlightLayer);

    this._clearSelection();
  }

  /** Marks the two squares of the move that led to the position on the board.
      Call with no arguments to clear it. */
  setLastMove(from, to) {
    this.lastMove = from && to ? { from, to } : null;
    if (!this.lastMoveLayer) return;
    this.lastMoveLayer.innerHTML = '';
    if (!this.lastMove) return;
    for (const square of [from, to]) {
      const mark = document.createElement('div');
      mark.className = 'sq-last';
      const { x, y } = this._squareToXY(square);
      mark.style.left = (x * 12.5) + '%';
      mark.style.top = (y * 12.5) + '%';
      this.lastMoveLayer.appendChild(mark);
    }
  }

  /** enabled: bool. handlers: { getLegalTargets(square) -> [{to, promotion}],
      onMove(from,to,promotion), getMoverColor() -> 'w'|'b' } */
  setInteractive(enabled, handlers) {
    this.interactive = enabled;
    if (handlers) this.handlers = handlers;
    this._clearSelection();
  }

  _xyToSquare(col, row) {
    let file, rank;
    if (this.orientation === 'w') { file = col; rank = 7 - row; }
    else { file = 7 - col; rank = row; }
    return String.fromCharCode(97 + file) + (rank + 1);
  }

  _handleClick(ev) {
    if (!this.interactive) return;
    const rect = this.el.getBoundingClientRect();
    if (rect.width === 0) return;
    const xFrac = (ev.clientX - rect.left) / rect.width;
    const yFrac = (ev.clientY - rect.top) / rect.height;
    const col = Math.min(7, Math.max(0, Math.floor(xFrac * 8)));
    const row = Math.min(7, Math.max(0, Math.floor(yFrac * 8)));
    const square = this._xyToSquare(col, row);

    if (this.selected) {
      const target = this.legalTargets.find((t) => t.to === square);
      if (target) {
        const from = this.selected;
        this._clearSelection();
        this._resolveAndMove(from, square, target);
        return;
      }
    }

    this._clearSelection();
    const targets = (this.handlers.getLegalTargets && this.handlers.getLegalTargets(square)) || [];
    if (targets.length) {
      this.selected = square;
      this.legalTargets = targets;
      this._showHighlights(square, targets);
    }
  }

  async _resolveAndMove(from, to, target) {
    let promotion;
    if (target.promotion) {
      const color = (this.handlers.getMoverColor && this.handlers.getMoverColor()) || 'w';
      promotion = await this.promptPromotion(color);
    }
    if (this.handlers.onMove) this.handlers.onMove(from, to, promotion);
  }

  promptPromotion(color) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'promo-overlay';
      for (const p of ['q', 'r', 'b', 'n']) {
        const img = document.createElement('img');
        img.className = 'promo-choice';
        img.src = this._pieceSrc(color === 'w' ? p.toUpperCase() : p);
        img.draggable = false;
        img.addEventListener('click', (ev) => { ev.stopPropagation(); overlay.remove(); resolve(p); });
        overlay.appendChild(img);
      }
      this.el.appendChild(overlay);
    });
  }

  _showHighlights(square, targets) {
    this.highlightLayer.innerHTML = '';
    const sel = document.createElement('div');
    sel.className = 'sq-select';
    const { x, y } = this._squareToXY(square);
    sel.style.left = (x * 12.5) + '%';
    sel.style.top = (y * 12.5) + '%';
    this.highlightLayer.appendChild(sel);
    if (!this.showLegalMoves) return;
    for (const t of targets) {
      const dot = document.createElement('div');
      dot.className = 'sq-dot';
      const p = this._squareToXY(t.to);
      dot.style.left = (p.x * 12.5) + '%';
      dot.style.top = (p.y * 12.5) + '%';
      this.highlightLayer.appendChild(dot);
    }
  }

  _clearSelection() {
    this.selected = null;
    this.legalTargets = [];
    if (this.highlightLayer) this.highlightLayer.innerHTML = '';
  }

  /** No-op when the orientation is already what's asked for. Callers poll
      this on every server update, and an unconditional re-render would tear
      down the piece elements mid-slide, killing any animation in flight. */
  setOrientation(color) {
    const next = color === 'b' ? 'b' : 'w';
    if (next === this.orientation) return;
    this.orientation = next;
    // The marks are positioned in board coordinates, so flipping has to
    // redraw them -- and re-render is what would otherwise drop them.
    const last = this.lastMove;
    this.renderFEN(this.currentFEN);
    if (last) this.setLastMove(last.from, last.to);
  }

  _squareToXY(square) {
    const file = square.charCodeAt(0) - 97; // a=0..h=7
    const rank = parseInt(square[1], 10) - 1; // 1=0..8=7
    if (this.orientation === 'w') {
      return { x: file, y: 7 - rank };
    }
    return { x: 7 - file, y: rank };
  }

  _pieceSrc(ch) {
    const color = ch === ch.toUpperCase() ? 'w' : 'b';
    const type = ch.toLowerCase();
    return `/assets/sets/${this.pieceSet}/${color}${type}.png`;
  }

  /** Snaps to a position. The last-move marks go with it: a bare FEN says
      nothing about how it was reached, and leaving the previous move's
      squares lit would point at squares this position never came from.
      Callers that do know the move (animateMove, or a jump through a game)
      set it again afterwards. */
  renderFEN(fen) {
    this._renderSeq++;
    this.currentFEN = fen;
    this.pieceLayer.innerHTML = '';
    this.pieceEls = {};
    this._clearSelection();
    this.setLastMove(null, null);
    const placement = fen.split(' ')[0];
    const rows = placement.split('/');
    for (let r = 0; r < 8; r++) {
      const rank = 8 - r;
      let file = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
        const square = String.fromCharCode(97 + file) + rank;
        this._placePiece(square, ch);
        file++;
      }
    }
  }

  _placePiece(square, ch) {
    const img = document.createElement('img');
    img.className = 'piece';
    img.src = this._pieceSrc(ch);
    img.draggable = false;
    img.alt = '';
    const { x, y } = this._squareToXY(square);
    img.style.left = (x * 12.5) + '%';
    img.style.top = (y * 12.5) + '%';
    this.pieceLayer.appendChild(img);
    this.pieceEls[square] = img;
  }

  /** Slide the piece at `from` to `to`, then snap the whole board to fenAfter
      (handles captures / castling rook / promotion / en passant cleanly). */
  animateMove(from, to, fenAfter, duration = 220) {
    return new Promise((resolve) => {
      const mover = this.pieceEls[from];
      if (!mover) { this.renderFEN(fenAfter); this.setLastMove(from, to); resolve(); return; }
      // Anything that repositions the board while this slide is in flight
      // supersedes it -- tapping back through a live game mid-animation must
      // not be undone by the animation landing a fifth of a second later.
      const seq = ++this._renderSeq;

      const captured = this.pieceEls[to];
      if (captured && captured !== mover) {
        captured.style.transition = 'opacity 140ms ease';
        captured.style.opacity = '0';
      }

      const { x, y } = this._squareToXY(to);
      mover.style.zIndex = '5';
      mover.style.transition = `left ${duration}ms ease, top ${duration}ms ease`;
      // force reflow so the transition applies
      // eslint-disable-next-line no-unused-expressions
      mover.offsetHeight;
      mover.style.left = (x * 12.5) + '%';
      mover.style.top = (y * 12.5) + '%';

      setTimeout(() => {
        if (this._renderSeq !== seq) { resolve(); return; }   // superseded
        this.renderFEN(fenAfter);
        this.setLastMove(from, to);
        resolve();
      }, duration + 15);
    });
  }

  reset(fen) {
    this.renderFEN(fen || START_FEN);
  }
}
