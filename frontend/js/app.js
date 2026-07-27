/* Wires the Board + Explorer into a full page: login, PGN upload, game
   picker, move table, nav, FEN box, live Stockfish eval bar, and the engine
   settings dialog. */

const state = {
  user: null,
  explorer: new Explorer(),
  board: null,
  games: [],
  selectedGameId: null,
  ws: null,
  seq: 0,
  lastMoverColor: 'w',
  settings: null,
  engineFamilies: [],
  classifications: {}, // ply -> classification dict, from the last completed analysis job
  analysisJobId: null,
  analysisWs: null,
  sweepJobId: null,
  sweepWs: null,
  batchJobId: null,
  batchWs: null,
  batchReconnect: null,        // pending reconnect timer, so retries can't stack
  batchFailures: new Set(),    // game indexes already listed, so a replay can't duplicate them
  playMode: false,
  play: null, // { ws, chess, humanColor, turn, whiteMs, blackMs, clockEnabled, result, tick }
  // The board faces the side you played, so a game you had as Black opens
  // flipped. The nav flip button sets this override for the current game;
  // selecting another game clears it.
  flipOverride: false,
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  if (!res.ok) {
    let message = res.statusText;
    try { const body = await res.json(); message = body.detail || message; } catch (e) { /* ignore */ }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ---------------- Auth / login ---------------- */

async function boot() {
  try {
    state.user = await api('/api/auth/me');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    await initApp();
  } catch (e) {
    await showLogin();
  }
}

async function showLogin() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  const accounts = await api('/api/auth/accounts');
  const list = document.getElementById('account-list');
  list.innerHTML = '';
  if (accounts.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No accounts yet -- add one below.';
    list.appendChild(p);
  }
  for (const acc of accounts) {
    const btn = document.createElement('button');
    btn.textContent = acc.display_name;
    btn.addEventListener('click', async () => {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: acc.username }) });
      await boot();
    });
    list.appendChild(btn);
  }
}

document.getElementById('bootstrap-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const username = document.getElementById('bootstrap-username').value;
  const display_name = document.getElementById('bootstrap-displayname').value;
  await api('/api/auth/accounts', { method: 'POST', body: JSON.stringify({ username, display_name }) });
  document.getElementById('bootstrap-form').reset();
  await showLogin();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (state.ws) state.ws.close();
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

/* ---------------- App init ---------------- */

async function initApp() {
  document.getElementById('whoami').textContent = state.user.display_name;
  state.settings = await api('/api/settings');

  state.board = new Board(document.getElementById('board'), state.user.asset_set || 'default');
  // The board is shared between analysis and play-vs-Maia, so its handlers
  // dispatch on the current mode rather than being rebound on every switch.
  state.board.setInteractive(true, {
    getLegalTargets: (sq) => (state.playMode ? playLegalTargets(sq) : state.explorer.getLegalTargets(sq)),
    getMoverColor: () => (state.playMode ? state.play.chess.turn() : state.explorer.moverColor),
    onMove: (from, to, promo) => (state.playMode ? onPlayMove(from, to, promo) : onBoardMove(from, to, promo)),
  });

  wireSound();
  wireNav();
  wireFenBox();
  wirePgnUpload();
  wireSettingsDialog();
  wireAnalysis();
  wireSweep();
  wireBatch();
  wireStrength();
  wireTrend();
  wirePlay();
  connectLiveEval();

  await refreshRunPicker();
  await refreshGameList();
  syncBoardFull();
  await reattachRunningJobs();
}

/* ---------------- Board <-> Explorer sync ---------------- */

function syncBoardFull() {
  state.board.renderFEN(state.explorer.fen);
  refreshFenBox();
  refreshMoveTableHighlight();
  renderPlayerPlates();   // the to-move marker follows the position
  requestEval();
}

function refreshFenBox() {
  document.getElementById('fen-box').value = state.explorer.fen;
}

async function onBoardMove(from, to, promotion) {
  const res = state.explorer.makeMove(from, to, promotion);
  if (!res) return;
  playMoveSound(res.san || res.move || '', true);
  await state.board.animateMove(from, to, state.explorer.fen);
  refreshFenBox();
  renderMoveTable(); // a new variation node may have just been created
  refreshMoveTableHighlight();
  requestEval();
}

/* ---------------- Sound ----------------
   The assets in assets/audio/ are the usual chess-site set. Sounds only ever
   follow something the user did -- a move they played, a reply from Maia, a
   game ending -- never the analysis animation, which steps through a hundred
   positions and would be unbearable. */

const SOUND_FILES = {
  move: 'move-self.webm',
  opponent: 'move-opponent.webm',
  capture: 'capture.webm',
  castle: 'castle.webm',
  check: 'move-check.webm',
  promote: 'promote.webm',
  illegal: 'illegal.webm',
  start: 'game-start.webm',
  end: 'game-end.webm',
  lowtime: 'tenseconds.webm',
};
const soundCache = {};

function soundEnabled() {
  return localStorage.getItem('sound') !== 'off';
}

function playSound(name) {
  if (!soundEnabled()) return;
  const file = SOUND_FILES[name];
  if (!file) return;
  try {
    let audio = soundCache[name];
    if (!audio) {
      audio = new Audio(`/assets/audio/${file}`);
      audio.volume = 0.55;
      soundCache[name] = audio;
    }
    audio.currentTime = 0;
    // Autoplay policy rejects until the page has been interacted with; every
    // call here follows a click, but a rejected promise must not surface as
    // an unhandled rejection.
    const played = audio.play();
    if (played && played.catch) played.catch(() => {});
  } catch (e) { /* sound is never worth breaking a move over */ }
}

/** Picks the sound from the SAN itself, so it works for both a move the user
    played and one that arrived from the server. */
function playMoveSound(san, mine) {
  if (!san) { playSound(mine ? 'move' : 'opponent'); return; }
  if (san.includes('#') || san.includes('+')) playSound('check');
  else if (san.includes('=')) playSound('promote');
  else if (san.startsWith('O-O')) playSound('castle');
  else if (san.includes('x')) playSound('capture');
  else playSound(mine ? 'move' : 'opponent');
}

function wireSound() {
  const btn = document.getElementById('sound-btn');
  const paint = () => {
    btn.textContent = soundEnabled() ? '🔊' : '🔇';
    btn.title = soundEnabled() ? 'Sound on — click to mute' : 'Muted — click for sound';
  };
  btn.addEventListener('click', () => {
    localStorage.setItem('sound', soundEnabled() ? 'off' : 'on');
    paint();
    if (soundEnabled()) playSound('move');   // confirm it actually works
  });
  paint();
}

/* ---------------- Board orientation and the player plates ----------------
   Section 5 wants the board facing the side you played. That's one decision
   applied in one place: everything that changes whose game is on the board
   calls applyOrientation(), rather than each caller doing its own
   yourColor-to-orientation dance and drifting. */

function bottomColor() {
  const base = state.playMode
    ? (state.play && state.play.humanColor === 'b' ? 'b' : 'w')
    // 'unassigned' (your display name matched neither header) falls back to
    // the conventional White-at-bottom rather than guessing.
    : (state.explorer.yourColor === 'b' ? 'b' : 'w');
  return state.flipOverride ? (base === 'w' ? 'b' : 'w') : base;
}

function applyOrientation() {
  state.board.setOrientation(bottomColor());
  renderPlayerPlates();
}

/** Names, ratings, result and clocks on the two plates, keyed to which colour
    is currently at the bottom -- so flipping the board moves the names too. */
function renderPlayerPlates() {
  const bottom = bottomColor();
  const sides = { w: {}, b: {} };

  if (state.playMode && state.play) {
    const p = state.play;
    for (const colour of ['w', 'b']) {
      const human = colour === p.humanColor;
      sides[colour] = {
        name: human ? (state.user.display_name || 'You') : 'Maia3',
        rating: human ? '' : (p.maiaElo ? String(p.maiaElo) : ''),
        you: human,
        result: '',
        clock: p.clockEnabled ? formatClock(colour === 'w' ? p.whiteMs : p.blackMs) : '',
        toMove: !p.result && p.turn === colour,
        low: p.clockEnabled && (colour === 'w' ? p.whiteMs : p.blackMs) < 30000,
      };
    }
    if (p.result) {
      const marks = { '1-0': ['1', '0'], '0-1': ['0', '1'], '1/2-1/2': ['½', '½'] };
      const [white, black] = marks[p.result] || ['', ''];
      sides.w.result = white; sides.b.result = black;
    }
  } else {
    const headers = state.explorer.headers || {};
    // No game loaded (or a bare FEN) means there is nobody to name -- the
    // placeholders must not claim one of them is you just because yourColor
    // defaults to White.
    const loaded = !!(headers.White || headers.Black);
    const yours = loaded ? state.explorer.yourColor : null;
    const marks = { '1-0': ['1', '0'], '0-1': ['0', '1'], '1/2-1/2': ['½', '½'] };
    const [white, black] = marks[headers.Result] || ['', ''];
    sides.w = {
      name: headers.White || 'White', rating: headers.WhiteElo || '',
      you: yours === 'w', result: white, placeholder: !loaded,
      clock: '', toMove: state.explorer.moverColor === 'w',
    };
    sides.b = {
      name: headers.Black || 'Black', rating: headers.BlackElo || '',
      you: yours === 'b', result: black, placeholder: !loaded,
      clock: '', toMove: state.explorer.moverColor === 'b',
    };
  }

  const top = bottom === 'w' ? 'b' : 'w';
  fillPlate(document.getElementById('plate-top'), sides[top], top);
  fillPlate(document.getElementById('plate-bottom'), sides[bottom], bottom);
}

function fillPlate(el, data, colour) {
  el.querySelector('.plate-dot').className = 'plate-dot dot-' + colour;
  el.querySelector('.plate-name').textContent = data.name || '—';
  el.querySelector('.plate-rating').textContent = data.rating ? `(${data.rating})` : '';
  el.querySelector('.plate-you').classList.toggle('hidden', !data.you);
  el.querySelector('.plate-result').textContent = data.result || '';
  const clock = el.querySelector('.plate-clock');
  clock.textContent = data.clock || '';
  clock.classList.toggle('hidden', !data.clock);
  clock.classList.toggle('low', !!data.low);
  el.classList.toggle('to-move', !!data.toMove);
  el.classList.toggle('placeholder', !!data.placeholder);
}

function wireNav() {
  document.getElementById('nav-flip').addEventListener('click', () => {
    state.flipOverride = !state.flipOverride;
    applyOrientation();
  });
  document.getElementById('nav-start').addEventListener('click', () => {
    state.explorer.goToStart();
    syncBoardFull();
  });
  document.getElementById('nav-prev').addEventListener('click', async () => {
    const res = state.explorer.stepBackward();
    if (!res) return;
    playMoveSound(res.san, true);
    await state.board.animateMove(res.to, res.from, state.explorer.fen);
    refreshFenBox();
    refreshMoveTableHighlight();
    requestEval();
  });
  document.getElementById('nav-next').addEventListener('click', async () => {
    const res = state.explorer.stepForward();
    if (!res) return;
    playMoveSound(res.san, true);
    await state.board.animateMove(res.from, res.to, state.explorer.fen);
    refreshFenBox();
    refreshMoveTableHighlight();
    requestEval();
  });
  document.getElementById('nav-end').addEventListener('click', () => {
    state.explorer.goToMainlineEnd();
    syncBoardFull();
  });
  document.addEventListener('keydown', (ev) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (ev.key === 'ArrowLeft') document.getElementById('nav-prev').click();
    if (ev.key === 'ArrowRight') document.getElementById('nav-next').click();
    if (ev.key === 'ArrowUp') document.getElementById('nav-start').click();
    if (ev.key === 'ArrowDown') document.getElementById('nav-end').click();
    if (ev.key === 'f' || ev.key === 'F') document.getElementById('nav-flip').click();
  });
}

