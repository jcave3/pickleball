let currentLeaderboard = [];
let currentGames = [];
let currentGamesLoaded = false;
let currentCalibration = null;

function splitRecordForPlayer(player, format) {
  if (currentGamesLoaded) {
    const normalizedFormat = format.toLowerCase();
    let wins = 0;
    let losses = 0;
    currentGames.forEach((game) => {
      if (String(game.Format || '').trim().toLowerCase() !== normalizedFormat) return;
      const onA = [game.SideA_Player1, game.SideA_Player2].includes(player.Name);
      const onB = [game.SideB_Player1, game.SideB_Player2].includes(player.Name);
      if (!onA && !onB) return;
      const winner = String(game.Winner || '').trim().toUpperCase();
      if (winner !== 'A' && winner !== 'B') return;
      if ((onA && winner === 'A') || (onB && winner === 'B')) wins += 1;
      else losses += 1;
    });
    return { wins, losses };
  }

  const prefix = format === 'Singles' ? 'Singles' : 'Doubles';
  const wins = Number(player[`${prefix}Wins`]);
  const losses = Number(player[`${prefix}Losses`]);
  if (Number.isFinite(wins) && Number.isFinite(losses)) return { wins, losses };

  const games = Number(player[`${prefix}Games`]);
  return games === 0 ? { wins: 0, losses: 0 } : null;
}

function splitRecordText(record) {
  return record ? `${record.wins}-${record.losses}` : '—';
}

function exportLeaderboardCsv() {
  const headers = ['Rank', 'Name', 'Rating', 'Confidence', 'Provisional', 'Wins', 'Losses', 'WinPct', 'Games', 'SinglesWins', 'SinglesLosses', 'DoublesWins', 'DoublesLosses', 'Streak'];
  const rows = currentLeaderboard.map((p) => {
    const singles = splitRecordForPlayer(p, 'Singles');
    const doubles = splitRecordForPlayer(p, 'Doubles');
    return [
      p.IsProvisional ? '' : displayRankFor(p),
      p.Name,
      Math.round(p.Elo),
      p.Confidence || 0,
      p.IsProvisional ? 'Yes' : 'No',
      p.Wins,
      p.Losses,
      Math.round((p.WinPct || 0) * 100),
      p.GamesPlayed || 0,
      singles ? singles.wins : '',
      singles ? singles.losses : '',
      doubles ? doubles.wins : '',
      doubles ? doubles.losses : '',
      p.Streak || 0,
    ];
  });
  downloadCsv('leaderboard.csv', rowsToCsv(headers, rows));
}

function displayRankFor(player) {
  let rank = 0;
  for (const p of currentLeaderboard) {
    if (p.IsProvisional) continue;
    rank += 1;
    if (p.Name === player.Name) return rank;
  }
  return '';
}

function streakBadgeHtml(streak) {
  if (streak >= 3) return `<span class="streak-badge win">🔥${streak}</span>`;
  if (streak <= -3) return `<span class="streak-badge loss">🥶${Math.abs(streak)}</span>`;
  return '';
}

function provisionalBadgeHtml(p) {
  return p.IsProvisional ? '<span class="provisional-badge">PROVISIONAL</span>' : '';
}

function mobileConfidenceHtml(p) {
  return `<div class="rating-meta mobile-only"><span>${p.Confidence || 0}% confidence</span></div>`;
}

function confidenceCellHtml(p) {
  const value = Math.max(0, Math.min(100, Number(p.Confidence) || 0));
  return `<div class="confidence-cell" title="${value}% confidence">
    <span>${value}%</span>
    <span class="confidence-meter" aria-hidden="true"><span style="width:${value}%"></span></span>
  </div>`;
}

function recentForm(games, name, limit) {
  const results = [];
  for (const g of games) {
    const onA = [g.SideA_Player1, g.SideA_Player2].includes(name);
    const onB = [g.SideB_Player1, g.SideB_Player2].includes(name);
    if (!onA && !onB) continue;
    results.push((onA && g.Winner === 'A') || (onB && g.Winner === 'B'));
    if (results.length >= limit) break;
  }
  return results.reverse();
}

function formDotsHtml(games, name, extraClass = '') {
  if (!games.length) return '';
  const form = recentForm(games, name, 5);
  if (!form.length) return '';
  const label = form.map((won) => won ? 'Win' : 'Loss').join(', ');
  return `<div class="form-dots ${extraClass}" aria-label="Recent form: ${label}" title="${label}">${form.map((won) => `<span class="form-dot ${won ? 'win' : 'loss'}" aria-hidden="true"></span>`).join('')}</div>`;
}

