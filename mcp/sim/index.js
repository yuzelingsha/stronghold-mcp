/**
 * Prepare the game's battle simulation for local use, from a running server.
 *
 * Two sources, tried in order:
 *
 *   1. the `stronghold-agent` plugin's endpoint   one ~10 MB request, an exact file list, a content
 *                                                fingerprint. Preferred.
 *   2. a crawl of `/sim/` + `/shared/`           several hundred requests, works on a stock server
 *                                                with no plugin installed.
 *
 * Either way the result is a materialized tree on disk plus the loaded modules, so the caller can run
 * a battle with exactly the code the server would have handed a browser.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { crawlModules } from './crawl.js';
import { fetchBundle, fetchData, fetchFile, fetchManifest, probePlugin, SIM_DATA_FILES } from './plugin.js';
import {
  cacheKeyFor, cachedDir, defaultCacheRoot, loadMaterialized, materialize,
} from './store.js';

export { SIM_DATA_FILES } from './plugin.js';
export { defaultCacheRoot, loadMaterialized } from './store.js';

/** A fingerprint of a crawled tree, used when the plugin is absent. */
export function fingerprintOf(sources, data) {
  const hash = createHash('sha256');
  for (const urlPath of Object.keys(sources).sort()) {
    const text = sources[urlPath];
    hash.update(`${urlPath}\u0000${Buffer.byteLength(text)}\n`).update(text);
  }
  for (const name of Object.keys(data).sort()) {
    const text = JSON.stringify(data[name]);
    hash.update(`data/${name}\u0000${Buffer.byteLength(text)}\n`).update(text);
  }
  return hash.digest('hex');
}

/**
 * The modules a browser page loads by name (public/js/battle/simLoader.js), not merely by following
 * `import` statements. `content/support/index.js` in particular is reached this way and appears in no
 * static graph, so a crawl that started only from `spec.js` would silently leave it out.
 */
const CRAWL_ENTRIES = Object.freeze([
  '/sim/spec.js',
  '/sim/simdata.js',
  '/sim/content/support/index.js',
]);