function wireFenBox() {
  document.getElementById('fen-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('fen-box').value);
  });
  document.getElementById('fen-goto-btn').addEventListener('click', () => {
    const fen = document.getElementById('fen-goto').value.trim();
    if (!fen) return;
    const ok = state.explorer.loadFEN(fen);
    if (!ok) { alert('That FEN could not be parsed.'); return; }
    state.selectedGameId = null;
    resetAnalysisState();
    renderGamePicker();
    renderMoveTable();
    syncBoardFull();
  });
}

/* ---------------- PGN upload + game picker ---------------- */

function wirePgnUpload() {
  document.getElementById('pgn-upload-btn').addEventListener('click', async () => {
    const files = document.getElementById('pgn-files').files;
    const pasted = document.getElementById('pgn-paste').value;
    const status = document.getElementById('upload-status');
    if (files.length === 0 && !pasted.trim()) {
      status.textContent = 'Choose a .pgn file or paste PGN text first.';
      return;
    }
    const form = new FormData();
    for (const f of files) form.append('files', f);
    if (pasted.trim()) form.append('pasted_pgn', pasted);
    status.textContent = 'Uploading...';
    try {
      const result = await api('/api/games/upload', { method: 'POST', body: form });
      status.textContent = `Parsed ${result.created} game(s).`;
      document.getElementById('pgn-files').value = '';
      document.getElementById('pgn-paste').value = '';
      await refreshGameList();
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  });
}

async function refreshGameList() {
  state.games = await api('/api/games');
  renderGamePicker();
}

function renderGamePicker() {
  const wrap = document.getElementById('game-picker');
  wrap.innerHTML = '';
  if (state.games.length === 0) {
    wrap.innerHTML = '<p style="color:var(--muted);font-size:13px;">No games loaded yet.</p>';
    return;
  }
  for (const g of state.games) {
    const row = document.createElement('div');
    row.className = 'game-row' + (g.id === state.selectedGameId ? ' active' : '');
    const opponent = g.your_color === 'w' ? g.black : g.your_color === 'b' ? g.white : `${g.white} vs ${g.black}`;
    const date = g.utc_date_header || g.date_header || '?';
    const left = document.createElement('span');
    left.textContent = `${opponent || '?'} — ${date} — ${g.result || '?'}`;
    row.appendChild(left);
    if (g.your_color === 'unassigned') {
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = '⚠ unassigned';
      row.appendChild(flag);
    }
    if (g.analyzed) {
      const mark = document.createElement('span');
      mark.className = 'analyzed-mark';
      mark.textContent = g.analyzed === 'full' ? '\u25CF full' : '\u25CB quick';
      mark.title = `has a saved ${g.analyzed} analysis`;
      row.appendChild(mark);
    }
    const del = document.createElement('button');
    del.className = 'game-delete';
    del.textContent = '\u2715';
    del.title = 'Delete this game and its saved analysis';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();   // don't also select the row we're deleting
      const who = `${g.white || '?'} vs ${g.black || '?'}`;
      const extra = g.analyzed ? ' and its saved analysis' : '';
      if (!confirm(`Delete ${who}${extra}? This cannot be undone.`)) return;
      await api(`/api/games/${g.id}`, { method: 'DELETE' });
      if (state.selectedGameId === g.id) {
        state.selectedGameId = null;
        resetAnalysisState();
      }
      await refreshGameList();
    });
    row.appendChild(del);
    row.addEventListener('click', () => selectGame(g.id));
    wrap.appendChild(row);
  }
}

async function selectGame(gameId) {
  const game = await api(`/api/games/${gameId}`);
  state.selectedGameId = gameId;
  resetAnalysisState();
  renderGamePicker();
  state.explorer.loadPGN(game.pgn_text, state.user.display_name);
  state.flipOverride = false;
  applyOrientation();
  state.explorer.goToStart();
  renderMoveTable();
  syncBoardFull();
  await loadSavedAnalysis(gameId);
}

/** Analyses are saved, so switching games in the picker restores what was
    already computed rather than throwing it away. A game with nothing stored
    just leaves the panels empty. */
async function loadSavedAnalysis(gameId) {
  let saved;
  try {
    saved = await api(`/api/analysis/saved/${gameId}`);
  } catch (e) {
    return; // nothing analysed for this game yet
  }
  if (state.selectedGameId !== gameId) return; // user moved on while we fetched

  state.classifications = {};
  for (const m of saved.moves) state.classifications[m.ply] = m;
  renderMoveTable();
  refreshMoveTableHighlight();
  renderAnalysisSummary(saved.moves);
  renderEvalPlot();

  const when = (saved.analyzed_at || '').replace('T', ' ');
  document.getElementById('analysis-status').textContent =
    `Saved ${saved.mode} analysis from ${when}.`;
  document.getElementById('analysis-progress-fill').style.width = '100%';

  if (saved.results) {
    renderSweepResults({ results: saved.results, your_color: state.explorer.yourColor });
    renderBlunderElo(saved.moves, state.explorer.yourColor);
    document.getElementById('sweep-status').textContent = 'From the saved analysis.';
    document.getElementById('sweep-progress-fill').style.width = '100%';
  }
}

/* ---------------- Move table (mainline, two columns, + variations) ---------------- */

/** The left column is yours whichever colour you played (section 5), which is
    only readable if the header says whose it is. */
function setMoveTableHeader(yourColor, headers) {
  const names = { w: headers.White || 'White', b: headers.Black || 'Black' };
  const theirColor = yourColor === 'w' ? 'b' : 'w';
  const known = !!(headers.White || headers.Black);
  const mine = state.explorer.yourColor === 'w' || state.explorer.yourColor === 'b';
  document.getElementById('mt-yours').textContent =
    known ? (mine ? `${names[yourColor]} (you)` : names[yourColor]) : '';
  document.getElementById('mt-theirs').textContent = known ? names[theirColor] : '';
}

function renderMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const mainlineIds = state.explorer.mainlineNodeIds;
  const yourColor = state.explorer.yourColor === 'b' ? 'b' : 'w'; // unassigned defaults to White-on-left
  setMoveTableHeader(yourColor, state.explorer.headers || {});

  for (let i = 0; i < mainlineIds.length; i += 2) {
    const whiteId = mainlineIds[i];
    const blackId = mainlineIds[i + 1];
    const yourId = yourColor === 'w' ? whiteId : blackId;
    const theirId = yourColor === 'w' ? blackId : whiteId;

    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'ply-num';
    numTd.textContent = (i / 2 + 1) + '.';
    tr.appendChild(numTd);

    for (const id of [yourId, theirId]) {
      const td = document.createElement('td');
      if (id !== undefined) {
        const node = state.explorer.nodes[id];
        const cls = state.classifications[node.ply];
        td.textContent = node.san + (cls ? CLASSIFICATION_SUFFIX[cls.classification] : '');
        if (cls) td.classList.add('cls-' + cls.classification);
        td.dataset.nodeId = id;
        td.addEventListener('click', () => {
          state.explorer.goToNode(id);
          syncBoardFull();
        });
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);

    // Any variations branching off either move in this pair get a full-width
    // row underneath, so the mainline stays exactly two columns as required.
    const branchPoints = [whiteId, blackId].filter(
      (id) => id !== undefined && state.explorer.nodes[id].children.length > 1
    );
    if (branchPoints.length) {
      const vtr = document.createElement('tr');
      vtr.className = 'variation-row';
      const vtd = document.createElement('td');
      vtd.colSpan = 3;
      for (const id of branchPoints) {
        const node = state.explorer.nodes[id];
        for (let k = 1; k < node.children.length; k++) {
          vtd.appendChild(buildVariationSpan(node.children[k]));
        }
      }
      vtr.appendChild(vtd);
      tbody.appendChild(vtr);
    }
  }
}

/** Builds "(1...e5 2.Nf3 ...)" for one variation branch, recursing into any
    further sub-variations found along the way, with a delete control. */
function buildVariationSpan(startNodeId) {
  const wrap = document.createElement('span');
  wrap.className = 'variation';
  wrap.appendChild(document.createTextNode('('));
  appendVariationLine(startNodeId, wrap, true);
  wrap.appendChild(document.createTextNode(') '));

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'var-delete';
  del.title = 'Delete this variation';
  del.textContent = '✕';
  del.addEventListener('click', (ev) => {
    ev.stopPropagation();
    state.explorer.deleteVariation(startNodeId);
    renderMoveTable();
    syncBoardFull();
  });
  wrap.appendChild(del);
  return wrap;
}

function appendVariationLine(nodeId, container, isFirstMove) {
  let id = nodeId;
  let first = isFirstMove;
  while (id !== undefined && id !== null) {
    const node = state.explorer.nodes[id];
    const moveSpan = document.createElement('span');
    moveSpan.className = 'var-move';
    const moveNum = Math.ceil(node.ply / 2);
    const isWhiteMove = node.ply % 2 === 1;
    const label = isWhiteMove ? `${moveNum}.` : first ? `${moveNum}...` : '';
    moveSpan.textContent = (label ? label + ' ' : '') + node.san;
    moveSpan.dataset.nodeId = node.id;
    moveSpan.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.explorer.goToNode(node.id);
      syncBoardFull();
    });
    container.appendChild(moveSpan);
    container.appendChild(document.createTextNode(' '));
    first = false;

    for (let k = 1; k < node.children.length; k++) {
      container.appendChild(buildVariationSpan(node.children[k]));
    }
    id = node.children[0];
  }
}

function refreshMoveTableHighlight() {
  const container = document.getElementById('move-table');
  const current = state.explorer.currentNodeId;
  for (const el of container.querySelectorAll('[data-node-id]')) {
    el.classList.toggle('current', Number(el.dataset.nodeId) === current);
  }
  markEvalPlotPosition();
}

/* ---------------- Evaluation plot ----------------
   The analysed game's evaluation across its whole length, always from
   White's point of view (the convention every chess site uses: up is good
   for White) rather than from yours, so the shape doesn't invert between a
   game you had as White and one you had as Black.

   It plots win probability, not centipawns: +3 and +9 are both "winning",
   and on a centipawn axis the second dwarfs the first and flattens the
   opening into a straight line. This is the same win-probability curve the
   move classifications are computed from, so a blunder marker always sits on
   a visible cliff. */

/** Win probability for White, from a mover-perspective centipawn score at a
    given ply. `cp_after` is scored for whoever is to move *after* that ply,
    which is White on even plies and Black on odd ones. */
function whiteWinProb(cp, ply) {
  const white = ply % 2 === 1 ? -cp : cp;
  return 1 / (1 + Math.exp(-0.00368208 * white));
}

const PLOT_MARK_COLOURS = {
  blunder: '#e05050', mistake: '#e08040', inaccuracy: '#e0c040',
  great: '#5fc9e8', brilliant: '#21c2a4',
};

function evalPlotMoves() {
  const plies = Object.keys(state.classifications).map(Number).sort((a, b) => a - b);
  return plies
    .map((ply) => state.classifications[ply])
    .filter((m) => m && m.cp_after !== null && m.cp_after !== undefined);
}

