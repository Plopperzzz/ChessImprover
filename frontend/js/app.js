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
  // Live engine lines: how many the board is asking for, and the newest
  // answer for each rank. Cleared whenever the position changes.
  liveLines: { count: 0, seq: -1, byRank: {} },
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
  activeTab: 'analysis',
  playMode: false,
  play: null,
  puzzleMode: false,
  // { key, source, id, chess, fen, your_color, themes, answered, busy, played }
  // `chess` tracks the position the solver is looking at, which for a
  // multi-move Lichess line moves on as the opponent answers; `played` is
  // every move of the line found so far, re-sent on each attempt so the
  // server can check the whole prefix without keeping per-solver state.
  puzzle: null,
  // 'own' | 'lichess'. Remembered in localStorage, so the tab opens on the
  // set you were last using.
  puzzleSource: 'own',
  puzzleImportPoll: null,
  // The board faces the side you played, so a game you had as Black opens
  // flipped. The nav flip button sets this override for the current game;
  // selecting another game clears it.
  flipOverride: false,
  // Which slice of the library is on show. Sent to the server rather than
  // applied here, so the picker, the bulk actions and a batch run all agree
  // on what "these games" means.
  filter: { speed: null, timeControl: null, collectionId: null },
  // The same choice for the Progress tab, kept separate on purpose: which
  // games you are *looking at* and which games you want *measured* are
  // different questions, and tying them together would re-fit both panels
  // every time you scrolled the library looking for a game.
  progressFilter: { speed: null, timeControl: null, collectionId: null },
  collections: [],
  facets: { speeds: [], total: 0 },
  // Ticked games, by id. Survives a re-render of the list; cleared when the
  // filter changes, because a selection you can no longer see is a selection
  // you can't check before deleting.
  selectedIds: new Set(),
};

/** Makes a string safe to drop into an innerHTML template.

    Most of this file builds its DOM with createElement/textContent, which
    needs no escaping. The places that don't -- a table of rows, a line of
    feedback -- are interpolating names out of PGN headers, theme labels and
    error text from the server, none of which are guaranteed to be free of
    angle brackets. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      ...opts,
    });
  } catch (e) {
    // fetch only rejects when the request never got an answer at all. The
    // browser's own wording for that is "Failed to fetch", which reads like
    // the app is broken and says nothing about where to look -- so name the
    // two things it actually means on a self-hosted server.
    throw new Error(
      `no answer from the server (${path}). It may have stopped, or be busy `
      + 'with a long job — check the terminal it is running in.',
    );
  }
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

function loginMessage(text, isError) {
  const el = document.getElementById('login-message');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
  el.classList.toggle('error', !!isError);
}

/** Which account row, if any, is open for editing. Kept outside showLogin so
    a re-render (after a failed save, say) doesn't close the form. */
let editingAccountId = null;

async function showLogin(message) {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  loginMessage(message);
  const accounts = await api('/api/auth/accounts');
  const list = document.getElementById('account-list');
  list.innerHTML = '';
  if (accounts.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No accounts yet -- add one below.';
    list.appendChild(p);
  }
  for (const acc of accounts) {
    list.appendChild(acc.id === editingAccountId ? accountEditor(acc) : accountRow(acc));
  }
}

function accountRow(acc) {
  const row = document.createElement('div');
  row.className = 'account-row';

  const login = document.createElement('button');
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = acc.display_name;
  const sub = document.createElement('span');
  sub.className = 'account-sub';
  sub.textContent = `${acc.username} — ${acc.game_count} game${acc.game_count === 1 ? '' : 's'}`;
  login.append(name, sub);
  login.addEventListener('click', async () => {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: acc.username }) });
    await boot();
  });
  row.appendChild(login);

  const edit = document.createElement('button');
  edit.className = 'account-action';
  edit.textContent = '✎';
  edit.title = 'Rename this account';
  edit.addEventListener('click', async () => {
    editingAccountId = acc.id;
    await showLogin();
  });
  row.appendChild(edit);

  const del = document.createElement('button');
  del.className = 'account-action danger';
  del.textContent = '✕';
  del.title = 'Delete this account';
  del.addEventListener('click', () => deleteAccount(acc));
  row.appendChild(del);
  return row;
}

/** Renaming is the fix for the commonest setup mistake: a display name that
    doesn't match the PGN headers leaves every uploaded game 'unassigned'.
    Saving re-matches the whole library, and says how many games moved. */
function accountEditor(acc) {
  const row = document.createElement('div');
  row.className = 'account-row';

  const form = document.createElement('form');
  form.className = 'account-edit';
  // Labelled, because the two fields hold near-identical text and an unlabelled
  // pair gives no clue which one has to match the PGN headers.
  const field = (text, value) => {
    const label = document.createElement('label');
    label.className = 'account-field';
    const caption = document.createElement('span');
    caption.textContent = text;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.required = true;
    label.append(caption, input);
    return [label, input];
  };
  const [usernameField, username] = field('Account name', acc.username);
  const [displayField, display] = field('Display name (must match your PGNs)', acc.display_name);
  const hint = document.createElement('p');
  hint.className = 'account-hint';
  hint.textContent = 'The display name is matched against the White/Black headers in your PGNs, '
    + 'so it should be your chess.com or Lichess handle. The account name is tried too. '
    + 'Saving re-checks every game you have already uploaded.';
  const buttons = document.createElement('div');
  buttons.className = 'row';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', async () => {
    editingAccountId = null;
    await showLogin();
  });
  buttons.append(save, cancel);
  form.append(usernameField, displayField, hint, buttons);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const res = await api(`/api/auth/accounts/${acc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ username: username.value, display_name: display.value }),
      });
      editingAccountId = null;
      await showLogin(rematchSummary(res.display_name, res.rematched));
    } catch (e) {
      loginMessage(e.message, true);
    }
  });
  row.appendChild(form);
  return row;
}

/** What a rename did to the library, in one sentence -- the whole point of
    renaming is usually the games, so silence would hide the result. */
function rematchSummary(displayName, rematched) {
  if (!rematched || !rematched.changed) {
    return `Saved ${displayName}. No games changed side.`;
  }
  const bits = [];
  if (rematched.assigned) bits.push(`${rematched.assigned} now assigned a side`);
  if (rematched.unassigned) bits.push(`${rematched.unassigned} no longer match and are unassigned`);
  return `Saved ${displayName}. ${bits.join(', ')}.`;
}

async function deleteAccount(acc) {
  const parts = [`${acc.game_count} game${acc.game_count === 1 ? '' : 's'}`];
  if (acc.analysis_count) parts.push(`${acc.analysis_count} saved analyses`);
  if (acc.puzzle_count) parts.push(`${acc.puzzle_count} puzzles`);
  const warning = `Delete the account "${acc.display_name}"?\n\n`
    + `This also deletes ${parts.join(', ')}. It cannot be undone.`;
  if (!confirm(warning)) return;
  // Typing the name is asked for only when there is something to lose: a
  // blank account is not worth a second dialog.
  if (acc.game_count > 0) {
    const typed = prompt(`Type the account name (${acc.username}) to confirm.`);
    if ((typed || '').trim().toLowerCase() !== acc.username) {
      loginMessage('Name did not match -- nothing was deleted.', true);
      return;
    }
  }
  try {
    const res = await api(`/api/auth/accounts/${acc.id}`, { method: 'DELETE' });
    editingAccountId = null;
    await showLogin(`Deleted ${res.display_name}.`);
  } catch (e) {
    loginMessage(e.message, true);
  }
}

document.getElementById('bootstrap-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const username = document.getElementById('bootstrap-username').value;
  const display_name = document.getElementById('bootstrap-displayname').value;
  try {
    await api('/api/auth/accounts', { method: 'POST', body: JSON.stringify({ username, display_name }) });
  } catch (e) {
    // A duplicate username used to fail as an unhandled rejection: the form
    // just sat there, having apparently done nothing.
    loginMessage(e.message, true);
    return;
  }
  document.getElementById('bootstrap-form').reset();
  await showLogin();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (state.ws) state.ws.close();
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
});

/* ---------------- App init ---------------- */

/** Every name the logged-in account may appear under in a PGN header. Mirrors
    the server's `account_names`, so the two agree on which side was yours. */
function accountNames() {
  return [state.user.display_name, state.user.username].filter(Boolean);
}

async function initApp() {
  document.getElementById('whoami').textContent = state.user.display_name;
  state.settings = await api('/api/settings');

  state.board = new Board(document.getElementById('board'), {
    board: state.user.board_set || state.user.asset_set || 'default',
    pieces: state.user.piece_set || state.user.asset_set || 'default',
    showLegalMoves: state.user.show_legal_moves !== 0,
  });
  applyEvalBarSide(state.user.eval_bar_side);
  // The board is shared between analysis and play-vs-Maia, so its handlers
  // dispatch on the current mode rather than being rebound on every switch.
  // The board serves three modes -- analysing a loaded game, playing Maia, and
  // solving a puzzle -- so its handlers dispatch on the current one rather
  // than being rebound on every switch.
  state.board.setInteractive(true, {
    getLegalTargets: (sq) => (state.puzzleMode ? puzzleLegalTargets(sq)
      : state.playMode ? playLegalTargets(sq) : state.explorer.getLegalTargets(sq)),
    getMoverColor: () => (state.puzzleMode ? state.puzzle.chess.turn()
      : state.playMode ? state.play.humanColor : state.explorer.moverColor),
    onMove: (from, to, promo) => (state.puzzleMode ? onPuzzleMove(from, to, promo)
      : state.playMode ? onPlayMove(from, to, promo) : onBoardMove(from, to, promo)),
    // Pre-move affordances: only the play side has them, and only while it's
    // the opponent's turn.
    isPremove: () => state.playMode && premovesOffered(),
    onPremoveCancel: () => clearPremove(),
  });

  wireSound();
  wireCollapsibles();
  wireNav();
  wireBoardDialog();
  wireFenBox();
  wireLiveLines();
  wirePgnUpload();
  wireLibraryTools();
  wireSettingsDialog();
  wireAnalysis();
  wireSweep();
  wireBatch();
  wireStrength();
  wireTrend();
  wireOpeningPanel();
  wirePuzzles();
  wirePlay();
  // Last of the wiring: opening a tab can enter play or puzzle mode, which
  // needs everything those modes touch to already be listening.
  wireTabs();
  connectLiveEval();

  await refreshRunPicker();
  await refreshLibrary();
  syncBoardFull();
  await reattachRunningJobs();
}

/* ---------------- Tabs ----------------
   Four pages over one board: analysing a loaded game, the long-term Progress
   view, playing Maia, and solving puzzles. Switching tabs is the *only* thing
   that enters or leaves play/puzzle mode, so there is exactly one place where
   the board changes hands -- and one place that decides which of the board's
   neighbours make sense. */

const TABS = ['analysis', 'progress', 'play', 'puzzles'];

function wireTabs() {
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  }
  const remembered = localStorage.getItem('tab');
  activateTab(TABS.includes(remembered) ? remembered : 'analysis', { force: true });
}

function activateTab(name, { force = false } = {}) {
  if (!TABS.includes(name)) return;
  if (!force && name === state.activeTab) return;

  // Leaving a game half-played loses it: the session lives on the server only
  // as long as the socket does.
  if (state.playMode && state.play && !state.play.result && (state.play.sanHistory || []).length) {
    if (!confirm('Leave the game in progress? It will be abandoned.')) return;
  }
  if (state.playMode) exitPlayMode();
  if (state.puzzleMode) exitPuzzleMode();

  state.activeTab = name;
  localStorage.setItem('tab', name);

  for (const btn of document.querySelectorAll('.tab-btn')) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const panels of document.querySelectorAll('.tab-panels')) {
    panels.classList.toggle('active', panels.id === 'panels-' + name);
  }
  // The board and the move table belong to some tabs and not others; each
  // declares which in data-tabs.
  for (const el of document.querySelectorAll('#layout > [data-tabs]')) {
    el.classList.toggle('hidden', !el.dataset.tabs.split(' ').includes(name));
  }
  document.getElementById('side-col').classList.toggle('full-width', name === 'progress');

  if (name === 'play') enterPlayMode();
  if (name === 'progress') { refreshStrength(); refreshTrend(); }
  applyBoardChrome();
  if (name === 'analysis') {
    // Put the loaded game back on a board that play or a puzzle was using.
    state.flipOverride = false;
    applyOrientation();
    renderMoveTable();
    syncBoardFull();
  }
  // Last, because it fetches: entering the tab is the request for a puzzle.
  if (name === 'puzzles') startPuzzles();
}

/** Which of the board's neighbours make sense in the current mode.

    The eval bar and the whole-game plot are analysis instruments: during a game
    they'd be cheating, and during a puzzle they'd be the answer. The step
    buttons stay live while playing -- they walk the game in progress (see
    goToPlayPly) -- but a puzzle is a single position with nothing to step
    through, so there they go rather than sit greyed out. */
function applyBoardChrome() {
  const analysing = state.activeTab === 'analysis';
  const steppable = analysing || state.activeTab === 'play';
  document.getElementById('eval-bar').classList.toggle('hidden', !analysing);
  document.getElementById('eval-plot-wrap').classList
    .toggle('hidden', !analysing || evalPlotMoves().length < 2);
  // The live-analysis controls belong to the analysis tab: during a game or a
  // puzzle, an engine line beside the board is the answer.
  for (const id of ['live-lines-btn', 'live-lines']) {
    document.getElementById(id).classList.toggle('tab-hidden', !analysing);
  }
  if (!analysing && state.liveLines.count) setLiveLines(0);
  for (const id of ['nav-start', 'nav-prev', 'nav-next', 'nav-end']) {
    const btn = document.getElementById(id);
    btn.disabled = !steppable;
    btn.classList.toggle('hidden', !steppable);
  }
}

/** True when the analysis streams may drive the board. A job keeps running
    while you're on another tab -- a batch finishes whether or not you watch it
    -- and its animation must not scribble over a game in progress or a puzzle
    you're solving. */
function boardIsAnalysing() {
  return state.activeTab === 'analysis';
}

/* ---------------- Collapsible panels ----------------
   Open/closed is remembered per panel, so the shape you left the page in is
   the shape you come back to. */

function wireCollapsibles() {
  for (const panel of document.querySelectorAll('.panel.collapsible')) {
    const key = 'open:' + panel.id;
    const stored = localStorage.getItem(key);
    if (stored !== null) panel.open = stored === '1';
    panel.addEventListener('toggle', () => localStorage.setItem(key, panel.open ? '1' : '0'));
  }
}

/** What a folded panel says about itself, so putting the game list away doesn't
    also hide which game is loaded. */
function refreshPanelSummaries() {
  const selected = state.games.find((g) => g.id === state.selectedGameId);
  const shown = state.games.length;
  // The whole library, not the filtered slice: "no games yet" and "no games
  // matching this filter" are different states and must not read the same.
  const total = state.facets.total;
  const filtered = shown !== total;
  document.getElementById('games-summary').textContent = selected
    ? gameLabel(selected)
    : filtered ? `${shown} of ${total} games` : `${total} game${total === 1 ? '' : 's'}`;
  document.getElementById('upload-summary').textContent =
    total ? '' : 'no games yet — start here';
  // A first-time visitor needs the upload box open; once there are games it's
  // in the way. Decided once, and after that the panel remembers.
  if (localStorage.getItem('open:upload-panel') === null) {
    document.getElementById('upload-panel').open = total === 0;
  }
}

/* ---------------- Board <-> Explorer sync ---------------- */

function syncBoardFull() {
  state.board.renderFEN(state.explorer.fen);
  refreshLastMove();
  refreshFenBox();
  refreshMoveTableHighlight();
  renderPlayerPlates();   // the to-move marker follows the position
  requestEval();
}

/** Lights the two squares of the move that led to the position now shown.
    renderFEN clears the marks (a bare FEN says nothing about how it was
    reached), so anything that changes the position calls this afterwards --
    including stepping *backwards*, where the move to mark is the one before
    the one just undone, not the undone move itself. */
function refreshLastMove() {
  if (state.playMode) {
    const move = state.play && (state.play.moves || [])[playViewPly() - 1];
    state.board.setLastMove(move ? move.from : null, move ? move.to : null);
    return;
  }
  const node = state.explorer.nodes[state.explorer.currentNodeId];
  // The badge rides with the last-move marks: both describe the move that
  // produced what's on the board, and both have to be redrawn together.
  const cls = node && state.classifications[node.ply];
  state.board.setLastMove(node && node.from, node && node.to, badgeFor(cls));
}

/** Everything the analysis board does to the position -- a move played on it,
    a step through the game, a jump to a node or a pasted FEN -- comes through
    here, which is why the opening lookup hangs off it rather than being
    repeated at half a dozen call sites. */
function refreshFenBox() {
  document.getElementById('fen-box').value = state.explorer.fen;
  refreshOpeningStats();
}

async function onBoardMove(from, to, promotion) {
  const res = state.explorer.makeMove(from, to, promotion);
  if (!res) return;
  playMoveSound(res.san || res.move || '', true);
  await state.board.animateMove(from, to, state.explorer.fen);
  refreshLastMove();
  refreshFenBox();
  renderMoveTable(); // a new variation node may have just been created
  refreshMoveTableHighlight();
  announceClassification();
  requestEval();
}

/* ---------------- Opening database ----------------
   What a large reference library played from the position in front of you.
   The analysis board already lets you push moves around freely -- no engine,
   no opponent -- so this needs no mode of its own: it follows the board, and
   clicking a row plays that move, which is the fastest way to walk a line.

   Every lookup is sequenced. Clicking down a variation fires a request per
   position and they can come back out of order; the answer to the position
   you're on now is the only one allowed to reach the screen. */

const opening = { seq: 0, status: null };

function wireOpeningPanel() {
  const panel = document.getElementById('opening-panel');
  // Nothing is fetched for a folded panel -- but unfolding it is a request to
  // see the position you're on, not the one you were on when you folded it.
  panel.addEventListener('toggle', () => { if (panel.open) refreshOpeningStats(); });
  document.getElementById('opening-body').addEventListener('click', (ev) => {
    const row = ev.target.closest('tr[data-uci]');
    if (!row) return;
    const uci = row.dataset.uci;
    onBoardMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] || undefined);
  });
  refreshOpeningStatus();
}

async function refreshOpeningStatus() {
  try {
    opening.status = await api('/api/openings/status');
  } catch (err) {
    opening.status = null;
  }
  refreshOpeningStats();
}

/** Debounced, because the position can change a hundred times in a few
    seconds -- an analysis run steps the board through a whole game -- and
    only the position it settles on is worth asking about. */
function refreshOpeningStats() {
  clearTimeout(opening.timer);
  opening.timer = setTimeout(loadOpeningStats, 120);
}

async function loadOpeningStats() {
  const panel = document.getElementById('opening-panel');
  if (!panel || !panel.open || !boardIsAnalysing()) return;
  const seq = ++opening.seq;
  let res = null;
  try {
    res = await api('/api/openings/stats?fen=' + encodeURIComponent(state.explorer.fen));
  } catch (err) { /* rendered as "no database" below */ }
  if (seq !== opening.seq) return;   // a later position has already answered
  // A database that has just finished building appears under a page that has
  // been open the whole time. The stats endpoint notices by itself; the size
  // in the panel header comes from the status call, so go and get it rather
  // than leaving the header blank until a reload.
  const appeared = res && res.available && !(opening.status && opening.status.available);
  renderOpeningStats(res);
  if (appeared) refreshOpeningStatus();
}

function renderOpeningStats(res) {
  const summary = document.getElementById('opening-summary');
  const totalEl = document.getElementById('opening-total');
  const body = document.getElementById('opening-body');

  if (!res || !res.available) {
    summary.textContent = 'not built';
    totalEl.innerHTML = '';
    body.innerHTML = `<p class="hint">Nothing indexed yet. Building the database is a one-off
      job you run yourself, on the machine holding the PGN — from <code>backend/</code>:</p>
      <pre class="hint-cmd">.venv/bin/python -m app.opening_import /path/to/LumbrasGigaBase.pgn</pre>
      <p class="hint">It indexes the first 12 moves of each game (<code>--max-plies</code>),
      at roughly an hour per three million. When it finishes, play a move and this
      panel fills in — no restart, no reload.</p>`;
    return;
  }

  const s = opening.status;
  summary.textContent = s && s.games ? `${fmtCount(s.games)} games` : '';

  if (!res.total.games) {
    totalEl.innerHTML = '';
    body.innerHTML = '<p class="hint">Out of book — no game in the database reached this position.</p>';
    return;
  }

  totalEl.innerHTML = `<span class="op-total-count">${res.total.games.toLocaleString()} games</span>`
    + wdlBar(res.total, res.total.games);

  const rows = res.moves.map((m) => `
    <tr data-uci="${m.uci}" title="Play ${m.san}">
      <td class="op-san">${m.san}</td>
      <td class="op-games">${fmtCount(m.games)}<span class="op-share">${
        Math.round((m.games / res.total.games) * 100)}%</span></td>
      <td class="op-wdl">${wdlBar(m, m.games)}</td>
      <td class="op-rating">${m.avg_rating || ''}</td>
    </tr>`).join('');
  body.innerHTML = `<table id="opening-table">
      <thead><tr><th>Move</th><th>Games</th><th>White / Draw / Black</th><th>Avg</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** The result split as one bar. Percentages are only written into a segment
    wide enough to hold them -- a 3% sliver with "3%" spilling out of it is
    worse than a plain sliver. */
function wdlBar(counts, games) {
  const parts = [
    ['w', counts.white], ['d', counts.draws], ['b', counts.black],
  ].map(([cls, n]) => {
    const pct = (n / games) * 100;
    if (!n) return '';
    return `<span class="wdl-${cls}" style="width:${pct}%">${pct >= 14 ? Math.round(pct) + '%' : ''}</span>`;
  }).join('');
  return `<span class="wdl">${parts}</span>`;
}

/** 1,234 / 12.3k / 1.2M -- the counts run to eight figures and the column has
    to stay narrow enough to sit beside the move. */
function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return n.toLocaleString();
}

