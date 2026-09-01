let allGames = [];
let allPlayers = [];
let currentFormatFilter = '';
let currentPlayerFilter = '';
let editingGameId = null;

function fmtDelta(d) {
  const n = Number(d);
  const cls = n >= 0 ? 'delta-pos' : 'delta-neg';
  return `<span class="${cls}">${n >= 0 ? '+' : ''}${n}</span>`;
}

function playerLinks(names) {
  return names
    .map((n) => `<a class="player-link" href="player.html?name=${encodeURIComponent(n)}">${n}</a>`)
    .join(' / ');
}

function gameCard(g) {
  if (g.GameId === editingGameId) return editForm(g);

  const date = new Date(g.Date);
  const sideANames = [g.SideA_Player1, g.SideA_Player2].filter(Boolean);
  const sideBNames = [g.SideB_Player1, g.SideB_Player2].filter(Boolean);
  const aWon = g.Winner === 'A';

  const rows = [
    { names: sideANames, score: g.ScoreA, delta: g.EloDeltaA, won: aWon },
    { names: sideBNames, score: g.ScoreB, delta: g.EloDeltaB, won: !aWon },
  ];
  rows.sort((a, b) => (b.won === a.won ? 0 : b.won ? 1 : -1)); // winner row first

  const rowsHtml = rows
    .map(
      (r) => `
      <div class="game-row ${r.won ? 'winner' : 'loser'}">
        <span class="side-names">${r.won ? '<span class="trophy">🏆</span>' : ''}${playerLinks(r.names)}</span>
        <span class="side-score">${r.score}</span>
        <span class="side-delta">${fmtDelta(r.delta)}</span>
      </div>`
    )
    .join('');

  return `
    <div class="game-card">
      <div class="game-meta">
        <div class="meta-left">
          <span>${date.toLocaleDateString()}</span>
          <span class="badge">${g.Format}</span>
        </div>
        <div class="card-actions admin-only">
          <button type="button" class="icon-btn" data-action="edit" data-gameid="${g.GameId}" title="Edit game">✏️</button>
          <button type="button" class="icon-btn" data-action="delete" data-gameid="${g.GameId}" title="Delete game">🗑️</button>
        </div>
      </div>
      ${rowsHtml}
    </div>`;
}

// Renders in place of a game-card when editing. Player pickers include
// archived players too, since an old game may involve someone no longer
// active. Only date (not time-of-day) is editable — acceptable loss of
// precision for fixing a wrong score/player/date after the fact.
function editForm(g) {
  const sideANames = [g.SideA_Player1, g.SideA_Player2].filter(Boolean);
  const sideBNames = [g.SideB_Player1, g.SideB_Player2].filter(Boolean);
  const isDoubles = g.Format === 'Doubles';
  const dateVal = new Date(g.Date).toISOString().slice(0, 10);

  const sortedPlayers = [...allPlayers].sort((a, b) => a.Name.localeCompare(b.Name));
  const options = (selected) =>
    sortedPlayers
      .map((p) => `<option value="${p.Name}" ${p.Name === selected ? 'selected' : ''}>${p.Name}</option>`)
      .join('');

  return `
    <div class="game-card edit-card" data-gameid="${g.GameId}">
      <label>Date</label>
      <input type="date" class="edit-date" value="${dateVal}" />

      <label>Format</label>
      <div class="toggle-group edit-format">
        <button type="button" data-format="Singles" class="${!isDoubles ? 'active' : ''}">Singles</button>
        <button type="button" data-format="Doubles" class="${isDoubles ? 'active' : ''}">Doubles</button>
      </div>

      <label>Side A</label>
      <select class="edit-a1">${options(sideANames[0])}</select>
      <select class="edit-a2" style="display:${isDoubles ? 'block' : 'none'};margin-top:8px;">${options(sideANames[1])}</select>

      <label>Side B</label>
      <select class="edit-b1">${options(sideBNames[0])}</select>
      <select class="edit-b2" style="display:${isDoubles ? 'block' : 'none'};margin-top:8px;">${options(sideBNames[1])}</select>

      <div class="score-row">
        <div><label>Score A</label><input type="number" class="edit-scoreA" value="${g.ScoreA}" /></div>
        <div><label>Score B</label><input type="number" class="edit-scoreB" value="${g.ScoreB}" /></div>
      </div>

      <div class="edit-status status" style="display:none;"></div>

      <div class="edit-actions">
        <button type="button" class="btn" data-action="save" data-gameid="${g.GameId}">Save</button>
        <button type="button" class="btn secondary" data-action="cancel" data-gameid="${g.GameId}">Cancel</button>
      </div>
    </div>`;
}