function renderEvalPlot() {
  const wrap = document.getElementById('eval-plot-wrap');
  const host = document.getElementById('eval-plot');
  const moves = evalPlotMoves();
  host.innerHTML = '';
  if (moves.length < 2) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  const W = 600, H = 110, padB = 0;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'eval-plot-svg',
                             preserveAspectRatio: 'none' });
  const n = moves.length;
  const sx = (i) => (i / n) * W;          // i = 0 is the starting position
  const sy = (wp) => H - wp * (H - padB);

  // The starting position is level by definition; including it stops the
  // curve from beginning mid-air at move 1.
  const points = [[sx(0), 0.5]];
  moves.forEach((m, i) => points.push([sx(i + 1), whiteWinProb(m.cp_after, m.ply)]));

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
  // White's share is the filled part, which is how a chess site reads.
  svg.appendChild(svgEl('path', {
    d: `${line} L${W},${H} L0,${H} Z`, fill: '#d6d9e0', stroke: 'none', opacity: '0.88',
  }));
  svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: sy(0.5), y2: sy(0.5),
                                  stroke: '#8b93a7', 'stroke-width': 1, 'stroke-dasharray': '4,4' }));

  for (let i = 0; i < moves.length; i++) {
    const colour = PLOT_MARK_COLOURS[moves[i].classification];
    if (!colour) continue;
    svg.appendChild(svgEl('circle', {
      cx: sx(i + 1), cy: sy(whiteWinProb(moves[i].cp_after, moves[i].ply)),
      r: 5, fill: colour, stroke: '#14161c', 'stroke-width': 1.5,
    }));
  }

  const marker = svgEl('line', { id: 'eval-plot-marker', x1: 0, x2: 0, y1: 0, y2: H,
                                 stroke: '#5b8dee', 'stroke-width': 2, opacity: '0' });
  svg.appendChild(marker);
  host.appendChild(svg);

  // Clicking anywhere on the plot jumps to that point in the game, which is
  // the whole reason to draw it rather than just list the blunders.
  host.onclick = (ev) => {
    const rect = host.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const index = Math.min(moves.length - 1, Math.max(0, Math.round(frac * n) - 1));
    goToMainlinePly(moves[index].ply);
  };
  host.onmousemove = (ev) => {
    const rect = host.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const index = Math.min(moves.length - 1, Math.max(0, Math.round(frac * n) - 1));
    const m = moves[index];
    const wp = whiteWinProb(m.cp_after, m.ply);
    document.getElementById('eval-plot-hint').textContent =
      `${Math.ceil(m.ply / 2)}${m.ply % 2 ? '.' : '...'} ${m.san || ''}  `
      + `White ${(wp * 100).toFixed(0)}%`
      + (PLOT_MARK_COLOURS[m.classification] ? `  — ${m.classification}` : '');
  };
  host.onmouseleave = () => { document.getElementById('eval-plot-hint').textContent = ''; };
  markEvalPlotPosition();
}

function goToMainlinePly(ply) {
  const id = state.explorer.mainlineNodeIds[ply - 1];
  if (id === undefined) return;
  state.explorer.goToNode(id);
  syncBoardFull();
}

/** Marks where in the game the board currently is. */
function markEvalPlotPosition() {
  const marker = document.getElementById('eval-plot-marker');
  if (!marker) return;
  const moves = evalPlotMoves();
  if (!moves.length) return;
  const ply = state.explorer.mainlineNodeIds.indexOf(state.explorer.currentNodeId) + 1;
  if (!ply) { marker.setAttribute('opacity', '0'); return; }
  const index = moves.findIndex((m) => m.ply === ply);
  if (index < 0) { marker.setAttribute('opacity', '0'); return; }
  const x = ((index + 1) / moves.length) * 600;
  marker.setAttribute('x1', x);
  marker.setAttribute('x2', x);
  marker.setAttribute('opacity', '1');
}

/* ---------------- Quick analysis (Stockfish-only move classification) ---------------- */

const CLASSIFICATION_SUFFIX = { good: '', inaccuracy: '?!', mistake: '?', blunder: '??', great: '!', brilliant: '!!' };

function resetAnalysisState() {
  state.classifications = {};
  state.analysisJobId = null;
  if (state.analysisWs) { state.analysisWs.close(); state.analysisWs = null; }
  document.getElementById('quick-analysis-btn').disabled = !state.selectedGameId;
  document.getElementById('full-analysis-btn').disabled = !state.selectedGameId;
  document.getElementById('analysis-cancel').classList.add('hidden');
  resetSweepState();
  document.getElementById('analysis-progress-fill').style.width = '0%';
  document.getElementById('analysis-status').textContent = '';
  document.getElementById('analysis-summary').innerHTML = '';
  document.getElementById('eval-plot-wrap').classList.add('hidden');
  document.getElementById('eval-plot').innerHTML = '';
}

async function refreshRunPicker() {
  const sel = document.getElementById('run-picker');
  const previous = sel.value;
  const runs = await api('/api/runs');
  sel.innerHTML = '';
  for (const run of runs) {
    const opt = document.createElement('option');
    opt.value = run.id;
    opt.textContent = `${run.name} (${run.game_count})`;
    // Kept on the option so the delete button can say what it's about to
    // destroy without another request.
    opt.dataset.name = run.name;
    opt.dataset.count = run.game_count;
    opt.dataset.default = run.is_default ? '1' : '';
    sel.appendChild(opt);
  }
  if (previous && runs.some((r) => String(r.id) === previous)) sel.value = previous;

  // The trend panel can be scoped to one run; "All runs" is the default
  // because a trend built from a single batch is usually what you don't want.
  for (const id of ['trend-run', 'strength-run']) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">All runs</option>';
    for (const run of runs) {
      const opt = document.createElement('option');
      opt.value = run.id;
      opt.textContent = run.name;
      sel.appendChild(opt);
    }
    if (prev && runs.some((r) => String(r.id) === prev)) sel.value = prev;
  }
}

/** Throws away a run and everything analysed into it. The games stay in the
    library -- it's the analysis that goes, so a run that was swept with the
    wrong settings can be redone rather than lived with. The default run is
    emptied instead of removed, since something has to catch the next
    analysis. */