function priorityLabel(score) {
  if (score >= 70) return 'Very high value';
  if (score >= 55) return 'High value';
  return 'Useful calibration';
}

function renderCalibration() {
  const section = document.getElementById('calibration-section');
  const list = document.getElementById('calibration-list');
  const confidence = document.getElementById('league-confidence');
  if (!currentCalibration || !currentCalibration.recommendations || !currentCalibration.recommendations.length) {
    section.style.display = 'none';
    return;
  }
  confidence.textContent = `${currentCalibration.LeagueConfidence || 0}% league confidence`;
  list.innerHTML = currentCalibration.recommendations.map((r, i) => {
    const url = `log-game.html?format=Singles&a=${encodeURIComponent(r.PlayerA)}&b=${encodeURIComponent(r.PlayerB)}`;
    return `<a class="calibration-card" href="${url}">
      <div class="calibration-rank">${i + 1}</div>
      <div class="calibration-main">
        <div class="calibration-match">${r.PlayerA} <span>vs</span> ${r.PlayerB}</div>
        <div class="calibration-reason">${r.Reason}</div>
        <div class="calibration-odds">Model: ${r.ExpectedA}% / ${r.ExpectedB}%</div>
      </div>
      <div class="calibration-priority">${priorityLabel(r.PriorityScore)}</div>
    </a>`;
  }).join('');
  section.style.display = 'block';
}

async function loadLeaderboard() {
  const loading = document.getElementById('loading');
  const table = document.getElementById('leaderboard-table');
  const body = document.getElementById('leaderboard-body');
  const exportBtn = document.getElementById('export-btn');

  loading.className = 'loading';
  loading.textContent = 'Loading…';
  loading.style.display = 'block';
  table.style.display = 'none';

  function render() {
    if (!currentLeaderboard.length) return;
    exportBtn.style.display = 'block';
    body.innerHTML = '';
    let rankedPosition = 0;
    currentLeaderboard.forEach((p) => {
      if (!p.IsProvisional) rankedPosition += 1;
      const tr = document.createElement('tr');
      if (!p.IsProvisional && rankedPosition === 1) tr.className = 'rank-1';
      if (p.IsProvisional) tr.classList.add('provisional-row');
      const winPct = Math.round((p.WinPct || 0) * 100);
      const singlesRecord = splitRecordForPlayer(p, 'Singles');
      const doublesRecord = splitRecordForPlayer(p, 'Doubles');
      tr.innerHTML = `
        <td class="rank">${p.IsProvisional ? 'P' : rankedPosition}</td>
        <td class="player-column">
          <a class="player-link" href="player.html?name=${encodeURIComponent(p.Name)}">${p.Name}</a>${streakBadgeHtml(p.Streak || 0)}
          ${provisionalBadgeHtml(p)}
          ${mobileConfidenceHtml(p)}
        </td>
        <td class="numeric-column"><strong>${Math.round(p.Elo)}</strong></td>
        <td class="record-column">${p.Wins}-${p.Losses}</td>
        <td class="desktop-only numeric-column">${winPct}%</td>
        <td class="desktop-only">${confidenceCellHtml(p)}</td>
        <td class="desktop-only numeric-column">${p.GamesPlayed || 0}</td>
        <td class="desktop-only record-column">${splitRecordText(singlesRecord)}</td>
        <td class="desktop-only record-column">${splitRecordText(doublesRecord)}</td>
        <td class="desktop-only">${formDotsHtml(currentGames, p.Name, 'desktop-form')}</td>
      `;
      body.appendChild(tr);
    });
    loading.style.display = 'none';
    table.style.display = 'table';
    renderCalibration();
  }

  let renderedFromCache = false;
  const leaderboardPromise = apiGetCached('getLeaderboard', null, (players, isCache) => {
    renderedFromCache = renderedFromCache || isCache;
    currentLeaderboard = players;
    if (players.length) render();
    else {
      loading.className = 'empty-state';
      loading.textContent = 'No players yet — add some on the Players tab.';
      exportBtn.style.display = 'none';
    }
  }).catch((err) => {
    if (!renderedFromCache) {
      loading.className = 'status error';
      loading.textContent = 'Error loading leaderboard: ' + err.message;
    }
  });

  const gamesPromise = apiGetCached('getGames', null, (games) => {
    currentGames = games;
    currentGamesLoaded = true;
    render();
  }).catch(() => {});

  const calibrationPromise = apiGetCached('getCalibrationRecommendations', null, (data) => {
    currentCalibration = data;
    renderCalibration();
  }).catch(() => {});

  await Promise.all([leaderboardPromise, gamesPromise, calibrationPromise]);
}

document.getElementById('export-btn').addEventListener('click', exportLeaderboardCsv);
loadLeaderboard();