/* ---------------- Sound ----------------
   The assets in assets/audio/ are the usual chess-site set. Sounds only ever
   follow something the user did -- a move they played, a reply from Maia, a
   game ending -- never the analysis animation, which steps through a hundred
   positions and would be unbearable.

   They live in a subdirectory per set now (assets/audio/<set>/), with the same
   file names inside each; what was the flat directory is 'default'. Which set
   this UI plays follows the account's own sound_set, so choosing one in either
   front end is heard in both. */

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
  brilliant: 'brilliant-86fb4d6.mp3',
  correct: 'correct-c1411f4.mp3',
  wrong: 'fail-blip-hi-2b78df0.mp3',
  solved: 'puzzle-solved-fee614d.mp3',
};
const soundCache = {};

function soundEnabled() {
  return localStorage.getItem('sound') !== 'off';
}

/** The account's set, or the original one. Read per play rather than cached,
    because it can change under us in the settings dialog of the other UI. */
function soundSet() {
  return state.user?.sound_set || 'default';
}

function playSound(name) {
  if (!soundEnabled()) return;
  const file = SOUND_FILES[name];
  if (!file) return;
  try {
    const key = `${soundSet()}/${name}`;
    let audio = soundCache[key];
    if (!audio) {
      audio = new Audio(`/assets/audio/${soundSet()}/${file}`);
      audio.volume = 0.55;
      soundCache[key] = audio;
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

/* ---------------- Move classifications ----------------
   The badge a move earns: on the square it landed on, and beside it in the
   move table. Names are the classifier's own, so the icon file and the CSS
   class are both reached by the same string and adding a classification
   means adding art rather than editing a lookup.

   Only six of these are produced today -- good, inaccuracy, mistake, blunder
   from Stockfish alone, plus great and brilliant once the Maia sweep has run.
   `best`, `excellent`, `book` and `miss` are here with their art ready for
   whatever comes to award them; nothing renders a badge it has no move for. */

const CLASSIFICATIONS = [
  'brilliant', 'great', 'best', 'excellent', 'good', 'book',
  'inaccuracy', 'mistake', 'miss', 'blunder',
];

/** Which of them earn a badge. Excellent, good and book are the moves you
    were always going to play, and a badge on almost every move is a badge on
    none of them -- they keep their colour in the move table and say nothing
    else. Everything here is either rare or worth stopping at. */
const BADGED_CLASSIFICATIONS = [
  'brilliant', 'great', 'best', 'inaccuracy', 'mistake', 'miss', 'blunder',
];

/** The badge name for a classification record, or null when that
    classification doesn't get one. The single gate both the board and the
    move table go through. */
function badgeFor(cls) {
  const name = cls && cls.classification;
  return name && BADGED_CLASSIFICATIONS.includes(name) ? name : null;
}

function classificationIcon(classification, size) {
  if (!classification || !BADGED_CLASSIFICATIONS.includes(classification)) return null;
  const img = document.createElement('img');
  img.className = 'cls-icon';
  img.src = `/assets/icons/classification/${classification}.svg`;
  img.width = size;
  img.height = size;
  img.alt = classification;
  img.title = classification;
  img.draggable = false;
  return img;
}

/** Brilliant, and only brilliant, gets a sound of its own. Every move already
    says what it did -- a capture, a check, a castle -- and a second noise on
    top of every one of them turns stepping through a game into a slot
    machine. A brilliancy is rare enough to be worth interrupting for.

    Called from the places a *person* moves the board -- stepping, clicking a
    move, playing one -- and not from the analysis animation, which walks a
    hundred positions. */
function announceClassification() {
  if (state.playMode || state.puzzleMode) return;
  const node = state.explorer.nodes[state.explorer.currentNodeId];
  const cls = node && state.classifications[node.ply];
  if (cls && cls.classification === 'brilliant') playSound('brilliant');
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
  const base = state.puzzleMode
    ? (state.puzzle && state.puzzle.your_color === 'b' ? 'b' : 'w')
    : state.playMode
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

  if (state.puzzleMode && state.puzzle) {
    // For a puzzle from your own games the plates name the two players -- it
    // happened, and whose game it was is part of recognising it. A Lichess
    // puzzle has no names worth showing (they aren't in the export), so the
    // side to solve is labelled as yours and the other as the opponent.
    const p = state.puzzle;
    const names = { w: p.white, b: p.black };
    for (const colour of ['w', 'b']) {
      const yours = colour === p.your_color;
      const fallback = p.source === 'lichess'
        ? (yours ? (state.user.display_name || 'You') : 'Opponent')
        : (colour === 'w' ? 'White' : 'Black');
      sides[colour] = {
        name: names[colour] || fallback,
        // No rating on the plate. The only number in play is the puzzle's
        // difficulty, and in the slot where a player's rating goes it reads
        // as though it were yours. It is in the line above the board instead,
        // where it is labelled.
        rating: '',
        you: yours, result: '', clock: '',
        toMove: yours,
      };
    }
  } else if (state.playMode && state.play) {
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
  // Each of these works on the game you're playing as readily as on a loaded
  // one: looking back at what just happened is the most ordinary thing to
  // want mid-game, and the board coming back to the live position is one tap.
  document.getElementById('nav-start').addEventListener('click', () => {
    if (state.playMode) { goToPlayPly(0); return; }
    state.explorer.goToStart();
    syncBoardFull();
  });
  document.getElementById('nav-prev').addEventListener('click', async () => {
    if (state.playMode) { await stepPlay(-1); return; }
    const res = state.explorer.stepBackward();
    if (!res) return;
    playMoveSound(res.san, true);
    await state.board.animateMove(res.to, res.from, state.explorer.fen);
    refreshLastMove();
    refreshFenBox();
    refreshMoveTableHighlight();
    announceClassification();
    requestEval();
  });
  document.getElementById('nav-next').addEventListener('click', async () => {
    if (state.playMode) { await stepPlay(1); return; }
    const res = state.explorer.stepForward();
    if (!res) return;
    playMoveSound(res.san, true);
    await state.board.animateMove(res.from, res.to, state.explorer.fen);
    refreshLastMove();
    refreshFenBox();
    refreshMoveTableHighlight();
    announceClassification();
    requestEval();
  });
  document.getElementById('nav-end').addEventListener('click', () => {
    if (state.playMode) { goToPlayPly(playLivePly()); return; }
    state.explorer.goToMainlineEnd();
    syncBoardFull();
  });
  document.getElementById('board-note').addEventListener('click', () => {
    if (state.playMode) goToPlayPly(playLivePly());
  });
  document.addEventListener('keydown', (ev) => {
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    // A puzzle is one position and Progress has no board, so there is nothing
    // for the arrows to walk on those tabs. Flip still makes sense anywhere.
    const steppable = ['analysis', 'play'].includes(state.activeTab);
    if (ev.key === 'f' || ev.key === 'F') { document.getElementById('nav-flip').click(); return; }
    if (!steppable) return;
    if (ev.key === 'ArrowLeft') document.getElementById('nav-prev').click();
    if (ev.key === 'ArrowRight') document.getElementById('nav-next').click();
    if (ev.key === 'ArrowUp') document.getElementById('nav-start').click();
    if (ev.key === 'ArrowDown') document.getElementById('nav-end').click();
  });
}

/* ---------------- Board settings (the ⚙ beside the board) ----------------
   How the board *looks and behaves* is a different kind of setting from which
   engine to launch, and you want to see the board while changing it -- hence
   its own dialog, opened from the board rather than from the top bar. */

function wireBoardDialog() {
  const dialog = document.getElementById('board-dialog');
  const boardSel = document.getElementById('b-board-set');
  const pieceSel = document.getElementById('b-piece-set');
  const legal = document.getElementById('b-legal-moves');
  const premoves = document.getElementById('b-premoves');
  const evalSide = document.getElementById('b-eval-bar-side');

  document.getElementById('board-settings-btn').addEventListener('click', async () => {
    await fillBoardForm();
    // The FEN lives in here now, and it is the position as of opening the
    // dialog -- refreshFenBox keeps it current while the dialog is closed.
    refreshFenBox();
    dialog.classList.remove('hidden');
  });

  // Every control previews live on the real board as well as on the swatch --
  // Cancel puts back whatever was saved.
  const preview = () => {
    state.board.setSets({ board: boardSel.value, pieces: pieceSel.value });
    renderBoardPreview(boardSel.value, pieceSel.value);
  };
  boardSel.addEventListener('change', preview);
  pieceSel.addEventListener('change', preview);
  legal.addEventListener('change', () => state.board.setShowLegalMoves(legal.checked));
  evalSide.addEventListener('change', () => applyEvalBarSide(evalSide.value));
  // Turning pre-moves off mid-game withdraws whatever is queued, rather than
  // leaving one that can still fire.
  premoves.addEventListener('change', () => { if (!premoves.checked) clearPremove(); });

  document.getElementById('board-cancel').addEventListener('click', () => {
    dialog.classList.add('hidden');
    applySavedBoardPrefs();
  });

  document.getElementById('board-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      state.user = await api('/api/settings/profile', {
        method: 'PUT',
        body: JSON.stringify({
          board_set: boardSel.value,
          piece_set: pieceSel.value,
          show_legal_moves: legal.checked,
          allow_premoves: premoves.checked,
          eval_bar_side: evalSide.value,
        }),
      });
      dialog.classList.add('hidden');
      applySavedBoardPrefs();
    } catch (e) {
      alert('Could not save board settings: ' + e.message);
    }
  });
}

/** Puts the board back to what's stored on the account -- used by Cancel to
    drop a live preview, and by Save to confirm what the server accepted. */
function applySavedBoardPrefs() {
  state.board.setSets({
    board: state.user.board_set || 'default',
    pieces: state.user.piece_set || 'default',
  });
  state.board.setShowLegalMoves(state.user.show_legal_moves !== 0);
  applyEvalBarSide(state.user.eval_bar_side);
  if (state.user.allow_premoves === 0) clearPremove();
}

/** Where the evaluation bar sits, as a class on the board column: 'top' runs
    it along the top, 'left'/'right' stand it beside the board. The CSS does
    the rest -- the bar is one element either way, so nothing has to be torn
    down and rebuilt to move it. */
function applyEvalBarSide(side) {
  const col = document.getElementById('board-col');
  const chosen = ['top', 'left', 'right'].includes(side) ? side : 'top';
  for (const option of ['top', 'left', 'right']) {
    col.classList.toggle('eval-' + option, option === chosen);
  }
}

async function fillBoardForm() {
  const [boardImages, sets] = await Promise.all([
    api('/api/board-images'),
    api('/api/asset-sets'),
  ]);
  // Board dropdown: populated from /assets/boards/ (flat .png files)
  const boardSel = document.getElementById('b-board-set');
  boardSel.innerHTML = '';
  for (const img of boardImages.filter((s) => s.has_board)) {
    const opt = document.createElement('option');
    opt.value = img.name;
    opt.textContent = img.name;
    boardSel.appendChild(opt);
  }
  const currentBoard = state.user.board_set || state.user.asset_set || 'default';
  if (boardImages.some((s) => s.name === currentBoard && s.has_board)) boardSel.value = currentBoard;

  // Piece dropdown: populated from asset sets that have all 12 piece images
  const pieceSel = document.getElementById('b-piece-set');
  pieceSel.innerHTML = '';
  for (const set of sets.filter((s) => s.has_pieces)) {
    const opt = document.createElement('option');
    opt.value = set.name;
    opt.textContent = set.name;
    pieceSel.appendChild(opt);
  }
  const currentPieces = state.user.piece_set || state.user.asset_set || 'default';
  if (sets.some((s) => s.name === currentPieces && s.has_pieces)) pieceSel.value = currentPieces;
  document.getElementById('b-legal-moves').checked = state.user.show_legal_moves !== 0;
  document.getElementById('b-premoves').checked = state.user.allow_premoves !== 0;
  document.getElementById('b-eval-bar-side').value = state.user.eval_bar_side || 'top';
  renderBoardPreview(document.getElementById('b-board-set').value,
                     document.getElementById('b-piece-set').value);
}

/** A small board+pieces swatch, drawn from the two chosen sets so a mix shows
    as the mix it is. */
function renderBoardPreview(boardSet, pieceSet) {
  const wrap = document.getElementById('board-preview');
  if (!wrap) return;
  wrap.innerHTML = '';

  const bg = document.createElement('img');
  bg.className = 'prev-board';
  bg.alt = '';
  bg.onerror = () => {
    // First fallback: try the old /assets/sets/{name}/board.png path
    if (bg.src.includes('/assets/boards/')) {
      bg.src = `/assets/sets/${boardSet}/board.png`;
      bg.onerror = () => {
        wrap.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 50% 50%';
      };
    } else {
      wrap.style.background = 'repeating-conic-gradient(#2a3040 0% 25%, #1a1f2c 0% 50%) 50% / 50% 50%';
    }
  };
  bg.src = `/assets/boards/${boardSet}.png`;
  wrap.appendChild(bg);

  // A representative handful of pieces, laid out on the swatch's 4x4 grid.
  const sample = [['wk', 0, 3], ['wq', 1, 3], ['bk', 3, 0], ['bq', 2, 0]];
  for (const [piece, col, row] of sample) {
    const img = document.createElement('img');
    img.className = 'prev-piece';
    img.src = `/assets/sets/${pieceSet}/${piece}.png`;
    img.alt = '';
    img.style.left = (col * 25) + '%';
    img.style.top = (row * 25) + '%';
    wrap.appendChild(img);
  }
}

function wireFenBox() {
  document.getElementById('fen-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('fen-box').value);
  });
  // Setting the board is not loading a game. The position goes up and the
  // move list empties with it (it is a new tree), but the library selection
  // and the analysis panel are left alone -- pasting a FEN to look at
  // something shouldn't put away the game you had open.
  document.getElementById('fen-goto-btn').addEventListener('click', () => {
    const fen = document.getElementById('fen-goto').value.trim();
    if (!fen) return;
    const ok = state.explorer.loadFEN(fen);
    if (!ok) { alert('That FEN could not be parsed.'); return; }
    // The classifications belonged to the game that was on the board, and
    // nothing about this position is that game's ply 7.
    state.classifications = {};
    renderMoveTable();
    syncBoardFull();
  });
}