async function deleteSelectedRun() {
  const sel = document.getElementById('run-picker');
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  const name = opt.dataset.name || opt.textContent;
  const count = Number(opt.dataset.count || 0);
  const held = count ? `the ${count} analysed game(s) in it` : 'it (nothing analysed in it yet)';
  const question = opt.dataset.default
    ? `Clear "${name}"? That deletes ${held}. The run itself is kept — it's the default one. The games stay in your library.`
    : `Delete "${name}" and ${held}? The games stay in your library.`;
  if (!confirm(question + '\n\nThis cannot be undone.')) return;

  const btn = document.getElementById('run-delete');
  btn.disabled = true;
  try {
    const res = await api(`/api/runs/${sel.value}`, { method: 'DELETE' });
    await refreshRunPicker();
    await refreshGameList();     // the analysed/quick/full marks change with it
    // What's on screen may be exactly what was just deleted, so clear the
    // panels and reload whatever (if anything) is still stored for this game.
    if (state.selectedGameId && !state.analysisJobId) {
      resetAnalysisState();
      renderMoveTable();
      refreshMoveTableHighlight();
      await loadSavedAnalysis(state.selectedGameId);
    }
    refreshTrend();              // both fits are over stored runs, so both move
    refreshStrength();
    document.getElementById('analysis-status').textContent =
      `${res.cleared ? 'Cleared' : 'Deleted'} "${res.name}" (${res.games_removed} analysed game(s)).`;
  } catch (e) {
    alert('Could not delete that run: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

function wireAnalysis() {
  document.getElementById('run-new').addEventListener('click', async () => {
    const name = prompt('Name for the new run:');
    if (!name || !name.trim()) return;
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await refreshRunPicker();
    document.getElementById('run-picker').value = run.id;
  });
  document.getElementById('run-delete').addEventListener('click', deleteSelectedRun);
  document.getElementById('quick-analysis-btn').addEventListener('click', () => startAnalysis('quick'));
  document.getElementById('full-analysis-btn').addEventListener('click', () => startAnalysis('full'));
  document.getElementById('analysis-cancel').addEventListener('click', cancelAnalysis);
}

/** A job can now sit in the worker-pool queue behind the other user's run
    (section 10), so there has to be a way to withdraw it rather than only
    abandon it. Also stops one that's already running. */
async function cancelAnalysis() {
  if (!state.analysisJobId) return;
  document.getElementById('analysis-cancel').disabled = true;
  document.getElementById('analysis-status').textContent = 'Cancelling...';
  try {
    await api(`/api/analysis/${state.analysisJobId}/cancel`, { method: 'POST' });
  } finally {
    document.getElementById('analysis-cancel').disabled = false;
  }
}

/** Shared wording for the pool's queue events, so all three panels explain a
    stalled progress bar the same way. */
function queuedText(msg) {
  const ahead = msg.ahead
    ? `${msg.ahead} job(s) ahead of it`
    : 'waiting for the engines in use to free up';
  return `Queued — ${ahead} (needs ${msg.slots} of ${msg.capacity} worker slot(s)).`;
}

/** mode: 'quick' (Stockfish only) or 'full' (adds the Maia sweep, so also
    Great/Brilliant and the blunder-Elo correlation). */
async function startAnalysis(mode) {
  if (!state.selectedGameId) return;
  setAnalysisButtonsEnabled(false);
  state.classifications = {};
  document.getElementById('analysis-summary').innerHTML = '';
  document.getElementById('analysis-status').textContent =
    mode === 'full' ? 'Starting full analysis (Stockfish, then the Maia sweep)...' : 'Starting...';
  const url = mode === 'full' ? '/api/sweep/full' : '/api/analysis/quick';
  try {
    const runId = document.getElementById('run-picker').value;
    const res = await api(url, { method: 'POST', body: JSON.stringify({
      game_id: state.selectedGameId,
      run_id: runId ? Number(runId) : null,
    }) });
    state.analysisJobId = res.job_id;
    document.getElementById('analysis-cancel').classList.remove('hidden');
    watchAnalysisJob(res.job_id);
  } catch (e) {
    document.getElementById('analysis-status').textContent = 'Error: ' + e.message;
    setAnalysisButtonsEnabled(true);
  }
}

function setAnalysisButtonsEnabled(enabled) {
  const on = enabled && !!state.selectedGameId;
  document.getElementById('quick-analysis-btn').disabled = !on;
  document.getElementById('full-analysis-btn').disabled = !on;
}

function watchAnalysisJob(jobId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/analysis/${jobId}`);
  state.analysisWs = ws;

  // Progress arrives faster than the board's slide animation can keep up
  // with (each Stockfish eval can resolve in well under 235ms), and 'message'
  // events fire independently -- without this chain, overlapping
  // animateToMainlinePly() calls can finish out of order and the status text
  // from a late-resolving earlier event clobbers the final "Done.". Chaining
  // onto a single promise processes messages strictly in arrival order.
  let chain = Promise.resolve();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handleAnalysisMessage(msg));
  });

  // Reconnect on drop (e.g. phone screen lock) as long as the job is still ours --
  // the server replays the full event backlog so we catch up immediately.
  ws.addEventListener('close', () => {
    if (state.analysisWs === ws && state.analysisJobId === jobId) {
      setTimeout(() => watchAnalysisJob(jobId), 2000);
    }
  });
}

async function handleAnalysisMessage(msg) {
  if (msg.type === 'queued') {
    document.getElementById('analysis-status').textContent = queuedText(msg);
  } else if (msg.type === 'started') {
    document.getElementById('analysis-status').textContent = 'A worker freed up — starting...';
  } else if (msg.type === 'progress') {
    // Full mode reports an overall fraction across both passes; quick mode
    // only has the one, so fall back to its ply counter.
    if (msg.phase === 'maia') {
      if (msg.fen) state.board.renderFEN(msg.fen);
      document.getElementById('analysis-status').textContent =
        `Maia sweep at Elo ${msg.elo}: ${msg.done} / ${msg.total}`;
    } else {
      await animateToMainlinePly(msg.ply);
      document.getElementById('analysis-status').textContent =
        `Evaluating move ${msg.ply} / ${msg.total}...`;
    }
    const pct = msg.fraction !== undefined
      ? Math.round(msg.fraction * 100)
      : (msg.total ? Math.round((msg.ply / msg.total) * 100) : 100);
    document.getElementById('analysis-progress-fill').style.width = pct + '%';
  } else if (msg.type === 'done') {
    state.classifications = {};
    for (const m of msg.moves) state.classifications[m.ply] = m;
    renderMoveTable();
    refreshMoveTableHighlight();
    renderAnalysisSummary(msg.moves);
    renderEvalPlot();
    if (msg.mode === 'full') {
      renderSweepResults(msg);            // reuse the sweep panel for the estimate
      renderBlunderElo(msg.moves, msg.your_color);
      document.getElementById('sweep-status').textContent = 'From the full analysis.';
      document.getElementById('sweep-progress-fill').style.width = '100%';
    }
    document.getElementById('analysis-status').textContent = 'Done and saved.';
    document.getElementById('analysis-progress-fill').style.width = '100%';
    finishAnalysis();
    await refreshRunPicker();
    await refreshGameList();
    if (msg.mode === 'full') { refreshTrend(); refreshStrength(); }  // new sweep data
    syncBoardFull();
  } else if (msg.type === 'error') {
    document.getElementById('analysis-status').textContent =
      msg.message === 'cancelled' ? 'Cancelled.' : 'Error: ' + msg.message;
    finishAnalysis();
  }
}

function finishAnalysis() {
  state.analysisJobId = null;
  if (state.analysisWs) { state.analysisWs.close(); state.analysisWs = null; }
  document.getElementById('analysis-cancel').classList.add('hidden');
  setAnalysisButtonsEnabled(true);
}

/** Steps the board (and the explorer's actual position) to the mainline
    position after `ply` moves, animating from wherever it currently is --
    this is what makes the board visibly step through the game in sync with
    analysis progress (section 6). */
async function animateToMainlinePly(ply) {
  if (ply === 0) {
    state.explorer.goToStart();
    syncBoardFull();
    return;
  }
  const nodeId = state.explorer.mainlineNodeIds[ply - 1];
  if (nodeId === undefined) return;
  const node = state.explorer.nodes[nodeId];
  state.explorer.goToNode(nodeId);
  await state.board.animateMove(node.from, node.to, node.fenAfter);
  refreshFenBox();
  refreshMoveTableHighlight();
  requestEval();
}

function renderAnalysisSummary(moves) {
  const counts = { brilliant: 0, great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const m of moves) counts[m.classification]++;
  const el = document.getElementById('analysis-summary');
  el.innerHTML = '';
  const labels = { brilliant: 'Brilliant', great: 'Great', good: 'Good',
                   inaccuracy: 'Inaccuracies', mistake: 'Mistakes', blunder: 'Blunders' };
  for (const key of ['brilliant', 'great', 'good', 'inaccuracy', 'mistake', 'blunder']) {
    if (counts[key] === 0 && (key === 'brilliant' || key === 'great')) continue;
    const span = document.createElement('span');
    span.className = 'cnt-' + key;
    span.textContent = `${labels[key]}: ${counts[key]}`;
    el.appendChild(span);
  }
}

/** "Would a player of this strength have avoided it?" -- for each mistake or
    blunder, the weakest swept Elo whose Maia top-1 was the move actually
    played. No swept Elo playing it means there's no correlation to report,
    which is different from a correlation of zero. */
function renderBlunderElo(moves, yourColor) {
  const box = document.getElementById('sweep-results');
  const bad = moves.filter((m) => m.lowest_matching_elo !== undefined
                               && ['mistake', 'blunder'].includes(m.classification));
  if (!bad.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'sweep-player';
  const title = document.createElement('div');
  title.className = 'sweep-who';
  title.textContent = 'Mistakes & blunders vs Maia strength';
  wrap.appendChild(title);
  const list = document.createElement('div');
  list.className = 'blunder-elo';
  for (const m of bad) {
    const side = m.ply % 2 === 1 ? 'w' : 'b';
    const row = document.createElement('div');
    const who = side === yourColor ? 'you' : 'opponent';
    row.innerHTML = m.lowest_matching_elo === null
      ? `<b>${m.san}</b> (${who}) — no swept Elo played this`
      : `<b>${m.san}</b> (${who}) — first played by Maia at ${m.lowest_matching_elo}`;
    list.appendChild(row);
  }
  wrap.appendChild(list);
  box.appendChild(wrap);
}

/* ---------------- Picking running jobs back up ---------------- */

/** Jobs live in the server, not in this page. A phone that gets switched away
    from will happily discard the tab, and the batch it was watching carries on
    regardless -- so on load we ask what's still running and reattach to it,
    rather than showing an idle panel over a run that never stopped (and
    inviting a second run to be started on top of the first). */
async function reattachRunningJobs() {
  let active = [];
  try {
    active = await api('/api/analysis/active');
  } catch (e) {
    return;
  }
  const batch = active.find((j) => j.kind === 'batch');
  if (batch) attachBatch(batch);

  // A single-game Full analysis is long enough to survive a screen lock too.
  // It needs its game loaded to make sense of the progress, which a reload
  // will have forgotten, so select it first.
  const single = active.find((j) => ['quick', 'full', 'sweep'].includes(j.kind));
  if (single && !state.batchJobId) {
    if (state.selectedGameId !== single.game_id) await selectGame(single.game_id);
    if (single.kind === 'sweep') {
      state.sweepJobId = single.job_id;
      document.getElementById('sweep-cancel').classList.remove('hidden');
      watchSweepJob(single.job_id);
    } else {
      state.analysisJobId = single.job_id;
      setAnalysisButtonsEnabled(false);
      document.getElementById('analysis-cancel').classList.remove('hidden');
      watchAnalysisJob(single.job_id);
    }
  }
}

/** Reconnects sockets the moment the page is looked at again. A backgrounded
    tab has its timers throttled and can come back holding a socket that looks
    open but is dead, so waiting for the retry timer would leave the panel
    frozen for however long the phone feels like. */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.user) return;
  if (state.batchJobId) {
    if (state.batchWs) {
      const stale = state.batchWs;
      state.batchWs = null;      // so its close handler doesn't also reconnect
      stale.close();
    }
    watchBatchJob(state.batchJobId);
  } else {
    await reattachRunningJobs();
  }
});

/* ---------------- Batch analysis (spec section 12) ---------------- */

function wireBatch() {
  document.getElementById('batch-start').addEventListener('click', startBatch);
  document.getElementById('batch-cancel').addEventListener('click', cancelBatch);
  for (const id of ['batch-mode', 'batch-scope']) {
    document.getElementById(id).addEventListener('change', refreshBatchPreview);
  }
  refreshBatchPreview();
}

/** Says how many games a batch would cover before committing to what may be
    a very long run. */
async function refreshBatchPreview() {
  if (state.batchJobId) return; // mid-run, the status line is more useful
  const mode = document.getElementById('batch-mode').value;
  const scope = document.getElementById('batch-scope').value;
  try {
    const info = await api(`/api/batch/preview?mode=${mode}&scope=${scope}`);
    if (state.batchJobId) return;   // reattached while this was in flight
    document.getElementById('batch-status').textContent =
      info.count ? `${info.count} game(s) would be analysed.` : 'Nothing to analyse for that selection.';
    document.getElementById('batch-start').disabled = info.count === 0;
  } catch (e) {
    document.getElementById('batch-status').textContent = '';
  }
}

async function startBatch() {
  const mode = document.getElementById('batch-mode').value;
  const scope = document.getElementById('batch-scope').value;
  const runId = document.getElementById('run-picker').value;
  document.getElementById('batch-start').disabled = true;
  document.getElementById('batch-status').textContent = 'Starting...';
  try {
    const res = await api('/api/batch', { method: 'POST', body: JSON.stringify({
      mode, scope, run_id: runId ? Number(runId) : null,
    }) });
    attachBatch(res);
    if (res.attached) {
      document.getElementById('batch-status').textContent =
        'That batch is already running — reattached to it.';
    }
  } catch (e) {
    document.getElementById('batch-status').textContent = 'Error: ' + e.message;
    document.getElementById('batch-start').disabled = false;
  }
}

/** Points the panel at a running batch, whether we just started it or found it
    already going. */
function attachBatch(info) {
  state.batchJobId = info.job_id;
  state.batchTotal = info.total;
  state.batchFailures = new Set();
  document.getElementById('batch-failures').innerHTML = '';
  document.getElementById('batch-start').disabled = true;
  document.getElementById('batch-cancel').classList.remove('hidden');
  document.getElementById('batch-cancel').disabled = false;
  document.getElementById('batch-progress-fill').style.width =
    ((info.fraction || 0) * 100).toFixed(1) + '%';
  document.getElementById('batch-status').textContent = 'Picking the run back up...';
  watchBatchJob(info.job_id);
}

async function cancelBatch() {
  if (!state.batchJobId) return;
  document.getElementById('batch-cancel').disabled = true;
  document.getElementById('batch-status').textContent =
    'Stopping — every game already finished stays saved.';
  try {
    await api(`/api/batch/${state.batchJobId}/cancel`, { method: 'POST' });
  } catch (e) {
    // Either the server has already forgotten the job -- which is as stopped
    // as it gets -- or the request never landed. Asking what's still running
    // settles which, rather than leaving a dead Cancel button either way.
    let active = [];
    try { active = await api('/api/analysis/active'); } catch (err) { /* offline */ }
    if (active.some((j) => j.job_id === state.batchJobId)) {
      document.getElementById('batch-cancel').disabled = false;
      document.getElementById('batch-status').textContent = "Couldn't stop it: " + e.message;
    } else {
      await batchNoLongerRunning();
    }
  }
}

function watchBatchJob(jobId) {
  clearTimeout(state.batchReconnect);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/analysis/${jobId}`);
  state.batchWs = ws;
  let chain = Promise.resolve();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handleBatchMessage(msg)).catch((e) => console.error('batch message failed', e));
  });
  ws.addEventListener('close', (ev) => {
    // A long run outlives a phone screen lock; the server replays where the
    // job has got to on the new socket, so reconnecting is all it takes.
    if (state.batchWs !== ws || state.batchJobId !== jobId) return;
    state.batchWs = null;
    if (ev.code === 4404 || ev.code === 4401) {
      batchNoLongerRunning();     // finished and evicted, or the server restarted
      return;
    }
    clearTimeout(state.batchReconnect);
    state.batchReconnect = setTimeout(() => {
      if (state.batchJobId === jobId && !state.batchWs) watchBatchJob(jobId);
    }, 2000);
  });
}

/** The job is gone from the server. Whatever it completed is saved, so show
    that instead of leaving a progress bar that will never move again. */
async function batchNoLongerRunning() {
  document.getElementById('batch-status').textContent =
    'That batch is no longer running — anything it finished is saved.';
  finishBatch();
  await refreshGameList();
  await refreshRunPicker();
  refreshTrend();
  refreshStrength();
}

