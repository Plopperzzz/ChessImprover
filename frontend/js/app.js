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
  browseTarget: null,
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

  state.board = new Board(document.getElementById('board'), 'default');
  state.board.setInteractive(true, {
    getLegalTargets: (sq) => state.explorer.getLegalTargets(sq),
    getMoverColor: () => state.explorer.moverColor,
    onMove: onBoardMove,
  });

  wireNav();
  wireFenBox();
  wirePgnUpload();
  wireSettingsDialog();
  connectLiveEval();

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
  if (state.explorer.onMainline) renderMoveTable();
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
    renderGamePicker();
    document.getElementById('move-table').querySelector('tbody').innerHTML = '';
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
    row.addEventListener('click', () => selectGame(g.id));
    wrap.appendChild(row);
  }
}

async function selectGame(gameId) {
  const game = await api(`/api/games/${gameId}`);
  state.selectedGameId = gameId;
  renderGamePicker();
  state.explorer.loadPGN(game.pgn_text, state.user.display_name);
  state.board.setOrientation(state.explorer.yourColor === 'b' ? 'b' : 'w');
  state.explorer.goToStart();
  renderMoveTable();
  syncBoardFull();
}

/* ---------------- Move table ---------------- */

function renderMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const san = state.explorer.mainlineSAN;
  const yourColor = state.explorer.yourColor === 'b' ? 'b' : 'w'; // unassigned defaults to White-on-left
  for (let i = 0; i < san.length; i += 2) {
    const whiteMove = { san: san[i], ply: i + 1 };
    const blackMove = san[i + 1] !== undefined ? { san: san[i + 1], ply: i + 2 } : null;
    const yours = yourColor === 'w' ? whiteMove : blackMove;
    const theirs = yourColor === 'w' ? blackMove : whiteMove;

    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'ply-num';
    numTd.textContent = (i / 2 + 1) + '.';
    tr.appendChild(numTd);

    for (const mv of [yours, theirs]) {
      const td = document.createElement('td');
      if (mv) {
        td.textContent = mv.san;
        td.dataset.ply = mv.ply;
        td.addEventListener('click', () => {
          state.explorer.goToPly(mv.ply);
          syncBoardFull();
        });
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function refreshMoveTableHighlight() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  const current = state.explorer.onMainline ? state.explorer.pointer : -1;
  for (const td of tbody.querySelectorAll('td[data-ply]')) {
    td.classList.toggle('current', Number(td.dataset.ply) === current);
  }
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
  document.getElementById('settings-btn').addEventListener('click', () => {
    fillSettingsForm();
    dialog.classList.remove('hidden');
  });
  document.getElementById('settings-cancel').addEventListener('click', () => dialog.classList.add('hidden'));

  document.getElementById('settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const skillRaw = document.getElementById('s-sf-skill').value;
    const body = {
      stockfish_path: document.getElementById('s-sf-path').value || null,
      stockfish_threads: Number(document.getElementById('s-sf-threads').value),
      stockfish_hash_mb: Number(document.getElementById('s-sf-hash').value),
      sf_limit_type: document.getElementById('s-sf-limit-type').value,
      sf_limit_value: Number(document.getElementById('s-sf-limit-value').value),
      sf_skill_level: skillRaw === '' ? null : Number(skillRaw),
      maia_path: document.getElementById('s-maia-path').value || null,
      maia_model_size: document.getElementById('s-maia-size').value,
      maia_elo_min: Number(document.getElementById('s-maia-elo-min').value),
      maia_elo_max: Number(document.getElementById('s-maia-elo-max').value),
      maia_elo_step: Number(document.getElementById('s-maia-elo-step').value),
    };
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    const displayName = document.getElementById('s-display-name').value.trim();
    if (displayName && displayName !== state.user.display_name) {
      state.user = await api('/api/settings/profile', { method: 'PUT', body: JSON.stringify({ display_name: displayName }) });
      document.getElementById('whoami').textContent = state.user.display_name;
    }
    dialog.classList.add('hidden');
    // Settings only take effect for new engine sessions -- reconnect live eval.
    if (state.ws) state.ws.close();
    connectLiveEval();
  });

  document.getElementById('s-sf-browse').addEventListener('click', () => openBrowse('s-sf-path'));
  document.getElementById('s-maia-browse').addEventListener('click', () => openBrowse('s-maia-path'));
  document.getElementById('browse-cancel').addEventListener('click', () => {
    document.getElementById('browse-panel').classList.add('hidden');
  });
}

function fillSettingsForm() {
  const s = state.settings;
  document.getElementById('s-display-name').value = state.user.display_name;
  document.getElementById('s-sf-path').value = s.stockfish_path || '';
  document.getElementById('s-sf-threads').value = s.stockfish_threads;
  document.getElementById('s-sf-hash').value = s.stockfish_hash_mb;
  document.getElementById('s-sf-limit-type').value = s.sf_limit_type;
  document.getElementById('s-sf-limit-value').value = s.sf_limit_value;
  document.getElementById('s-sf-skill').value = s.sf_skill_level === null || s.sf_skill_level === undefined ? '' : s.sf_skill_level;
  document.getElementById('s-maia-path').value = s.maia_path || '';
  document.getElementById('s-maia-size').value = s.maia_model_size;
  document.getElementById('s-maia-elo-min').value = s.maia_elo_min;
  document.getElementById('s-maia-elo-max').value = s.maia_elo_max;
  document.getElementById('s-maia-elo-step').value = s.maia_elo_step;
}

async function openBrowse(targetFieldId) {
  state.browseTarget = targetFieldId;
  const current = document.getElementById(targetFieldId).value;
  const startPath = current ? current.split('/').slice(0, -1).join('/') || '/' : '/';
  await renderBrowse(startPath);
  document.getElementById('browse-panel').classList.remove('hidden');
}

async function renderBrowse(path) {
  const data = await api(`/api/fs/browse?path=${encodeURIComponent(path)}`);
  document.getElementById('browse-path').textContent = data.path;
  const list = document.getElementById('browse-list');
  list.innerHTML = '';
  if (data.parent) {
    const up = document.createElement('div');
    up.className = 'browse-entry dir';
    up.textContent = '..';
    up.addEventListener('click', () => renderBrowse(data.parent));
    list.appendChild(up);
  }
  for (const entry of data.entries) {
    const div = document.createElement('div');
    div.className = 'browse-entry ' + (entry.is_dir ? 'dir' : 'file');
    div.textContent = entry.name;
    const fullPath = data.path.replace(/\/$/, '') + '/' + entry.name;
    div.addEventListener('click', () => {
      if (entry.is_dir) {
        renderBrowse(fullPath);
      } else {
        document.getElementById(state.browseTarget).value = fullPath;
        document.getElementById('browse-panel').classList.add('hidden');
      }
    });
    list.appendChild(div);
  }
}

boot();