/* ---------------- Live engine lines ----------------
   The eval bar has always been driven by a live Stockfish process on the
   position in front of you (spec section 3). This shows its working: the top
   one to three moves it is considering, with what each is worth and the line
   it expects to follow.

   It reuses that same process and socket rather than starting anything --
   turning it on asks the session for more ranked lines, turning it off asks
   for one again, which is what the bar needs anyway. */

function wireLiveLines() {
  const btn = document.getElementById('live-lines-btn');
  const count = document.getElementById('live-lines-count');
  btn.addEventListener('click', () => setLiveLines(state.liveLines.count ? 0 : Number(count.value)));
  count.addEventListener('change', () => {
    if (state.liveLines.count) setLiveLines(Number(count.value));
  });
}

function setLiveLines(n) {
  state.liveLines.count = n;
  state.liveLines.byRank = {};
  document.getElementById('live-lines-btn').textContent = n ? 'Stop live analysis' : 'Analyse live';
  document.getElementById('live-lines-btn').classList.toggle('on', !!n);
  document.getElementById('live-lines').classList.toggle('hidden', !n);
  renderLiveLines();
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.seq += 1;
  state.liveLines.seq = state.seq;
  // One line is what the bar needs, so switching off costs the engine nothing
  // -- it goes back to the search it would have been running anyway.
  state.ws.send(JSON.stringify({ type: 'multipv', lines: n || 1, seq: state.seq }));
}

/** Files an `info` line under its rank. Ranks arrive interleaved as the search
    deepens and each one supersedes the last of its own rank, which is all this
    has to know. */
function noteLiveLine(msg) {
  if (!state.liveLines.count) return;
  if (msg.seq !== state.seq) return;
  if (state.liveLines.seq !== msg.seq) {
    state.liveLines.seq = msg.seq;
    state.liveLines.byRank = {};
  }
  state.liveLines.byRank[msg.multipv || 1] = msg;
  renderLiveLines();
}

/** Centipawns as White sees them, from a mover's-perspective info line. The
    panel is read next to an eval bar that is already White-relative, and two
    numbers with opposite signs for the same position is the kind of thing
    nobody notices until it has misled them. */
function whiteScore(info) {
  const flip = state.lastMoverColor === 'b' ? -1 : 1;
  if (info.mate !== null && info.mate !== undefined) {
    const mate = flip * info.mate;
    return { text: (mate > 0 ? '#' : '#-') + Math.abs(info.mate), cp: mate > 0 ? 10000 : -10000 };
  }
  if (info.cp === null || info.cp === undefined) return null;
  const cp = flip * info.cp;
  return { text: (cp > 0 ? '+' : '') + (cp / 100).toFixed(2), cp };
}

/** The engine's principal variation as SAN, which is the only form it can be
    read in. Replayed on a scratch board from the position on ours; a line
    that doesn't replay is truncated rather than dropped, since the first few
    moves are the part anyone reads. */
function pvToSan(uciMoves, fen, limit = 8) {
  const board = new Chess();
  if (!board.load(fen)) return '';
  const out = [];
  for (const uci of (uciMoves || []).slice(0, limit)) {
    const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    if (!move) break;
    out.push(move.san);
  }
  return out.join(' ');
}

function renderLiveLines() {
  const box = document.getElementById('live-lines-body');
  if (!state.liveLines.count) { box.innerHTML = ''; return; }
  const ranks = Object.keys(state.liveLines.byRank).map(Number).sort((a, b) => a - b);
  if (!ranks.length) { box.innerHTML = '<p class="hint">Thinking...</p>'; return; }
  const fen = state.explorer.fen;
  box.innerHTML = ranks.slice(0, state.liveLines.count).map((rank) => {
    const info = state.liveLines.byRank[rank];
    const score = whiteScore(info);
    if (!score) return '';
    const san = pvToSan(info.pv, fen);
    return `<div class="live-line">
        <span class="live-score ${score.cp >= 0 ? 'white-better' : 'black-better'}">${score.text}</span>
        <span class="live-pv">${san || '—'}</span>
        <span class="live-depth">d${info.depth || 0}</span>
      </div>`;
  }).join('');
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
      await refreshLibrary();
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  });

  wireChesscomImport();

  document.getElementById('rematch-colors-btn').addEventListener('click', async () => {
    const status = document.getElementById('rematch-status');
    status.textContent = 'Checking...';
    try {
      const res = await api('/api/games/rematch-colors', { method: 'POST' });
      await refreshGameList();
      status.textContent = res.changed
        ? `${res.changed} game(s) changed — ${res.assigned} now assigned.`
        : 'No games changed. Check the display name on your account matches your PGN headers.';
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  });
}

async function refreshGameList() {
  const query = filterQuery();
  state.games = await api('/api/games' + (query ? `?${query}` : ''));
  // A game that has left the filter (or the library) must not stay ticked:
  // "delete selected" has to mean the rows in front of you.
  const visible = new Set(state.games.map((g) => g.id));
  for (const id of [...state.selectedIds]) if (!visible.has(id)) state.selectedIds.delete(id);
  renderGamePicker();
  renderBulkTools();
}

/** A filter as query parameters, shared by the game list, the bulk actions,
    the batch preview and the Progress fits so they can't drift apart. The
    server spells these three the same way at every endpoint that takes them. */
function filterQuery(filter = state.filter) {
  const p = new URLSearchParams();
  if (filter.speed) p.set('speed', filter.speed);
  if (filter.timeControl) p.set('time_control', filter.timeControl);
  if (filter.collectionId) p.set('collection_id', filter.collectionId);
  return p.toString();
}

/** The same thing as a JSON body, for the endpoints that take one. */
function filterBody() {
  const body = {};
  if (state.filter.speed) body.speed = state.filter.speed;
  if (state.filter.timeControl) body.time_control = state.filter.timeControl;
  if (state.filter.collectionId) body.collection_id = state.filter.collectionId;
  return body;
}

/* ---------------- Time controls, groups and the library filter ----------------
   The speed buckets are chess.com's, because the games come from there: a
   library that called 3+2 something other than blitz would be useless for
   comparing against the rating the site gives you. */

const SPEED_ICONS = { bullet: '🚀', blitz: '⚡', rapid: '⏱', daily: '📆', unknown: '?' };

/** '600+5' as the label chess.com would put on it ('10 + 5'). Seconds under a
    minute stay seconds, because "0.5 min" helps nobody. */
function formatTimeControl(raw) {
  if (!raw) return 'no clock';
  const [movesPart, slash, rest] = raw.includes('/')
    ? [raw.split('/')[0], true, raw.split('/').slice(1).join('/')] : [null, false, raw];
  const [baseStr, incStr] = rest.split('+');
  const base = Number(baseStr);
  if (!Number.isFinite(base)) return raw;
  if (slash && Number(movesPart) === 1 && base >= 86400) {
    const days = Math.round(base / 86400);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const inc = Number(incStr);
  const minutes = base % 60 === 0 ? base / 60 : null;
  // chess.com's own convention: the unit is dropped once an increment is
  // shown ('10 + 5', not '10 min + 5'), and sub-minute bases keep 'sec'.
  if (inc) return minutes ? `${minutes} + ${inc}` : `${base} sec + ${inc}`;
  return minutes ? `${minutes} min` : `${base} sec`;
}

async function refreshCollections() {
  state.collections = await api('/api/collections');
  renderCollectionControls();
  // Progress filters by the same groups, so a group renamed or deleted has to
  // reach both pickers or the second one keeps offering a name that's gone.
  renderProgressFilter();
  // Making the first group has to reveal the actions that need one to exist.
  renderBulkTools();
}

async function refreshFacets() {
  state.facets = await api('/api/games/facets');
  renderSpeedChips();
  renderControlChips();
  renderProgressFilter();
}

/** Everything about the library at once: what buckets exist, what groups
    exist, and the games themselves under the current filter. */
async function refreshLibrary() {
  await Promise.all([refreshFacets(), refreshCollections()]);
  await refreshGameList();
  refreshBatchScopeNote();
}

function chip(label, count, on, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'filter-chip' + (on ? ' on' : '');
  b.textContent = label;
  if (title) b.title = title;
  if (count !== null && count !== undefined) {
    const n = document.createElement('span');
    n.className = 'chip-count';
    n.textContent = count;
    b.appendChild(n);
  }
  b.addEventListener('click', onClick);
  return b;
}

/** Changing what you're looking at drops the selection: a tick you can no
    longer see is exactly the tick that makes a bulk delete a mistake. */
async function setFilter(patch) {
  Object.assign(state.filter, patch);
  state.selectedIds.clear();
  renderSpeedChips();
  renderControlChips();
  renderCollectionControls();
  await refreshGameList();
  refreshBatchScopeNote();
}

/** The speed row and the exact-control row, for whichever filter is asking.

    The Games list and the Progress fits offer the same choice over the same
    facets and differ only in what a click does, so the chips are defined once
    here: two rows that looked the same but drifted apart would be worse than
    either. `apply` takes the patch and is responsible for refetching. */
function renderSpeedChipRow(wrap, filter, apply) {
  wrap.replaceChildren();
  const speeds = state.facets.speeds || [];
  // With one bucket there is nothing to choose between, so the row would be
  // a filter that can only be switched off.
  if (speeds.length < 2) return;
  wrap.appendChild(chip('All', state.facets.total, !filter.speed,
    () => apply({ speed: null, timeControl: null })));
  for (const s of speeds) {
    wrap.appendChild(chip(
      `${SPEED_ICONS[s.speed] || ''} ${s.speed}`.trim(), s.games,
      filter.speed === s.speed,
      () => apply({ speed: s.speed, timeControl: null }),
      s.speed === 'unknown'
        ? 'Games whose export carried no usable TimeControl header'
        : null,
    ));
  }
}

/** The exact controls inside the chosen speed. Only shown once a speed is
    picked and there is more than one control in it -- the point is telling
    10+5 from 15+10, not listing every control you own. */
function renderControlChipRow(wrap, filter, apply) {
  wrap.replaceChildren();
  const bucket = (state.facets.speeds || []).find((s) => s.speed === filter.speed);
  if (!bucket || bucket.controls.length < 2) return;
  wrap.appendChild(chip(`Any ${bucket.speed}`, bucket.games, !filter.timeControl,
    () => apply({ timeControl: null })));
  for (const c of bucket.controls) {
    wrap.appendChild(chip(formatTimeControl(c.time_control), c.games,
      filter.timeControl === c.time_control,
      () => apply({ timeControl: c.time_control }), c.time_control));
  }
}

function renderSpeedChips() {
  renderSpeedChipRow(document.getElementById('speed-chips'), state.filter, setFilter);
}

function renderControlChips() {
  renderControlChipRow(document.getElementById('control-chips'), state.filter, setFilter);
}

function renderCollectionControls() {
  const select = document.getElementById('collection-filter');
  const current = state.filter.collectionId;
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = state.collections.length ? 'All groups' : 'No groups yet';
  select.appendChild(all);
  for (const c of state.collections) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name} (${c.game_count})`;
    select.appendChild(o);
  }
  select.value = current ? String(current) : '';
  // Rename/delete apply to the group being shown, so they only exist when
  // one is.
  document.getElementById('collection-rename').classList.toggle('hidden', !current);
  document.getElementById('collection-delete').classList.toggle('hidden', !current);

  // The two other places a group can be chosen: the bulk-action target and
  // the chess.com importer.
  for (const id of ['bulk-group-target', 'cc-collection']) {
    const box = document.getElementById(id);
    if (!box) continue;
    const keep = box.value;
    box.replaceChildren();
    if (id === 'cc-collection') {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'none';
      box.appendChild(none);
    }
    for (const c of state.collections) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      box.appendChild(o);
    }
    // Default the bulk target to the group on show: "add these to the group
    // I'm looking at" is not the common case, but "remove them from it" is.
    box.value = [...box.options].some((o) => o.value === keep) ? keep
      : (id === 'bulk-group-target' && current ? String(current) : '');
  }
  const ccRow = document.getElementById('cc-group-row');
  if (ccRow) ccRow.classList.toggle('hidden', state.collections.length === 0);
}

function renderBulkTools() {
  const n = state.selectedIds.size;
  const shown = state.games.length;
  const anySelected = n > 0;
  document.getElementById('selection-count').textContent =
    anySelected ? `${n} of ${shown} selected` : '';
  const all = document.getElementById('select-all');
  all.checked = shown > 0 && n === shown;
  all.indeterminate = anySelected && n < shown;
  all.disabled = shown === 0;
  document.getElementById('select-all-label').textContent =
    shown === 0 ? 'Select all' : `Select all ${shown}`;
  document.getElementById('bulk-delete').classList.toggle('hidden', !anySelected);
  document.getElementById('bulk-add').classList.toggle('hidden',
    !anySelected || state.collections.length === 0);
  // Removing from a group is only meaningful while one is on show.
  document.getElementById('bulk-remove').classList.toggle('hidden',
    !anySelected || !state.filter.collectionId);
  document.getElementById('bulk-group-target').classList.toggle('hidden',
    !anySelected || state.collections.length === 0);
}

function wireLibraryTools() {
  document.getElementById('collection-filter').addEventListener('change', (e) => {
    setFilter({ collectionId: e.target.value ? Number(e.target.value) : null });
  });

  document.getElementById('collection-new').addEventListener('click', async () => {
    const name = prompt('Name for the new group:');
    if (name === null || !name.trim()) return;
    try {
      const made = await api('/api/collections', {
        method: 'POST', body: JSON.stringify({ name }),
      });
      await refreshCollections();
      // Straight into it: making a group is nearly always followed by
      // putting something in it.
      document.getElementById('bulk-group-target').value = String(made.id);
    } catch (e) { alert(e.message); }
  });

  document.getElementById('collection-rename').addEventListener('click', async () => {
    const id = state.filter.collectionId;
    const current = state.collections.find((c) => c.id === id);
    if (!current) return;
    const name = prompt('New name for this group:', current.name);
    if (name === null || !name.trim() || name === current.name) return;
    try {
      await api(`/api/collections/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      await refreshCollections();
    } catch (e) { alert(e.message); }
  });

  document.getElementById('collection-delete').addEventListener('click', async () => {
    const id = state.filter.collectionId;
    const current = state.collections.find((c) => c.id === id);
    if (!current) return;
    // Worth being explicit: "delete group" beside a list of games reads like
    // it deletes the games, and it does not.
    if (!confirm(`Delete the group "${current.name}"?\n\n`
      + `The ${current.game_count} game(s) in it stay in your library — only the group goes.`)) return;
    await api(`/api/collections/${id}`, { method: 'DELETE' });
    await setFilter({ collectionId: null });
    await refreshCollections();
  });

  document.getElementById('select-all').addEventListener('change', (e) => {
    state.selectedIds = e.target.checked ? new Set(state.games.map((g) => g.id)) : new Set();
    renderGamePicker();
    renderBulkTools();
  });

  document.getElementById('bulk-add').addEventListener('click', async () => {
    const target = document.getElementById('bulk-group-target').value;
    if (!target) return;
    const res = await api(`/api/collections/${target}/games`, {
      method: 'POST', body: JSON.stringify({ game_ids: [...state.selectedIds] }),
    });
    await refreshCollections();
    await refreshGameList();
    const name = state.collections.find((c) => c.id === Number(target))?.name || 'the group';
    setRematchNote(res.added
      ? `Added ${res.added} game(s) to "${name}".`
      : `Those ${res.already_in} game(s) were already in "${name}".`);
  });

  document.getElementById('bulk-remove').addEventListener('click', async () => {
    const id = state.filter.collectionId;
    if (!id) return;
    const res = await api(`/api/collections/${id}/games/remove`, {
      method: 'POST', body: JSON.stringify({ game_ids: [...state.selectedIds] }),
    });
    state.selectedIds.clear();
    await refreshCollections();
    await refreshGameList();
    setRematchNote(`Removed ${res.removed} game(s) from the group. They are still in your library.`);
  });

  document.getElementById('bulk-delete').addEventListener('click', async () => {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    const analysed = state.games.filter((g) => ids.includes(g.id) && g.analyzed).length;
    const extra = analysed ? `\n\n${analysed} of them have a saved analysis, which goes too.` : '';
    if (!confirm(`Delete ${ids.length} game(s)?${extra}\n\nThis cannot be undone.`)) return;
    const res = await api('/api/games/bulk-delete', {
      method: 'POST', body: JSON.stringify({ game_ids: ids }),
    });
    // The loaded game may have been one of them.
    if (state.selectedGameId && ids.includes(state.selectedGameId)) {
      state.selectedGameId = null;
      resetAnalysisState();
    }
    state.selectedIds.clear();
    await refreshLibrary();
    setRematchNote(`Deleted ${res.deleted} game(s).`);
  });
}

/** The status line under the game list, reused by the bulk actions -- they
    happen right above it and it is where the outcome of the last thing you
    pressed already appears. */
function setRematchNote(text) {
  document.getElementById('rematch-status').textContent = text;
}

/* ---------------- Download from chess.com ----------------
   The months are listed first and picked by hand rather than "import
   everything": an account with five years on it is sixty downloads, and the
   months you actually want to study are usually the recent ones.

   Downloading runs a few months per request in a loop, not one big request.
   chess.com rate-limits, an archive can be slow, and a single call covering
   five years would sit past any sane HTTP timeout with nothing to show for
   it -- this way there's a progress line and stopping halfway keeps whatever
   already landed. */

// Matches the server's per-request cap (chesscom.MAX_MONTHS_PER_REQUEST).
const CC_MONTHS_PER_REQUEST = 6;

