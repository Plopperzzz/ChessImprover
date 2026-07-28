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
    this.premove = null;    // {from, to} queued to play when it's your turn
    // square -> piece char for the position on the board. Occupancy is what
    // tells a quiet destination from a capture, and the FEN it came from is
    // long gone by the time highlights are drawn.
    this.position = {};
    // In-flight pointer drag: { from, el, pointerId, origin, hover }.
    this.drag = null;
    // Bumped on every position change. A slide finishes ~235ms after it
    // starts, and whatever the board was asked to show in the meantime must
    // win -- see animateMove.
    this._renderSeq = 0;
    // Pointer events rather than click: the same press that selects a square
    // also starts a drag, and only the pointer stream can tell where the
    // piece was let go.
    this._onPointerDown = (ev) => this._handlePointerDown(ev);
    this._onPointerMove = (ev) => this._handlePointerMove(ev);
    this._onPointerUp = (ev) => this._handlePointerUp(ev);
    this.el.addEventListener('pointerdown', this._onPointerDown);
    this.el.addEventListener('pointermove', this._onPointerMove);
    this.el.addEventListener('pointerup', this._onPointerUp);
    // A cancelled pointer is the system taking the gesture away, not a drop:
    // the piece goes back where it came from.
    this.el.addEventListener('pointercancel', (ev) => {
      if (this.drag && ev.pointerId === this.drag.pointerId) this._cancelDrag();
    });
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
    const pre = this.premove;
    this._build();
    this.renderFEN(this.currentFEN);
    if (last) this.setLastMove(last.from, last.to);
    if (pre) this.setPremove(pre.from, pre.to);
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
    bg.className = 'board-bg';
    bg.draggable = false;
    bg.alt = '';
    bg.onerror = () => {
      // First fallback: try the old /assets/sets/{name}/board.png path
      if (bg.src.includes('/assets/boards/')) {
        bg.src = `/assets/sets/${this.boardSet}/board.png`;
        bg.onerror = () => {
          this.el.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 25% 25%';
        };
      } else {
        this.el.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 25% 25%';
      }
    };
    bg.src = `/assets/boards/${this.boardSet}.png`;
    this.el.appendChild(bg);

    // Under the pieces: the last-move squares tint the board, they don't sit
    // on top of the piece standing on them.
    this.lastMoveLayer = document.createElement('div');
    this.lastMoveLayer.className = 'last-move-layer';
    this.el.appendChild(this.lastMoveLayer);

    // Its own layer, and deliberately not cleared by renderFEN: a pre-move
    // has to stay visible across the opponent's move arriving, which is the
    // whole moment it exists for.
    this.premoveLayer = document.createElement('div');
    this.premoveLayer.className = 'premove-layer';
    this.el.appendChild(this.premoveLayer);

    this.pieceLayer = document.createElement('div');
    this.pieceLayer.className = 'piece-layer';
    this.el.appendChild(this.pieceLayer);

    this.highlightLayer = document.createElement('div');
    this.highlightLayer.className = 'highlight-layer';
    this.el.appendChild(this.highlightLayer);

    // The square the held piece would land on. Its own layer because
    // _showHighlights owns (and empties) the one below it.
    this.dragLayer = document.createElement('div');
    this.dragLayer.className = 'drag-layer';
    this.el.appendChild(this.dragLayer);

    this._cancelDrag();
    this._clearSelection();
  }

  /** Marks the two squares of a move queued to play the moment it's your
      turn. Call with no arguments to clear it. */
  setPremove(from, to) {
    this.premove = from && to ? { from, to } : null;
    if (!this.premoveLayer) return;
    this.premoveLayer.innerHTML = '';
    if (!this.premove) return;
    for (const square of [from, to]) {
      const mark = document.createElement('div');
      mark.className = 'sq-premove';
      const { x, y } = this._squareToXY(square);
      mark.style.left = (x * 12.5) + '%';
      mark.style.top = (y * 12.5) + '%';
      this.premoveLayer.appendChild(mark);
    }
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
    this._cancelDrag();
    this._clearSelection();
  }

  _xyToSquare(col, row) {
    let file, rank;
    if (this.orientation === 'w') { file = col; rank = 7 - row; }
    else { file = 7 - col; rank = row; }
    return String.fromCharCode(97 + file) + (rank + 1);
  }

  /** The square under a pointer event, or null when it is off the board --
      a piece let go past the edge is a cancelled drag, not a move to the
      nearest square. */
  _squareFromEvent(ev) {
    const rect = this.el.getBoundingClientRect();
    if (rect.width === 0) return null;
    const xFrac = (ev.clientX - rect.left) / rect.width;
    const yFrac = (ev.clientY - rect.top) / rect.height;
    if (xFrac < 0 || xFrac >= 1 || yFrac < 0 || yFrac >= 1) return null;
    return this._xyToSquare(Math.floor(xFrac * 8), Math.floor(yFrac * 8));
  }

  _handlePointerDown(ev) {
    if (!this.interactive) return;
    if (ev.button != null && ev.button > 0) return;
    // The promotion picker is its own thing sitting on top of the board.
    if (ev.target && ev.target.closest && ev.target.closest('.promo-overlay')) return;
    const square = this._squareFromEvent(ev);
    if (!square) return;

    // Touching the board at all withdraws a queued pre-move -- including the
    // first click of the one that replaces it.
    if (this.premove && this.handlers.onPremoveCancel) this.handlers.onPremoveCancel();

    if (this.selected) {
      const target = this.legalTargets.find((t) => t.to === square);
      if (target) {
        const from = this.selected;
        this._clearSelection();
        this._resolveAndMove(from, square, target);
        return;
      }
    }

    const targets = (this.handlers.getLegalTargets && this.handlers.getLegalTargets(square)) || [];
    if (!targets.length) { this._clearSelection(); return; }

    // Re-pressing the square that is already selected keeps the highlights
    // exactly as they are: the grow animation marks *becoming* selected, and
    // replaying it on every grab would make picking a piece back up flicker.
    if (this.selected === square) {
      this.legalTargets = targets;
    } else {
      this._clearSelection();
      this.selected = square;
      this.legalTargets = targets;
      this._showHighlights(square, targets, true);
    }

    const piece = this.pieceEls[square];
    if (!piece) return;
    this.drag = {
      from: square,
      el: piece,
      pointerId: ev.pointerId,
      origin: { left: piece.style.left, top: piece.style.top },
      hover: null,
    };
    piece.classList.add('dragging');
    try { this.el.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    this._dragTo(ev);
    ev.preventDefault();
  }

  _handlePointerMove(ev) {
    if (!this.drag || ev.pointerId !== this.drag.pointerId) return;
    this._dragTo(ev);
  }

  _handlePointerUp(ev) {
    if (!this.drag || ev.pointerId !== this.drag.pointerId) return;
    const drag = this.drag;
    const square = this._squareFromEvent(ev);
    this._cancelDrag();

    const target = square && square !== drag.from
      ? this.legalTargets.find((t) => t.to === square)
      : null;
    if (target) {
      // Land the piece on the square it was dropped on before handing the
      // move off: the animation that follows would otherwise start by
      // yanking it back to where it came from.
      const { x, y } = this._squareToXY(square);
      drag.el.style.left = (x * 12.5) + '%';
      drag.el.style.top = (y * 12.5) + '%';
      const from = drag.from;
      this._clearSelection();
      this._resolveAndMove(from, square, target);
      return;
    }

    // Released on its own square: that was a click, and the selection stands.
    // Let go anywhere else, it was a drag that missed -- put the board back.
    if (square !== drag.from) this._clearSelection();
  }

  /** Centres the held piece on the pointer and marks the square under it. */
  _dragTo(ev) {
    const rect = this.el.getBoundingClientRect();
    if (rect.width === 0) return;
    const half = 6.25; // half a square, in board percent
    this.drag.el.style.left = (((ev.clientX - rect.left) / rect.width) * 100 - half) + '%';
    this.drag.el.style.top = (((ev.clientY - rect.top) / rect.height) * 100 - half) + '%';
    this._setDragHover(this._squareFromEvent(ev));
  }

  _setDragHover(square) {
    if (!this.drag || !this.dragLayer) return;
    if (this.drag.hover === square) return;
    this.drag.hover = square;
    this.dragLayer.innerHTML = '';
    if (!square) return;
    const mark = document.createElement('div');
    const legal = this.legalTargets.some((t) => t.to === square);
    mark.className = 'sq-hover' + (legal ? ' legal' : '');
    const { x, y } = this._squareToXY(square);
    mark.style.left = (x * 12.5) + '%';
    mark.style.top = (y * 12.5) + '%';
    this.dragLayer.appendChild(mark);
  }

  /** Ends the drag and puts the piece back on the square it was lifted from.
      A caller that has somewhere better to put it says so afterwards. */
  _cancelDrag() {
    if (this.dragLayer) this.dragLayer.innerHTML = '';
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    drag.el.classList.remove('dragging');
    drag.el.style.left = drag.origin.left;
    drag.el.style.top = drag.origin.top;
    try { this.el.releasePointerCapture(drag.pointerId); } catch (e) { /* already gone */ }
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

  /** animate: true only when the square is *becoming* selected, so the circle
      sweeping out over it reads as the selection landing rather than as
      something the board does at random. */
  _showHighlights(square, targets, animate = false) {
    this.highlightLayer.innerHTML = '';
    // A pre-move selection is a different promise from a move -- it might
    // never happen -- so it doesn't get to look identical.
    const pre = !!(this.handlers.isPremove && this.handlers.isPremove());
    const sel = document.createElement('div');
    sel.className = 'sq-select' + (pre ? ' premove' : '') + (animate ? ' animate' : '');
    const { x, y } = this._squareToXY(square);
    sel.style.left = (x * 12.5) + '%';
    sel.style.top = (y * 12.5) + '%';
    this.highlightLayer.appendChild(sel);
    if (!this.showLegalMoves) return;
    for (const t of targets) {
      // A dot in the middle of an occupied square would be hidden behind the
      // piece it is about, so a capture tints the square instead and leaves a
      // hole for the piece you'd be taking.
      const mark = document.createElement('div');
      const capture = this._isCapture(square, t.to);
      mark.className = (capture ? 'sq-capture' : 'sq-dot') + (pre ? ' premove' : '');
      const p = this._squareToXY(t.to);
      mark.style.left = (p.x * 12.5) + '%';
      mark.style.top = (p.y * 12.5) + '%';
      this.highlightLayer.appendChild(mark);
    }
  }

  _isCapture(from, to) {
    const victim = this.position[to];
    const mover = this.position[from];
    if (victim) {
      if (!mover) return true;
      const victimWhite = victim === victim.toUpperCase();
      const moverWhite = mover === mover.toUpperCase();
      return victimWhite !== moverWhite;
    }
    // En passant: the only way a pawn changes file onto an empty square.
    return !!mover && mover.toLowerCase() === 'p' && from[0] !== to[0];
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
    const pre = this.premove;
    this.renderFEN(this.currentFEN);
    if (last) this.setLastMove(last.from, last.to);
    if (pre) this.setPremove(pre.from, pre.to);
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
    // Whatever was being dragged is about to be thrown away with the rest of
    // the piece elements.
    this._cancelDrag();
    this.pieceLayer.innerHTML = '';
    this.pieceEls = {};
    this.position = {};
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
    this.position[square] = ch;
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