async function handleBatchMessage(msg) {
  const status = document.getElementById('batch-status');
  if (msg.type === 'queued') {
    // A batch leases per game, so this can appear mid-run when the other
    // user's job takes the slots at a game boundary (section 10).
    status.textContent = queuedText(msg);
  } else if (msg.type === 'started') {
    status.textContent = 'A worker freed up — resuming...';
  } else if (msg.type === 'game_start') {
    // Section 6: show whichever game is currently being processed.
    try {
      state.explorer.loadPGN(msg.pgn, state.user.display_name);
      applyOrientation();
      state.explorer.goToStart();
      state.classifications = {};
      renderMoveTable();
      state.board.renderFEN(state.explorer.fen);
    } catch (e) { /* an unparseable game still gets reported by game_failed */ }
    status.innerHTML = `Game <b>${msg.index + 1}</b> of <b>${msg.total}</b>: ${msg.white || '?'} vs ${msg.black || '?'}`;
  } else if (msg.type === 'progress') {
    if (msg.phase === 'maia') {
      if (msg.fen) state.board.renderFEN(msg.fen);
    } else if (msg.ply !== undefined) {
      await animateToMainlinePly(msg.ply);
    }
    if (msg.fraction !== undefined) {
      document.getElementById('batch-progress-fill').style.width = (msg.fraction * 100).toFixed(1) + '%';
    }
  } else if (msg.type === 'game_done') {
    document.getElementById('batch-progress-fill').style.width =
      (((msg.index + 1) / msg.total) * 100).toFixed(1) + '%';
  } else if (msg.type === 'game_failed') {
    // One bad game shouldn't stop a long run, but it shouldn't vanish either.
    // Keyed by game index: a reconnect replays the failures it still holds,
    // and they shouldn't pile up a second copy of each.
    if (!state.batchFailures.has(msg.index)) {
      state.batchFailures.add(msg.index);
      const div = document.createElement('div');
      div.textContent = `Game ${msg.index + 1} failed: ${msg.message}`;
      document.getElementById('batch-failures').appendChild(div);
    }
  } else if (msg.type === 'done') {
    const bits = [`${msg.completed} analysed`];
    if (msg.failed) bits.push(`${msg.failed} failed`);
    if (msg.cancelled) bits.push('cancelled (finished games are saved)');
    status.innerHTML = `Batch finished — <b>${bits.join(', ')}</b>.`;
    document.getElementById('batch-progress-fill').style.width = '100%';
    finishBatch();
    await refreshGameList();
    await refreshRunPicker();
    refreshTrend();
    refreshStrength();
  } else if (msg.type === 'error') {
    status.textContent = 'Error: ' + msg.message;
    finishBatch();
  }
}

function finishBatch() {
  state.batchJobId = null;
  clearTimeout(state.batchReconnect);
  if (state.batchWs) { const ws = state.batchWs; state.batchWs = null; ws.close(); }
  document.getElementById('batch-cancel').classList.add('hidden');
  document.getElementById('batch-cancel').disabled = false;
  document.getElementById('batch-start').disabled = false;
}

/* ---------------- Elo sweep (Maia, spec section 9) ---------------- */

function wireSweep() {
  document.getElementById('sweep-btn').addEventListener('click', startSweep);
  document.getElementById('sweep-cancel').addEventListener('click', async () => {
    if (!state.sweepJobId) return;
    document.getElementById('sweep-status').textContent = 'Cancelling...';
    await api(`/api/analysis/${state.sweepJobId}/cancel`, { method: 'POST' });
  });
}

function resetSweepState() {
  state.sweepJobId = null;
  document.getElementById('sweep-cancel').classList.add('hidden');
  document.getElementById('sweep-btn').disabled = !state.selectedGameId;
  document.getElementById('sweep-progress-fill').style.width = '0%';
  document.getElementById('sweep-status').textContent = '';
  document.getElementById('sweep-results').innerHTML = '';
}

async function startSweep() {
  if (!state.selectedGameId) return;
  const btn = document.getElementById('sweep-btn');
  btn.disabled = true;
  document.getElementById('sweep-results').innerHTML = '';
  document.getElementById('sweep-status').textContent = 'Starting sweep...';
  try {
    const res = await api('/api/sweep', { method: 'POST', body: JSON.stringify({ game_id: state.selectedGameId }) });
    state.sweepJobId = res.job_id;
    document.getElementById('sweep-cancel').classList.remove('hidden');
    watchSweepJob(res.job_id);
  } catch (e) {
    document.getElementById('sweep-status').textContent = 'Error: ' + e.message;
    btn.disabled = false;
  }
}

function watchSweepJob(jobId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/analysis/${jobId}`);
  state.sweepWs = ws;
  // Same serialisation as the other streams: progress steps the board, and
  // a concurrent handler would re-render mid-animation.
  let chain = Promise.resolve();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handleSweepMessage(msg)).catch((e) => console.error('sweep message failed', e));
  });
  ws.addEventListener('close', () => {
    if (state.sweepWs === ws && state.sweepJobId === jobId) {
      setTimeout(() => watchSweepJob(jobId), 2000); // resume after a phone screen lock
    }
  });
}

async function handleSweepMessage(msg) {
  if (msg.type === 'queued') {
    document.getElementById('sweep-status').textContent = queuedText(msg);
  } else if (msg.type === 'started') {
    document.getElementById('sweep-status').textContent = 'A worker freed up — starting...';
  } else if (msg.type === 'progress') {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    document.getElementById('sweep-progress-fill').style.width = pct + '%';
    document.getElementById('sweep-status').textContent =
      `Elo ${msg.elo}: ${msg.done} / ${msg.total} position-evaluations (${pct}%)`;
    if (msg.fen) state.board.renderFEN(msg.fen);
  } else if (msg.type === 'done') {
    document.getElementById('sweep-progress-fill').style.width = '100%';
    document.getElementById('sweep-status').textContent = 'Sweep complete.';
    renderSweepResults(msg);
    finishSweep();
    syncBoardFull();
  } else if (msg.type === 'error') {
    document.getElementById('sweep-status').textContent =
      msg.message === 'cancelled' ? 'Cancelled.' : 'Error: ' + msg.message;
    finishSweep();
  }
}

function finishSweep() {
  state.sweepJobId = null;
  state.sweepWs = null;
  document.getElementById('sweep-btn').disabled = !state.selectedGameId;
  document.getElementById('sweep-cancel').classList.add('hidden');
}

function renderSweepResults(msg) {
  const box = document.getElementById('sweep-results');
  box.innerHTML = '';
  for (const side of ['w', 'b']) {
    const res = msg.results[side];
    if (!res) continue;
    const card = document.createElement('div');
    card.className = 'sweep-player';

    const head = document.createElement('div');
    head.className = 'sweep-head';
    const who = document.createElement('span');
    who.className = 'sweep-who';
    who.textContent = side === msg.your_color ? 'You' : 'Opponent';
    const elo = document.createElement('span');
    elo.className = 'sweep-elo';
    elo.textContent = res.estimate ?? '—';
    const ci = document.createElement('span');
    ci.className = 'sweep-ci';
    ci.textContent = res.ci_low != null ? `95% CI ${res.ci_low}–${res.ci_high}` : '';
    const badge = document.createElement('span');
    badge.className = 'conf-badge conf-' + res.confidence;
    badge.textContent = res.confidence;
    head.append(who, elo, ci, badge);
    card.appendChild(head);

    card.appendChild(sweepChart(res));

    // The number on its own invites more trust than it deserves, so the
    // reasons behind the confidence label are always shown (section 9).
    const ul = document.createElement('ul');
    ul.className = 'sweep-reasons';
    for (const reason of res.reasons) {
      const li = document.createElement('li');
      li.textContent = reason;
      ul.appendChild(li);
    }
    card.appendChild(ul);
    box.appendChild(card);
  }
}

/** Observed match rate per swept Elo, with the fitted curve over it and the
    peak marked -- so the estimate can be eyeballed, not just trusted. */
function sweepChart(res) {
  const W = 300, H = 110, padX = 6, padY = 10;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'sweep-chart');

  const xs = res.curve_x, ys = res.curve_y;
  const allY = ys.concat(res.match_rates);
  const yMin = Math.min(...allY), yMax = Math.max(...allY);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const sx = (x) => padX + ((x - xMin) / (xMax - xMin || 1)) * (W - 2 * padX);
  const sy = (y) => H - padY - ((y - yMin) / (yMax - yMin || 1)) * (H - 2 * padY);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#7db37d');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  res.grid.forEach((g, i) => {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', sx(g)); dot.setAttribute('cy', sy(res.match_rates[i]));
    dot.setAttribute('r', '2.5'); dot.setAttribute('fill', '#8b93a7');
    svg.appendChild(dot);
  });

  if (res.estimate != null) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', sx(res.estimate)); line.setAttribute('x2', sx(res.estimate));
    line.setAttribute('y1', padY); line.setAttribute('y2', H - padY);
    line.setAttribute('stroke', '#5b8dee'); line.setAttribute('stroke-dasharray', '3,3');
    svg.appendChild(line);
  }
  return svg;
}

/* ---------------- Pooled strength estimate (spec section 9) ----------------
   The per-game number is far too noisy to act on; this is the one that pools
   every stored sweep into a single fit. It also reports the opposition field,
   which is what makes the calibration possible: your opponents' real ratings
   are in the PGN headers, so the gap between their Maia estimate and their
   actual average measures the offset between the two scales on your own
   games rather than from a conversion table. */

function wireStrength() {
  document.getElementById('strength-refresh').addEventListener('click', refreshStrength);
  document.getElementById('strength-run').addEventListener('change', refreshStrength);
  document.getElementById('strength-topn').addEventListener('change', refreshStrength);
  refreshStrength();
}

async function refreshStrength() {
  const runId = document.getElementById('strength-run').value;
  const topN = document.getElementById('strength-topn').value;
  const status = document.getElementById('strength-status');
  const body = document.getElementById('strength-body');
  status.textContent = 'Fitting...';
  try {
    const d = await api(`/api/strength?top_n=${topN}` + (runId ? `&run_id=${runId}` : ''));
    renderStrength(d, status, body);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    body.innerHTML = '';
  }
}

function renderStrength(d, status, body) {
  body.innerHTML = '';
  if (!d.you || d.you.estimate == null) {
    status.textContent = 'Nothing to fit yet — run a Full analysis (or a Full batch) first.';
    renderTrendSkipped(body, d);
    return;
  }
  const objective = d.top_n > 1 ? `your move in Maia's top ${d.top_n}` : "Maia's own first choice";
  status.textContent =
    `${d.you.games} game(s), ${d.you.n_discriminative} discriminative of ${d.you.n_positions} positions`
    + `, matching ${objective}.`
    // A sweep run before MultiPV was recorded only stored rank 1, so a wider
    // objective silently collapses back to top-1. Say so rather than showing
    // the same number under a different label.
    + (d.top_n > 1 && d.max_rank_seen < 2
        ? ' These sweeps recorded only Maia\'s top move, so this is the same as top-1'
          + ' — re-run a Full analysis to record ranked candidates.' : '');

  const card = document.createElement('div');
  card.className = 'sweep-player';
  const head = document.createElement('div');
  head.className = 'sweep-head';
  head.innerHTML =
    `<span class="sweep-who">You</span><span class="sweep-elo">${d.you.estimate}</span>`
    + (d.you.ci_low != null ? `<span class="sweep-ci">95% ${d.you.ci_low}–${d.you.ci_high}</span>` : '')
    + `<span class="conf-badge conf-${d.you.confidence}">${d.you.confidence}</span>`;
  card.appendChild(head);
  card.appendChild(sweepChart(d.you));
  const ul = document.createElement('ul');
  ul.className = 'sweep-reasons';
  for (const reason of d.you.reasons || []) {
    const li = document.createElement('li');
    li.textContent = reason;
    ul.appendChild(li);
  }
  card.appendChild(ul);
  body.appendChild(card);

  // The calibration is the useful half: a raw Maia number on the Lichess
  // scale means little next to a Chess.com rating.
  const cal = d.calibration || {};
  const note = document.createElement('div');
  note.className = 'calibration';
  if (cal.available) {
    note.innerHTML =
      `<div class="cal-headline">On your opponents' scale: <b>${cal.your_calibrated}</b>`
      + (cal.your_calibrated_low != null
          ? ` <span class="sweep-ci">95% ${cal.your_calibrated_low}–${cal.your_calibrated_high}</span>` : '')
      + '</div>'
      + `<div class="cal-detail">Your ${cal.field_actual_n} opponents are rated <b>${cal.field_actual}</b> `
      + `on average and this sweep estimates them at <b>${cal.field_estimate}</b>, so the Maia scale sits `
      + `<b>${cal.offset > 0 ? '+' : ''}${cal.offset}</b> above the rating pool you play in. `
      + `That offset is measured from your own games, not looked up.</div>`
      + (d.your_rating_mean != null
          ? `<div class="cal-detail">Your own header rating averages ${d.your_rating_mean} `
            + `across ${d.your_rating_n} game(s).</div>` : '');
  } else {
    // Withheld on purpose: subtracting an offset measured from a flat or
    // edge-pinned opposition curve would look authoritative and mean nothing.
    note.innerHTML = `<div class="cal-detail">Not converted to your pool's scale — `
      + `${cal.reason || 'not enough to calibrate from'}. The figure above stays on the raw `
      + `Maia scale.</div>`;
  }
  const tf = d.think_filter || {};
  if (tf.applied) {
    note.innerHTML += `<div class="cal-detail">Left out <b>${tf.dropped}</b> of ${tf.eligible} `
      + `timed moves played in under ${tf.min_think_ms / 1000}s — a premove or an instant `
      + `recapture says nothing about how well you play.</div>`;
  } else if (tf.reason && tf.reason !== 'off') {
    note.innerHTML += `<div class="cal-detail">Think-time filter not applied: ${tf.reason}.</div>`;
  }
  note.innerHTML += `<div class="cal-detail scale-note">${d.scale_note}</div>`;
  body.appendChild(note);
  renderTrendSkipped(body, d);
}

