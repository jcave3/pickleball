function fmtDelta(d) {
  const n = Number(d);
  const cls = n >= 0 ? 'delta-pos' : 'delta-neg';
  return `<span class="${cls}">${n >= 0 ? '+' : ''}${n}</span>`;
}

// Must match STARTING_ELO in apps-script/Code.gs — everyone's rating history
// starts here, and recomputeAllStats() replays every game forward from it.
const CLIENT_STARTING_ELO = 1000;

// Turns a player's game log (most-recent-first, as getPlayerStats returns it)
// into a chronological (oldest-first) series of {date, elo, gameId} points by
// replaying EloDelta forward from CLIENT_STARTING_ELO — no backend change
// needed, since every game already carries its own delta.
function computeEloHistory(gamesMostRecentFirst) {
  const chronological = [...gamesMostRecentFirst].reverse();
  let running = CLIENT_STARTING_ELO;
  return chronological.map((g) => {
    running += Number(g.EloDelta);
    return { date: new Date(g.Date), elo: running, gameId: g.GameId };
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
  return el;
}

// Fixed logical coordinate space — the <svg> scales this proportionally via
// CSS (width: 100%; height: auto), so these numbers never need to know the
// actual rendered pixel size.
const CHART_W = 600;
const CHART_H = 220;
const PLOT_LEFT = 40;
const PLOT_RIGHT = CHART_W - 54; // room for the end-of-line value label
const PLOT_TOP = 14;
const PLOT_BOTTOM = CHART_H - 28; // room for date labels
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

function drawEloChart(points) {
  const svg = document.getElementById('elo-chart');
  const emptyEl = document.getElementById('elo-chart-empty');
  const card = document.getElementById('elo-chart-card');

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // A single point (or none) can't show a trend — an honest empty state
  // beats a flat or missing line pretending to be one.
  if (points.length < 2) {
    card.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  card.style.display = 'block';

  const n = points.length;
  const values = points.map((p) => p.elo);
  let yMin = Math.min(...values);
  let yMax = Math.max(...values);
  const pad = Math.max(15, (yMax - yMin) * 0.15) || 20;
  yMin -= pad;
  yMax += pad;

  const xAt = (i) => PLOT_LEFT + (i / (n - 1)) * PLOT_WIDTH;
  const yAt = (v) => PLOT_BOTTOM - ((v - yMin) / (yMax - yMin)) * PLOT_HEIGHT;

  // Gridlines + rounded Elo tick labels — hairline, one step off the
  // surface, drawn first so every mark layers on top of them.
  [0, 0.5, 1].forEach((f) => {
    const val = yMin + f * (yMax - yMin);
    const y = yAt(val);
    svg.appendChild(svgEl('line', { x1: PLOT_LEFT, x2: PLOT_RIGHT, y1: y, y2: y, stroke: 'var(--border)', 'stroke-width': 1 }));
    const label = svgEl('text', { x: PLOT_LEFT - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-muted)' });
    label.textContent = String(Math.round(val));
    svg.appendChild(label);
  });

  // Date labels — only the endpoints, never one per point.
  const dateLabel = (i, anchor) => {
    const t = svgEl('text', { x: xAt(i), y: PLOT_BOTTOM + 18, 'text-anchor': anchor, 'font-size': 10, fill: 'var(--text-muted)' });
    t.textContent = points[i].date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return t;
  };
  svg.appendChild(dateLabel(0, 'start'));
  svg.appendChild(dateLabel(n - 1, 'end'));

  // Line + a ~10% wash fill beneath it — never a saturated block.
  let linePath = '';
  points.forEach((p, i) => {
    linePath += (i === 0 ? 'M' : 'L') + xAt(i) + ',' + yAt(p.elo) + ' ';
  });
  linePath = linePath.trim();
  const areaPath = `${linePath} L ${xAt(n - 1)},${PLOT_BOTTOM} L ${xAt(0)},${PLOT_BOTTOM} Z`;

  svg.appendChild(svgEl('path', { d: areaPath, fill: 'var(--accent)', 'fill-opacity': 0.1, stroke: 'none' }));
  svg.appendChild(svgEl('path', { d: linePath, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // End marker + direct label — the one point worth labeling on a line
  // chart is the end, per the mark spec; every other value lives in the
  // hover tooltip or the games table below.
  const lastX = xAt(n - 1);
  const lastY = yAt(points[n - 1].elo);
  svg.appendChild(svgEl('circle', { cx: lastX, cy: lastY, r: 5, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  const endLabel = svgEl('text', { x: lastX + 10, y: lastY + 4, 'font-size': 13, 'font-weight': 700, fill: 'var(--text)' });
  endLabel.textContent = String(Math.round(points[n - 1].elo));
  svg.appendChild(endLabel);

  // Hover layer: a crosshair that snaps to the nearest point, plus a
  // tooltip. The transparent overlay rect is the hit target (wider than
  // the thin line itself) that drives it.
  const crosshair = svgEl('line', { class: 'crosshair', x1: 0, x2: 0, y1: PLOT_TOP, y2: PLOT_BOTTOM, stroke: 'var(--border)', 'stroke-width': 1 });
  const hoverDot = svgEl('circle', { class: 'hover-dot', r: 6, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 });
  svg.appendChild(crosshair);
  svg.appendChild(hoverDot);

  const overlay = svgEl('rect', { x: 0, y: 0, width: CHART_W, height: CHART_H, fill: 'transparent' });
  svg.appendChild(overlay);

  wireEloHover(svg, overlay, crosshair, hoverDot, points, xAt, yAt, n);
}

function wireEloHover(svg, overlay, crosshair, hoverDot, points, xAt, yAt, n) {
  const tooltip = document.getElementById('elo-tooltip');
  const tooltipValue = document.getElementById('elo-tooltip-value');
  const tooltipDate = document.getElementById('elo-tooltip-date');

  function move(e) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const xView = (e.clientX - rect.left) * (CHART_W / rect.width);
    let idx = Math.round(((xView - PLOT_LEFT) / PLOT_WIDTH) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));

    const px = xAt(idx);
    const py = yAt(points[idx].elo);

    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.style.opacity = '1';

    hoverDot.setAttribute('cx', px);
    hoverDot.setAttribute('cy', py);
    hoverDot.style.opacity = '1';

    const pxToPixels = rect.width / CHART_W;
    const pyToPixels = rect.height / CHART_H;
    tooltip.style.left = `${px * pxToPixels}px`;
    tooltip.style.top = `${py * pyToPixels}px`;
    // Labels are untrusted-ish data (dates/numbers here, but keep the habit
    // consistent) — textContent, never innerHTML.
    tooltipValue.textContent = String(Math.round(points[idx].elo));
    tooltipDate.textContent = points[idx].date.toLocaleDateString();
    tooltip.style.display = 'block';
  }

  function leave() {
    crosshair.style.opacity = '0';
    hoverDot.style.opacity = '0';
    tooltip.style.display = 'none';
  }

  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerleave', leave);
}

async function loadPlayerStats() {
  const loading = document.getElementById('loading');
  const content = document.getElementById('content');

  const params = new URLSearchParams(window.location.search);
  const name = params.get('name');
  if (!name) {
    loading.className = 'status error';
    loading.textContent = 'No player specified.';
    return;
  }

  document.getElementById('player-title').textContent = name;

  function render(stats) {
    const p = stats.player;
    const winPct = Math.round((p.WinPct || 0) * 100);

    document.getElementById('stat-rank').textContent = p.IsProvisional ? 'P' : (p.Rank ? `#${p.Rank}` : '–');
    document.getElementById('stat-elo').textContent = Math.round(p.Elo);
    document.getElementById('stat-record').textContent = `${p.Wins}-${p.Losses}`;
    document.getElementById('stat-winpct').textContent = `${winPct}%`;
    document.getElementById('stat-confidence').textContent = `${p.Confidence || 0}%`;
    document.getElementById('stat-singles').textContent = `${p.SinglesWins || 0}-${p.SinglesLosses || 0}`;
    document.getElementById('stat-doubles').textContent = `${p.DoublesWins || 0}-${p.DoublesLosses || 0}`;

    const eloHistory = (stats.ratingHistory || []).map((pt) => ({
      date: new Date(pt.Date), elo: Number(pt.Elo), gameId: pt.GameId,
    }));
    drawEloChart(eloHistory);
    const eloAfterByGameId = {};
    eloHistory.forEach((pt) => { eloAfterByGameId[pt.gameId] = pt.elo; });

    const h2hBody = document.getElementById('h2h-body');
    const h2hTable = document.getElementById('h2h-table');
    const h2hEmpty = document.getElementById('h2h-empty');
    h2hBody.innerHTML = '';
    stats.headToHead.forEach((h) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><a class="player-link" href="player.html?name=${encodeURIComponent(h.Opponent)}">${h.Opponent}</a></td>
        <td>${h.Wins}</td>
        <td>${h.Losses}</td>
      `;
      h2hBody.appendChild(tr);
    });
    h2hTable.style.display = stats.headToHead.length ? 'table' : 'none';
    h2hEmpty.style.display = stats.headToHead.length ? 'none' : 'block';

    const gamesBody = document.getElementById('games-body');
    const gamesTable = document.getElementById('games-table');
    const gamesEmpty = document.getElementById('games-empty');
    gamesBody.innerHTML = '';
    stats.games.forEach((g) => {
      const tr = document.createElement('tr');
      const date = new Date(g.Date);
      const opponents = g.Opponents.join(' / ');
      const eloAfter = eloAfterByGameId[g.GameId];
      tr.innerHTML = `
        <td>${date.toLocaleDateString()}</td>
        <td>${opponents}${g.Won ? ' 🏆' : ''}</td>
        <td>${g.MyScore}–${g.OppScore}</td>
        <td>${fmtDelta(g.EloDelta)}</td>
        <td>${eloAfter === undefined ? '–' : Math.round(eloAfter)}</td>
      `;
      gamesBody.appendChild(tr);
    });
    gamesTable.style.display = stats.games.length ? 'table' : 'none';
    gamesEmpty.style.display = stats.games.length ? 'none' : 'block';

    loading.style.display = 'none';
    content.style.display = 'block';
  }

  let renderedFromCache = false;
  try {
    await apiGetCached('getPlayerStats', { name }, (stats, isCache) => {
      renderedFromCache = renderedFromCache || isCache;
      render(stats);
    });
  } catch (err) {
    if (!renderedFromCache) {
      loading.className = 'status error';
      loading.textContent = 'Error loading player stats: ' + err.message;
    }
  }
}

loadPlayerStats();