let currentFilteredGames = [];

function applyFiltersAndRender() {
  const list = document.getElementById('game-list');
  const empty = document.getElementById('empty-state');
  const exportBtn = document.getElementById('export-btn');

  const filtered = allGames.filter((g) => {
    if (currentFormatFilter && g.Format !== currentFormatFilter) return false;
    if (currentPlayerFilter) {
      const names = [g.SideA_Player1, g.SideA_Player2, g.SideB_Player1, g.SideB_Player2].filter(Boolean);
      if (!names.includes(currentPlayerFilter)) return false;
    }
    return true;
  });

  currentFilteredGames = filtered;
  list.innerHTML = filtered.map(gameCard).join('');
  empty.style.display = filtered.length ? 'none' : 'block';
  exportBtn.style.display = filtered.length ? 'block' : 'none';
}

// Exports whatever's currently filtered/visible, not the full unfiltered
// log — matches what the user is actually looking at.
function exportHistoryCsv() {
  const headers = ['Date', 'Format', 'SideA', 'SideB', 'ScoreA', 'ScoreB', 'Winner', 'RatingImpactA1', 'RatingImpactA2', 'RatingImpactB1', 'RatingImpactB2'];
  const rows = currentFilteredGames.map((g) => [
    new Date(g.Date).toLocaleDateString(),
    g.Format,
    [g.SideA_Player1, g.SideA_Player2].filter(Boolean).join(' / '),
    [g.SideB_Player1, g.SideB_Player2].filter(Boolean).join(' / '),
    g.ScoreA,
    g.ScoreB,
    g.Winner,
    g.EloDeltaA1,
    g.EloDeltaA2,
    g.EloDeltaB1,
    g.EloDeltaB2,
  ]);
  downloadCsv('game-history.csv', rowsToCsv(headers, rows));
}

function populatePlayerFilterOptions() {
  const select = document.getElementById('player-filter');
  while (select.options.length > 1) select.remove(1); // keep only the "All players" placeholder
  allPlayers
    .slice()
    .sort((a, b) => a.Name.localeCompare(b.Name))
    .forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.Name;
      opt.textContent = p.Name;
      select.appendChild(opt);
    });
  select.value = currentPlayerFilter; // re-selecting after a post-save/delete reload
}

// One request for both the game feed and the full roster (needed for the
// player filter and the edit-form pickers) instead of two — each call to
// the Apps Script web app pays its own round-trip/cold-start cost, so
// combining halves that overhead.
let loadPromise = null;

async function loadHistory() {
  const loading = document.getElementById('loading');
  let renderedFromCache = false;

  try {
    await apiGetCached('getLogGameData', null, (data, isCache) => {
      renderedFromCache = renderedFromCache || isCache;
      allGames = data.games;
      allPlayers = data.players;
      populatePlayerFilterOptions();
      applyFiltersAndRender();
      loading.style.display = 'none';
    });
  } catch (err) {
    if (!renderedFromCache) {
      loading.className = 'status error';
      loading.textContent = 'Error loading history: ' + err.message;
    }
  }
}

// Edit forms need allPlayers for their pickers. loadHistory() kicks off in
// the background at page load, but a click on the edit button can beat it
// back — this makes edit wait on the same in-flight fetch instead of
// rendering pickers before the data has arrived.
function ensurePlayersLoaded() {
  if (allPlayers.length) return Promise.resolve();
  return loadPromise;
}