/* ---------------- Trend over time (spec section 15) ----------------
   Estimated Elo per date bucket against the Elo in the PGN headers. Changing
   granularity is a pure re-fit of the cached per-position sweep scores on the
   server, so it never re-runs an engine -- which is why the control just
   refetches rather than starting a job. */

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function wireTrend() {
  document.getElementById('trend-granularity').addEventListener('change', refreshTrend);
  document.getElementById('trend-run').addEventListener('change', refreshTrend);
  refreshTrend();
}

async function refreshTrend() {
  const granularity = document.getElementById('trend-granularity').value;
  const runId = document.getElementById('trend-run').value;
  const status = document.getElementById('trend-status');
  status.textContent = 'Loading...';
  try {
    const data = await api(`/api/trend?granularity=${granularity}` + (runId ? `&run_id=${runId}` : ''));
    renderTrend(data);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
}

function renderTrend(data) {
  const status = document.getElementById('trend-status');
  const chart = document.getElementById('trend-chart');
  const verdict = document.getElementById('trend-verdict');
  const table = document.getElementById('trend-table');
  chart.innerHTML = ''; verdict.innerHTML = ''; table.innerHTML = '';

  const plotted = data.buckets.filter((b) => b.estimate != null || b.actual_elo != null);
  if (!plotted.length) {
    status.textContent =
      'Nothing to plot yet — this needs games with a Full analysis (the Maia Elo sweep), '
      + 'a date in the PGN headers, and your name matching White or Black.';
    renderTrendSkipped(verdict, data);
    return;
  }
  status.textContent =
    `${data.total_games} analysed game(s) across ${data.buckets.length} ${data.granularity} bucket(s).`;

  chart.appendChild(trendChart(plotted));
  const legend = document.createElement('div');
  legend.className = 'trend-legend';
  legend.innerHTML =
    '<span><i class="swatch-est"></i>Estimated Elo (Maia sweep), shaded 95% interval</span>'
    + '<span><i class="swatch-actual"></i>Rating from your PGN headers</span>';
  chart.appendChild(legend);

  for (const key of ['trend', 'actual_trend']) {
    const t = data[key];
    if (!t) continue;
    const p = document.createElement('p');
    p.className = 'trend-verdict' + (t.significant ? ' trend-significant' : '');
    const who = key === 'trend' ? 'Estimated Elo' : 'Rating in your PGN headers';
    p.innerHTML = `<b>${who}:</b> ${t.verdict}`;
    verdict.appendChild(p);
  }
  if (data.offset && data.offset.mean != null) {
    const p = document.createElement('p');
    p.className = 'trend-note';
    const sign = data.offset.mean >= 0 ? 'above' : 'below';
    p.textContent = `The Maia estimate averages ${Math.abs(data.offset.mean)} Elo ${sign} your `
      + `header rating across ${data.offset.n} bucket(s). A constant offset is expected — the two `
      + `are different scales — so watch the shape, not the gap.`;
    verdict.appendChild(p);
  }

  const t = document.createElement('table');
  t.className = 'trend-table';
  t.innerHTML = '<thead><tr><th>Bucket</th><th>Games</th><th>Estimated</th>'
    + '<th>95% interval</th><th>Actual</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const b of data.buckets) {
    const tr = document.createElement('tr');
    if (b.sparse) tr.className = 'trend-sparse';
    const ci = b.ci_low != null ? `${b.ci_low}–${b.ci_high}` : '—';
    const flags = [];
    // Sparse buckets are shown rather than dropped (section 15), but they say
    // so -- a point drawn from four positions shouldn't read like the others.
    if (b.sparse) flags.push('sparse');
    if (b.games_excluded_grid_mismatch) flags.push(`${b.games_excluded_grid_mismatch} on a different Elo grid`);
    tr.innerHTML = `<td>${b.label}</td><td>${b.games}</td><td>${b.estimate ?? '—'}</td>`
      + `<td>${ci}</td><td>${b.actual_elo ?? '—'}</td><td class="trend-flags">${flags.join(', ')}</td>`;
    tr.title = (b.reasons || []).join('; ');
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  table.appendChild(t);
  renderTrendSkipped(table, data);
}

function renderTrendSkipped(host, data) {
  const labels = {
    no_full_analysis: 'no Full analysis (Quick alone has no Elo sweep)',
    undated: 'no usable date in the PGN headers',
    unassigned_color: "your display name didn't match White or Black",
    no_sweep_positions: 'no stored sweep positions',
    no_header_elo: 'no WhiteElo/BlackElo header (still used for the estimate)',
  };
  const parts = Object.entries(data.skipped || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} × ${labels[k] || k}`);
  if (!parts.length) return;
  const p = document.createElement('p');
  p.className = 'trend-note';
  p.textContent = 'Left out: ' + parts.join('; ') + '.';
  host.appendChild(p);
}

/** Estimated Elo with its 95% band, and the header rating over it. The band
    is the point of the chart: two bucket estimates whose bands overlap have
    not been shown to differ, however far apart the dots look. */
function trendChart(buckets) {
  const W = 320, H = 170, padL = 34, padR = 8, padT = 10, padB = 26;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend-chart' });

  const ys = [];
  for (const b of buckets) {
    if (b.ci_low != null) ys.push(b.ci_low, b.ci_high);
    if (b.estimate != null) ys.push(b.estimate);
    if (b.actual_elo != null) ys.push(b.actual_elo);
  }
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMax - yMin < 100) { const mid = (yMax + yMin) / 2; yMin = mid - 50; yMax = mid + 50; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  const xs = buckets.map((b) => b.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const sx = (x) => padL + ((x - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const sy = (y) => H - padB - ((y - yMin) / (yMax - yMin || 1)) * (H - padT - padB);

  for (const frac of [0, 0.5, 1]) {
    const value = yMin + frac * (yMax - yMin);
    svg.appendChild(svgEl('line', {
      x1: padL, x2: W - padR, y1: sy(value), y2: sy(value),
      stroke: '#39405166', 'stroke-width': 1,
    }));
    const label = svgEl('text', { x: padL - 4, y: sy(value) + 3, class: 'trend-axis', 'text-anchor': 'end' });
    label.textContent = Math.round(value);
    svg.appendChild(label);
  }

  const band = buckets.filter((b) => b.ci_low != null);
  if (band.length > 1) {
    const top = band.map((b) => `${sx(b.x).toFixed(1)},${sy(b.ci_high).toFixed(1)}`);
    const bottom = band.slice().reverse().map((b) => `${sx(b.x).toFixed(1)},${sy(b.ci_low).toFixed(1)}`);
    svg.appendChild(svgEl('polygon', {
      points: top.concat(bottom).join(' '), fill: '#5b8dee33', stroke: 'none',
    }));
  } else if (band.length === 1) {
    const b = band[0];
    svg.appendChild(svgEl('line', {
      x1: sx(b.x), x2: sx(b.x), y1: sy(b.ci_high), y2: sy(b.ci_low),
      stroke: '#5b8dee88', 'stroke-width': 4,
    }));
  }

  const line = (points, colour, dash) => {
    if (points.length < 2) return;
    svg.appendChild(svgEl('path', {
      d: points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' '),
      fill: 'none', stroke: colour, 'stroke-width': 2,
      ...(dash ? { 'stroke-dasharray': dash } : {}),
    }));
  };
  line(buckets.filter((b) => b.estimate != null).map((b) => [b.x, b.estimate]), '#5b8dee');
  line(buckets.filter((b) => b.actual_elo != null).map((b) => [b.x, b.actual_elo]), '#7db37d', '4,3');

  for (const b of buckets) {
    if (b.estimate != null) {
      svg.appendChild(svgEl('circle', {
        cx: sx(b.x), cy: sy(b.estimate), r: b.sparse ? 2 : 3.2,
        fill: b.sparse ? '#1b1f2a' : '#5b8dee', stroke: '#5b8dee', 'stroke-width': 1.5,
      }));
    }
    if (b.actual_elo != null) {
      svg.appendChild(svgEl('circle', { cx: sx(b.x), cy: sy(b.actual_elo), r: 2.2, fill: '#7db37d' }));
    }
  }

  // Only the ends get a label: a week-bucketed year would otherwise be a
  // solid smear of text.
  for (const [b, anchor] of [[buckets[0], 'start'], [buckets[buckets.length - 1], 'end']]) {
    const t = svgEl('text', { x: sx(b.x), y: H - 8, class: 'trend-axis', 'text-anchor': anchor });
    t.textContent = b.label;
    svg.appendChild(t);
  }
  return svg;
}

/* ---------------- Play vs Maia3 ----------------
   Deliberately independent of the analysis pipeline (spec section 14): this
   shares the board UI and nothing else. The server owns the game state and
   the clock; this side keeps a chess.js copy purely to highlight legal moves
   and animate immediately, and snaps to the server's FEN whenever they
   disagree. */

function wirePlay() {
  document.getElementById('p-start').addEventListener('click', startPlayGame);
  document.getElementById('p-resign').addEventListener('click', () => sendPlay({ type: 'resign' }));
  document.getElementById('p-save').addEventListener('click', () => sendPlay({ type: 'save' }));
  document.getElementById('p-exit').addEventListener('click', exitPlayMode);
}

function sendPlay(msg) {
  if (state.play && state.play.ws && state.play.ws.readyState === WebSocket.OPEN) {
    state.play.ws.send(JSON.stringify(msg));
  }
}

function playLegalTargets(square) {
  const p = state.play;
  if (!p || p.result || p.chess.turn() !== p.humanColor) return [];
  const byTo = new Map();
  for (const m of p.chess.moves({ square, verbose: true })) {
    if (!byTo.has(m.to)) byTo.set(m.to, { to: m.to, promotion: !!m.promotion });
  }
  return Array.from(byTo.values());
}

async function onPlayMove(from, to, promotion) {
  const p = state.play;
  const res = p.chess.move({ from, to, promotion: promotion || 'q' });
  if (!res) return;
  playMoveSound(res.san, true);
  await state.board.animateMove(from, to, p.chess.fen());
  (p.sanHistory = p.sanHistory || []).push(res.san); // optimistic; the next state message is authoritative
  renderPlayMoveTable();
  sendPlay({ type: 'move', uci: from + to + (promotion || (res.promotion ? 'q' : '')) });
}

async function startPlayGame() {
  const elo = Number(document.getElementById('p-elo').value);
  const color = document.getElementById('p-color').value;
  const baseMinutes = Number(document.getElementById('p-base').value);
  const incrementSeconds = Number(document.getElementById('p-inc').value);

  enterPlayMode();
  state.play.maiaElo = elo;
  document.getElementById('p-status').textContent = 'Connecting to Maia...';

  if (state.play.ws && state.play.ws.readyState === WebSocket.OPEN) {
    sendPlay({ type: 'new_game', elo, color, base_minutes: baseMinutes, increment_seconds: incrementSeconds });
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/play`);
  state.play.ws = ws;
  ws.addEventListener('open', () => {
    sendPlay({ type: 'new_game', elo, color, base_minutes: baseMinutes, increment_seconds: incrementSeconds });
  });
  // The server sends engine_move immediately followed by state. Handling
  // them concurrently lets the state handler re-render the board while the
  // engine move is still sliding, so chain them and let each finish first.
  let chain = Promise.resolve();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    chain = chain.then(() => handlePlayMessage(msg)).catch((e) => console.error('play message failed', e));
  });
  ws.addEventListener('close', () => {
    if (state.playMode) document.getElementById('p-status').textContent = 'Disconnected from the play session.';
  });
}

