let currentFormat = 'Singles';
let players = [];
let pendingPrefill = null;
let lastSavedGameId = null;

function readPrefill() {
  const params = new URLSearchParams(window.location.search);
  const format = params.get('format');
  const a = params.get('a');
  const b = params.get('b');
  if (format === 'Singles' && a && b) pendingPrefill = { format, a, b };
}

function setFormat(format) {
  currentFormat = format;
  document.querySelectorAll('#format-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.format === format));
  refreshPickers();
  document.getElementById('post-game-panel').style.display = 'none';
}

function playerRating(name) {
  const p = players.find((x) => x.Name === name);
  return p ? Number(p.Elo) || 1000 : 1000;
}

function predictedProbability(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// `slots` is the single source of truth for who is playing. The chip grid
// writes into it and re-renders from it; nothing mirrors it. Slot order is the
// order taps land — a1, a2 fill Side A, then b1, b2 fill Side B.
//
// This replaced four <select>s, which couldn't represent "nobody picked yet":
// a <select> always has a value, so every picker silently defaulted to a real
// player and a forgotten dropdown logged a game against the wrong person.
const SLOT_IDS_DOUBLES = ['a1', 'a2', 'b1', 'b2'];
const SLOT_IDS_SINGLES = ['a1', 'b1'];
let slots = { a1: '', a2: '', b1: '', b2: '' };

function activeSlotIds() {
  return currentFormat === 'Doubles' ? SLOT_IDS_DOUBLES : SLOT_IDS_SINGLES;
}

function slotFor(name) {
  return activeSlotIds().findIndex((id) => slots[id] === name);
}

function isLineupFull() {
  return activeSlotIds().every((id) => slots[id]);
}

// Keeps the {slotId: name} shape its callers already used — the ?a=/?b=
// prefill link, the team balancer and Swap sides all assign a whole lineup.
function assignPickerValues(valuesById) {
  activeSlotIds().forEach((id) => {
    if (id in valuesById) slots[id] = valuesById[id] || '';
  });
  refreshPickers();
}

function togglePlayer(name) {
  const held = activeSlotIds().find((id) => slots[id] === name);
  if (held) {
    slots[held] = '';
  } else {
    const empty = activeSlotIds().find((id) => !slots[id]);
    if (!empty) return;
    slots[empty] = name;
  }
  refreshPickers();
}

function slotNamesHtml(ids) {
  return ids.map((id) => {
    const name = slots[id];
    if (!name) return '<span class="slot-name empty">Tap a player</span>';
    return `<button type="button" class="slot-name filled" data-clear-slot="${id}" aria-label="Remove ${escapeHtml(name)}">`
      + `${escapeHtml(name)}<span class="slot-remove" aria-hidden="true">×</span></button>`;
  }).join('');
}

function refreshPickers() {
  const isDoubles = currentFormat === 'Doubles';
  const balancePanel = document.getElementById('balance-panel');
  if (balancePanel) balancePanel.style.display = isDoubles ? 'block' : 'none';
  if (!isDoubles) { slots.a2 = ''; slots.b2 = ''; }

  document.getElementById('slot-names-a').innerHTML = slotNamesHtml(isDoubles ? ['a1', 'a2'] : ['a1']);
  document.getElementById('slot-names-b').innerHTML = slotNamesHtml(isDoubles ? ['b1', 'b2'] : ['b1']);

  const full = isLineupFull();
  document.getElementById('player-grid').innerHTML = players.map((p) => {
    // Badge the slot the player actually occupies, not their position among
    // those picked — with a hole in the lineup those two disagree.
    const index = slotFor(p.Name);
    const picked = index !== -1;
    // Once every slot is taken the only useful tap is on someone already in the
    // lineup, so dim the rest rather than silently swallowing the tap.
    const disabled = !picked && full;
    const cls = ['player-chip'];
    if (picked) cls.push('picked');
    if (disabled) cls.push('is-disabled');
    return `<button type="button" class="${cls.join(' ')}" data-player="${escapeHtml(p.Name)}"`
      + ` aria-pressed="${picked}"${disabled ? ' disabled' : ''}>`
      + `<span class="chip-slot">${picked ? index + 1 : ''}</span>`
      + `<span class="chip-name">${escapeHtml(p.Name)}</span>`
      + `<span class="chip-elo">${Math.round(Number(p.Elo) || 0)}</span>`
      + '</button>';
  }).join('');

  const remaining = activeSlotIds().filter((id) => !slots[id]).length;
  document.getElementById('picker-hint').textContent = remaining === 0
    ? 'Lineup set — tap a name to swap someone out.'
    : `Tap ${remaining} more player${remaining === 1 ? '' : 's'}`;
  document.getElementById('clear-players').disabled = activeSlotIds().every((id) => !slots[id]);
}

// Sorts the roster by "most recently played with" (derived from game
// history, most-recent-first) so the usual weekly group surfaces at the
// top of each picker instead of everyone scrolling an alphabetical list.
// Players with no game history yet sort after everyone with a history,
// alphabetically among themselves.
function sortByRecency(players, games) {
  const lastPlayedAt = {};
  games.forEach((g) => {
    const names = [g.SideA_Player1, g.SideA_Player2, g.SideB_Player1, g.SideB_Player2].filter(Boolean);
    names.forEach((n) => {
      if (!(n in lastPlayedAt)) lastPlayedAt[n] = g.Date; // games is most-recent-first
    });
  });

  return [...players].sort((a, b) => {
    const aTime = a.Name in lastPlayedAt ? new Date(lastPlayedAt[a.Name]).getTime() : -Infinity;
    const bTime = b.Name in lastPlayedAt ? new Date(lastPlayedAt[b.Name]).getTime() : -Infinity;
    if (aTime !== bTime) return bTime - aTime;
    return a.Name.localeCompare(b.Name);
  });
}

async function loadPlayers() {
  await apiGetCached('getLogGameData', null, ({ players: allPlayers, games }) => {
    players = sortByRecency(allPlayers.filter((p) => !p.Archived), games);

    const emptyState = document.getElementById('empty-state');
    const form = document.getElementById('log-game-form');
    const hasEnoughPlayers = players.length >= 2;
    emptyState.style.display = hasEnoughPlayers ? 'none' : 'block';
    form.style.display = hasEnoughPlayers ? 'block' : 'none';
    if (!hasEnoughPlayers) return;

    // A roster refresh (or an undo) can retire someone who is still sitting in
    // a slot; drop them rather than submitting a name the backend won't find.
    const rosterNames = new Set(players.map((p) => p.Name));
    Object.keys(slots).forEach((id) => {
      if (slots[id] && !rosterNames.has(slots[id])) slots[id] = '';
    });

    refreshPickers();
    if (pendingPrefill) {
      setFormat('Singles');
      assignPickerValues({ a1: pendingPrefill.a, b1: pendingPrefill.b });
      pendingPrefill = null;
    }
  });
}

document.getElementById('format-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  setFormat(btn.dataset.format);
});

document.getElementById('player-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('.player-chip');
  if (btn && !btn.disabled) togglePlayer(btn.dataset.player);
});

