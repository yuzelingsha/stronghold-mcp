/**
 * Materialize a fetched tree on disk, and load it as a Node module graph.
 *
 * Why disk: a browser resolves `import './Battle.js'` over HTTP, but Node's loader needs real files.
 * The fetched modules already use paths relative to their own location (`../../../data.js` from
 * `/sim/content/support/index.js` means `/data.js`), so writing them out with the same relative
 * layout is all it takes for Node's own resolver to do the rest.
 *
 * The cache is keyed by a content fingerprint, so a matching fingerprint means the bytes on disk are
 * the bytes the server would serve and nothing needs downloading.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SIM_DATA_FILES } from './plugin.js';

/** Where materialized trees live when STRONGHOLD_SIM_CACHE is unset. */
export function defaultCacheRoot(env = process.env) {
  const configured = String(env.STRONGHOLD_SIM_CACHE || '').trim();
  if (configured) return configured;
  const home = homedir();
  return home ? join(home, '.cache', 'stronghold-mcp') : join(tmpdir(), 'stronghold-mcp');
}

/** A stable directory name for one server. */
export function cacheKeyFor(httpUrl) {
  let host = String(httpUrl);
  try { host = new URL(httpUrl).host; } catch { /* keep the raw string */ }
  const safe = host.replace(/[^A-Za-z0-9._-]/g, '_');
  const digest = createHash('sha256').update(String(httpUrl)).digest('hex').slice(0, 8);
  return `${safe}-${digest}`;
}

/**
 * URL path -> path inside a materialized tree.
 *
 * The mapping reproduces the **repository layout**, not the URL layout, and that is load-bearing.
 * The simulation's modules are written for `server/sim/` sitting two levels below the repository root:
 * `server/sim/simdata.js` imports `../../shared/loadoutRecord.js`, and
 * `server/sim/content/support/index.js` imports `../../../data.js`. Over HTTP those specifiers resolve
 * against `/sim/` and get clamped at the root, so `/shared/…` and `/data.js` come out right. On a
 * filesystem nothing clamps, so a flat `/sim/…` mirror would let `../../` escape one level too far.
 * Writing `/sim/x` to `server/sim/x` restores the depth the specifiers expect.
 */
const TREE_MAP = Object.freeze([
  ['/sim/', 'server/sim/'],
  ['/shared/', 'shared/'],
  // The server answers `/data.js` with a generated stand-in for `server/data.js`. In the module graph
  // that file is reached as `../../../data.js` from `server/sim/content/support/index.js`, which lands
  // on `server/data.js` — so that is where the stand-in belongs on disk.
  ['/data.js', 'server/data.js'],
]);

export function diskRelFor(urlPath) {
  const clean = String(urlPath).split('?')[0].split('#')[0];
  if (clean.includes('..') || clean.includes('\0')) {
    throw new Error(`refusing to materialize a path that escapes the root: ${urlPath}`);
  }
  for (const [prefix, target] of TREE_MAP) {
    if (clean === prefix) return target;
    if (prefix.endsWith('/') && clean.startsWith(prefix)) return target + clean.slice(prefix.length);
  }
  const rel = clean.replace(/^\/+/, '');
  if (!rel) throw new Error(`refusing to materialize an empty path: ${urlPath}`);
  return rel;
}

/** URL path -> path inside a materialized tree. `/sim/a.js` -> `<dir>/server/sim/a.js`. */
export function materialPathFor(dir, urlPath) {
  return join(dir, diskRelFor(urlPath));
}