async function handleDelete(gameId) {
  if (!window.confirm('Delete this game? Elo will be recalculated for every game after it.')) return;

  const passcode = await getOrPromptPasscode();
  if (!passcode) return;

  try {
    await apiPost('deleteGame', { passcode, gameId });
    invalidateAllCache();
    await loadHistory();
  } catch (err) {
    if (/passcode/i.test(err.message)) clearStoredPasscode();
    window.alert('Error: ' + err.message);
  }
}

async function handleSave(gameId) {
  const card = document.querySelector(`.edit-card[data-gameid="${gameId}"]`);
  const statusEl = card.querySelector('.edit-status');

  const showError = (msg) => {
    statusEl.style.display = 'block';
    statusEl.className = 'edit-status status error';
    statusEl.textContent = msg;
  };

  const format = card.querySelector('.edit-format button.active').dataset.format;
  const isDoubles = format === 'Doubles';
  const sideAPlayers = [card.querySelector('.edit-a1').value];
  const sideBPlayers = [card.querySelector('.edit-b1').value];
  if (isDoubles) {
    sideAPlayers.push(card.querySelector('.edit-a2').value);
    sideBPlayers.push(card.querySelector('.edit-b2').value);
  }
  const scoreA = card.querySelector('.edit-scoreA').value;
  const scoreB = card.querySelector('.edit-scoreB').value;
  const date = card.querySelector('.edit-date').value;

  if (sideAPlayers.some((n) => !n) || sideBPlayers.some((n) => !n) || scoreA === '' || scoreB === '') {
    showError('Fill in all players and both scores.');
    return;
  }
  if (new Set([...sideAPlayers, ...sideBPlayers]).size !== sideAPlayers.length + sideBPlayers.length) {
    showError('The same player can’t appear twice.');
    return;
  }

  const passcode = await getOrPromptPasscode();
  if (!passcode) return;

  statusEl.style.display = 'block';
  statusEl.className = 'edit-status status';
  statusEl.textContent = 'Saving…';

  try {
    await apiPost('editGame', { passcode, gameId, date, format, sideAPlayers, sideBPlayers, scoreA, scoreB });
    invalidateAllCache();
    editingGameId = null;
    await loadHistory();
  } catch (err) {
    if (/passcode/i.test(err.message)) clearStoredPasscode();
    showError('Error: ' + err.message);
  }
}

document.getElementById('game-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  const action = btn.dataset.action;
  const gameId = btn.dataset.gameid;

  if (action === 'edit') {
    btn.disabled = true;
    await ensurePlayersLoaded();
    btn.disabled = false;
    editingGameId = gameId;
    applyFiltersAndRender();
  } else if (action === 'cancel') {
    editingGameId = null;
    applyFiltersAndRender();
  } else if (action === 'delete') {
    handleDelete(gameId);
  } else if (action === 'save') {
    handleSave(gameId);
  } else if (btn.dataset.format) {
    const card = btn.closest('.edit-card');
    card.querySelectorAll('.edit-format button').forEach((b) => b.classList.toggle('active', b === btn));
    const isDoubles = btn.dataset.format === 'Doubles';
    card.querySelector('.edit-a2').style.display = isDoubles ? 'block' : 'none';
    card.querySelector('.edit-b2').style.display = isDoubles ? 'block' : 'none';
  }
});

document.getElementById('format-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  currentFormatFilter = btn.dataset.format;
  document.querySelectorAll('#format-filter button').forEach((b) => b.classList.toggle('active', b === btn));
  applyFiltersAndRender();
});

document.getElementById('player-filter').addEventListener('change', (e) => {
  currentPlayerFilter = e.target.value;
  applyFiltersAndRender();
});

document.getElementById('export-btn').addEventListener('click', exportHistoryCsv);

loadPromise = loadHistory();

window.addEventListener(ADMIN_MODE_EVENT, applyFiltersAndRender);
