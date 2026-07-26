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

  state.board = new Board(document.getElementById('board'), state.user.asset_set || 'default');
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
        td.textContent = state.explorer.nodes[id].san;
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
    state.board.setAssetSet(ev.target.value); // live preview before saving
  });

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

  document.getElementById('s-sf-browse').addEventListener('click', () => openBrowse('s-sf-path'));
  document.getElementById('s-maia-browse').addEventListener('click', () => openBrowse('s-maia-path'));
  document.getElementById('browse-cancel').addEventListener('click', () => {
    document.getElementById('browse-panel').classList.add('hidden');
  });
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
  // Works for both '/foo/bar' and 'C:\foo\bar' -- strip the last path segment
  // regardless of which separator the server's OS uses. No match (or no
  // existing value) means: start at the root (Unix) or the drive list (Windows).
  const m = current.match(/^(.*)[\\/][^\\/]+[\\/]?$/);
  const startPath = m ? m[1] : '';
  await renderBrowse(startPath);
  document.getElementById('browse-panel').classList.remove('hidden');
}

async function renderBrowse(path) {
  const data = await api(`/api/fs/browse?path=${encodeURIComponent(path)}`);
  document.getElementById('browse-path').textContent = data.path;
  const list = document.getElementById('browse-list');
  list.innerHTML = '';
  // parent is null only at a true root with nowhere to go up to; '' (e.g. a
  // Windows drive root) still means "go up" -- back to the drive list.
  if (data.parent !== null && data.parent !== undefined) {
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
    div.addEventListener('click', () => {
      if (entry.is_dir) {
        renderBrowse(entry.full_path);
      } else {
        document.getElementById(state.browseTarget).value = entry.full_path;
        document.getElementById('browse-panel').classList.add('hidden');
      }
    });
    list.appendChild(div);
  }
}

boot();