document.getElementById('team-slots').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-clear-slot]');
  if (!btn) return;
  slots[btn.dataset.clearSlot] = '';
  refreshPickers();
});

document.getElementById('clear-players').addEventListener('click', () => {
  slots = { a1: '', a2: '', b1: '', b2: '' };
  refreshPickers();
});

function syncPresetHighlight(input) {
  const row = document.querySelector(`.preset-row[data-target="${input.id}"]`);
  row.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === input.value);
  });
}

document.querySelectorAll('.preset-row').forEach((row) => {
  const input = document.getElementById(row.dataset.target);
  row.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    input.value = btn.dataset.value;
    syncPresetHighlight(input);
  });
  input.addEventListener('input', () => syncPresetHighlight(input));
});

function balanceSelectedPlayers() {
  if (currentFormat !== 'Doubles') return false;
  const selected = SLOT_IDS_DOUBLES.map((id) => slots[id]);
  const resultEl = document.getElementById('balance-result');
  if (selected.some((n) => !n) || new Set(selected).size !== 4) {
    resultEl.className = 'balance-result status error';
    resultEl.textContent = 'Pick four different players first.';
    resultEl.style.display = 'block';
    return false;
  }

  const [p1, p2, p3, p4] = selected;
  const pairings = [
    [[p1, p2], [p3, p4]],
    [[p1, p3], [p2, p4]],
    [[p1, p4], [p2, p3]],
  ].map(([a, b]) => {
    const ratingA = (playerRating(a[0]) + playerRating(a[1])) / 2;
    const ratingB = (playerRating(b[0]) + playerRating(b[1])) / 2;
    const pA = predictedProbability(ratingA, ratingB);
    return { a, b, ratingA, ratingB, pA, gap: Math.abs(pA - 0.5) };
  }).sort((x, y) => x.gap - y.gap);

  const best = pairings[0];
  assignPickerValues({ a1: best.a[0], a2: best.a[1], b1: best.b[0], b2: best.b[1] });

  const pctA = Math.round(best.pA * 100);
  const pctB = 100 - pctA;
  const ratingDiff = Math.abs(best.ratingA - best.ratingB);
  let handicapText = '';
  if (Math.max(pctA, pctB) >= 62) {
    const points = Math.min(4, Math.max(1, Math.round(ratingDiff / 55)));
    const weaker = best.ratingA < best.ratingB ? best.a.join(' + ') : best.b.join(' + ');
    handicapText = `<div class="handicap-note">Optional fun handicap: <strong>${weaker}</strong> starts +${points}. Keep the recorded score unhandicapped if you want the rating model to stay clean.</div>`;
  }
  resultEl.className = 'balance-result';
  resultEl.innerHTML = `<strong>${best.a.join(' + ')}</strong> vs <strong>${best.b.join(' + ')}</strong><br><span>${pctA}% / ${pctB}% predicted</span>${handicapText}`;
  resultEl.style.display = 'block';
  return true;
}

document.getElementById('balance-btn').addEventListener('click', balanceSelectedPlayers);

function newRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'game-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function clearScoresAndFocus() {
  ['scoreA', 'scoreB'].forEach((id) => {
    const input = document.getElementById(id);
    input.value = '';
    syncPresetHighlight(input);
  });
  document.getElementById('post-game-panel').style.display = 'none';
  document.getElementById('status').className = '';
  document.getElementById('status').textContent = '';
  document.getElementById('scoreA').focus();
}

function showPostGamePanel(sideAPlayers, sideBPlayers, scoreA, scoreB, gameId) {
  lastSavedGameId = gameId;
  const panel = document.getElementById('post-game-panel');
  const summary = document.getElementById('post-game-summary');
  const aWon = Number(scoreA) > Number(scoreB);
  const winners = aWon ? sideAPlayers : sideBPlayers;
  const losers = aWon ? sideBPlayers : sideAPlayers;
  const winnerScore = aWon ? scoreA : scoreB;
  const loserScore = aWon ? scoreB : scoreA;
  summary.textContent = `${winners.join(' + ')} beat ${losers.join(' + ')} ${winnerScore}–${loserScore}`;
  document.getElementById('rebalance-btn').style.display = currentFormat === 'Doubles' ? 'flex' : 'none';
  panel.style.display = 'block';
}

document.getElementById('rematch-btn').addEventListener('click', clearScoresAndFocus);

document.getElementById('swap-sides-btn').addEventListener('click', () => {
  const values = { a1: slots.b1, b1: slots.a1 };
  if (currentFormat === 'Doubles') {
    values.a2 = slots.b2;
    values.b2 = slots.a2;
  }
  assignPickerValues(values);
  clearScoresAndFocus();
});

document.getElementById('rebalance-btn').addEventListener('click', () => {
  if (balanceSelectedPlayers()) clearScoresAndFocus();
});

document.getElementById('undo-game-btn').addEventListener('click', async () => {
  if (!lastSavedGameId || !window.confirm('Undo the game you just saved? Ratings will be recalculated.')) return;
  const btn = document.getElementById('undo-game-btn');
  const statusEl = document.getElementById('status');
  const passcode = await getOrPromptPasscode();
  if (!passcode) return;
  btn.disabled = true;
  try {
    await apiPost('deleteGame', { passcode, gameId: lastSavedGameId });
    invalidateAllCache();
    lastSavedGameId = null;
    document.getElementById('post-game-panel').style.display = 'none';
    statusEl.className = 'status success';
    statusEl.textContent = 'Last game undone.';
    await loadPlayers();
  } catch (err) {
    if (/passcode/i.test(err.message)) clearStoredPasscode();
    statusEl.className = 'status error';
    statusEl.textContent = 'Could not undo: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('unlock-log-game').addEventListener('click', unlockAdminMode);

document.getElementById('submit-btn').addEventListener('click', async () => {
  const submitBtn = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');
  statusEl.className = '';
  statusEl.textContent = '';

  const isDoubles = currentFormat === 'Doubles';
  const sideAPlayers = isDoubles ? [slots.a1, slots.a2] : [slots.a1];
  const sideBPlayers = isDoubles ? [slots.b1, slots.b2] : [slots.b1];
  const scoreA = document.getElementById('scoreA').value;
  const scoreB = document.getElementById('scoreB').value;

  if (sideAPlayers.some((n) => !n) || sideBPlayers.some((n) => !n) || scoreA === '' || scoreB === '') {
    statusEl.className = 'status error';
    statusEl.textContent = 'Fill in all players and both scores.';
    return;
  }
  if (new Set([...sideAPlayers, ...sideBPlayers]).size !== sideAPlayers.length + sideBPlayers.length) {
    statusEl.className = 'status error';
    statusEl.textContent = 'The same player can’t appear twice.';
    return;
  }

  const passcode = await getOrPromptPasscode();
  if (!passcode) return;

  submitBtn.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = 'Saving…';

  try {
    const result = await apiPost('logGame', {
      passcode,
      requestId: newRequestId(),
      date: new Date().toISOString(),
      format: currentFormat,
      sideAPlayers,
      sideBPlayers,
      scoreA,
      scoreB,
    });
    const deltaA = result.game.EloDeltaA;
    const deltaB = result.game.EloDeltaB;
    const fmt = (d) => `<span class="${d >= 0 ? 'delta-pos' : 'delta-neg'}">${d >= 0 ? '+' : ''}${d}</span>`;
    statusEl.className = 'status success';
    statusEl.innerHTML = `Saved! Immediate model impact: Side A ${fmt(deltaA)}, Side B ${fmt(deltaB)}.`;
    showPostGamePanel(sideAPlayers, sideBPlayers, scoreA, scoreB, result.game.GameId);
    document.getElementById('scoreA').value = '';
    document.getElementById('scoreB').value = '';
    syncPresetHighlight(document.getElementById('scoreA'));
    syncPresetHighlight(document.getElementById('scoreB'));
    invalidateAllCache();
    await loadPlayers();
  } catch (err) {
    if (/passcode/i.test(err.message)) clearStoredPasscode();
    statusEl.className = 'status error';
    statusEl.textContent = 'Error: ' + err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

readPrefill();
loadPlayers();
