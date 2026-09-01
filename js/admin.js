// Admin Mode is remembered per browser for convenience, while Apps Script
// validates the passcode again for every write. Hiding controls is UX;
// server-side validation is the actual protection.

const ADMIN_PASSCODE_STORAGE_KEY = 'pickleballAdminPasscode';
const ADMIN_MODE_EVENT = 'adminmodechange';

function isAdminUnlocked() {
  return Boolean(localStorage.getItem(ADMIN_PASSCODE_STORAGE_KEY));
}

function ensurePasscodeModal() {
  let overlay = document.getElementById('passcode-modal-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'passcode-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="passcode-modal-title">
      <div class="modal-kicker">League management</div>
      <h2 id="passcode-modal-title">Unlock Admin Mode</h2>
      <p class="field-help">Enter the league passcode once. This browser will stay unlocked until you lock it again.</p>
      <label for="passcode-modal-input">Admin passcode</label>
      <input type="password" id="passcode-modal-input" autocomplete="current-password" />
      <div id="passcode-modal-status" class="status" style="display:none"></div>
      <div class="modal-actions">
        <button type="button" class="btn" id="passcode-modal-ok">Unlock</button>
        <button type="button" class="btn secondary" id="passcode-modal-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function promptForPasscode() {
  return new Promise((resolve) => {
    const overlay = ensurePasscodeModal();
    const input = overlay.querySelector('#passcode-modal-input');
    const okBtn = overlay.querySelector('#passcode-modal-ok');
    const cancelBtn = overlay.querySelector('#passcode-modal-cancel');
    const statusEl = overlay.querySelector('#passcode-modal-status');

    input.value = '';
    statusEl.style.display = 'none';
    overlay.style.display = 'flex';
    input.focus();

    function cleanup(result) {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    }
    function onOk() {
      const value = input.value.trim();
      if (!value) {
        statusEl.className = 'status error';
        statusEl.textContent = 'Enter the admin passcode.';
        statusEl.style.display = 'block';
        return;
      }
      cleanup(value);
    }
    function onCancel() { cleanup(''); }
    function onKeydown(e) {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeydown);
  });
}

async function verifyAdminPasscode(passcode) {
  await apiPost('verifyAdmin', { passcode });
  return passcode;
}

function applyAdminMode() {
  const unlocked = isAdminUnlocked();
  document.body.classList.toggle('admin-unlocked', unlocked);

  const toggle = document.getElementById('admin-mode-toggle');
  if (toggle) {
    toggle.classList.toggle('unlocked', unlocked);
    toggle.title = unlocked ? 'Lock Admin Mode' : 'Unlock Admin Mode';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.innerHTML = unlocked
      ? '<span class="admin-lock-icon">🔓</span><span class="admin-lock-label">Admin</span>'
      : '<span class="admin-lock-icon">🔒</span><span class="admin-lock-label">Admin</span>';
  }

  window.dispatchEvent(new CustomEvent(ADMIN_MODE_EVENT, { detail: { unlocked } }));
}

async function unlockAdminMode() {
  const passcode = await promptForPasscode();
  if (!passcode) return '';
  try {
    await verifyAdminPasscode(passcode);
    localStorage.setItem(ADMIN_PASSCODE_STORAGE_KEY, passcode);
    applyAdminMode();
    return passcode;
  } catch (err) {
    clearStoredPasscode();
    window.alert('Could not unlock Admin Mode: ' + err.message);
    return '';
  }
}

async function getOrPromptPasscode() {
  const stored = localStorage.getItem(ADMIN_PASSCODE_STORAGE_KEY);
  if (stored) return stored;
  return unlockAdminMode();
}

function clearStoredPasscode() {
  localStorage.removeItem(ADMIN_PASSCODE_STORAGE_KEY);
  applyAdminMode();
}

function buildAdminChrome() {
  document.querySelectorAll('nav.tab-bar a[href="log-game.html"]').forEach((link) => link.classList.add('admin-nav-item'));

  const header = document.querySelector('header.top-bar');
  if (!header || document.getElementById('admin-mode-toggle')) return;

  const existingSettings = document.getElementById('settings-btn');
  const actions = document.createElement('div');
  actions.className = 'header-actions';
  if (existingSettings) {
    existingSettings.classList.add('admin-settings-link');
    actions.appendChild(existingSettings);
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'admin-mode-toggle';
  toggle.className = 'admin-mode-toggle';
  toggle.addEventListener('click', async () => {
    if (isAdminUnlocked()) clearStoredPasscode();
    else await unlockAdminMode();
  });
  actions.appendChild(toggle);
  header.appendChild(actions);
  applyAdminMode();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildAdminChrome);
else buildAdminChrome();