/** Fetch the shim the simulation's content modules import as `../../../data.js`. */
async function fetchDataShim({ origin, cookie, fetchImpl, timeoutMs }) {
  const res = await fetchImpl(new URL('/data.js', origin), {
    headers: cookie ? { Cookie: cookie } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`could not read /data.js (HTTP ${res.status})`);
  return res.text();
}

/** The plugin path: manifest, then bundle (or per-file when the bundle is refused). */
async function fromPlugin({ origin, cookie, fetchImpl, timeoutMs, onProgress, manifest: probedManifest }) {
  const manifest = probedManifest ?? await fetchManifest({ origin, cookie, fetchImpl, timeoutMs });
  onProgress?.(`plugin manifest: ${manifest.files.length} modules, fingerprint ${String(manifest.fingerprint).slice(0, 12)}`);

  const sources = {};
  const data = {};

  let bundle = null;
  try {
    bundle = await fetchBundle({ origin, cookie, fetchImpl, timeoutMs: Math.max(timeoutMs, 120_000) });
  } catch (error) {
    if (!error?.refused) throw error;
    onProgress?.(`plugin refused the bundle (${error.message}); fetching file by file`);
  }

  if (bundle) {
    Object.assign(sources, bundle.sources);
    Object.assign(data, bundle.data);
  } else {
    for (const file of manifest.files) {
      sources[file.url] = await fetchFile({ origin, path: file.url, cookie, fetchImpl, timeoutMs });
    }
    sources['/data.js'] = await fetchDataShim({ origin, cookie, fetchImpl, timeoutMs });
    for (const entry of manifest.data) {
      data[entry.name] = await fetchData({ origin, name: entry.name, cookie, fetchImpl, timeoutMs });
    }
  }

  const missing = SIM_DATA_FILES.filter((name) => !data[name] || typeof data[name] !== 'object');
  if (missing.length) throw new Error(`the plugin did not provide every data file: ${missing.join(', ')}`);
  if (!sources['/sim/spec.js']) throw new Error('the plugin did not provide /sim/spec.js');
  if (!sources['/data.js']) throw new Error('the plugin did not provide the /data.js stand-in');

  const version = bundle?.fingerprint ?? (await fetchManifest({ origin, cookie, fetchImpl, timeoutMs })).fingerprint;
  if (version !== manifest.fingerprint) {
    const error = new Error('the simulation changed during download; retry to load one consistent version');
    error.code = 'SIM_VERSION_CHANGED';
    throw error;
  }

  return { sources, data, fingerprint: String(bundle?.fingerprint ?? manifest.fingerprint), via: 'plugin', manifest };
}

/** The no-plugin path: crawl the same URLs a browser loads. */
async function fromCrawl({ origin, cookie, fetchImpl, timeoutMs, onProgress }) {
  const { sources: crawled, missing } = await crawlModules({
    origin, cookie, fetchImpl, timeoutMs, entries: CRAWL_ENTRIES,
    onProgress: (count) => onProgress?.(`crawling /sim/: ${count} modules`),
  });
  if (missing.length) {
    onProgress?.(`${missing.length} module(s) not served, e.g. ${missing[0].urlPath} (${missing[0].message})`);
  }
  // `crawlModules` hands back a Map; everything downstream works with a plain object keyed by URL path.
  const sources = Object.fromEntries(crawled);
  sources['/data.js'] = await fetchDataShim({ origin, cookie, fetchImpl, timeoutMs });

  const data = {};
  const absent = [];
  for (const name of SIM_DATA_FILES) {
    const res = await fetchImpl(new URL(`/data/${name}.json`, origin), {
      headers: cookie ? { Cookie: cookie } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { absent.push(`${name} (HTTP ${res.status})`); continue; }
    data[name] = await res.json();
  }
  if (absent.length) throw new Error(`the server did not serve every simulation data file: ${absent.join(', ')}`);

  return { sources, data, fingerprint: fingerprintOf(sources, data), via: 'crawl', manifest: null };
}

/**
 * Fetch (or reuse) the simulation for one server and load it.
 *
 * @param {object} options
 * @param {string} options.origin       the game server's HTTP origin
 * @param {string|null} [options.cookie] session cookie, when the site is behind a login
 * @param {'auto'|'plugin'|'crawl'} [options.source]  force one source instead of trying in order
 * @param {boolean} [options.force]     ignore the cache
 * @param {Function} [options.onProgress]
 * @returns {Promise<{ spec, constants, support, raw, dir, via, fingerprint, reused, origin }>}
 */
async function prepareSimOnce({
  origin,
  cookie = null,
  source = 'auto',
  cacheRoot = defaultCacheRoot(),
  force = false,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  onProgress = null,
} = {}) {
  if (!origin) throw new Error('prepareSim needs the game server origin (STRONGHOLD_HTTP_URL)');
  const cacheKey = cacheKeyFor(origin);

  // The plugin is the preferred source; `probe` is one cheap request and tells us whether to use it.
  let usePlugin = source === 'plugin';
  let probe = null;
  if (source === 'auto' || source === 'plugin') {
    probe = await probePlugin({ origin, cookie, fetchImpl, timeoutMs });
    if (source === 'auto') usePlugin = probe.available;
    onProgress?.(probe.available
      ? `stronghold-agent plugin found (fingerprint ${String(probe.manifest.fingerprint).slice(0, 12)})`
      : `no stronghold-agent plugin (${probe.reason}); falling back to crawling /sim/`);
  }

  let dir = (force || !probe?.manifest?.fingerprint) ? null : await cachedDir({ cacheRoot, cacheKey, fingerprint: probe.manifest.fingerprint });
  let reused = !!dir;

  let fetched;
  if (reused) {
    fetched = {
      fingerprint: probe.manifest.fingerprint,
      via: 'plugin',
      manifest: probe.manifest,
    };
  } else if (usePlugin) {
    try {
      fetched = await fromPlugin({ origin, cookie, fetchImpl, timeoutMs, onProgress, manifest: probe?.manifest });
    } catch (error) {
      if (source === 'plugin' || error.code === 'SIM_VERSION_CHANGED') throw error;
      onProgress?.(`the plugin path failed (${error?.message ?? error}); falling back to crawling /sim/`);
      fetched = await fromCrawl({ origin, cookie, fetchImpl, timeoutMs, onProgress });
    }
  } else {
    fetched = await fromCrawl({ origin, cookie, fetchImpl, timeoutMs, onProgress });
  }

  if (!dir) {
    dir = await materialize({ cacheRoot, cacheKey, fingerprint: fetched.fingerprint, sources: fetched.sources, data: fetched.data });
    // Older versions may still be running (or importing modules) in another process.
    // Pruning is explicit offline maintenance, never part of publishing a new version.
  }

  onProgress?.(reused ? `simulation cache hit (${fetched.fingerprint.slice(0, 12)})` : `materialized ${Object.keys(fetched.sources).length} modules`);

  const loaded = await loadMaterialized(dir);
  return {
    ...loaded,
    dir,
    via: fetched.via,
    fingerprint: fetched.fingerprint,
    reused,
    origin,
    manifest: fetched.manifest,
  };
}

// Coalesce concurrent work only. Each later call still checks the server's manifest.
// Keep auth scopes separate without storing the cookie in a cache key.
const preparations = new WeakMap();

export function prepareSim(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let pending = preparations.get(fetchImpl);
  if (!pending) preparations.set(fetchImpl, pending = new Map());
  const key = JSON.stringify([
    options.origin, resolve(options.cacheRoot ?? defaultCacheRoot()), options.source ?? 'auto',
    options.force ?? false, options.timeoutMs ?? 20_000,
    createHash('sha256').update(options.cookie ?? '').digest('hex'),
  ]);
  let entry = pending.get(key);
  if (entry) {
    if (options.onProgress) entry.listeners.add(options.onProgress);
    return entry.promise;
  }
  entry = { listeners: new Set(options.onProgress ? [options.onProgress] : []) };
  entry.promise = Promise.resolve().then(() => prepareSimOnce({
    ...options, fetchImpl,
    onProgress: (message) => { for (const listener of entry.listeners) listener(message); },
  })).finally(() => { pending.delete(key); });
  pending.set(key, entry);
  return entry.promise;
}
