const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

class Board {
  constructor(el, assetSet = 'default') {
    this.el = el;
    this.assetSet = assetSet;
    this.orientation = 'w'; // 'w' -> white at bottom (standard), 'b' -> flipped
    this.currentFEN = START_FEN;
    this.pieceEls = {};
    // Interactivity state lives for the life of the Board instance, not just
    // one _build() -- setAssetSet() rebuilds the DOM layers on every switch
    // and must not silently drop click-to-move handlers set up earlier.
    this.interactive = false;
    this.handlers = {};
    this.selected = null;
    this.legalTargets = [];
    this._clickHandler = (ev) => this._handleClick(ev);
    this.el.addEventListener('click', this._clickHandler);
    this._build();
    this.renderFEN(START_FEN);
  }

  /** Switch to a different asset set (directory under /assets/sets/) and
      redraw the current position with it. */
  setAssetSet(name) {
    this.assetSet = name;
    this._build();
    this.renderFEN(this.currentFEN);
  }

  _build() {
    this.el.innerHTML = '';
    const bg = document.createElement('img');
    bg.src = `/assets/sets/${this.assetSet}/board.png`;
    bg.className = 'board-bg';
    bg.draggable = false;
    bg.alt = '';
    bg.onerror = () => {
      this.el.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 25% 25%';
    };
    this.el.appendChild(bg);

    this.pieceLayer = document.createElement('div');
    this.pieceLayer.className = 'piece-layer';
    this.el.appendChild(this.pieceLayer);

    this.highlightLayer = document.createElement('div');
    this.highlightLayer.className = 'highlight-layer';
    this.el.appendChild(this.highlightLayer);

    this._clearSelection();
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
    this.renderFEN(this.currentFEN);
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
    return `/assets/sets/${this.assetSet}/${color}${type}.png`;
  }

  renderFEN(fen) {
    this.currentFEN = fen;
    this.pieceLayer.innerHTML = '';
    this.pieceEls = {};
    this._clearSelection();
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
      if (!mover) { this.renderFEN(fenAfter); resolve(); return; }

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

      setTimeout(() => { this.renderFEN(fenAfter); resolve(); }, duration + 15);
    });
  }

  reset(fen) {
    this.renderFEN(fen || START_FEN);
  }
}