function ccStatus(text, isError) {
  const el = document.getElementById('cc-status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function ccSelected() {
  return [...document.querySelectorAll('#cc-months input:checked')].map((i) => i.value);
}

function renderCcMonths(months) {
  const wrap = document.getElementById('cc-months');
  wrap.innerHTML = '';
  for (const m of months) {
    const label = document.createElement('label');
    label.className = 'cc-month' + (m.imported ? ' done' : '')
      + (m.settled ? ' settled' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = m.label;
    box.dataset.imported = m.imported;
    box.dataset.settled = m.settled ? '1' : '0';
    label.appendChild(box);
    label.appendChild(document.createTextNode(m.label));
    if (m.imported) {
      const have = document.createElement('span');
      have.className = 'cc-have';
      have.textContent = `${m.imported} held`;
      have.title = 'already in your library — downloading again adds only new games';
      label.appendChild(have);
    }
    if (m.settled) {
      // A finished month that's already been read can't gain a game, so
      // "Get new games" won't even ask about it. Marked, because a button
      // that quietly does less than the whole list has to say so.
      const done = document.createElement('span');
      done.className = 'cc-settled';
      done.textContent = '✓';
      done.title = 'this month is over and already downloaded — nothing can be '
        + 'added to it, so it will not be fetched again';
      label.appendChild(done);
    }
    wrap.appendChild(label);
  }
  document.getElementById('cc-actions').classList.toggle('hidden', months.length === 0);
}

function wireChesscomImport() {
  const usernameBox = document.getElementById('cc-username');
  // The handle that decides which side of a game was yours is the best guess
  // at the chess.com account too, so it's filled in rather than asked for.
  usernameBox.value = localStorage.getItem('cc:username')
    || state.user?.display_name || state.user?.username || '';

  /** Fetches the month list and paints it. Returns the months, or null if the
      lookup failed (having said why). Silent about its own progress when
      called to repaint after an import, so the "added N games" line it was
      called from is what stays on screen. */
  const loadMonths = async (quiet) => {
    const username = usernameBox.value.trim();
    if (!username) { ccStatus('Type your chess.com username first.', true); return null; }
    if (!quiet) {
      ccStatus('Asking chess.com which months you have games in...');
      document.getElementById('cc-months').innerHTML = '';
      document.getElementById('cc-actions').classList.add('hidden');
    }
    try {
      const res = await api('/api/games/chesscom/archives', {
        method: 'POST', body: JSON.stringify({ username }),
      });
      usernameBox.value = res.username;
      localStorage.setItem('cc:username', res.username);
      renderCcMonths(res.months);
      if (!quiet) {
        ccStatus(res.months.length
          ? `${res.months.length} month(s) of games. Pick the ones to download.`
          : `chess.com has no games for '${res.username}'.`);
      }
      return res.months;
    } catch (e) {
      if (!quiet) ccStatus(e.message, true);
      return null;
    }
  };
  const find = () => loadMonths(false);

  document.getElementById('cc-find-btn').addEventListener('click', find);
  usernameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });

  document.getElementById('cc-select-new').addEventListener('click', () => {
    for (const box of document.querySelectorAll('#cc-months input')) {
      box.checked = box.dataset.imported === '0';
    }
  });
  document.getElementById('cc-clear').addEventListener('click', () => {
    for (const box of document.querySelectorAll('#cc-months input')) box.checked = false;
  });

  /** Runs an import to completion over `months`.

      In 'new' mode the whole list goes to the server at once: it decides
      which months cost a request (a finished month already downloaded costs
      none) and hands back whatever its per-request cap didn't reach, so this
      loops on `remaining` rather than slicing the list itself. Only the
      server knows which months are free.

      'refetch' pulls the named months down in full, so it chunks by the
      server's cap the way it always did. */
  const ccRun = async (buttonId, months, mode) => {
    // Looked up by id rather than taken from the click event: `currentTarget`
    // is only valid while the event is dispatching, and both callers await
    // before getting here, by which point it is null and the button never
    // comes back out of its disabled state.
    const button = document.getElementById(buttonId);
    const username = usernameBox.value.trim();
    if (!username) { ccStatus('Type your chess.com username first.', true); return; }
    if (!months.length) { ccStatus('Tick at least one month.', true); return; }

    button.disabled = true;
    let added = 0, skipped = 0, clocked = 0;
    let downloaded = 0, settled = 0, unchanged = 0, handled = 0;
    let pending = mode === 'refetch' ? months.slice(0, CC_MONTHS_PER_REQUEST) : months;
    let queued = mode === 'refetch' ? months.slice(CC_MONTHS_PER_REQUEST) : [];

    try {
      while (pending.length) {
        ccStatus(mode === 'refetch'
          ? `Downloading ${handled + 1}-${handled + pending.length} of ${months.length} month(s)...`
          : `Checking ${months.length - handled} month(s) for new games...`);
        const target = document.getElementById('cc-collection').value;
        const res = await api('/api/games/chesscom/import', {
          method: 'POST', body: JSON.stringify({
            username, months: pending, mode,
            collection_id: target ? Number(target) : null,
          }),
        });
        added += res.added; skipped += res.skipped; clocked += res.with_clocks;
        downloaded += res.downloaded || 0;
        settled += res.settled || 0;
        unchanged += res.unchanged || 0;
        handled += pending.length - (res.remaining || []).length;
        // After every round, so a long import fills the library as it goes
        // rather than all at the end. The whole library, not just the list:
        // new games change the speed counts and the group sizes too.
        await refreshLibrary();
        pending = (res.remaining && res.remaining.length) ? res.remaining
          : queued.splice(0, CC_MONTHS_PER_REQUEST);
      }
      await loadMonths(true);   // repaint the "held" counts against the new library

      // Say what was downloaded as well as what was added. "Added 0 games"
      // on its own reads as a failure; "checked 1 month, 119 already
      // complete" says the thing actually worked.
      const savings = [];
      if (settled) savings.push(`${settled} already complete`);
      if (unchanged) savings.push(`${unchanged} unchanged`);
      const detail = savings.length ? ` (${savings.join(', ')}, not re-downloaded)` : '';
      if (added) {
        // Clocks are called out because they're the reason to import this
        // way: without them the Elo fit can't drop moves played instantly.
        ccStatus(`Added ${added} game(s)${clocked ? `, ${clocked} with clock times` : ''}`
          + `${skipped ? `; ${skipped} already in your library` : ''}`
          + `${detail}.`);
      } else {
        ccStatus(`No new games. Downloaded ${downloaded} month(s)${detail}.`);
      }
    } catch (e) {
      ccStatus(`Stopped after ${handled} of ${months.length} month(s): ${e.message}`
        + (added ? ` ${added} game(s) were saved.` : ''), true);
      await refreshLibrary();
    } finally {
      button.disabled = false;
    }
  };

  // The everyday action: whatever chess.com has that you don't. Every month
  // goes to the server, which skips the finished ones for free -- so this is
  // usually one request that checks the current month and nothing else.
  document.getElementById('cc-sync-btn').addEventListener('click', async () => {
    const months = await loadMonths(true)
      || [...document.querySelectorAll('#cc-months input')].map((i) => ({ label: i.value }));
    await ccRun('cc-sync-btn', months.map((m) => m.label), 'new');
  });

  document.getElementById('cc-import-btn').addEventListener('click', () => {
    const refetch = document.getElementById('cc-refetch').checked;
    return ccRun('cc-import-btn', ccSelected(), refetch ? 'refetch' : 'new');
  });
}

/** One line of prose for a game: the picker rows and the collapsed Games
    panel's summary say the same thing about it. */
function gameLabel(g) {
  const opponent = g.your_color === 'w' ? g.black : g.your_color === 'b' ? g.white : `${g.white} vs ${g.black}`;
  const date = g.utc_date_header || g.date_header || '?';
  return `${opponent || '?'} — ${date} — ${g.result || '?'}`;
}

function renderGamePicker() {
  const wrap = document.getElementById('game-picker');
  wrap.innerHTML = '';
  refreshPanelSummaries();
  if (state.games.length === 0) {
    const filtered = state.filter.speed || state.filter.timeControl || state.filter.collectionId;
    wrap.innerHTML = filtered
      ? '<p style="color:var(--muted);font-size:13px;">No games match this filter.</p>'
      : '<p style="color:var(--muted);font-size:13px;">No games loaded yet.</p>';
    return;
  }
  for (const g of state.games) {
    const row = document.createElement('div');
    row.className = 'game-row' + (g.id === state.selectedGameId ? ' active' : '');

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'game-select';
    tick.checked = state.selectedIds.has(g.id);
    tick.title = 'Select for a bulk action';
    tick.addEventListener('click', (ev) => ev.stopPropagation());  // not also load it
    tick.addEventListener('change', () => {
      if (tick.checked) state.selectedIds.add(g.id); else state.selectedIds.delete(g.id);
      renderBulkTools();
    });
    row.appendChild(tick);

    const left = document.createElement('span');
    left.className = 'game-label';
    left.textContent = gameLabel(g);
    row.appendChild(left);

    // What the filter decided about this game, so the buckets are checkable
    // rather than taken on trust. Dimmed when the game carries no clocks,
    // which is what the Elo fit's instant-move filter needs.
    const tc = document.createElement('span');
    tc.className = 'game-tc' + (g.has_clocks ? '' : ' no-clock');
    tc.textContent = formatTimeControl(g.time_control);
    tc.title = g.has_clocks
      ? `${g.speed || 'unknown speed'} — has clock times`
      : `${g.speed || 'unknown speed'} — no clock times in this export`;
    row.appendChild(tc);

    row.appendChild(colorControl(g));
    if (g.analyzed) {
      const mark = document.createElement('span');
      mark.className = 'analyzed-mark';
      mark.textContent = { full: '\u25CF full', quick: '\u25CB quick' }[g.analyzed] || '\u25CB sweep';
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
      await refreshLibrary();
    });
    row.appendChild(del);
    row.addEventListener('click', () => selectGame(g.id));
    wrap.appendChild(row);
  }
}

/** The side-you-played chip on a game row, and the way to correct it.
    Unassigned games are worth shouting about: they're dropped from the
    strength fit, the trend and the puzzle generator, so a library that's
    silently all-unassigned looks like an app that just doesn't work. */
function colorControl(g) {
  const wrap = document.createElement('span');
  wrap.className = 'game-color';
  const unassigned = g.your_color !== 'w' && g.your_color !== 'b';

  const chip = document.createElement('button');
  chip.className = 'color-chip' + (unassigned ? ' unassigned' : '');
  chip.textContent = unassigned ? '⚠ set side' : (g.your_color === 'w' ? 'you: White' : 'you: Black');
  chip.title = unassigned
    ? "Neither player's name matched this account -- pick which side was yours"
    : 'Which side was yours (click to change)';
  chip.addEventListener('click', (ev) => {
    ev.stopPropagation();       // picking a side shouldn't also load the game
    wrap.replaceChildren(...picker());
  });
  wrap.appendChild(chip);

  function picker() {
    const choose = async (colour) => {
      await api(`/api/games/${g.id}/color`, {
        method: 'PATCH', body: JSON.stringify({ your_color: colour }),
      });
      await refreshGameList();
      // The board faces the side you played, and the move table's left column
      // is yours, so the open game has to be reloaded to follow the change.
      if (state.selectedGameId === g.id) await selectGame(g.id);
    };
    return [
      ['w', g.white || 'White'], ['b', g.black || 'Black'], ['unassigned', 'neither'],
    ].map(([colour, label]) => {
      const btn = document.createElement('button');
      btn.className = 'color-choice' + (g.your_color === colour ? ' current' : '');
      btn.textContent = label;
      btn.title = colour === 'unassigned' ? 'I played neither side' : `I played as ${label}`;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); choose(colour); });
      return btn;
    });
  }
  return wrap;
}

