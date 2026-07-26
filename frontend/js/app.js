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
  sweepWs: null,
  playMode: false,
  play: null, // { ws, chess, humanColor, turn, whiteMs, blackMs, clockEnabled, result, tick }
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

  wireNav();
  wireFenBox();
  wirePgnUpload();
  wireSettingsDialog();
  wireAnalysis();
  wireSweep();
  wirePlay();
  connectLiveEval();

  await refreshRunPicker();
  await refreshGameList();
  syncBoardFull();
}

/* ---------------- Board <-> Explorer sync ---------------- */

function syncBoardFull() {
  state.board.renderFEN(state.explorer.fen);
  refreshFenBox();
  refreshMoveTableHighlight();
  requestEval();
}

function refreshFenBox() {
  document.getElementById('fen-box').value = state.explorer.fen;
}

async function onBoardMove(from, to, promotion) {
  const res = state.explorer.makeMove(from, to, promotion);
  if (!res) return;
  await state.board.animateMove(from, to, state.explorer.fen);
  refreshFenBox();
  renderMoveTable(); // a new variation node may have just been created
  refreshMoveTableHighlight();
  requestEval();
}

function wireNav() {
  document.getElementById('nav-start').addEventListener('click', () => {
    state.explorer.goToStart();
    syncBoardFull();
  });
  document.getElementById('nav-prev').addEventListener('click', async () => {
    const res = state.explorer.stepBackward();
    if (!res) return;
    await state.board.animateMove(res.to, res.from, state.explorer.fen);
    refreshFenBox();
    refreshMoveTableHighlight();
    requestEval();
  });
  document.getElementById('nav-next').addEventListener('click', async () => {
    const res = state.explorer.stepForward();
    if (!res) return;
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
  state.board.setOrientation(state.explorer.yourColor === 'b' ? 'b' : 'w');
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

function renderMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const mainlineIds = state.explorer.mainlineNodeIds;
  const yourColor = state.explorer.yourColor === 'b' ? 'b' : 'w'; // unassigned defaults to White-on-left

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
}

/* ---------------- Quick analysis (Stockfish-only move classification) ---------------- */

const CLASSIFICATION_SUFFIX = { good: '', inaccuracy: '?!', mistake: '?', blunder: '??', great: '!', brilliant: '!!' };

function resetAnalysisState() {
  state.classifications = {};
  state.analysisJobId = null;
  if (state.analysisWs) { state.analysisWs.close(); state.analysisWs = null; }
  document.getElementById('quick-analysis-btn').disabled = !state.selectedGameId;
  document.getElementById('full-analysis-btn').disabled = !state.selectedGameId;
  resetSweepState();
  document.getElementById('analysis-progress-fill').style.width = '0%';
  document.getElementById('analysis-status').textContent = '';
  document.getElementById('analysis-summary').innerHTML = '';
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
    sel.appendChild(opt);
  }
  if (previous && runs.some((r) => String(r.id) === previous)) sel.value = previous;
}

function wireAnalysis() {
  document.getElementById('run-new').addEventListener('click', async () => {
    const name = prompt('Name for the new run:');
    if (!name || !name.trim()) return;
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await refreshRunPicker();
    document.getElementById('run-picker').value = run.id;
  });
  document.getElementById('quick-analysis-btn').addEventListener('click', () => startAnalysis('quick'));
  document.getElementById('full-analysis-btn').addEventListener('click', () => startAnalysis('full'));
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
  if (msg.type === 'progress') {
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
    if (msg.mode === 'full') {
      renderSweepResults(msg);            // reuse the sweep panel for the estimate
      renderBlunderElo(msg.moves, msg.your_color);
      document.getElementById('sweep-status').textContent = 'From the full analysis.';
      document.getElementById('sweep-progress-fill').style.width = '100%';
    }
    document.getElementById('analysis-status').textContent = 'Done and saved.';
    document.getElementById('analysis-progress-fill').style.width = '100%';
    setAnalysisButtonsEnabled(true);
    await refreshRunPicker();
    await refreshGameList();
    syncBoardFull();
  } else if (msg.type === 'error') {
    document.getElementById('analysis-status').textContent = 'Error: ' + msg.message;
    setAnalysisButtonsEnabled(true);
  }
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

/* ---------------- Elo sweep (Maia, spec section 9) ---------------- */

function wireSweep() {
  document.getElementById('sweep-btn').addEventListener('click', startSweep);
}

function resetSweepState() {
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
    if (state.sweepWs === ws && document.getElementById('sweep-btn').disabled) {
      setTimeout(() => watchSweepJob(jobId), 2000); // resume after a phone screen lock
    }
  });
}