function enterPlayMode() {
  state.playMode = true;
  if (!state.play) state.play = {};
  state.play.chess = new Chess();
  state.play.result = null;
  state.play.humanColor = 'w';
  state.play.sanHistory = [];
  state.play.greeted = false;
  state.play.lowTimeWarned = false;
  state.flipOverride = false;   // a new game always starts facing you
  document.getElementById('p-exit').classList.remove('hidden');
  // Showing a live Stockfish eval of your own game in progress would just be
  // cheating, so the eval bar is hidden for the duration of a played game.
  document.getElementById('eval-bar').classList.add('hidden');
  for (const el of document.querySelectorAll('.fen-row')) el.classList.add('hidden');
  // Analysis controls act on the loaded game, which isn't what's on the board now.
  document.getElementById('quick-analysis-btn').disabled = true;
  for (const id of ['nav-start', 'nav-prev', 'nav-next', 'nav-end']) {
    document.getElementById(id).disabled = true;
  }
}

function exitPlayMode() {
  state.playMode = false;
  if (state.play) {
    clearInterval(state.play.tick);
    if (state.play.ws) state.play.ws.close();
    state.play.ws = null;
  }
  document.getElementById('p-exit').classList.add('hidden');
  document.getElementById('eval-bar').classList.remove('hidden');
  for (const el of document.querySelectorAll('.fen-row')) el.classList.remove('hidden');
  document.getElementById('p-resign').disabled = true;
  document.getElementById('p-save').disabled = true;
  document.getElementById('p-status').textContent = '';
  document.getElementById('p-notes').textContent = '';
  for (const id of ['nav-start', 'nav-prev', 'nav-next', 'nav-end']) {
    document.getElementById(id).disabled = false;
  }
  document.getElementById('quick-analysis-btn').disabled = !state.selectedGameId;
  state.flipOverride = false;
  applyOrientation();
  renderMoveTable();
  syncBoardFull();
}

async function handlePlayMessage(msg) {
  const p = state.play;
  if (msg.type === 'error') {
    document.getElementById('p-status').textContent = 'Error: ' + msg.message;
    return;
  }
  if (msg.type === 'illegal') {
    playSound('illegal');
    // Server rejected it; its next state message is authoritative.
    return;
  }
  if (msg.type === 'saved') {
    document.getElementById('p-status').textContent = 'Saved to your library.';
    await refreshGameList();
    return;
  }
  if (msg.type === 'engine_move') {
    // Keep the local copy in step, then slide the piece.
    p.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || 'q' });
    (p.sanHistory = p.sanHistory || []).push(msg.san);
    playMoveSound(msg.san, false);
    await state.board.animateMove(msg.from, msg.to, msg.fen);
    renderPlayMoveTable();
    return;
  }
  if (msg.type === 'state') {
    const wasResult = p.result;
    if (msg.move_count === 0 && !p.greeted) { p.greeted = true; playSound('start'); }
    if (msg.result && !wasResult) { playSound('end'); p.lowTimeWarned = false; }
    p.humanColor = msg.human_color;
    p.turn = msg.turn;
    p.result = msg.result;
    p.clockEnabled = msg.clock_enabled;
    p.whiteMs = msg.white_ms;
    p.blackMs = msg.black_ms;
    // The move list comes from the server, not from chess.js history: a
    // resync below calls chess.load(), which throws that history away.
    p.sanHistory = msg.san_history || [];
    renderPlayMoveTable();

    // The server is the source of truth -- if the local copy drifted for any
    // reason, snap to what the server says rather than letting them diverge.
    if (p.chess.fen() !== msg.fen) {
      p.chess.load(msg.fen);
      state.board.renderFEN(msg.fen);
    }
    applyOrientation();

    document.getElementById('p-resign').disabled = !!msg.result;
    document.getElementById('p-save').disabled = msg.move_count === 0;

    const notes = document.getElementById('p-notes');
    notes.textContent = (msg.engine_notes || []).join('\n');
    notes.classList.toggle('warn', (msg.engine_notes || []).some((n) => n.includes('NOT applied')));

    const status = document.getElementById('p-status');
    if (msg.result) {
      status.textContent = `Game over — ${msg.result} (${msg.result_reason}).`;
      status.classList.add('result');
      clearInterval(p.tick);
    } else {
      status.classList.remove('result');
      const yours = msg.turn === msg.human_color;
      status.textContent = yours ? (msg.in_check ? 'Your move — check!' : 'Your move.') : 'Maia is thinking...';
      startClockTicker();
    }
    renderPlayerPlates();
  }
}

/** The server sends clock values with each state; between states this ticks
    the side-to-move's display down so it doesn't look frozen. Server values
    always overwrite it, so drift can't accumulate. */
function startClockTicker() {
  const p = state.play;
  clearInterval(p.tick);
  if (!p.clockEnabled) return;
  p.tick = setInterval(() => {
    if (!state.playMode || p.result) { clearInterval(p.tick); return; }
    if (p.turn === 'w') p.whiteMs = Math.max(0, p.whiteMs - 200);
    else p.blackMs = Math.max(0, p.blackMs - 200);
    // Warn once per game, and only on your own clock -- Maia flagging is not
    // something you need to be alerted about.
    const yourMs = p.humanColor === 'w' ? p.whiteMs : p.blackMs;
    if (p.turn === p.humanColor && yourMs <= 10000 && !p.lowTimeWarned) {
      p.lowTimeWarned = true;
      playSound('lowtime');
    }
    renderPlayerPlates();
  }, 200);
}

function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}


/** Play-mode move list, reusing the analysis move table's markup so the two
    modes look consistent. Oriented to the human, same as section 5 requires
    for the analysis view. */
function renderPlayMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const history = state.play.sanHistory || [];
  const humanIsWhite = state.play.humanColor === 'w';
  document.getElementById('mt-yours').textContent = `${state.user.display_name || 'You'} (you)`;
  document.getElementById('mt-theirs').textContent = 'Maia3';
  for (let i = 0; i < history.length; i += 2) {
    const whiteSan = history[i];
    const blackSan = history[i + 1];
    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'ply-num';
    numTd.textContent = (i / 2 + 1) + '.';
    tr.appendChild(numTd);
    for (const san of humanIsWhite ? [whiteSan, blackSan] : [blackSan, whiteSan]) {
      const td = document.createElement('td');
      td.textContent = san || '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  const wrap = document.getElementById('move-table-wrap');
  wrap.scrollTop = wrap.scrollHeight;
}

/* ---------------- Live eval (Stockfish over WebSocket) ---------------- */

function connectLiveEval() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/live-eval`);
  state.ws = ws;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error') {
      document.getElementById('eval-label').textContent = 'engine error';
      console.warn('live-eval error:', msg.message);
      return;
    }
    if (msg.type === 'info' && msg.seq === state.seq) {
      updateEvalBar(msg);
    }
  });
  ws.addEventListener('close', () => {
    if (state.ws === ws) {
      setTimeout(connectLiveEval, 2000); // reconnect (e.g. after phone screen lock)
    }
  });
  ws.addEventListener('open', () => requestEval());
}

function requestEval() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.seq += 1;
  state.lastMoverColor = state.explorer.moverColor;
  state.ws.send(JSON.stringify({ type: 'position', fen: state.explorer.fen, seq: state.seq }));
}

function updateEvalBar(info) {
  let cpWhite;
  let label;
  if (info.mate !== null && info.mate !== undefined) {
    const mateWhite = state.lastMoverColor === 'b' ? -info.mate : info.mate;
    cpWhite = mateWhite > 0 ? 10000 : -10000;
    label = (mateWhite > 0 ? '#' : '#-') + Math.abs(info.mate);
  } else if (info.cp !== null && info.cp !== undefined) {
    cpWhite = state.lastMoverColor === 'b' ? -info.cp : info.cp;
    label = (cpWhite / 100).toFixed(2);
  } else {
    return;
  }
  const wp = 1 / (1 + Math.exp(-0.00368208 * cpWhite));
  document.getElementById('eval-fill').style.width = (wp * 100).toFixed(1) + '%';
  document.getElementById('eval-label').textContent = label;
}

/* ---------------- Settings dialog ---------------- */

function wireSettingsDialog() {
  const dialog = document.getElementById('settings-dialog');
  document.getElementById('settings-btn').addEventListener('click', async () => {
    await fillSettingsForm();
    dialog.classList.remove('hidden');
  });
  document.getElementById('settings-cancel').addEventListener('click', () => {
    dialog.classList.add('hidden');
    state.board.setAssetSet(state.user.asset_set || 'default'); // undo any live preview
  });
  document.getElementById('s-asset-set').addEventListener('change', (ev) => {
    renderAssetPreview(ev.target.value);      // visible feedback inside the dialog
    state.board.setAssetSet(ev.target.value); // and the real board behind it
  });

  document.getElementById('settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const skillRaw = document.getElementById('s-sf-skill').value;
    const body = {
      stockfish_path: selectedStockfishPath(),
      stockfish_threads: Number(document.getElementById('s-sf-threads').value),
      stockfish_hash_mb: Number(document.getElementById('s-sf-hash').value),
      sf_limit_type: document.getElementById('s-sf-limit-type').value,
      sf_limit_value: Number(document.getElementById('s-sf-limit-value').value),
      sf_skill_level: skillRaw === '' ? null : Number(skillRaw),
      maia_path: selectedMaiaPath(),
      maia_model_size: document.getElementById('s-maia-size').value,
      maia_elo_min: Number(document.getElementById('s-maia-elo-min').value),
      maia_elo_max: Number(document.getElementById('s-maia-elo-max').value),
      maia_elo_step: Number(document.getElementById('s-maia-elo-step').value),
      maia_elo_step_batch: Number(document.getElementById('s-maia-elo-step-batch').value),
      maia_multipv: Number(document.getElementById('s-maia-multipv').value),
      min_think_ms: Number(document.getElementById('s-min-think-ms').value),
      great_max_drop: Number(document.getElementById('s-great-drop').value),
      great_max_match_rate: Number(document.getElementById('s-great-rate').value),
      brilliant_enabled: document.getElementById('s-brilliant').value === '1',
      maia_options: collectEngineOptions('s-maia-options'),
      stockfish_options: state.settings.stockfish_options || {},
    };
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });

    const displayName = document.getElementById('s-display-name').value.trim();
    const assetSet = document.getElementById('s-asset-set').value;
    const profileBody = {};
    if (displayName && displayName !== state.user.display_name) profileBody.display_name = displayName;
    if (assetSet && assetSet !== state.user.asset_set) profileBody.asset_set = assetSet;
    if (Object.keys(profileBody).length) {
      state.user = await api('/api/settings/profile', { method: 'PUT', body: JSON.stringify(profileBody) });
      document.getElementById('whoami').textContent = state.user.display_name;
      state.board.setAssetSet(state.user.asset_set);
    }
    dialog.classList.add('hidden');
    // Settings only take effect for new engine sessions -- reconnect live eval.
    if (state.ws) state.ws.close();
    connectLiveEval();
  });

  // Re-scan when the Maia engine or size changes, so the dialog always shows
  // the binary that will actually be launched, and re-reads that binary's
  // advertised options (a different model can expose different knobs).
  document.getElementById('s-maia-family').addEventListener('change', async () => {
    await refreshMaiaModels();
    await renderEngineOptions('s-maia-options', selectedMaiaPath(), state.settings.maia_options);
  });
  document.getElementById('s-maia-size').addEventListener('change', () => refreshMaiaModels());
  document.getElementById('s-sf-family').addEventListener('change', () => populateBuildPicker(null));
}

/** Fills both engine dropdowns from the binaries discovered under the
    Engines directory. The browser only ever holds these names -- absolute
    paths never leave the server, and the settings API rejects anything that
    doesn't resolve inside that directory. */
async function populateEngineDropdowns(selectedStockfish, selectedMaia) {
  const hint = document.getElementById('engines-hint');
  let info;
  try {
    info = await api('/api/settings/engines');
  } catch (e) {
    hint.textContent = 'Could not list engines: ' + e.message;
    return;
  }
  state.engineFamilies = info.families;

  // The dropdown shows products ("Stockfish-18", "Maia3"), not the dozen
  // near-identical executables a release ships. Stockfish variants differ
  // only by instruction set (handled by the Build picker below); Maia's
  // variant is the model size, which has its own dropdown already.
  for (const [selId, kind, selected] of [['s-sf-family', 'stockfish', selectedStockfish],
                                         ['s-maia-family', 'maia', selectedMaia]]) {
    const sel = document.getElementById(selId);
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(none selected)';
    sel.appendChild(none);
    // Offer same-kind families first, but never hide the others: a build
    // named something unexpected should still be selectable.
    const families = [...info.families].sort(
      (a, b) => (b.kind === kind) - (a.kind === kind) || a.label.localeCompare(b.label));
    for (const fam of families) {
      const opt = document.createElement('option');
      opt.value = fam.id;
      opt.textContent = fam.label;
      sel.appendChild(opt);
    }
    const owning = info.families.find((f) => f.members.some((m) => m.value === selected));
    sel.value = owning ? owning.id : '';
  }

  populateBuildPicker(selectedStockfish);

  if (!info.engines_dir_exists) {
    hint.textContent = 'No assets/Engines directory yet — create it and put your engine folders inside.';
    hint.classList.add('warn');
  } else if (info.families.length === 0) {
    hint.textContent = 'No engines found under assets/Engines.';
    hint.classList.add('warn');
  } else {
    hint.textContent = info.families.map((f) => f.label).join(', ') + ' found under assets/Engines.';
    hint.classList.remove('warn');
  }
}

/** Stockfish releases ship one binary per instruction set. The default picks
    a widely-supported one; this exposes the rest for anyone who knows their
    CPU supports something faster (or needs something older). */
function populateBuildPicker(selectedStockfish) {
  const famId = document.getElementById('s-sf-family').value;
  const fam = (state.engineFamilies || []).find((f) => f.id === famId);
  const row = document.getElementById('s-sf-build-row');
  const sel = document.getElementById('s-sf-build');
  sel.innerHTML = '';
  if (!fam || fam.members.length <= 1) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  const auto = document.createElement('option');
  auto.value = fam.default_member;
  auto.textContent = `Automatic (${fam.members[0].name})`;
  sel.appendChild(auto);
  for (const m of fam.members) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.value = fam.members.some((m) => m.value === selectedStockfish) ? selectedStockfish : fam.default_member;
}

/** The concrete binary to save for each engine: the build picker for
    Stockfish, and for Maia any family member (the model-size dropdown picks
    the real one at launch). */
function selectedStockfishPath() {
  const famId = document.getElementById('s-sf-family').value;
  const fam = (state.engineFamilies || []).find((f) => f.id === famId);
  if (!fam) return null;
  const build = document.getElementById('s-sf-build').value;
  return fam.members.some((m) => m.value === build) ? build : fam.default_member;
}

function selectedMaiaPath() {
  const famId = document.getElementById('s-maia-family').value;
  const fam = (state.engineFamilies || []).find((f) => f.id === famId);
  return fam ? fam.default_member : null;
}

/** Renders a control per option the engine actually advertises, so Maia's
    temperature (and anything else that build exposes) shows up because the
    engine said so -- not because it was hardcoded here. */
async function renderEngineOptions(containerId, enginePath, saved) {
  const box = document.getElementById(containerId);
  box.innerHTML = '';
  if (!enginePath) return;
  let info;
  try {
    info = await api('/api/settings/engine-options?engine=' + encodeURIComponent(enginePath));
  } catch (e) {
    box.textContent = 'Could not read engine options: ' + e.message;
    box.className = 'engine-options warn';
    return;
  }
  box.className = 'engine-options';
  if (info.error) {
    box.textContent = `Could not start ${info.binary} to read its options (${info.error}).`;
    box.classList.add('warn');
    return;
  }
  if (!info.options.length) {
    box.textContent = `${info.binary} advertises no tunable options.`;
    return;
  }
  const title = document.createElement('div');
  title.className = 'engine-options-title';
  title.textContent = `${info.binary} options`;
  box.appendChild(title);

  for (const opt of info.options) {
    const label = document.createElement('label');
    const current = saved && saved[opt.name] !== undefined ? saved[opt.name] : opt.default;
    let field;
    if (opt.type === 'check') {
      field = document.createElement('select');
      for (const v of ['true', 'false']) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        field.appendChild(o);
      }
      field.value = String(current) === 'true' ? 'true' : 'false';
    } else if (opt.type === 'combo') {
      field = document.createElement('select');
      for (const v of opt.vars) {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        field.appendChild(o);
      }
      field.value = current ?? (opt.vars[0] || '');
    } else {
      field = document.createElement('input');
      field.type = opt.type === 'spin' ? 'number' : 'text';
      if (opt.min !== null && opt.min !== undefined) field.min = opt.min;
      if (opt.max !== null && opt.max !== undefined) field.max = opt.max;
      field.value = current ?? '';
    }
    field.dataset.optionName = opt.name;
    const range = opt.type === 'spin' && opt.min != null ? ` (${opt.min}–${opt.max})` : '';
    label.append(`${opt.name}${range} `, field);
    box.appendChild(label);
  }
}

/** {name: value} for every option control the user actually changed from the
    engine's own default -- storing the whole set would freeze defaults that
    a future engine version might improve. */
function collectEngineOptions(containerId) {
  const out = {};
  for (const field of document.querySelectorAll(`#${containerId} [data-option-name]`)) {
    const value = field.value;
    if (value !== '' && value !== null) out[field.dataset.optionName] = String(value);
  }
  return out;
}

/** Populates the model-size dropdown from the maia3-<size> executables that
    actually exist next to the configured path, and reports which binary the
    current selection resolves to -- the size picks a binary, not a UCI
    option, so being explicit about it is the whole point. */
async function refreshMaiaModels(selected) {
  const sel = document.getElementById('s-maia-size');
  const note = document.getElementById('s-maia-resolved');
  const typedPath = selectedMaiaPath() || '';
  const wantSize = selected || sel.value;
  let info;
  try {
    info = await api('/api/settings/maia-models?path=' + encodeURIComponent(typedPath || '')
                     + '&size=' + encodeURIComponent(wantSize || ''));
  } catch (e) {
    note.textContent = 'Could not check installed models: ' + e.message;
    return;
  }
  const want = wantSize;
  sel.innerHTML = '';
  for (const size of info.sizes) {
    const opt = document.createElement('option');
    opt.value = size;
    opt.textContent = size + (info.discovered ? '' : ' (not found on disk)');
    sel.appendChild(opt);
  }
  if (want && info.sizes.includes(want)) sel.value = want;

  const binary = info.resolved_binary ? info.resolved_binary.split(/[\\/]/).pop() : null;
  note.textContent = binary ? `will run: ${binary}` : info.note;
  note.classList.toggle('warn', !info.discovered || /NOT applied/.test(info.note || ''));
}

/** Draws a small board+pieces swatch for `setName` inside the settings
    dialog. The dialog is a full-screen overlay (it has to be, to stay usable
    on a phone), so the real board behind it can't be seen while choosing --
    without this, picking a set looks like it does nothing. */
function renderAssetPreview(setName) {
  const wrap = document.getElementById('asset-preview');
  if (!wrap) return;
  wrap.innerHTML = '';

  const bg = document.createElement('img');
  bg.className = 'prev-board';
  bg.src = `/assets/sets/${setName}/board.png`;
  bg.alt = '';
  bg.onerror = () => { wrap.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 50% 50%'; };
  wrap.appendChild(bg);

  // A representative handful of pieces, laid out on the swatch's 4x4 grid.
  const sample = [['wk', 0, 3], ['wq', 1, 3], ['bk', 3, 0], ['bq', 2, 0]];
  for (const [piece, col, row] of sample) {
    const img = document.createElement('img');
    img.className = 'prev-piece';
    img.src = `/assets/sets/${setName}/${piece}.png`;
    img.alt = '';
    img.style.left = (col * 25) + '%';
    img.style.top = (row * 25) + '%';
    wrap.appendChild(img);
  }
}

async function fillSettingsForm() {
  const s = state.settings;
  document.getElementById('s-display-name').value = state.user.display_name;

  const sets = await api('/api/asset-sets');
  const sel = document.getElementById('s-asset-set');
  sel.innerHTML = '';
  for (const name of sets) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = state.user.asset_set || 'default';
  renderAssetPreview(sel.value);

  await populateEngineDropdowns(s.stockfish_path, s.maia_path);
  document.getElementById('s-sf-threads').value = s.stockfish_threads;
  document.getElementById('s-sf-hash').value = s.stockfish_hash_mb;
  document.getElementById('s-sf-limit-type').value = s.sf_limit_type;
  document.getElementById('s-sf-limit-value').value = s.sf_limit_value;
  document.getElementById('s-sf-skill').value = s.sf_skill_level === null || s.sf_skill_level === undefined ? '' : s.sf_skill_level;
  await refreshMaiaModels(s.maia_model_size);
  await renderEngineOptions('s-maia-options', selectedMaiaPath(), s.maia_options);
  document.getElementById('s-maia-elo-min').value = s.maia_elo_min;
  document.getElementById('s-maia-elo-max').value = s.maia_elo_max;
  document.getElementById('s-maia-elo-step').value = s.maia_elo_step;
  document.getElementById('s-maia-elo-step-batch').value = s.maia_elo_step_batch ?? 200;
  document.getElementById('s-maia-multipv').value = s.maia_multipv ?? 3;
  document.getElementById('s-min-think-ms').value = s.min_think_ms ?? 2000;
  document.getElementById('s-great-drop').value = s.great_max_drop ?? 0.02;
  document.getElementById('s-great-rate').value = s.great_max_match_rate ?? 0.20;
  document.getElementById('s-brilliant').value = s.brilliant_enabled ? '1' : '0';
}

boot();
