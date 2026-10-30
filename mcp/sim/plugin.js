/**
 * The agent-side client for the game's `stronghold-agent` plugin.
 *
 * The plugin is a `trusted` server plugin that exposes, under `/x/stronghold-agent/`:
 *
 *   manifest   the file list, the game version and a content fingerprint   (small)
 *   bundle     every module's source text and every data file, in one body (~10 MB)
 *   file       one module by URL path                                      (fallback)
 *   data       one data file by name                                       (fallback)
 *
 * None of it is privileged and none of it changes the game: the plugin reads the same files the
 * server already serves to browsers, and hands them over in a form a Node process can use.
 *
 * Every route is unauthenticated by the plugin itself, so a site behind a login needs the same
 * session cookie here that the player connection uses.
 */

export const PLUGIN_ID = 'stronghold-agent';
export const ROUTE_PREFIX = `/x/${PLUGIN_ID}`;

/** The data files a browser simulation loads (public/js/battle/simLoader.js SIM_DATA_FILES). */
export const SIM_DATA_FILES = Object.freeze([
  'chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups',
]);

function headersFor(cookie) {
  return cookie ? { Cookie: cookie } : undefined;
}

async function getJson(url, { cookie = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const res = await fetchImpl(url, { headers: headersFor(cookie), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} for ${url}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/** Is the plugin installed and loaded on this server? Never throws. */
export async function probePlugin({ origin, cookie = null, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const body = await getJson(new URL(`${ROUTE_PREFIX}/manifest`, origin), { cookie, fetchImpl, timeoutMs });
    if (!body?.ok) return { available: false, reason: body?.error ?? 'the plugin answered with an error' };
    return { available: true, manifest: body };
  } catch (error) {
    const status = error?.status;
    if (status === 404) return { available: false, reason: `no ${ROUTE_PREFIX}/manifest route: the plugin is not installed (or not enabled)` };
    return { available: false, reason: String(error?.message ?? error) };
  }
}

/** The file list and content fingerprint. */
export async function fetchManifest({ origin, cookie = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const body = await getJson(new URL(`${ROUTE_PREFIX}/manifest`, origin), { cookie, fetchImpl, timeoutMs });
  if (!body?.ok) throw new Error(`stronghold-agent plugin manifest failed: ${body?.error ?? 'unknown error'}`);
  return body;
}

/**
 * Everything in one response.
 *
 * The body is around 10 MB and the plugin answers within a 5 s request budget, so this is one request
 * rather than the several hundred a crawl would need. A server whose tree grew past the plugin's own
 * bundle cap answers `ok: false`; callers then fall back to per-file fetches.
 */
export async function fetchBundle({ origin, cookie = null, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const body = await getJson(new URL(`${ROUTE_PREFIX}/bundle`, origin), { cookie, fetchImpl, timeoutMs });
  if (!body?.ok) {
    const error = new Error(`stronghold-agent plugin bundle refused: ${body?.error ?? 'unknown error'}`);
    error.refused = true;
    throw error;
  }
  return body;
}

/** One module by URL path (the fallback when a bundle is refused). */
export async function fetchFile({ origin, path: urlPath, cookie = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = new URL(`${ROUTE_PREFIX}/file`, origin);
  url.searchParams.set('path', urlPath);
  const body = await getJson(url, { cookie, fetchImpl, timeoutMs });
  if (!body?.ok) throw new Error(`stronghold-agent plugin file ${urlPath} failed: ${body?.error ?? 'unknown error'}`);
  return body.source;
}

/** One data file by name (the fallback when a bundle is refused). */
export async function fetchData({ origin, name, cookie = null, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = new URL(`${ROUTE_PREFIX}/data`, origin);
  url.searchParams.set('name', name);
  const body = await getJson(url, { cookie, fetchImpl, timeoutMs });
  if (!body?.ok) throw new Error(`stronghold-agent plugin data ${name} failed: ${body?.error ?? 'unknown error'}`);
  return body.value;
}