/** The materialized locations the loader needs, in one place. */
export const LAYOUT = Object.freeze({
  spec: ['server', 'sim', 'spec.js'],
  constants: ['server', 'sim', 'constants.js'],
  simdata: ['server', 'sim', 'simdata.js'],
  support: ['server', 'sim', 'content', 'support', 'index.js'],
  bounds: ['shared', 'plugins', 'officialBounds.js'],
  shim: ['server', 'data.js'],
  dataDir: ['data'],
});

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Write one fetched tree into `<cacheRoot>/<cacheKey>/<fingerprint>/`. Returns the directory. */
export async function materialize({ cacheRoot, cacheKey, fingerprint, sources, data }) {
  const dir = join(cacheRoot, cacheKey, fingerprint);
  if (await cachedDir({ cacheRoot, cacheKey, fingerprint })) return dir;
  await mkdir(dirname(dir), { recursive: true });
  const staging = await mkdtemp(`${dir}.staging-`);
  try {
    const files = [];
    const write = async (urlPath, text) => {
      const target = materialPathFor(staging, urlPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, 'utf8');
      files.push({ path: diskRelFor(urlPath), bytes: Buffer.byteLength(text) });
    };
    for (const [urlPath, text] of Object.entries(sources)) await write(urlPath, text);
    for (const [name, value] of Object.entries(data ?? {})) await write(`/data/${name}.json`, JSON.stringify(value));
    await writeFile(join(staging, 'package.json'), '{"type":"module"}');
    await writeFile(join(staging, 'materialized.json'), JSON.stringify({
      cacheKey, fingerprint, modules: Object.keys(sources).length, data: Object.keys(data ?? {}).length,
      files, materializedAt: new Date().toISOString(),
    }));
    try {
      // Published versions are immutable. A concurrent writer may have won the rename.
      await rename(staging, dir);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (!await cachedDir({ cacheRoot, cacheKey, fingerprint })) {
        throw new Error(`simulation cache at ${dir} is incomplete; remove this entry before retrying`);
      }
    }
    return dir;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The directory for a fingerprint, when it is already materialized and complete. */
export async function cachedDir({ cacheRoot, cacheKey, fingerprint }) {
  const dir = join(cacheRoot, cacheKey, fingerprint);
  const marker = await readJson(join(dir, 'materialized.json'));
  if (!marker || marker.cacheKey !== cacheKey || marker.fingerprint !== fingerprint) return null;
  for (const part of [LAYOUT.spec, LAYOUT.constants, LAYOUT.simdata, LAYOUT.support, LAYOUT.shim]) {
    if (!await exists(join(dir, ...part))) return null;
  }
  for (const name of SIM_DATA_FILES) {
    if (!await exists(join(dir, ...LAYOUT.dataDir, `${name}.json`))) return null;
  }
  if (Array.isArray(marker.files)) {
    for (const file of marker.files) {
      if (typeof file.path !== 'string' || file.path.includes('..') || file.path.startsWith('/')) return null;
      try { if ((await stat(join(dir, file.path))).size !== file.bytes) return null; }
      catch { return null; }
    }
  }
  return dir;
}

/** Offline maintenance only: stop other processes using this cache before pruning versions. */
export async function pruneCache({ cacheRoot, cacheKey, keepFingerprint }) {
  const root = join(cacheRoot, cacheKey);
  let entries;
  try { entries = await readdir(root); } catch { return; }
  for (const entry of entries) {
    if (entry === keepFingerprint || !await readJson(join(root, entry, 'materialized.json'))) continue;
    await rm(join(root, entry), { recursive: true, force: true });
  }
}

/** Deep-freeze like the browser loader does, so a content bug fails the same way on both sides. */
function deepFreeze(root) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  return root;
}

/**
 * Run `fn` while collecting the simulation's own content-loading diagnostics.
 *
 * `server/sim/content/index.js` and `content/kits/index.js` load their modules with computed dynamic
 * imports (`import(path)`, ``import(`./ops/${file}`)``), which no static crawl can follow. A tree that
 * is missing them still *loads* — the simulation is built to survive a broken content module, replacing
 * it with an empty one — and would then simulate a plausible but wrong battle that the server accepts.
 *
 * So the crawl path must not be trusted on its own: this captures the simulation's own
 * `[content] failed to load …` lines, and the caller refuses to run rather than guess.
 */
async function withContentDiagnostics(fn) {
  const failures = [];
  const original = console.error;
  console.error = (...args) => {
    const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    const match = /^\[content\] failed to load (\S+)/.exec(text);
    if (match) failures.push(match[1]);
    original.apply(console, args);
  };
  try {
    return { value: await fn(), failures };
  } finally {
    console.error = original;
  }
}

/**
 * Import a materialized tree and prepare it exactly the way a browser page does.
 *
 * The order matters and mirrors public/js/battle/simLoader.js:
 *   1. `setSimData(raw)` — the simulation's data access layer takes the injected object and stops
 *      looking for a Node-side loader. (`simdata.js` tries `./nodeData.js` at module evaluation; the
 *      plugin never serves that file, the import fails, and the simulation catches it — by design.)
 *   2. `setGameData(null)` — the content support layer re-reads through the injected data.
 *   3. `rememberOfficialBounds(raw)` — the plugin caps table, so a modded battle is simulated with
 *      the same caps the server validates against.
 *
 * @param {string} dir
 * @returns {Promise<{ spec, constants, support, raw, dir, specPath, contentFailures: string[] }>}
 */
async function importMaterialized(dir) {
  const diagnostics = [];
  let raw = {};

  const loaded = await withContentDiagnostics(async () => {
    const simdata = await import(pathToFileURL(join(dir, ...LAYOUT.simdata)).href);

    for (const name of SIM_DATA_FILES) {
      const file = join(dir, ...LAYOUT.dataDir, `${name}.json`);
      let value;
      try { value = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { throw new Error(`materialized data is incomplete: ${file} (${error?.message ?? error})`); }
      raw[name] = deepFreeze(value);
    }
    // Inject before the content modules are evaluated, so their data lookups see the real records.
    simdata.setSimData(raw);

    const support = await import(pathToFileURL(join(dir, ...LAYOUT.support)).href);
    if (typeof support.setGameData === 'function') support.setGameData(null);

    try {
      const bounds = await import(pathToFileURL(join(dir, ...LAYOUT.bounds)).href);
      bounds.rememberOfficialBounds(raw);
    } catch { /* the caps table is optional: an older tree may not have it */ }

    const specPath = join(dir, ...LAYOUT.spec);
    const constantsPath = join(dir, ...LAYOUT.constants);
    const spec = await import(pathToFileURL(specPath).href);
    const constants = await import(pathToFileURL(constantsPath).href);

    for (const name of ['createBattleFromSpec', 'compactResult', 'battleProgress', 'attachLpMeter']) {
      if (typeof spec[name] !== 'function') throw new Error(`${specPath} does not export ${name}()`);
    }
    if (typeof constants.TICK !== 'number') throw new Error(`${constantsPath} does not export a numeric TICK`);

    return { spec, constants, support, specPath };
  });

  diagnostics.push(...loaded.failures);
  const { spec, constants, support, specPath } = loaded.value;

  return { spec, constants, support, raw, dir, specPath, contentFailures: diagnostics };
}

// Imports initialize module-level simulation data and temporarily collect console diagnostics.
// Serialize those initializations and share one result per immutable version directory.
const loadedTrees = new Map();
let importQueue = Promise.resolve();

/**
 * Share a loaded immutable tree. Incomplete-content diagnostics remain attached across calls.
 * @param {string} dir
 * @param {{ tolerateIncomplete?: boolean }} [options] Allow missing content for inspection only.
 */
export async function loadMaterialized(dir, options = {}) {
  const key = resolve(dir);
  let loading = loadedTrees.get(key);
  if (!loading) {
    loading = importQueue.then(() => importMaterialized(key));
    loadedTrees.set(key, loading);
    importQueue = loading.catch(() => {});
    loading.catch(() => { loadedTrees.delete(key); });
  }
  const loaded = await loading;
  const diagnostics = loaded.contentFailures;
  if (diagnostics.length && !options.tolerateIncomplete) {
    const sample = diagnostics.slice(0, 5).join(', ');
    throw new Error(
      `the simulation tree at ${dir} is incomplete: ${diagnostics.length} content module(s) failed to load (${sample}${diagnostics.length > 5 ? ', …' : ''}). `
      + 'These are loaded with computed dynamic imports that a crawl cannot follow, so the tree must come from the '
      + 'stronghold-agent plugin or from a game installation on disk (STRONGHOLD_SIM_ROOT). Refusing to simulate a battle with missing content.',
    );
  }

  return loaded;
}
