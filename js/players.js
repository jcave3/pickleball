function renderRow(p, archived) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><a class="player-link" href="player.html?name=${encodeURIComponent(p.Name)}">${p.Name}</a></td>
    <td>${Math.round(p.Elo)}</td>
    <td class="admin-only"></td>
  `;
  const btn = document.createElement('button');
  btn.className = 'small';
  btn.textContent = archived ? 'Unarchive' : 'Archive';
  btn.addEventListener('click', () => setArchived(p.PlayerId, p.Name, !archived, btn));
  tr.lastElementChild.appendChild(btn);
  return tr;
}

async function loadPlayersList() {
  const loading = document.getElementById('loading');
  const rosterContent = document.getElementById('roster-content');

  const activeBody = document.getElementById('active-body');
  const activeTable = document.getElementById('active-table');
  const activeEmpty = document.getElementById('active-empty');
  const archivedBody = document.getElementById('archived-body');
  const archivedTable = document.getElementById('archived-table');
  const archivedEmpty = document.getElementById('archived-empty');

  try {
    const players = await apiGet('getPlayers');
    const active = players.filter((p) => p.Archived !== true).sort((a, b) => a.Name.localeCompare(b.Name));
    const archived = players.filter((p) => p.Archived === true).sort((a, b) => a.Name.localeCompare(b.Name));

    activeBody.innerHTML = '';
    active.forEach((p) => activeBody.appendChild(renderRow(p, false)));
    activeTable.style.display = active.length ? 'table' : 'none';
    activeEmpty.style.display = active.length ? 'none' : 'block';

    archivedBody.innerHTML = '';
    archived.forEach((p) => archivedBody.appendChild(renderRow(p, true)));
    archivedTable.style.display = archived.length ? 'table' : 'none';
    archivedEmpty.style.display = archived.length ? 'none' : 'block';

    loading.style.display = 'none';
    rosterContent.style.display = 'block';
  } catch (err) {
    loading.className = 'status error';
    loading.textContent = 'Error loading players: ' + err.message;
  }
}

async function setArchived(playerId, name, archived, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = archived ? 'Archiving…' : 'Unarchiving…';

  const statusEl = document.getElementById('status');
  try {
    const passcode = await getOrPromptPasscode();
    if (!passcode) {
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }
    await apiPost(archived ? 'archivePlayer' : 'unarchivePlayer', { passcode, playerId });
    invalidateAllCache();
    statusEl.className = 'status success';
    statusEl.textContent = `${name} ${archived ? 'archived' : 'unarchived'}.`;
    await loadPlayersList();
  } catch (err) {
    if (/passcode/i.test(err.message)) clearStoredPasscode();
    btn.disabled = false;
    btn.textContent = originalText;
    statusEl.className = 'status error';
    statusEl.textContent = `Error ${archived ? 'archiving' : 'unarchiving'} ${name}: ` + err.message;
  }
}

document.getElementById('add-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('status');
  const name = document.getElementById('name').value.trim().replace(/\s+/g, ' ');

  if (name.split(' ').length < 2) {
    statusEl.className = 'status error';
    statusEl.textContent = 'Enter both a first and last name.';
    return;
  }

  statusEl.className = 'status';
  statusEl.textContent = 'Saving…';

  try {
    const passcode = await getOrPromptPasscode();
    if (!passcode) {
      statusEl.className = '';
      statusEl.textContent = '';
      return;
    }
    await apiPost('addPlayer', { passcode, name });
    invalidateAllCache();
    statusEl.className = 'status success';
    statusEl.textContent = `Added ${name}.`;
    document.getElementById('name').value = '';
    await loadPlayersList();
  } catch (err) {
    if (/passcode/i.test(err.message)) clearStoredPasscode();
    statusEl.className = 'status error';
    statusEl.textContent = 'Error: ' + err.message;
  }
});

loadPlayersList();