async function selectGame(gameId) {
  const game = await api(`/api/games/${gameId}`);
  state.selectedGameId = gameId;
  resetAnalysisState();
  renderGamePicker();
  // The stored colour wins: it may have been assigned by hand, which the
  // header match can't rediscover.
  state.explorer.loadPGN(game.pgn_text, accountNames(), game.your_color);
  state.flipOverride = false;
  state.explorer.goToStart();
  renderMoveTable();
  // Reattaching to a job on load can select a game while the Play or Puzzles
  // tab owns the board (see reattachRunningJobs); the explorer still loads, the
  // board doesn't move.
  if (boardIsAnalysing()) {
    applyOrientation();
    syncBoardFull();
  }
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
  refreshLastMove();   // the badge for whatever is on the board is known now
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

/** White on the left, Black on the right, always -- the order the moves were
    played in and the order every other chess interface writes them. Which
    side was yours is said in the header rather than by moving the column,
    since a table whose columns swap between games is one you have to read
    the header of anyway. */
function setMoveTableHeader(headers) {
  const names = { w: headers.White || 'White', b: headers.Black || 'Black' };
  const known = !!(headers.White || headers.Black);
  const yours = state.explorer.yourColor;
  for (const colour of ['w', 'b']) {
    const cell = document.getElementById(colour === 'w' ? 'mt-white' : 'mt-black');
    cell.textContent = !known ? '' : names[colour] + (colour === yours ? ' (you)' : '');
  }
}

function renderMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const mainlineIds = state.explorer.mainlineNodeIds;
  setMoveTableHeader(state.explorer.headers || {});

  for (let i = 0; i < mainlineIds.length; i += 2) {
    const whiteId = mainlineIds[i];
    const blackId = mainlineIds[i + 1];

    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'ply-num';
    numTd.textContent = (i / 2 + 1) + '.';
    tr.appendChild(numTd);

    for (const id of [whiteId, blackId]) {
      const td = document.createElement('td');
      if (id !== undefined) {
        const node = state.explorer.nodes[id];
        const cls = state.classifications[node.ply];
        const icon = cls && classificationIcon(cls.classification, 24);
        // The icon says what the suffix said, so it doesn't say it twice.
        td.textContent = node.san + (cls && !icon ? classificationSuffix(cls.classification) : '');
        if (cls) td.classList.add('cls-' + cls.classification);
        if (icon) td.appendChild(icon);
        td.dataset.nodeId = id;
        td.addEventListener('click', () => {
          state.explorer.goToNode(id);
          syncBoardFull();
          announceClassification();
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

// Matched to the badge art, so a mark on the curve and a badge on the board
// are recognisably the same judgement.
const PLOT_MARK_COLOURS = {
  blunder: '#fa412d', miss: '#ff7769', mistake: '#ffa459', inaccuracy: '#f7c631',
  great: '#749bbf', brilliant: '#26c2a3',
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
  // A batch or a full analysis can finish while you're on another tab.
  wrap.classList.toggle('hidden', !boardIsAnalysing());

  const W = 600, H = 110, padB = 0;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'eval-plot-svg',
                             preserveAspectRatio: 'none' });
  const n = moves.length;
  const sx = (i) => (i / n) * W;          // i = 0 is the starting position
  const sy = (wp) => H - wp * (H - padB);

  // The starting position is level by definition; including it stops the
  // curve from beginning mid-air at move 1.
  const points = [[sx(0), sy(0.5)]];
  moves.forEach((m, i) => points.push([sx(i + 1), sy(whiteWinProb(m.cp_after, m.ply))]));

  // Smoothed, but by a spline that cannot overshoot -- a cliff stays a cliff
  // and no swing appears that the evaluation didn't make (see smoothPath).
  const line = smoothPath(points);
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

/** The old text annotation, still used for the classifications that don't get
    a badge -- which today means it renders nothing at all, since those are the
    unremarkable ones. Kept so that unbadging a label doesn't silently drop
    what it was saying. */
const CLASSIFICATION_SUFFIX = {
  brilliant: '!!', great: '!', best: '', excellent: '', good: '', book: '',
  inaccuracy: '?!', mistake: '?', miss: '??', blunder: '??',
};

function classificationSuffix(classification) {
  return CLASSIFICATION_SUFFIX[classification] || '';
}

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
      if (msg.fen && boardIsAnalysing()) state.board.renderFEN(msg.fen);
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
    refreshLastMove();   // the badge for whatever is on the board is known now
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
    if (boardIsAnalysing()) syncBoardFull();
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
    if (boardIsAnalysing()) syncBoardFull();
    return;
  }
  const nodeId = state.explorer.mainlineNodeIds[ply - 1];
  if (nodeId === undefined) return;
  const node = state.explorer.nodes[nodeId];
  state.explorer.goToNode(nodeId);
  // The explorer keeps following along, so coming back to the tab lands where
  // the job got to -- but the board belongs to whoever is using it.
  if (!boardIsAnalysing()) return;
  await state.board.animateMove(node.from, node.to, node.fenAfter);
  refreshFenBox();
  refreshMoveTableHighlight();
  requestEval();
}

function renderAnalysisSummary(moves) {
  const counts = {};
  for (const key of CLASSIFICATIONS) counts[key] = 0;
  for (const m of moves) if (m.classification in counts) counts[m.classification]++;
  const el = document.getElementById('analysis-summary');
  el.innerHTML = '';
  const labels = { brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent',
                   good: 'Good', book: 'Book', inaccuracy: 'Inaccuracies', mistake: 'Mistakes',
                   miss: 'Misses', blunder: 'Blunders' };
  // The rare awards are worth a line only when they happened; the everyday
  // counts are the shape of the game and read better with the zeroes in.
  const onlyWhenEarned = ['brilliant', 'great', 'best', 'book', 'miss'];
  for (const key of CLASSIFICATIONS) {
    if (counts[key] === 0 && onlyWhenEarned.includes(key)) continue;
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
    const who = sideLabel(side, yourColor);
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
/** Names the slice of the library a batch would run over, in the batch panel
    -- the filter that decides it lives in another panel, and a run over your
    rapid games only is a different number from a run over everything. */
function refreshBatchScopeNote() {
  const note = document.getElementById('batch-scope-note');
  if (!note) return;
  const bits = [];
  if (state.filter.timeControl) bits.push(formatTimeControl(state.filter.timeControl));
  else if (state.filter.speed) bits.push(state.filter.speed);
  if (state.filter.collectionId) {
    const group = state.collections.find((c) => c.id === state.filter.collectionId);
    if (group) bits.push(`group "${group.name}"`);
  }
  note.textContent = bits.length
    ? `Limited to ${bits.join(', ')} — the filter set in Games. Clear it there to run over everything.`
    : '';
  refreshBatchPreview();
}

async function refreshBatchPreview() {
  if (state.batchJobId) return; // mid-run, the status line is more useful
  const mode = document.getElementById('batch-mode').value;
  const scope = document.getElementById('batch-scope').value;
  const filter = filterQuery();
  try {
    const info = await api(`/api/batch/preview?mode=${mode}&scope=${scope}`
      + (filter ? `&${filter}` : ''));
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
      mode, scope, run_id: runId ? Number(runId) : null, ...filterBody(),
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
      state.explorer.loadPGN(msg.pgn, accountNames());
      state.explorer.goToStart();
      state.classifications = {};
      renderMoveTable();
      if (boardIsAnalysing()) {
        applyOrientation();
        state.board.renderFEN(state.explorer.fen);
      }
    } catch (e) { /* an unparseable game still gets reported by game_failed */ }
    status.innerHTML = `Game <b>${msg.index + 1}</b> of <b>${msg.total}</b>: ${msg.white || '?'} vs ${msg.black || '?'}`;
  } else if (msg.type === 'progress') {
    if (msg.phase === 'maia') {
      if (msg.fen && boardIsAnalysing()) state.board.renderFEN(msg.fen);
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
    if (msg.fen && boardIsAnalysing()) state.board.renderFEN(msg.fen);
  } else if (msg.type === 'done') {
    document.getElementById('sweep-progress-fill').style.width = '100%';
    document.getElementById('sweep-status').textContent = 'Sweep complete.';
    renderSweepResults(msg);
    finishSweep();
    if (boardIsAnalysing()) syncBoardFull();
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

/** What to call the player of a side in the sweep panel. The PGN's own names,
    because a one-off analysis is just as likely to be a game between two other
    people as one of yours -- "You" and "Opponent" name nobody in that game.
    When one of the sides *is* yours it still says so, which is the only thing
    the old wording carried that a name doesn't. */
function sideLabel(side, yourColor) {
  const headers = state.explorer.headers || {};
  const name = (side === 'w' ? headers.White : headers.Black) || (side === 'w' ? 'White' : 'Black');
  return side === yourColor ? `${name} (you)` : name;
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
    who.textContent = sideLabel(side, msg.your_color);
    const elo = document.createElement('span');
    elo.className = 'sweep-elo';
    // Same rule as the pooled view: a peak that never reached the match rate
    // this model manages at that Elo is the grid running out, not a reading.
    elo.textContent = res.estimate == null ? '—'
      : res.bound === 'lower' ? `≥ ${res.estimate}`
      : res.bound === 'upper' ? `≤ ${res.estimate}` : `${res.estimate}`;
    const ci = document.createElement('span');
    ci.className = 'sweep-ci';
    ci.textContent = res.bound ? 'outside the swept range'
      : res.ci_low != null ? `95% CI ${res.ci_low}–${res.ci_high}` : '';
    const badge = document.createElement('span');
    badge.className = 'conf-badge conf-' + res.confidence;
    badge.textContent = res.confidence;
    head.append(who, elo, ci, badge);
    card.appendChild(head);

    card.appendChild(sweepChartBlock(res));

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

/** The sweep chart plus a note saying what its y axis is. Both the per-game
    and the pooled views use this, so neither can end up showing an unlabelled
    axis whose meaning depends on a setting elsewhere on the page. */
function sweepChartBlock(res) {
  const frag = document.createDocumentFragment();
  // A fit that never ran -- no positions, or a grid of one Elo -- returns the
  // reasons and nothing to plot. Say so rather than throwing on the missing
  // arrays and taking the reasons down with the chart.
  if (!res.curve_x || !res.curve_x.length) {
    const empty = document.createElement('div');
    empty.className = 'sweep-axis-note';
    empty.textContent = 'Nothing to plot for this sweep.';
    frag.appendChild(empty);
    return frag;
  }
  frag.appendChild(sweepChart(res));
  const axis = document.createElement('div');
  axis.className = 'sweep-axis-note';
  axis.textContent = res.curve_kind === 'mean_logp'
    ? `${res.curve_label} against swept Elo — higher is better predicted`
    : 'Maia match rate against swept Elo';
  frag.appendChild(axis);
  return frag;
}

/** What each swept Elo made of your moves, with the fitted curve over it and
    the peak marked -- so the estimate can be eyeballed, not just trusted.

    The y axis is whichever objective produced the fit, and the two are not the
    same quantity: the top-1 fit plots a match rate (higher is more of your
    moves guessed), the likelihood plots mean log probability per move (higher
    is still better, but it runs negative and is not a percentage). `curve_kind`
    says which, so a reader is never left to infer it from the numbers. */
function sweepChart(res) {
  const W = 300, H = 110, padX = 6, padY = 10;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'sweep-chart');
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = res.curve_label || 'Maia match rate';
  svg.appendChild(title);

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

/* ---------------- The Progress filter ----------------
   One choice of games for both panels on the tab. The batch runner can already
   analyse just your rapid games; without this, the number those analyses feed
   pooled them straight back together with everything else. */

// Below this many analysed games, a filtered fit gets a warning rather than
// being shown in the same typeface as one built from the whole library. It is
// a rule of thumb, not a threshold in the statistics: the interval is the real
// answer, and this only decides when to point at it.
const THIN_POOL_GAMES = 20;

async function setProgressFilter(patch) {
  Object.assign(state.progressFilter, patch);
  renderProgressFilter();
  await Promise.all([refreshStrength(), refreshTrend()]);
}

function renderProgressFilter() {
  const speeds = document.getElementById('progress-speed-chips');
  if (!speeds) return;
  renderSpeedChipRow(speeds, state.progressFilter, setProgressFilter);
  renderControlChipRow(document.getElementById('progress-control-chips'),
    state.progressFilter, setProgressFilter);

  const select = document.getElementById('progress-collection');
  const current = state.progressFilter.collectionId;
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = state.collections.length ? 'All groups' : 'No groups yet';
  select.appendChild(all);
  for (const c of state.collections) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name} (${c.game_count})`;
    select.appendChild(o);
  }
  select.value = current ? String(current) : '';
  // A group that has been deleted can't stay selected: the fits would keep
  // filtering by an id nothing is in and both panels would sit empty.
  if (current && select.value !== String(current)) {
    state.progressFilter.collectionId = null;
    select.value = '';
  }
}

/** What the Progress fits are running over, as a noun phrase: 'game(s)',
    'rapid game(s)', '10 + 5 game(s) in “Tournament prep”'. Every status line
    on the tab is built from this one, so they can't describe the same slice
    two different ways. */
function progressGamesPhrase(filter = state.progressFilter) {
  const speed = filter.timeControl ? formatTimeControl(filter.timeControl) : filter.speed;
  const group = filter.collectionId
    && state.collections.find((c) => c.id === Number(filter.collectionId));
  return `${speed ? `${speed} ` : ''}game(s)${group ? ` in “${group.name}”` : ''}`;
}

/** Whether any of it is narrowed at all -- the difference between "you have
    analysed nothing" and "you have analysed nothing *of this*". */
function progressFiltered(filter = state.progressFilter) {
  return Boolean(filter.speed || filter.timeControl || filter.collectionId);
}

/** The line under the filter, and the same sentence both panels lean on: what
    is being fitted, and — when the pool is thin — that this is a narrower
    measurement than the all-games one rather than a correction to it. */
function renderProgressFilterNote(games) {
  const note = document.getElementById('progress-filter-note');
  if (!note) return;
  if (!progressFiltered()) {
    note.textContent = '';
    note.className = 'filter-note';
    return;
  }
  const phrase = progressGamesPhrase();
  const thin = games != null && games < THIN_POOL_GAMES;
  note.className = 'filter-note' + (thin ? ' filter-note-warn' : '');
  note.textContent = games == null
    ? `Fitting your ${phrase} only.`
    : thin
      ? `Only ${games} analysed ${phrase} — wide intervals, and not comparable with the `
        + 'all-games number. Analyse more of this slice, or widen the filter.'
      : `Fitting ${games} analysed ${phrase}. A filtered estimate is a different `
        + 'measurement from the all-games one, not a more accurate version of it.';
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
  document.getElementById('strength-objective').addEventListener('change', refreshStrength);
  document.getElementById('progress-collection').addEventListener('change', (e) => {
    setProgressFilter({ collectionId: e.target.value ? Number(e.target.value) : null });
  });
  refreshStrength();
}

async function refreshStrength() {
  const runId = document.getElementById('strength-run').value;
  const topN = document.getElementById('strength-topn').value;
  const objective = document.getElementById('strength-objective').value;
  // "How many of Maia's top moves count as a match" is a top-1-objective
  // question; the likelihood uses the whole ordering and has no N to pick.
  document.getElementById('strength-topn-label').hidden = objective !== 'top1';
  const status = document.getElementById('strength-status');
  const body = document.getElementById('strength-body');
  const slice = filterQuery(state.progressFilter);
  status.textContent = 'Fitting...';
  try {
    const d = await api(`/api/strength?top_n=${topN}&objective=${objective}`
      + (runId ? `&run_id=${runId}` : '') + (slice ? `&${slice}` : ''));
    renderStrength(d, status, body);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    body.innerHTML = '';
  }
}

function renderStrength(d, status, body) {
  body.innerHTML = '';
  renderProgressFilterNote(d.you ? d.you.games : d.games);
  if (!d.you || d.you.estimate == null) {
    status.textContent = progressFiltered()
      ? `Nothing to fit from your ${progressGamesPhrase()} — analyse some (the Games list `
        + 'filters to the same slice, and a Full batch will sweep them), or widen the '
        + 'filter above.'
      : 'Nothing to fit yet — run a Full analysis (or a Full batch) first.';
    renderTrendSkipped(body, d);
    return;
  }
  // The two objectives count different things, so they describe themselves
  // differently. Under the likelihood a position is "usable" when Maia's
  // opinion of your move changes anywhere across the grid, which is far more
  // of them than the top-1 rate's "its favourite changed".
  let describe;
  if (d.objective === 'top1') {
    const matched = d.top_n > 1 ? `your move in Maia's top ${d.top_n}` : "Maia's own first choice";
    describe = `, matching ${matched}.`
      // A sweep run before MultiPV was recorded only stored rank 1, so a wider
      // objective silently collapses back to top-1. Say so rather than showing
      // the same number under a different label.
      + (d.top_n > 1 && d.max_rank_seen < 2
          ? ' These sweeps recorded only Maia\'s top move, so this is the same as top-1'
            + ' — re-run a Full analysis to record ranked candidates.' : '');
  } else {
    describe = d.policy_source === 'engine'
      ? ', scored by the probability Maia gave each move you played.'
      : ", scored by where each move you played ranked in Maia's ordering —"
        + ' these sweeps carry no policy from the engine.';
  }
  status.textContent =
    `${d.you.games} ${progressGamesPhrase()}, `
    + `${d.you.n_discriminative} usable of ${d.you.n_positions} positions`
    + describe;

  const card = document.createElement('div');
  card.className = 'sweep-player';
  const head = document.createElement('div');
  head.className = 'sweep-head';
  // A bound is not an estimate. When the match rate never got near what this
  // model manages on players at the fitted Elo, the sweep ran out of grid
  // before it ran out of player, and showing a bare number would be a lie
  // dressed as a measurement.
  const bound = d.you.bound;
  const shown = bound === 'lower' ? `≥ ${d.you.estimate}`
    : bound === 'upper' ? `≤ ${d.you.estimate}` : `${d.you.estimate}`;
  head.innerHTML =
    `<span class="sweep-who">You</span><span class="sweep-elo">${shown}</span>`
    + (!bound && d.you.ci_low != null
        ? `<span class="sweep-ci">95% ${d.you.ci_low}–${d.you.ci_high}</span>` : '')
    + (bound ? `<span class="sweep-ci">outside the swept range</span>` : '')
    + `<span class="conf-badge conf-${d.you.confidence}">${d.you.confidence}</span>`;
  card.appendChild(head);
  card.appendChild(sweepChartBlock(d.you));
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
  // How predictable you are, next to how strong you are. These come from the
  // same fit but from different parts of it -- one from where the match rate
  // peaks, one from how high it got -- so a wide gap is not an error, it is
  // the part of someone's play that a single strength doesn't describe.
  const pr = d.predictability || {};
  if (pr.available && pr.scale === 'logp') {
    // The likelihood's own version, on an absolute scale: how close the model
    // got to predicting these moves as well as it predicts anyone, where 0%
    // would be no better than guessing among legal moves.
    const share = Math.round((pr.reached ?? 0) * 100);
    note.innerHTML +=
      `<div class="cal-detail">Maia predicted your moves at <b>${pr.observed}</b> nats per `
      + `move, against the <b>${pr.expected}</b> it manages on a player whose rating it has `
      + `right and the ${pr.unpredictable} that guessing among legal moves scores — `
      + `<b>${share}%</b> of the way from guessing to fully predicted. `
      + (share >= 90
          ? `Your play is about as consistent as the field at your level.`
          : `Your moves are spread across a wider range of strengths than one rating `
            + `explains, so the estimate describes a broader spread than usual.`)
      + `</div>`
      // Only worth saying when the filter actually removed something: it runs
      // on every library, and most carry no move fast enough to drop.
      + (pr.think_filtered && (d.think_filter || {}).dropped
          ? `<div class="cal-detail">Instant moves were left out before this was measured, `
            + `which raises it — the moves dropped are the least predictable ones.</div>` : '')
      + `<div class="cal-detail scale-note">${pr.note}</div>`;
  } else if (pr.available) {
    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const over = pr.observed >= pr.expected;
    note.innerHTML +=
      `<div class="cal-detail">Your moves match ${pr.model} <b>${pct(pr.observed)}</b> of the time `
      + `at its best setting, against the <b>${pct(pr.expected)}</b> it manages on players at `
      + `${d.you.estimate}. `
      + (pr.gap_significant
          ? (over
              ? `You are more predictable than your estimate implies — your play is consistent, `
                + `with fewer moves that a player at your level wouldn't make.`
              : `You are less predictable than the field at your level: your moves are spread `
                + `across a wider range of strengths than one rating explains.`)
          : `That is within the noise — at this many positions the match rate can't pin `
            + `down consistency any tighter.`)
      + `</div>`
      + (pr.think_filtered
          ? `<div class="cal-detail">Instant moves were left out before this was measured, `
            + `which raises it — the moves dropped are the least predictable ones. Comparable `
            + `with other filtered figures, not with unfiltered ones.</div>` : '')
      + (pr.share_known < 1
          ? `<div class="cal-detail">${Math.round((1 - pr.share_known) * 100)}% of these positions `
            + `don't record which Maia model swept them and sit out of this comparison.</div>` : '')
      + `<div class="cal-detail scale-note">${pr.note}</div>`;
  } else if (pr.reason) {
    note.innerHTML += `<div class="cal-detail">Predictability not measured — ${pr.reason}.</div>`;
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

/** A path through every point, with monotone cubic (Fritsch–Carlson)
    tangents.

    Monotone rather than the usual Catmull-Rom, and that is the whole point:
    Catmull-Rom overshoots between points, so on a win-probability curve it
    would draw probabilities above 1 or below 0, and on either side of a
    blunder it would invent a dip or a bump that never happened. This variant
    provably cannot overshoot -- between two points the curve stays within
    their two values -- and it passes through every data point exactly. So it
    rounds the corners and changes nothing you could read off the chart.

    Points must be in screen coordinates and sorted by x. */
function smoothPath(points) {
  const n = points.length;
  if (n === 0) return '';
  const at = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  if (n < 3) return points.map((p, i) => `${i ? 'L' : 'M'}${at(p)}`).join(' ');

  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push(dx[i] === 0 ? 0 : (points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // A sign change is a local extremum: a flat tangent there is what stops
    // the curve sailing past the point it's supposed to turn at.
    if (slope[i - 1] * slope[i] <= 0) { tangent[i] = 0; continue; }
    const w1 = 2 * dx[i] + dx[i - 1];
    const w2 = dx[i] + 2 * dx[i - 1];
    tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
  }

  let d = `M${at(points[0])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(points[i][0] + h).toFixed(1)},${(points[i][1] + tangent[i] * h).toFixed(1)}`
       + ` ${(points[i + 1][0] - h).toFixed(1)},${(points[i + 1][1] - tangent[i + 1] * h).toFixed(1)}`
       + ` ${at(points[i + 1])}`;
  }
  return d;
}

/** Round gridline values inside [min, max]. An axis labelled 1168 / 1400 /
    1632 is three numbers nobody asked for; 1200 / 1400 / 1600 is a scale. */
function niceTicks(min, max, target = 3) {
  const span = max - min;
  if (!(span > 0)) return [Math.round(min)];
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find((s) => span / s <= target) || steps[steps.length - 1];
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  // A range too narrow to contain a round number still needs an axis.
  return ticks.length ? ticks : [Math.round(min), Math.round(max)];
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function wireTrend() {
  for (const id of ['trend-granularity', 'trend-run', 'trend-window',
                    'trend-window-count', 'trend-window-unit']) {
    document.getElementById(id).addEventListener('change', refreshTrend);
  }
  // `change` on a number input only fires on blur or Enter, so typing a
  // custom count and waiting would look like nothing happened. Debounced,
  // because each refit is seconds of work and "12" is typed as "1" then "2".
  let typing = null;
  document.getElementById('trend-window-count').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(refreshTrend, 500);
  });
  refreshTrend();
}

/** The `window` query value, and whether the custom count/unit pair applies.
    Kept in one place so the control and the request can't drift. */
function trendWindow() {
  const choice = document.getElementById('trend-window').value;
  const custom = document.getElementById('trend-window-custom');
  custom.classList.toggle('hidden', choice !== 'custom');
  if (choice !== 'custom') return choice;
  const count = Math.min(Math.max(parseInt(document.getElementById('trend-window-count').value, 10) || 1, 1), 999);
  return count + document.getElementById('trend-window-unit').value;
}

// The fit is a bootstrap over every stored position and takes seconds on a
// large library, so clicking through the controls leaves several requests in
// flight at once. Only the newest one is allowed to paint: without this, a
// slow earlier response can land last and show a window the controls no
// longer say.
let trendSeq = 0;

async function refreshTrend() {
  const granularity = document.getElementById('trend-granularity').value;
  const runId = document.getElementById('trend-run').value;
  const status = document.getElementById('trend-status');
  const slice = filterQuery(state.progressFilter);
  const seq = ++trendSeq;
  status.textContent = 'Loading...';
  try {
    const data = await api(`/api/trend?granularity=${granularity}`
      + `&window=${encodeURIComponent(trendWindow())}`
      + (runId ? `&run_id=${runId}` : '') + (slice ? `&${slice}` : ''));
    if (seq !== trendSeq) return;
    renderTrend(data);
  } catch (e) {
    if (seq !== trendSeq) return;
    status.textContent = 'Error: ' + e.message;
  }
}

function renderTrend(data) {
  const status = document.getElementById('trend-status');
  const chart = document.getElementById('trend-chart');
  const verdict = document.getElementById('trend-verdict');
  const table = document.getElementById('trend-table');
  chart.innerHTML = ''; verdict.innerHTML = ''; table.innerHTML = '';

  const phrase = progressGamesPhrase();
  const plotted = data.buckets.filter((b) => b.estimate != null || b.actual_elo != null);
  if (!plotted.length) {
    const w = data.window || {};
    status.textContent = w.applied && w.excluded
      // Distinguish "you have no data" from "your window hid it all", which
      // are the same empty chart and completely different problems.
      ? `Nothing to plot in the last ${w.requested} — ${w.excluded} analysed ${phrase} `
        + 'fall outside that window. Widen the timespan to see them.'
      : progressFiltered()
        ? `Nothing to plot from your ${phrase} — analyse some, or widen the filter above.`
        : 'Nothing to plot yet — this needs games with a Full analysis (the Maia Elo sweep), '
          + 'a date in the PGN headers, and your name matching White or Black.';
    renderTrendSkipped(verdict, data);
    return;
  }
  status.textContent =
    `${data.total_games} analysed ${phrase} across `
    + `${data.buckets.length} ${data.granularity} bucket(s)`
    + `${trendRangeText(data.window)}.`;

  chart.appendChild(trendChart(plotted));
  const legend = document.createElement('div');
  legend.className = 'trend-legend';
  legend.innerHTML =
    '<span><i class="swatch-est"></i>Estimated Elo (Maia sweep), shaded 95% interval</span>'
    + '<span><i class="swatch-actual"></i>Rating from your PGN headers</span>'
    + '<span class="legend-note">Separate scales — the two are different scales, '
    + 'so compare the shapes, not the heights.</span>';
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

/** The dates a window actually covered. Always spelled out when one is in
    force: "the last 6 months" ends at your most recent game, not today, and
    a reader who assumes otherwise would misread every date on the axis. */
function trendRangeText(w) {
  if (!w || !w.start || !w.end) return '';
  if (!w.applied) return `, ${w.start} to ${w.end}`;
  const outside = w.excluded ? `, ${w.excluded} older game(s) excluded` : '';
  return `, covering the last ${w.requested} of play (${w.start} to ${w.end})${outside}`;
}

function renderTrendSkipped(host, data) {
  const labels = {
    no_full_analysis: 'no Elo sweep yet (Quick alone does not sweep)',
    undated: 'no usable date in the PGN headers',
    unassigned_color: 'no side assigned — set yours on the game in the Games list',
    no_sweep_positions: 'no stored sweep positions',
    no_header_elo: 'no WhiteElo/BlackElo header (still used for the estimate)',
    outside_window: 'older than the timespan you picked',
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

/** Estimated Elo with its 95% band, and the header rating, in two stacked
    panels sharing one x-axis.

    They were one chart on one y-axis, and the interval ruined it: a 95% band
    600 Elo wide forces a y-range that flattens a header rating moving over 80
    into a straight line, so the series you can actually read week to week
    became unreadable. A second y-axis on the same frame would fix the scale
    and introduce a worse problem -- two axes invite reading a crossing as an
    event, when the gap between the two is an arbitrary constant (they are
    different scales; the README says watch the shape). Stacked panels give
    each series its own scale, keep the x-positions aligned so the shapes can
    still be compared vertically, and never draw the two in a relationship
    they don't have.

    The band is still the point of the upper panel: two bucket estimates whose
    bands overlap have not been shown to differ, however far apart the dots
    look. */
function trendChart(buckets) {
  const W = 320, padL = 34, padR = 8, padT = 14, padB = 24, gap = 12;
  const panels = [];
  if (buckets.some((b) => b.estimate != null)) panels.push('estimate');
  if (buckets.some((b) => b.actual_elo != null)) panels.push('actual');
  const panelH = panels.length > 1 ? 106 : 150;
  const H = panels.length * panelH + Math.max(0, panels.length - 1) * gap + padB;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend-chart' });

  const xs = buckets.map((b) => b.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const sx = (x) => padL + ((x - xMin) / (xMax - xMin || 1)) * (W - padL - padR);

  panels.forEach((kind, index) => {
    const top = index * (panelH + gap);
    const estimated = kind === 'estimate';

    const ys = [];
    for (const b of buckets) {
      if (estimated) {
        if (b.estimate != null) ys.push(b.estimate);
        if (b.ci_low != null) ys.push(b.ci_low, b.ci_high);
      } else if (b.actual_elo != null) {
        ys.push(b.actual_elo);
      }
    }
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    // A rating that barely moved would otherwise be drawn as dramatic noise
    // across the full height of its panel.
    if (yMax - yMin < 100) { const mid = (yMax + yMin) / 2; yMin = mid - 50; yMax = mid + 50; }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad; yMax += pad;
    const sy = (y) => top + panelH - ((y - yMin) / (yMax - yMin || 1)) * (panelH - padT);

    for (const value of niceTicks(yMin, yMax)) {
      svg.appendChild(svgEl('line', {
        x1: padL, x2: W - padR, y1: sy(value), y2: sy(value),
        stroke: '#39405166', 'stroke-width': 1,
      }));
      const label = svgEl('text', { x: padL - 4, y: sy(value) + 3, class: 'trend-axis', 'text-anchor': 'end' });
      label.textContent = value;
      svg.appendChild(label);
    }

    const caption = svgEl('text', { x: padL, y: top + 9, class: 'trend-panel-title' });
    caption.textContent = estimated ? 'Estimated Elo (Maia sweep)' : 'Rating from your PGN headers';
    svg.appendChild(caption);

    const colour = estimated ? '#5b8dee' : '#7db37d';
    const points = buckets
      .filter((b) => (estimated ? b.estimate : b.actual_elo) != null)
      .map((b) => [sx(b.x), sy(estimated ? b.estimate : b.actual_elo)]);

    if (estimated) {
      const band = buckets.filter((b) => b.ci_low != null);
      if (band.length > 1) {
        // The band's edges follow the same spline as the line through the
        // middle of it, so the two can't disagree about the shape.
        const upper = band.map((b) => [sx(b.x), sy(b.ci_high)]);
        const lower = band.slice().reverse().map((b) => [sx(b.x), sy(b.ci_low)]);
        svg.appendChild(svgEl('path', {
          d: `${smoothPath(upper)} L${lower[0][0].toFixed(1)},${lower[0][1].toFixed(1)} `
             + `${smoothPath(lower).replace(/^M/, 'L')} Z`,
          fill: '#5b8dee33', stroke: 'none',
        }));
      } else if (band.length === 1) {
        const b = band[0];
        svg.appendChild(svgEl('line', {
          x1: sx(b.x), x2: sx(b.x), y1: sy(b.ci_high), y2: sy(b.ci_low),
          stroke: '#5b8dee88', 'stroke-width': 4,
        }));
      }
    }

    if (points.length > 1) {
      svg.appendChild(svgEl('path', {
        d: smoothPath(points), fill: 'none', stroke: colour, 'stroke-width': 2,
        ...(estimated ? {} : { 'stroke-dasharray': '4,3' }),
      }));
    }

    for (const b of buckets) {
      const value = estimated ? b.estimate : b.actual_elo;
      if (value == null) continue;
      svg.appendChild(svgEl('circle', {
        cx: sx(b.x), cy: sy(value),
        r: estimated ? (b.sparse ? 2 : 3.2) : 2.2,
        fill: estimated && b.sparse ? '#1b1f2a' : colour,
        stroke: colour, 'stroke-width': estimated ? 1.5 : 0,
      }));
    }
  });

  // Only the ends get a label: a week-bucketed year would otherwise be a
  // solid smear of text. One row for both panels -- they share the axis.
  for (const [b, anchor] of [[buckets[0], 'start'], [buckets[buckets.length - 1], 'end']]) {
    const t = svgEl('text', { x: sx(b.x), y: H - 8, class: 'trend-axis', 'text-anchor': anchor });
    t.textContent = b.label;
    svg.appendChild(t);
  }
  return svg;
}

/* ---------------- Puzzles ----------------
   Two sources over the same board. Your own games give you the mistakes you
   actually make; the Lichess database gives you difficulty measured against
   real solvers, themes to aim at, and a set that doesn't run out. Which one
   you're on changes what the panel offers, but not how solving feels.

   The move you played is hidden until you've tried -- knowing it turns "find
   the move" into "find the other move" -- and for a Lichess puzzle the line
   is never sent to the browser at all: each move is checked against the
   server, one at a time, and the opponent's reply comes back with it. */

const PZ_SOURCES = ['own', 'lichess'];

/** Themes chosen per source, remembered across visits. Kept apart because the
    two sets barely overlap: 'fork' is worth picking against a hundred
    thousand Lichess puzzles and pointless against the four in your own. */
function pzThemeKey(source) { return `pz-themes-${source}`; }

function pzSelectedThemes(source = state.puzzleSource) {
  try {
    const raw = JSON.parse(localStorage.getItem(pzThemeKey(source)) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function pzSetSelectedThemes(themes) {
  localStorage.setItem(pzThemeKey(state.puzzleSource), JSON.stringify(themes));
}

function wirePuzzles() {
  state.puzzleSource = PZ_SOURCES.includes(localStorage.getItem('pz-source'))
    ? localStorage.getItem('pz-source') : 'own';

  document.getElementById('pz-next').addEventListener('click', () => loadNextPuzzle());
  document.getElementById('pz-reveal').addEventListener('click', revealPuzzle);
  document.getElementById('pz-rebuild').addEventListener('click', rebuildPuzzles);
  for (const id of ['pz-scope', 'pz-order']) {
    document.getElementById(id).addEventListener('change', () => {
      if (state.puzzleMode) loadNextPuzzle();
    });
  }
  for (const btn of document.querySelectorAll('.pz-source')) {
    btn.addEventListener('click', () => setPuzzleSource(btn.dataset.source));
  }
  document.getElementById('pz-themes-clear').addEventListener('click', () => {
    pzSetSelectedThemes([]);
    renderPuzzleThemes();
    if (state.puzzleMode) loadNextPuzzle();
  });
  document.getElementById('pz-import-start').addEventListener('click', startPuzzleImport);
  document.getElementById('pz-import-cancel').addEventListener('click', cancelPuzzleImport);

  applyPuzzleSource();
  refreshPuzzleStats();
}

function setPuzzleSource(source) {
  if (!PZ_SOURCES.includes(source) || source === state.puzzleSource) return;
  state.puzzleSource = source;
  localStorage.setItem('pz-source', source);
  applyPuzzleSource();
  // The themes belong to the source, so they have to be re-fetched before a
  // puzzle is asked for with them.
  renderPuzzleThemes().then(() => {
    if (state.puzzleMode) loadNextPuzzle();
  });
}

/** Which controls make sense for the source that's selected. */
function applyPuzzleSource() {
  const own = state.puzzleSource === 'own';
  for (const btn of document.querySelectorAll('.pz-source')) {
    const on = btn.dataset.source === state.puzzleSource;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  // Scope and Rescan are about your own library and mean nothing against
  // Lichess; the rating bar is the other way round until an own-game puzzle
  // has been rated.
  document.getElementById('pz-own-controls').classList.toggle('hidden', !own);
  document.getElementById('pz-rebuild').classList.toggle('hidden', !own);
  document.getElementById('puzzle-import-panel').classList.toggle('hidden', own);
  document.getElementById('pz-source-note').textContent = own
    ? 'Every position where you gave something away, as a puzzle. No engine '
      + 'runs to build them, only to check an answer.'
    : 'Positions from real games, rated against millions of solvers. Puzzles '
      + 'are drawn from a band around your rating, and one you have attempted '
      + 'never comes back.';
}

function puzzleCounts(stats) {
  if (!stats || !stats.total) {
    return 'No puzzles yet — analyse some games (Quick is enough) and press Rescan.';
  }
  return `${stats.solved} of ${stats.total} solved · ${stats.blunders} from blunders.`;
}

async function refreshPuzzleStats() {
  try {
    const stats = await api('/api/puzzles/stats');
    if (!state.puzzleMode && state.puzzleSource === 'own') {
      document.getElementById('pz-status').textContent = puzzleCounts(stats);
    }
    renderPuzzleRating(stats.progress, null);
    renderPuzzleProgress(stats.progress);
    renderImportStatus(stats.lichess);
    return stats;
  } catch (e) {
    return null;
  }
}

/* ---- the rating ---- */

function renderPuzzleRating(progress, change) {
  const bar = document.getElementById('pz-rating-bar');
  if (!progress || !progress.overall) { bar.classList.add('hidden'); return; }
  const overall = progress.overall;
  bar.classList.remove('hidden');
  document.getElementById('pz-rating').textContent = overall.rating;

  // The interval, not just the number. A rating with three attempts behind it
  // is a guess, and showing it bare would be a claim the data can't support.
  const parts = [];
  if (overall.provisional) {
    parts.push(`provisional, ${overall.interval[0]}–${overall.interval[1]}`);
  } else {
    parts.push(`± ${Math.round((overall.interval[1] - overall.interval[0]) / 2)}`);
  }
  if (overall.attempts) {
    parts.push(`${overall.solved}/${overall.attempts} rated`);
  }
  document.getElementById('pz-rating-meta').textContent = parts.join(' · ');

  const delta = document.getElementById('pz-rating-delta');
  if (change && change.rated && change.delta) {
    delta.textContent = (change.delta > 0 ? '+' : '') + change.delta;
    delta.className = 'pz-rating-delta ' + (change.delta > 0 ? 'up' : 'down');
  } else if (change && !change.rated) {
    // Say why nothing moved rather than leaving a number that looks stuck.
    delta.textContent = change.first_try === false ? 'seen before — unrated' : 'unrated';
    delta.className = 'pz-rating-delta';
  } else {
    delta.textContent = '';
    delta.className = 'pz-rating-delta';
  }
}

/* ---- per-theme progress ---- */

/** The per-theme list only. Deliberately does *not* touch the rating bar:
    both are refreshed together after an attempt, and having this one also
    redraw the bar wiped the "+34" that had just been put there. */
function renderPuzzleProgress(progress) {
  const host = document.getElementById('pz-progress');
  if (!progress || !progress.themes || !progress.themes.length) {
    host.innerHTML = '<div class="pz-progress-empty">Nothing yet. Solve a few '
      + 'puzzles and this fills in with a rating per theme.</div>';
    return;
  }
  // Scaled against the strongest theme, so the bars compare with each other
  // rather than with an arbitrary ceiling.
  const top = Math.max(...progress.themes.map((t) => t.rating), 1);
  host.innerHTML = progress.themes.map((t) => {
    const label = PZ_THEME_LABELS[t.theme] || t.theme;
    const provisional = t.provisional ? ' <span class="pz-provisional">provisional</span>' : '';
    return `<div class="pz-progress-row">
      <span class="pz-progress-name">${escapeHtml(label)}</span>
      <span class="pz-progress-rating">${t.rating}${provisional}</span>
      <span class="pz-progress-detail">${t.solved}/${t.attempts} solved</span>
      <span class="pz-progress-detail">${t.interval[0]}–${t.interval[1]}</span>
      <div class="pz-progress-bar"><div class="pz-progress-fill"
        style="width:${Math.max(2, Math.round((t.rating / top) * 100))}%"></div></div>
    </div>`;
  }).join('');
}

/* ---- the theme picker ---- */

// Filled from the catalog the server sends, so a label is never duplicated
// here and left to drift.
const PZ_THEME_LABELS = {};

async function renderPuzzleThemes() {
  const host = document.getElementById('pz-themes');
  const chosen = new Set(pzSelectedThemes());
  let data;
  try {
    data = await api(`/api/puzzles/themes?source=${state.puzzleSource}`);
  } catch (e) {
    host.innerHTML = `<div class="pz-hint">Couldn't load themes: ${escapeHtml(e.message)}</div>`;
    return;
  }

  for (const group of data.groups) {
    for (const theme of group.themes) PZ_THEME_LABELS[theme.key] = theme.label;
  }

  document.getElementById('pz-themes-count').textContent =
    chosen.size ? `(${chosen.size} picked)` : '';
  document.getElementById('pz-themes-hint').textContent = state.puzzleSource === 'own'
    ? 'Motifs are tagged once an engine has worked a puzzle out, so a fresh set only lists its phases.'
    : 'Pick none to draw from everything.';

  if (!data.groups.length) {
    host.innerHTML = state.puzzleSource === 'own'
      ? '<div class="pz-hint">No themes yet — rescan your games, then solve a few.</div>'
      : '<div class="pz-hint">Import the database below and the themes appear here.</div>';
    return;
  }

  host.innerHTML = data.groups.map((group) => `
    <div class="pz-theme-group">
      <div class="pz-theme-group-name">${escapeHtml(group.label)}</div>
      <div class="pz-theme-chips">${group.themes.map((theme) => {
        const on = chosen.has(theme.key) ? ' on' : '';
        const rating = theme.progress
          ? `<span class="pz-theme-rating">${theme.progress.rating}</span>` : '';
        return `<button type="button" class="filter-chip pz-theme${on}"
          data-theme="${escapeHtml(theme.key)}" title="${escapeHtml(theme.description)}">`
          + `${escapeHtml(theme.label)}`
          + `<span class="chip-count">${theme.count}</span>${rating}</button>`;
      }).join('')}</div>
    </div>`).join('');

  for (const chip of host.querySelectorAll('.pz-theme')) {
    chip.addEventListener('click', () => {
      const selected = new Set(pzSelectedThemes());
      if (selected.has(chip.dataset.theme)) selected.delete(chip.dataset.theme);
      else selected.add(chip.dataset.theme);
      pzSetSelectedThemes([...selected]);
      renderPuzzleThemes();
      if (state.puzzleMode) loadNextPuzzle();
    });
  }
}

/** Scans analysed games for mistakes worth practising. No engine runs here --
    the position and the move come from the stored PGN. */
async function rebuildPuzzles() {
  const btn = document.getElementById('pz-rebuild');
  btn.disabled = true;
  document.getElementById('pz-status').textContent = 'Scanning your analysed games...';
  try {
    const result = await api('/api/puzzles/rebuild', { method: 'POST' });
    const bits = [`${result.added} new`, `${result.total} in total`];
    if (result.skipped_already_lost) {
      bits.push(`${result.skipped_already_lost} skipped (the game was already lost there)`);
    }
    document.getElementById('pz-status').textContent = bits.join(', ') + '.';
    renderPuzzleThemes();
  } catch (e) {
    document.getElementById('pz-status').textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

/** Opening the Puzzles tab. Entering the tab *is* the request for a puzzle --
    there is nothing to configure first, and a filter change just fetches
    another one. */
async function startPuzzles() {
  state.puzzleMode = true;
  applyPuzzleSource();
  renderPuzzleThemes();
  await loadNextPuzzle();
}

function exitPuzzleMode() {
  state.puzzleMode = false;
  state.puzzle = null;
  document.getElementById('pz-feedback').innerHTML = '';
  refreshPuzzleStats();
  state.flipOverride = false;
}

async function loadNextPuzzle() {
  const previous = state.puzzle ? state.puzzle.id : null;
  document.getElementById('pz-feedback').innerHTML = '';
  document.getElementById('pz-status').textContent = 'Finding one...';
  const params = new URLSearchParams({ source: state.puzzleSource });
  if (state.puzzleSource === 'own') {
    params.set('scope', document.getElementById('pz-scope').value);
    params.set('order', document.getElementById('pz-order').value);
  }
  const themes = pzSelectedThemes();
  if (themes.length) params.set('themes', themes.join(','));
  if (previous) params.set('exclude', previous);

  try {
    const data = await api(`/api/puzzles/next?${params}`);
    showPuzzle(data);
  } catch (e) {
    document.getElementById('pz-status').textContent = e.message;
    // Nothing to solve, so nothing should look solvable. Now that the tab loads
    // a puzzle on its own, this is a state you can land straight in, and the
    // previous puzzle's board sitting there would read as the next one.
    state.puzzle = null;
    state.board.renderFEN(new Chess().fen());
    renderPlayerPlates();
  }
}

/** Puts a puzzle on the board.

    For a Lichess puzzle the position stored is the one *before* the
    opponent's move, and that move is played in rather than skipped: seeing it
    land is what makes the position read as a moment from a game instead of a
    diagram, and it is how you know which piece just moved. */
async function showPuzzle(data) {
  const p = data.puzzle;
  state.puzzle = {
    ...p,
    chess: new Chess(),
    answered: false,
    busy: false,
    // Every move you've played in this line so far. The server checks the
    // whole prefix each time, so it never has to remember where you are.
    played: [],
  };
  state.flipOverride = false;
  applyOrientation();
  renderPlayerPlates();
  renderPuzzleRating(data.progress, null);

  if (p.setup) {
    // Show the position before, then play the opponent's move into it.
    state.puzzle.chess.load(p.setup.fen);
    state.board.renderFEN(p.setup.fen);
    state.puzzle.busy = true;
    document.getElementById('pz-status').innerHTML = describePuzzle(p, data);
    document.getElementById('pz-feedback').innerHTML =
      '<div class="pz-prompt">Watch the last move...</div>';
    const from = p.setup.uci.slice(0, 2);
    const to = p.setup.uci.slice(2, 4);
    playMoveSound(p.setup.san || '', true);
    await state.board.animateMove(from, to, p.fen);
    state.puzzle.busy = false;
  } else {
    state.board.renderFEN(p.fen);
  }
  state.puzzle.chess.load(p.fen);

  document.getElementById('pz-status').innerHTML = describePuzzle(p, data);
  document.getElementById('pz-feedback').innerHTML =
    `<div class="pz-prompt">${puzzlePrompt(p)}</div>`;
}

function puzzlePrompt(p) {
  const side = p.your_color === 'w' ? 'White' : 'Black';
  if (p.source === 'own') return 'Find the move you should have played.';
  if (p.moves_required > 1) return `${side} to play and win — ${p.moves_required} moves.`;
  return `${side} to play and win.`;
}

/** The line above the board: where the puzzle came from and what it's worth. */
function describePuzzle(p, data) {
  const bits = [`<b>${p.your_color === 'w' ? 'White' : 'Black'} to move</b>`];
  if (p.source === 'own') {
    const opponent = p.your_color === 'w' ? p.black : p.white;
    bits.push(`move ${p.move_number} vs ${escapeHtml(opponent || '?')}`
      + (p.date ? ` (${escapeHtml(p.date)})` : ''));
    if (p.wp_drop != null) bits.push(`you gave up ${(p.wp_drop * 100).toFixed(0)}% here`);
    if (p.rating) bits.push(`about ${p.rating}`);
    const counts = data && data.total
      ? ` <span class="pz-count">${data.solved}/${data.total} solved</span>` : '';
    return bits.join(' — ') + '.' + counts;
  }
  bits.push(`rated ${p.rating}`);
  if (p.themes && p.themes.length) {
    // Themes that would give the puzzle away are held back until it's over.
    const safe = p.themes.filter((t) => !PZ_SPOILER_THEMES.has(t));
    if (safe.length) {
      bits.push(safe.map((t) => escapeHtml(PZ_THEME_LABELS[t] || t)).join(', '));
    }
  }
  return bits.join(' — ') + '.';
}

/* Naming the motif is naming the answer. 'Mate in two' is a hint the solver
   should be allowed to have -- Lichess shows it too, and the move count is
   already public -- but 'smothered mate' or 'hanging piece' hands over the
   idea, so those wait until the puzzle is finished. */
const PZ_SPOILER_THEMES = new Set([
  'fork', 'pin', 'skewer', 'hangingPiece', 'discoveredAttack', 'doubleCheck',
  'sacrifice', 'deflection', 'attraction', 'trappedPiece', 'capturingDefender',
  'interference', 'clearance', 'xRayAttack', 'intermezzo', 'zugzwang',
  'backRankMate', 'smotheredMate', 'hookMate', 'anastasiaMate', 'arabianMate',
  'bodenMate', 'doubleBishopMate', 'dovetailMate', 'promotion',
  'underPromotion', 'enPassant', 'castling', 'quietMove', 'advancedPawn',
  'defensiveMove', 'attackingF2F7',
]);

function puzzleLegalTargets(square) {
  const p = state.puzzle;
  if (!p || p.answered || p.busy) return [];
  const byTo = new Map();
  for (const m of p.chess.moves({ square, verbose: true })) {
    if (!byTo.has(m.to)) byTo.set(m.to, { to: m.to, promotion: !!m.promotion });
  }
  return Array.from(byTo.values());
}

async function onPuzzleMove(from, to, promotion) {
  const p = state.puzzle;
  if (!p || p.answered || p.busy) return;
  const probe = new Chess();
  probe.load(p.chess.fen());
  const res = probe.move({ from, to, promotion: promotion || 'q' });
  if (!res) return;

  p.busy = true;
  playMoveSound(res.san, true);
  await state.board.animateMove(from, to, probe.fen());
  const feedback = document.getElementById('pz-feedback');
  feedback.innerHTML = '<div class="pz-prompt">Checking...</div>';

  const uci = from + to + (promotion || (res.promotion ? 'q' : ''));
  try {
    if (p.source === 'lichess') {
      await attemptLichessMove(uci);
    } else {
      const verdict = await api(`/api/puzzles/${p.id}/attempt`, {
        method: 'POST',
        body: JSON.stringify({ uci }),
      });
      renderPuzzleVerdict(verdict);
    }
  } catch (e) {
    feedback.innerHTML = `<div class="pz-wrong">Couldn't check that: ${escapeHtml(e.message)}</div>`;
    resetPuzzleBoard();
  } finally {
    p.busy = false;
  }
}

/** One move of a Lichess line. The server holds the answer and hands back the
    opponent's reply, so the browser learns the line only by getting it
    right. */
async function attemptLichessMove(uci) {
  const p = state.puzzle;
  const feedback = document.getElementById('pz-feedback');
  const moves = [...p.played, uci];
  const verdict = await api(`/api/puzzles/lichess/${p.id}/attempt`, {
    method: 'POST',
    body: JSON.stringify({ moves }),
  });

  if (!verdict.correct) {
    playSound('wrong');
    p.answered = true;
    feedback.innerHTML =
      `<div class="pz-wrong">✗ <b>${escapeHtml(verdict.attempt.san || uci)}</b> `
      + `isn't it — ${escapeHtml(verdict.expected.san)} was.</div>`
      + `<div class="pz-note">${puzzleThemeLine(verdict.themes)}</div>`;
    renderPuzzleRating(verdict.progress, verdict.rating);
    renderPuzzleProgress(verdict.progress);
    setTimeout(resetPuzzleBoard, 650);
    return;
  }

  p.played = moves;

  if (!verdict.done) {
    // Right so far: play the opponent's answer and keep going.
    p.chess.load(verdict.fen);
    feedback.innerHTML =
      `<div class="pz-onward">✓ <b>${escapeHtml(verdict.attempt.san)}</b>`
      + `<span class="pz-step">${verdict.moves_played} of ${verdict.moves_required}`
      + ` — they reply ${escapeHtml(verdict.reply.san)}</span></div>`;
    playMoveSound(verdict.reply.san, true);
    await state.board.animateMove(
      verdict.reply.uci.slice(0, 2), verdict.reply.uci.slice(2, 4), verdict.fen,
    );
    return;
  }

  p.answered = true;
  playSound('solved');
  const link = verdict.game_url
    ? ` <a href="${escapeHtml(verdict.game_url)}" target="_blank" rel="noopener">See the game</a>.`
    : '';
  feedback.innerHTML =
    '<div class="pz-right">✓ Solved.</div>'
    + `<div class="pz-note">${puzzleThemeLine(verdict.themes)}${link}</div>`;
  renderPuzzleRating(verdict.progress, verdict.rating);
  renderPuzzleProgress(verdict.progress);
}

/** The themes, spelled out once the puzzle is over -- which is when naming
    the motif teaches something rather than giving it away. */
function puzzleThemeLine(themes) {
  if (!themes || !themes.length) return '';
  const named = themes.map((t) => escapeHtml(PZ_THEME_LABELS[t] || t));
  return `Themes: ${named.join(', ')}.`;
}

/** Puts the board back to where the line had got to after a wrong answer, so
    the next attempt starts from the same place you started from. */
function resetPuzzleBoard() {
  const p = state.puzzle;
  if (!p) return;
  state.board.renderFEN(p.chess.fen());
}

function renderPuzzleVerdict(v) {
  const p = state.puzzle;
  const feedback = document.getElementById('pz-feedback');
  const played = v.played && v.played.san
    ? `In the game you played <b>${escapeHtml(v.played.san)}</b>.` : '';
  renderPuzzleRating(v.progress, v.rating);
  renderPuzzleProgress(v.progress);

  if (v.correct) {
    p.answered = true;
    playSound('solved');
    const equal = v.attempt.uci !== v.best.uci
      ? ` (the engine prefers ${escapeHtml(v.best.san)}, but yours is as good)` : '';
    feedback.innerHTML =
      `<div class="pz-right">✓ <b>${escapeHtml(v.attempt.san)}</b> — that's it${equal}.</div>`
      + `<div class="pz-note">${played} ${puzzleThemeLine(v.themes)}</div>`;
    document.getElementById('pz-status').innerHTML =
      `Solved. <span class="pz-count">${v.solved}/${v.total} solved</span>`;
    return;
  }

  playSound('wrong');
  const cost = `${(v.given_up * 100).toFixed(0)}%`;
  feedback.innerHTML =
    (v.same_as_played
      ? `<div class="pz-wrong">✗ <b>${escapeHtml(v.attempt.san)}</b> — that's the move you played, and it gives up ${cost}.</div>`
      : `<div class="pz-wrong">✗ <b>${escapeHtml(v.attempt.san)}</b> gives up ${cost} of the win probability.</div>`)
    + `<div class="pz-note">Try again, or <b>Show me</b>.${v.same_as_played ? '' : ' ' + played}</div>`;
  // A beat on the board before it goes back, so you see what you played.
  setTimeout(resetPuzzleBoard, 650);
}

async function revealPuzzle() {
  const p = state.puzzle;
  // Already answered means the board is showing the answer -- asking again
  // would search the position a second time to say the same thing.
  if (!p || p.busy || p.answered) return;
  p.busy = true;
  const feedback = document.getElementById('pz-feedback');
  feedback.innerHTML = '<div class="pz-prompt">Working it out...</div>';
  try {
    if (p.source === 'lichess') await revealLichessPuzzle();
    else await revealOwnPuzzle();
  } catch (e) {
    feedback.innerHTML = `<div class="pz-wrong">Couldn't work it out: ${escapeHtml(e.message)}</div>`;
  } finally {
    p.busy = false;
  }
}

async function revealOwnPuzzle() {
  const p = state.puzzle;
  const data = await api(`/api/puzzles/${p.id}/reveal`, { method: 'POST' });
  p.answered = true;
  // Play it on the board: seeing the move is the point of asking.
  const probe = new Chess();
  probe.load(p.fen);
  const move = data.best.uci && probe.move({
    from: data.best.uci.slice(0, 2), to: data.best.uci.slice(2, 4),
    promotion: data.best.uci.slice(4) || 'q',
  });
  if (move) await state.board.animateMove(move.from, move.to, probe.fen());
  document.getElementById('pz-feedback').innerHTML =
    `<div class="pz-shown">The move was <b>${escapeHtml(data.best.san)}</b>.</div>`
    + `<div class="pz-note">In the game you played <b>${escapeHtml(data.played.san)}</b>. `
    + `This one stays unsolved — it'll come round again. ${puzzleThemeLine(data.themes)}</div>`;
  renderPuzzleRating(data.progress, data.rating);
  renderPuzzleProgress(data.progress);
}

/** Gives up on a Lichess puzzle and plays the whole line out on the board. */
async function revealLichessPuzzle() {
  const p = state.puzzle;
  const data = await api(`/api/puzzles/lichess/${p.id}/reveal`, { method: 'POST' });
  p.answered = true;

  // Replay from the puzzle's own starting position, not from wherever a
  // half-finished attempt left the board.
  const probe = new Chess();
  probe.load(p.fen);
  state.board.renderFEN(p.fen);
  for (const move of data.line) {
    const res = probe.move({
      from: move.uci.slice(0, 2), to: move.uci.slice(2, 4),
      promotion: move.uci.slice(4) || 'q',
    });
    if (!res) break;
    playMoveSound(res.san, true);
    await state.board.animateMove(move.uci.slice(0, 2), move.uci.slice(2, 4), probe.fen());
  }
  const line = data.line
    .map((m) => (m.yours ? `<b>${escapeHtml(m.san)}</b>` : escapeHtml(m.san)))
    .join(' ');
  document.getElementById('pz-feedback').innerHTML =
    `<div class="pz-shown">The line was ${line}.</div>`
    + `<div class="pz-note">${puzzleThemeLine(data.themes)} Giving up counts as a miss.</div>`;
  renderPuzzleRating(data.progress, data.rating);
  renderPuzzleProgress(data.progress);
}

/* ---------------- Importing the Lichess database ----------------
   A long job with no websocket behind it: the import runs inside one request
   and the browser polls for progress, which is enough for something you start
   once and watch a progress bar for. */

function renderImportStatus(status) {
  const host = document.getElementById('pz-import-status');
  if (!host) return;
  if (!status) { host.textContent = ''; return; }
  if (!status.available) {
    host.innerHTML = 'Nothing imported yet.';
  } else {
    const span = status.min_rating != null
      ? ` rated ${status.min_rating}–${status.max_rating}` : '';
    host.innerHTML = `<b>${status.puzzles.toLocaleString()}</b> puzzles imported${span}`
      + (status.imported_at ? ` · ${escapeHtml(status.imported_at)}` : '');
  }
  if (status.running) {
    // An import survives a page reload -- it's a thread on the server, not
    // something this tab owns. Pick it back up rather than showing a stale
    // "nothing imported" next to a job that is halfway through.
    renderImportProgress(status.running);
    importInFlight(true);
    pollImportProgress();
  }
}

function renderImportProgress(progress) {
  const host = document.getElementById('pz-import-progress');
  if (!progress) { host.innerHTML = ''; return; }
  const bits = [];
  if (progress.rows_kept) bits.push(`${progress.rows_kept.toLocaleString()} kept`);
  if (progress.rows_read) bits.push(`${progress.rows_read.toLocaleString()} read`);
  if (progress.bytes_read) {
    bits.push(`${(progress.bytes_read / 1e6).toFixed(0)} MB`);
  }
  if (progress.elapsed_s) bits.push(`${Math.round(progress.elapsed_s)}s`);

  const pct = progress.total_bytes
    ? Math.min(100, (progress.bytes_read / progress.total_bytes) * 100) : null;
  const bar = pct != null
    ? `<div class="pz-import-bar"><div class="pz-import-fill" style="width:${pct.toFixed(1)}%"></div></div>`
    : '';
  const failed = progress.state === 'error' ? ' pz-import-error' : '';
  host.innerHTML = `<div class="${failed.trim()}">${escapeHtml(progress.message || progress.state)}`
    + (bits.length ? ` — ${bits.join(', ')}` : '') + '</div>' + bar;
}

function importInFlight(running) {
  document.getElementById('pz-import-start').disabled = running;
  document.getElementById('pz-import-cancel').disabled = !running;
}

/** Kicks off an import. The request returns as soon as the job has started;
    everything after that is the poll below. An import can run for many
    minutes, and waiting on the request is how the browser ends up reporting
    a failure on a job that is running fine. */
async function startPuzzleImport() {
  const number = (id) => {
    const raw = document.getElementById(id).value.trim();
    return raw === '' ? null : Number(raw);
  };
  const body = {
    min_rating: number('pz-import-min'),
    max_rating: number('pz-import-max'),
    max_puzzles: number('pz-import-limit'),
    source_path: document.getElementById('pz-import-path').value.trim() || null,
    themes: pzSelectedThemes('lichess'),
    replace: document.getElementById('pz-import-replace').checked,
  };
  importInFlight(true);
  renderImportProgress({ state: 'starting', message: 'starting...' });
  try {
    const ack = await api('/api/puzzles/lichess/import', {
      method: 'POST', body: JSON.stringify(body),
    });
    if (ack.progress) renderImportProgress(ack.progress);
    pollImportProgress();
  } catch (e) {
    // Only the things checkable up front land here -- a missing file, an
    // import already running. Anything that goes wrong once it's going is
    // reported through the poll.
    renderImportProgress({ state: 'error', message: e.message });
    importInFlight(false);
  }
}

/** Follows a running import to its end, then refreshes what it produced. */
function pollImportProgress() {
  clearTimeout(state.puzzleImportPoll);
  state.puzzleImportPoll = setTimeout(async () => {
    let status;
    try {
      status = await api('/api/puzzles/lichess/status');
    } catch (e) {
      // A dropped poll is not the import failing. Keep asking.
      pollImportProgress();
      return;
    }
    const progress = status.running || status.last_run;
    if (progress) renderImportProgress(progress);
    if (status.running) {
      pollImportProgress();
      return;
    }
    // Finished, one way or another.
    importInFlight(false);
    renderImportStatus(status);
    if (progress) renderImportProgress(progress);
    await refreshPuzzleStats();
    await renderPuzzleThemes();
  }, 900);
}

async function cancelPuzzleImport() {
  document.getElementById('pz-import-cancel').disabled = true;
  try {
    await api('/api/puzzles/lichess/cancel', { method: 'POST' });
  } catch (e) {
    /* the import is finishing anyway */
  }
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
}

function sendPlay(msg) {
  if (state.play && state.play.ws && state.play.ws.readyState === WebSocket.OPEN) {
    state.play.ws.send(JSON.stringify(msg));
  }
}

/* ---- Looking back through the game you're playing --------------------
   The board can show any earlier position of the live game without the game
   pausing for it: `viewPly` is what's on screen, null meaning "the live
   position". Everything the server sends keeps updating the model while you
   look; only the *board* stays where you put it, and one tap brings it back. */

function playLivePly() {
  return state.play && state.play.moves ? state.play.moves.length : 0;
}

function playViewPly() {
  const p = state.play;
  if (!p) return 0;
  return p.viewPly === null || p.viewPly === undefined ? playLivePly() : p.viewPly;
}

function playIsLive() {
  return playViewPly() === playLivePly();
}

/** Rebuilds the per-ply positions from the server's move list. Cheap enough
    to redo on every state message, and it means the review positions can
    never drift from the game the server thinks is being played. */
function rebuildPlayMoves() {
  const p = state.play;
  const replay = new Chess();
  p.startFen = replay.fen();
  p.moves = [];
  for (const san of p.sanHistory || []) {
    const res = replay.move(san) || replay.move(san, { sloppy: true });
    if (!res) break;
    p.moves.push({ san: res.san, from: res.from, to: res.to, fenAfter: replay.fen() });
  }
  // A move played while you were looking back can't drag the board with it,
  // but the ply you're looking at has to stay the same ply.
  if (p.viewPly !== null && p.viewPly !== undefined && p.viewPly > p.moves.length) {
    p.viewPly = p.moves.length;
  }
}

function playFenAt(ply) {
  const p = state.play;
  return ply <= 0 ? p.startFen : (p.moves[ply - 1] || {}).fenAfter;
}

/** Jumps the board to `ply` of the live game. Snaps by default; `animate`
    slides the one move between here and there. */
async function goToPlayPly(ply, animate = false) {
  const p = state.play;
  if (!p || !p.moves) return;
  const target = Math.max(0, Math.min(ply, p.moves.length));
  const from = playViewPly();
  p.viewPly = target === p.moves.length ? null : target;
  // A pre-move belongs to the live position; stepping away withdraws it
  // rather than leaving marks on a board it doesn't apply to.
  if (p.viewPly !== null) clearPremove();

  const fen = playFenAt(target);
  if (animate && Math.abs(target - from) === 1) {
    // Stepping forward slides the move being added; stepping back slides the
    // move being undone in reverse.
    const move = p.moves[Math.max(target, from) - 1];
    const [a, b] = target > from ? [move.from, move.to] : [move.to, move.from];
    await state.board.animateMove(a, b, fen);
  } else {
    state.board.renderFEN(fen);
  }
  refreshLastMove();
  renderPlayMoveTable();
  renderPlayReviewNote();
}

async function stepPlay(delta) {
  await goToPlayPly(playViewPly() + delta, true);
}

/** Says the board isn't showing the live position, and takes you back. Silent
    when you're up to date, which is nearly always. */
function renderPlayReviewNote() {
  const note = document.getElementById('board-note');
  if (!state.playMode || playIsLive()) {
    note.classList.add('hidden');
    note.textContent = '';
    return;
  }
  const behind = playLivePly() - playViewPly();
  note.textContent = `Looking back ${behind} move(s) — tap to return to the game`;
  note.classList.remove('hidden');
}

function playLegalTargets(square) {
  const p = state.play;
  // Moving from a position that isn't the live one would be a move in a game
  // that has moved on. Return to the game first.
  if (!playIsLive()) return [];
  if (!p || p.result) return [];
  if (p.chess.turn() !== p.humanColor) {
    return premovesOffered() ? premoveTargets(p.chess, square, p.humanColor) : [];
  }
  const byTo = new Map();
  for (const m of p.chess.moves({ square, verbose: true })) {
    if (!byTo.has(m.to)) byTo.set(m.to, { to: m.to, promotion: !!m.promotion });
  }
  return Array.from(byTo.values());
}

/* ---- Pre-moves --------------------------------------------------------
   Queue your reply while Maia is still thinking and it plays the instant its
   move lands. The point is the obvious reply -- a recapture, a check you'd
   already decided on -- where waiting for the board costs you seconds you
   didn't need to spend. A pre-move is a *hope*, not a move: it is validated
   against the position it actually arrives in and dropped if it doesn't fit. */

function premovesOffered() {
  const p = state.play;
  return !!(p && p.chess && !p.result && playIsLive()
            && state.user.allow_premoves !== 0
            && p.chess.turn() !== p.humanColor);
}

const PREMOVE_RAYS = {
  b: [[1, 1], [1, -1], [-1, -1], [-1, 1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};
const PREMOVE_KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

/** Where a piece could go *ignoring everything else on the board*.

    Deliberately not "legal moves": at pre-move time the opponent hasn't moved
    yet, so what's legal isn't knowable — a rook can be pre-moved through a
    square the blocker is about to vacate, and a capture can be aimed at a
    square nothing is on yet. Generating from the piece's movement pattern is
    both what a pre-move means and what every chess site does. Legality is
    settled when it's played. */
function premoveTargets(chess, square, colour) {
  const piece = chess.get(square);
  if (!piece || piece.color !== colour) return [];
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const name = (f, r) => (f < 0 || f > 7 || r < 0 || r > 7 ? null : String.fromCharCode(97 + f) + (r + 1));
  const out = new Map();
  const add = (f, r, promotion = false) => {
    const to = name(f, r);
    if (to && to !== square) out.set(to, { to, promotion });
  };

  if (piece.type === 'p') {
    const dir = colour === 'w' ? 1 : -1;
    const start = colour === 'w' ? 1 : 6;
    const last = colour === 'w' ? 7 : 0;
    add(file, rank + dir, rank + dir === last);
    if (rank === start) add(file, rank + 2 * dir);
    // Both captures are always offered: the square may be empty now and
    // occupied by the time the pre-move is played, which is the usual case.
    for (const df of [-1, 1]) add(file + df, rank + dir, rank + dir === last);
  } else if (piece.type === 'n') {
    for (const [df, dr] of PREMOVE_KNIGHT) add(file + df, rank + dr);
  } else if (piece.type === 'k') {
    for (const [df, dr] of PREMOVE_RAYS.q) add(file + df, rank + dr);
    // Castling as the king's two-square move. Offered from the home square
    // without checking rights -- the move itself is checked when it's played.
    const home = colour === 'w' ? 0 : 7;
    if (file === 4 && rank === home) { add(6, home); add(2, home); }
  } else {
    for (const [df, dr] of PREMOVE_RAYS[piece.type] || []) {
      for (let step = 1; step < 8; step++) add(file + df * step, rank + dr * step);
    }
  }
  return Array.from(out.values());
}

function setPremove(from, to, promotion) {
  if (!state.play) return;
  state.play.premove = { from, to, promotion: promotion || null };
  state.board.setPremove(from, to);
}

function clearPremove() {
  if (state.play) state.play.premove = null;
  state.board.setPremove(null, null);
}

/** Plays the queued pre-move if the position that arrived allows it, and
    drops it if not -- silently, the same as every site that has these: the
    marks disappearing is the answer. */
async function tryPremove() {
  const p = state.play;
  const pending = p && p.premove;
  if (!pending) return;
  clearPremove();
  if (p.result || !playIsLive() || p.chess.turn() !== p.humanColor) return;
  await onPlayMove(pending.from, pending.to, pending.promotion);
}

async function onPlayMove(from, to, promotion) {
  const p = state.play;
  // Not your turn: this is a pre-move, queued rather than played.
  if (premovesOffered()) {
    setPremove(from, to, promotion);
    return false;
  }
  const res = p.chess.move({ from, to, promotion: promotion || 'q' });
  if (!res) return false;
  playMoveSound(res.san, true);
  await state.board.animateMove(from, to, p.chess.fen());
  (p.sanHistory = p.sanHistory || []).push(res.san); // optimistic; the next state message is authoritative
  rebuildPlayMoves();
  refreshLastMove();
  renderPlayMoveTable();
  sendPlay({ type: 'move', uci: from + to + (promotion || (res.promotion ? 'q' : '')) });
  return true;
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

/** Entering the Play tab, and also starting a second game within it: the board
    changes hands on the tab switch rather than on Start, so an empty Play tab
    already shows a board ready to play on instead of whichever analysed
    position happened to be up. */
function enterPlayMode() {
  state.playMode = true;
  if (!state.play) state.play = {};
  state.play.chess = new Chess();
  state.play.result = null;
  state.play.humanColor = 'w';
  state.play.sanHistory = [];
  state.play.viewPly = null;    // null = the board is showing the live position
  clearPremove();               // nothing carries over from the last game
  state.play.greeted = false;
  state.play.lowTimeWarned = false;
  rebuildPlayMoves();
  renderPlayReviewNote();
  state.flipOverride = false;   // a new game always starts facing you
  // The eval bar, the FEN boxes and the analysis controls are the Play tab's
  // business now -- applyBoardChrome owns them, and the analysis controls live
  // on a tab that isn't showing. The nav buttons deliberately stay live: they
  // step through the game in progress rather than the loaded one (goToPlayPly).
  state.board.renderFEN(state.play.chess.fen());
  applyOrientation();
  renderPlayMoveTable();
}

/** Leaving the Play tab. Whichever tab we're going to puts the board back the
    way it wants it, so this only tears the session down. */
function exitPlayMode() {
  state.playMode = false;
  if (state.play) {
    clearInterval(state.play.tick);
    if (state.play.ws) state.play.ws.close();
    state.play.ws = null;
    state.play.viewPly = null;
  }
  document.getElementById('p-resign').disabled = true;
  document.getElementById('p-save').disabled = true;
  document.getElementById('p-status').textContent = '';
  document.getElementById('p-notes').textContent = '';
  clearPremove();
  renderPlayReviewNote();
  state.flipOverride = false;
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
    rebuildPlayMoves();
    playMoveSound(msg.san, false);
    // If you're looking back at an earlier position, Maia's reply goes into
    // the move list but does not yank the board out from under you.
    if (playIsLive()) {
      await state.board.animateMove(msg.from, msg.to, msg.fen);
      refreshLastMove();
    }
    renderPlayMoveTable();
    renderPlayReviewNote();
    // The moment the pre-move exists for: the reply has landed and it's your
    // turn again. After the slide, so it reads as your answer to that move.
    await tryPremove();
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
    rebuildPlayMoves();
    renderPlayMoveTable();
    renderPlayReviewNote();

    // The server is the source of truth -- if the local copy drifted for any
    // reason, snap to what the server says rather than letting them diverge.
    // The board only follows when it's showing the live position; while
    // you're looking back, the correction is to the model, not the view.
    if (p.chess.fen() !== msg.fen) {
      p.chess.load(msg.fen);
      if (playIsLive()) {
        state.board.renderFEN(msg.fen);
        refreshLastMove();
      }
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
    // A game that has ended can't take the pre-move you'd queued for it.
    if (msg.result) clearPremove();
    // Normally the engine_move handler plays it; this covers a state message
    // that hands you the turn without one (a resync, or the server rejecting
    // a move of yours).
    else if (msg.turn === msg.human_color) await tryPremove();
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
    modes look consistent -- White on the left there and here. Clicking a move
    puts that position on the board: the same gesture as in the analysis
    table, and it doesn't interrupt the game (see goToPlayPly). */
function renderPlayMoveTable() {
  const tbody = document.getElementById('move-table').querySelector('tbody');
  tbody.innerHTML = '';
  const history = state.play.sanHistory || [];
  const humanIsWhite = state.play.humanColor === 'w';
  const shown = playViewPly();
  const you = `${state.user.display_name || 'You'} (you)`;
  document.getElementById('mt-white').textContent = humanIsWhite ? you : 'Maia3';
  document.getElementById('mt-black').textContent = humanIsWhite ? 'Maia3' : you;
  for (let i = 0; i < history.length; i += 2) {
    const tr = document.createElement('tr');
    const numTd = document.createElement('td');
    numTd.className = 'ply-num';
    numTd.textContent = (i / 2 + 1) + '.';
    tr.appendChild(numTd);
    // Ply numbers are 1-based; i is the index of White's move in this row.
    const white = { san: history[i], ply: i + 1 };
    const black = { san: history[i + 1], ply: i + 2 };
    for (const move of [white, black]) {
      const td = document.createElement('td');
      td.textContent = move.san || '';
      if (move.san) {
        td.classList.toggle('current', move.ply === shown);
        td.addEventListener('click', () => goToPlayPly(move.ply));
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  const wrap = document.getElementById('move-table-wrap');
  // Chasing the newest move would fight you while you're reading back
  // through the game, so it only follows when the board is live.
  if (playIsLive()) wrap.scrollTop = wrap.scrollHeight;
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
      // Rank 1 is the bar's number; every rank is a row in the lines panel.
      if ((msg.multipv || 1) === 1) updateEvalBar(msg);
      noteLiveLine(msg);
    }
  });
  ws.addEventListener('close', () => {
    if (state.ws === ws) {
      setTimeout(connectLiveEval, 2000); // reconnect (e.g. after phone screen lock)
    }
  });
  ws.addEventListener('open', () => {
    // A reconnect gets a fresh engine session, which is back to one line.
    if (state.liveLines.count) setLiveLines(state.liveLines.count);
    requestEval();
  });
}

function requestEval() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.seq += 1;
  state.lastMoverColor = state.explorer.moverColor;
  // The lines described the position we just left.
  state.liveLines.byRank = {};
  renderLiveLines();
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
  // One number, two orientations: the CSS decides whether White's share of
  // the bar is its width or its height, so the bar can move without this
  // knowing where it went.
  document.getElementById('eval-bar').style.setProperty(
    '--eval-white', (wp * 100).toFixed(1) + '%');
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
      maia_policy: document.getElementById('s-maia-policy').value === '1',
      min_think_ms: Number(document.getElementById('s-min-think-ms').value),
      maia_accuracy_offset: Number(document.getElementById('s-maia-accuracy-offset').value),
      great_max_drop: Number(document.getElementById('s-great-drop').value),
      great_max_match_rate: Number(document.getElementById('s-great-rate').value),
      brilliant_enabled: document.getElementById('s-brilliant').value === '1',
      maia_options: collectEngineOptions('s-maia-options'),
      stockfish_options: state.settings.stockfish_options || {},
    };
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });

    const displayName = document.getElementById('s-display-name').value.trim();
    if (displayName && displayName !== state.user.display_name) {
      state.user = await api('/api/settings/profile', {
        method: 'PUT', body: JSON.stringify({ display_name: displayName }),
      });
      document.getElementById('whoami').textContent = state.user.display_name;
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

async function fillSettingsForm() {
  const s = state.settings;
  document.getElementById('s-display-name').value = state.user.display_name;

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
  document.getElementById('s-maia-policy').value = (s.maia_policy ?? 1) ? '1' : '0';
  document.getElementById('s-min-think-ms').value = s.min_think_ms ?? 2000;
  document.getElementById('s-maia-accuracy-offset').value = s.maia_accuracy_offset ?? 0;
  document.getElementById('s-great-drop').value = s.great_max_drop ?? 0.02;
  document.getElementById('s-great-rate').value = s.great_max_match_rate ?? 0.20;
  document.getElementById('s-brilliant').value = s.brilliant_enabled ? '1' : '0';
}

boot();
