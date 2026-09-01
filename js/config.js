// Resolves the Apps Script Web App URL at runtime instead of hardcoding it:
// 1. A `?api=` query param (so a bookmarked link carries the URL with it)
// 2. Otherwise, whatever was saved in this browser's localStorage last time
// 3. Otherwise, null — the page below redirects to settings.html to set one

const API_STORAGE_KEY = 'pickleballApiUrl';

// Shown in the banner at the top of every page until the real league name
// (set via the Settings page, stored server-side as a Script Property so
// it's shared across everyone rather than per-browser) is fetched — and
// permanently, as a fallback, if nothing's been set there yet.
const DEFAULT_LEAGUE_NAME = 'Pickleball League';

function resolveApiUrl() {
  const params = new URLSearchParams(window.location.search);
  let url = params.get('api');

  if (url) {
    localStorage.setItem(API_STORAGE_KEY, url);
  } else {
    url = localStorage.getItem(API_STORAGE_KEY);
  }

  if (url) {
    params.set('api', url);
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? '?' + query : ''}${window.location.hash}`);
  }

  return url;
}

function resetApiUrl() {
  localStorage.removeItem(API_STORAGE_KEY);
  const params = new URLSearchParams(window.location.search);
  params.delete('api');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? '?' + query : ''}`);
  window.location.reload();
}

const APPS_SCRIPT_URL = resolveApiUrl();

// First-ever visit (or after clearing the data source): send the user to a
// guided setup page instead of blocking every page load with a native
// prompt(). returnTo carries them back to whatever they were trying to
// open once they've configured a URL there.
const IS_SETTINGS_PAGE = window.location.pathname.endsWith('settings.html');
if (!APPS_SCRIPT_URL && !IS_SETTINGS_PAGE) {
  const returnTo = window.location.pathname.split('/').pop() + window.location.search;
  window.location.href = `settings.html?returnTo=${encodeURIComponent(returnTo)}`;
}

// Lets the browser start DNS/TCP/TLS for the Apps Script host before the
// first fetch() fires, shaving that handshake off the perceived load time.
function addPreconnect(url) {
  try {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = new URL(url).origin;
    document.head.appendChild(link);
  } catch (err) {
    // Malformed/missing URL — nothing to preconnect to, not fatal.
  }
}

if (APPS_SCRIPT_URL) addPreconnect(APPS_SCRIPT_URL);

function wireSettingsButton() {
  const btn = document.getElementById('settings-btn');
  if (!btn) return;
  btn.title = 'Settings';
  btn.addEventListener('click', () => {
    window.location.href = 'settings.html';
  });
}

function renderLeagueBanner() {
  const banner = document.getElementById('league-banner');
  if (!banner) return;

  banner.textContent = DEFAULT_LEAGUE_NAME;
  if (!APPS_SCRIPT_URL) return; // not configured yet — nothing to fetch

  apiGetCached('getLeagueName', null, (data) => {
    if (data && data.name) banner.textContent = data.name;
  }).catch(() => {
    // Non-fatal — banner just stays on the hardcoded default.
  });
}

function initChrome() {
  wireSettingsButton();
  renderLeagueBanner();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initChrome);
} else {
  initChrome();
}

// Install the static app shell for home-screen use. League data itself keeps
// using the existing local cache in api.js, so a previously viewed page can
// still render useful read-only data when the connection is spotty.
if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
