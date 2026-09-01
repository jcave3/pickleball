// Shared fetch wrapper for the Apps Script backend.
// Deliberately avoids custom headers / JSON content-type on POST — Apps Script
// Web Apps can't answer a CORS preflight, so any custom header or
// application/json content-type would get the request blocked by the browser.

function requireApiUrl() {
  if (!APPS_SCRIPT_URL) {
    throw new Error('No data source configured — click the ⚙ icon to set one.');
  }
}

// Shared by apiGet/apiPost: turns the two ways a request can go wrong in a
// way that isn't the backend's own { error } payload — a network failure,
// or a response that isn't JSON at all (wrong URL, deployment not public,
// Google's own HTML error page) — into a message a non-developer can act
// on, instead of a raw "Failed to fetch" or JSON syntax error.
async function fetchApiResponse(url, options) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', ...options });
  } catch (err) {
    throw new Error('Could not reach the data source. Check your internet connection, or click the ⚙ icon to verify the API URL.');
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('Unexpected response from the data source — click the ⚙ icon to check the API URL, and confirm the Apps Script deployment\'s access is set to "Anyone".');
  }

  if (data && data.error) throw new Error(data.error);
  return data;
}

async function apiGet(action, params) {
  requireApiUrl();
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set('action', action);
  if (params) {
    Object.keys(params).forEach((k) => url.searchParams.set(k, params[k]));
  }
  // Every GET to a given action hits the exact same URL, which browsers
  // (and Google's own front end) can cache — so a write can succeed but a
  // later read on refresh silently serves a stale cached response instead
  // of re-running the script. `cache: 'no-store'` above only covers the
  // local HTTP cache; this cache-busting param defeats caching wherever it
  // might happen, since the URL itself is now unique per request.
  url.searchParams.set('_', Date.now());
  return fetchApiResponse(url.toString());
}

async function apiPost(action, payload) {
  requireApiUrl();
  return fetchApiResponse(APPS_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ action, ...payload }),
  });
}

// Stale-while-revalidate cache for GET actions, so a page that's been
// visited before can render instantly from the last response while a fresh
// one loads in the background — instead of showing a spinner every single
// time. Deliberately dumb: no TTL, no per-action invalidation rules to
// maintain. Every apiGetCached call overwrites its own cache entry with
// whatever the network returns, so it self-corrects within one round trip
// regardless of what changed it. The only other moving part is
// invalidateAllCache() (below), which any write action should call once it
// succeeds — that's the one convention future code needs to follow.

const CACHE_PREFIX = 'pickleballCache:';

function cacheKey(action, params) {
  return CACHE_PREFIX + action + ':' + JSON.stringify(params || {});
}

function readCache(action, params) {
  try {
    const raw = localStorage.getItem(cacheKey(action, params));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeCache(action, params, data) {
  try {
    localStorage.setItem(cacheKey(action, params), JSON.stringify(data));
  } catch (err) {
    // Storage full/unavailable (e.g. private browsing) — caching is a
    // nice-to-have, so just skip it rather than fail the request.
  }
}

// Clears every cached GET response. Call this after any write action
// (logGame, editGame, deleteGame, archivePlayer, addPlayer, ...) succeeds,
// so pages don't keep serving pre-change data as their "instant" paint.
function invalidateAllCache() {
  Object.keys(localStorage)
    .filter((k) => k.startsWith(CACHE_PREFIX))
    .forEach((k) => localStorage.removeItem(k));
}

// onData may be called once (cache miss: fresh data only) or twice (cache
// hit: cached data immediately, then fresh data once the network resolves).
// Callers should treat onData as idempotent re-render, not a one-shot.
async function apiGetCached(action, params, onData) {
  const cached = readCache(action, params);
  if (cached) onData(cached, true);

  const fresh = await apiGet(action, params);
  writeCache(action, params, fresh);
  onData(fresh, false);
  return fresh;
}
