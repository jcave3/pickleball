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

function confidencePct(p) {
  return Math.max(0, Math.min(100, Number(p.Confidence) || 0));
}

function confidenceCellHtml(p) {
  const value = confidencePct(p);
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

/* One computed shape per player, so the table row and the mobile card stay in
   sync and the per-format record scan only runs once per player. */
function playerView(p, rankedPosition) {
  return {
    player: p,
    rank: p.IsProvisional ? 'P' : rankedPosition,
    isTop: !p.IsProvisional && rankedPosition === 1,
    elo: Math.round(p.Elo),
    record: `${p.Wins}-${p.Losses}`,
    winPct: Math.round((p.WinPct || 0) * 100),
    games: p.GamesPlayed || 0,
    confidence: confidencePct(p),
    singles: splitRecordText(splitRecordForPlayer(p, 'Singles')),
    doubles: splitRecordText(splitRecordForPlayer(p, 'Doubles')),
    profileUrl: `player.html?name=${encodeURIComponent(p.Name)}`,
  };
}

function leaderboardRow(v) {
  const p = v.player;
  const tr = document.createElement('tr');
  if (v.isTop) tr.className = 'rank-1';
  if (p.IsProvisional) tr.classList.add('provisional-row');
  tr.innerHTML = `
    <td class="rank">${v.rank}</td>
    <td class="player-column">
      <a class="player-link" href="${v.profileUrl}">${p.Name}</a>${streakBadgeHtml(p.Streak || 0)}
      ${provisionalBadgeHtml(p)}
    </td>
    <td class="numeric-column"><strong>${v.elo}</strong></td>
    <td class="record-column">${v.record}</td>
    <td class="numeric-column">${v.winPct}%</td>
    <td>${confidenceCellHtml(p)}</td>
    <td class="numeric-column">${v.games}</td>
    <td class="record-column">${v.singles}</td>
    <td class="record-column">${v.doubles}</td>
    <td>${formDotsHtml(currentGames, p.Name, 'desktop-form')}</td>
  `;
  return tr;
}

/* The mobile view. <details> carries the expand/collapse for free — keyboard,
   screen-reader state and all — so there is no toggle handler to wire up. The
   player's name is plain text inside <summary> (a link there would fight the
   toggle for the tap); the profile link lives in the expanded panel instead. */
function playerCardHtml(v, isOpen) {
  const p = v.player;
  const classes = ['player-card'];
  if (v.isTop) classes.push('rank-1');
  if (p.IsProvisional) classes.push('provisional-row');
  return `<details class="${classes.join(' ')}" data-player="${escapeAttr(p.Name)}"${isOpen ? ' open' : ''}>
    <summary class="pc-head">
      <span class="pc-rank">${v.rank}</span>
      <span class="pc-identity">
        <span class="pc-name">${p.Name}${streakBadgeHtml(p.Streak || 0)}${provisionalBadgeHtml(p)}</span>
        <span class="pc-line">
          <span class="pc-record">${v.record}</span>
          <span class="pc-sep" aria-hidden="true">·</span>
          <span>${v.winPct}% won</span>
          ${formDotsHtml(currentGames, p.Name, 'pc-form')}
        </span>
      </span>
      <span class="pc-rating">
        <span class="pc-rating-value">${v.elo}</span>
        <span class="pc-rating-label">rating</span>
      </span>
      <svg class="pc-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <div class="pc-body">
      <div class="pc-stats">
        <div class="pc-stat"><span class="pc-stat-label">Games</span><span class="pc-stat-value">${v.games}</span></div>
        <div class="pc-stat"><span class="pc-stat-label">Singles</span><span class="pc-stat-value">${v.singles}</span></div>
        <div class="pc-stat"><span class="pc-stat-label">Doubles</span><span class="pc-stat-value">${v.doubles}</span></div>
      </div>
      <div class="pc-confidence">
        <span class="pc-stat-label">Confidence</span>
        <span class="confidence-meter" aria-hidden="true"><span style="width:${v.confidence}%"></span></span>
        <span class="pc-confidence-value">${v.confidence}%</span>
      </div>
      <a class="pc-profile" href="${v.profileUrl}">View profile <span aria-hidden="true">→</span></a>
    </div>
  </details>`;
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function loadLeaderboard() {
  const loading = document.getElementById('loading');
  const views = document.getElementById('leaderboard-views');
  const body = document.getElementById('leaderboard-body');
  const cards = document.getElementById('leaderboard-cards');
  const exportBtn = document.getElementById('export-btn');

  // Leave #loading's markup alone — it holds the skeleton from index.html.
  // The error/empty branches below overwrite it, which is what clears it.
  loading.style.display = 'block';
  views.hidden = true;

  function render() {
    if (!currentLeaderboard.length) return;
    exportBtn.style.display = 'block';
    // A re-render (cache paint -> fresh data) rebuilds every card, which would
    // otherwise snap open cards shut under the reader's finger.
    const expanded = new Set(
      Array.from(cards.querySelectorAll('details[open]')).map((d) => d.dataset.player)
    );
    body.innerHTML = '';
    cards.innerHTML = '';
    let rankedPosition = 0;
    currentLeaderboard.forEach((p) => {
      if (!p.IsProvisional) rankedPosition += 1;
      const view = playerView(p, rankedPosition);
      body.appendChild(leaderboardRow(view));
      cards.insertAdjacentHTML('beforeend', playerCardHtml(view, expanded.has(p.Name)));
    });
    loading.style.display = 'none';
    views.hidden = false;
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