async function handleSweepMessage(msg) {
  if (msg.type === 'progress') {
    const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
    document.getElementById('sweep-progress-fill').style.width = pct + '%';
    document.getElementById('sweep-status').textContent =
      `Elo ${msg.elo}: ${msg.done} / ${msg.total} position-evaluations (${pct}%)`;
    if (msg.fen) state.board.renderFEN(msg.fen);
  } else if (msg.type === 'done') {
    document.getElementById('sweep-progress-fill').style.width = '100%';
    document.getElementById('sweep-status').textContent = 'Sweep complete.';
    renderSweepResults(msg);
    document.getElementById('sweep-btn').disabled = false;
    state.sweepWs = null;
    syncBoardFull();
  } else if (msg.type === 'error') {
    document.getElementById('sweep-status').textContent = 'Error: ' + msg.message;
    document.getElementById('sweep-btn').disabled = false;
    state.sweepWs = null;
  }
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
  document.getElementById('clock-row').classList.remove('hidden');
  document.getElementById('p-exit').classList.remove('hidden');
  // Showing a live Stockfish eval of your own game in progress would just be
  // cheating, so the eval bar is hidden for the duration of a played game.
  document.getElementById('eval-bar').classList.add('hidden');
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
  document.getElementById('clock-row').classList.add('hidden');
  document.getElementById('p-exit').classList.add('hidden');
  document.getElementById('eval-bar').classList.remove('hidden');
  document.getElementById('p-resign').disabled = true;
  document.getElementById('p-save').disabled = true;
  document.getElementById('p-status').textContent = '';
  document.getElementById('p-notes').textContent = '';
  for (const id of ['nav-start', 'nav-prev', 'nav-next', 'nav-end']) {
    document.getElementById(id).disabled = false;
  }
  document.getElementById('quick-analysis-btn').disabled = !state.selectedGameId;
  state.board.setOrientation(state.explorer.yourColor === 'b' ? 'b' : 'w');
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
    await state.board.animateMove(msg.from, msg.to, msg.fen);
    renderPlayMoveTable();
    return;
  }
  if (msg.type === 'state') {
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
    state.board.setOrientation(msg.human_color === 'b' ? 'b' : 'w');

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
    renderClocks();
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
    renderClocks();
  }, 200);
}

function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderClocks() {
  const p = state.play;
  const row = document.getElementById('clock-row');
  if (!p || !p.clockEnabled) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');

  // Top of the board is whoever is not the human (board is oriented to them).
  const humanIsWhite = p.humanColor === 'w';
  const topMs = humanIsWhite ? p.blackMs : p.whiteMs;
  const bottomMs = humanIsWhite ? p.whiteMs : p.blackMs;
  const topTurn = humanIsWhite ? p.turn === 'b' : p.turn === 'w';

  document.getElementById('clock-top-label').textContent = 'Maia';
  document.getElementById('clock-bottom-label').textContent = 'You';
  document.getElementById('clock-top-time').textContent = formatClock(topMs);
  document.getElementById('clock-bottom-time').textContent = formatClock(bottomMs);

  const top = document.getElementById('clock-top');
  const bottom = document.getElementById('clock-bottom');
  top.classList.toggle('active', topTurn && !p.result);
  bottom.classList.toggle('active', !topTurn && !p.result);
  top.classList.toggle('low', topMs < 30000);
  bottom.classList.toggle('low', bottomMs < 30000);
}

/** Play-mode move list, reusing the analysis move table's markup so the two
    modes look consistent. Oriented to the human, same as section 5 requires
    for the analysis view. */
function renderPlayMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const history = state.play.sanHistory || [];
  const humanIsWhite = state.play.humanColor === 'w';
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
  document.getElementById('s-great-drop').value = s.great_max_drop ?? 0.02;
  document.getElementById('s-great-rate').value = s.great_max_match_rate ?? 0.20;
  document.getElementById('s-brilliant').value = s.brilliant_enabled ? '1' : '0';
}

boot();
