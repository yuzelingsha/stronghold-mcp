// stronghold-agent · server entry
//
// Exposes, over HTTP, everything an AI agent needs to run the match's battles itself: the simulation's
// ES modules, the shared ESM they import, the game data files, and a fingerprint of all of it.
//
// It is read-only. It registers three routes under /x/stronghold-agent/, reads files from the game
// installation, and changes nothing about the game. No room, no match and no player is touched.
//
// Why an agent needs this: the protocol hands each client a battle spec (`b.start`) and expects the
// client to simulate it and report the result. A browser does that with the modules the server already
// serves at /sim/ — but those cannot be *enumerated* over HTTP (there is no directory listing), and a
// Node process cannot import from HTTP. This plugin supplies the missing piece: an exact list of the
// files, plus their bytes, in one response.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** The data files the browser simulation loads (public/js/battle/simLoader.js SIM_DATA_FILES). */
const DATA_FILES = Object.freeze([
  'chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups',
]);

/** Trees mirrored to the agent, as `[directory, url prefix]`. */
const TREES = Object.freeze([
  ['server/sim', '/sim'],
  ['shared', '/shared'],
]);

/** Files the server deliberately never serves (server/http/static.js SIM_PRIVATE). */
const NEVER_SERVED = new Set(['nodedata.js']);

/** A bundle larger than this is refused, so one response can never blow the 5 s request budget. */
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

/**
 * The game installation this plugin is running inside.
 *
 * `process.argv[1]` is the trusted entry the server forked (`server/plugins/trustedEntry.js`), so the
 * repository root is three levels up from it — that is reliable whatever the working directory is.
 * The fallbacks cover a future layout change.
 */
function resolveRoot() {
  const candidates = [];
  const entry = process.argv?.[1];
  if (typeof entry === 'string' && entry.endsWith('.js')) candidates.push(path.resolve(entry, '..', '..', '..'));
  candidates.push(process.cwd());
  let dir = process.cwd();
  for (let i = 0; i < 4 && dir !== path.dirname(dir); i++) { dir = path.dirname(dir); candidates.push(dir); }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'server', 'sim', 'spec.js')) && fs.existsSync(path.join(candidate, 'data', 'chess.json'))) return candidate;
    } catch { /* try the next candidate */ }
  }
  throw new Error('stronghold-agent: could not locate the game installation (no server/sim/spec.js found)');
}

const ROOT = resolveRoot();

/** Every `.js` under a tree, as repository-relative paths, sorted. */
function listTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile() && entry.name.endsWith('.js') && !NEVER_SERVED.has(entry.name.toLowerCase())) out.push(childRel);
    }
  };
  walk(path.join(ROOT, dir), dir);
  return out;
}

/** The whole servable set, as `{ rel, url, abs, bytes, mtimeMs }`. */
function inventory() {
  const files = [];
  for (const [dir, prefix] of TREES) {
    for (const rel of listTree(dir)) {
      const abs = path.join(ROOT, rel);
      try {
        const stat = fs.statSync(abs);
        files.push({ rel, url: `${prefix}${rel.slice(dir.length)}`, abs, bytes: stat.size, signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}` });
      } catch { /* vanished between the walk and the stat */ }
    }
  }
  return files;
}

/**
 * Hash actual file contents. Filesystem metadata only controls reuse of per-file hashes.
 */
function fingerprintOf(files, dataStats) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.rel}\u0000${file.digest}\n`);
  for (const entry of dataStats) hash.update(`data/${entry.name}.json\u0000${entry.digest}\n`);
  hash.update(dataShim());
  return hash.digest('hex');
}

function dataInventory() {
  const out = [];
  for (const name of DATA_FILES) {
    const abs = path.join(ROOT, 'data', `${name}.json`);
    try {
      const stat = fs.statSync(abs);
      out.push({ name, abs, bytes: stat.size, signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}` });
    } catch { /* a data file the installation does not have */ }
  }
  return out;
}

/** The `/data.js` stand-in the simulation's content modules import as `../../../data.js`. */
function dataShim() {
  return [
    '// Generated by the stronghold-agent plugin — the same stand-in the server serves at /data.js.',
    '// The simulation\u2019s content modules (/sim/content/support/index.js) import getData() from here; it',
    '// returns the game data injected with /sim/simdata.js setSimData(data).',
    "import { getSimData } from './sim/simdata.js';",
    'export function getData() { return getSimData() || {}; }',
    'export function resetData() {}',
    '',
  ].join('\n');
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** `?path=/sim/x.js` -> the file inside the game root, or null when it is not part of the servable set. */
function fileForUrlPath(files, urlPath) {
  return files.find((f) => f.url === urlPath) ?? null;
}

/** The route handler receives one frozen `{ method, path, url }`; the query lives on `url`. */
function queryOf(url) {
  try { return new URL(url, 'http://localhost').searchParams; } catch { return new URLSearchParams(); }
}

export async function activate(api) {
  let files = [];
  let dataStats = [];
  let fingerprint = '';
  let scannedAt = 0;
  let contents = new Map();
  let cachedBundle = null;

  const rescan = () => {
    files = inventory();
    dataStats = dataInventory();
    const nextContents = new Map();
    for (const entry of [...files, ...dataStats]) {
      let cached = contents.get(entry.abs);
      if (!cached || cached.signature !== entry.signature) {
        const bytes = fs.readFileSync(entry.abs);
        cached = { signature: entry.signature, text: bytes.toString('utf8'), digest: createHash('sha256').update(bytes).digest('hex') };
      }
      entry.digest = cached.digest;
      nextContents.set(entry.abs, cached);
    }
    contents = nextContents;
    fingerprint = fingerprintOf(files, dataStats);
    if (cachedBundle?.fingerprint !== fingerprint) cachedBundle = null;
    scannedAt = Date.now();
  };
  rescan();

  /** The file list. Small — an agent calls this first and then asks only for what changed. */
  api.http.route('/x/stronghold-agent/manifest', () => {
    rescan();
    return {
      ok: true,
      plugin: 'stronghold-agent',
      root: path.basename(ROOT),
      app: safeApp(),
      fingerprint,
      files: files.map((f) => ({ url: f.url, bytes: f.bytes })),
      data: dataStats.map((d) => ({ name: d.name, bytes: d.bytes })),
      hasShim: true,
      scannedAt,
    };
  });

  /**
   * Everything in one response: every module's source text and every data file.
   * This is the call an agent normally makes — one request instead of several hundred.
   */
  api.http.route('/x/stronghold-agent/bundle', () => {
    rescan();
    if (cachedBundle) return cachedBundle;
    let total = 0;
    const sources = {};
    for (const file of files) {
      const text = contents.get(file.abs).text;
      total += Buffer.byteLength(text);
      if (total > MAX_BUNDLE_BYTES) {
        return { ok: false, error: 'bundle too large', fingerprint, hint: 'use /x/stronghold-agent/file?path=… per file' };
      }
      sources[file.url] = text;
    }
    sources['/data.js'] = dataShim();
    const data = {};
    for (const entry of dataStats) {
      const text = contents.get(entry.abs).text;
      total += Buffer.byteLength(text);
      if (total > MAX_BUNDLE_BYTES) return { ok: false, error: 'bundle too large', fingerprint, hint: 'use /x/stronghold-agent/file and /data per file' };
      try { data[entry.name] = JSON.parse(text); } catch { /* a data file that will not parse */ }
    }
    cachedBundle = { ok: true, fingerprint, sources, data };
    return cachedBundle;
  });

  /** One module by URL path — the fallback for a tree too large to bundle. */
  api.http.route('/x/stronghold-agent/file', (req) => {
    const wanted = queryOf(req.url).get('path');
    if (!wanted) return { ok: false, error: 'path is required' };
    if (wanted === '/data.js') return { ok: true, path: wanted, source: dataShim() };
    const file = fileForUrlPath(files, wanted);
    if (!file) return { ok: false, error: `not a servable path: ${wanted}` };
    try { return { ok: true, path: wanted, source: readText(file.abs) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  });

  /** One data file by name. */
  api.http.route('/x/stronghold-agent/data', (req) => {
    const name = queryOf(req.url).get('name');
    const entry = dataStats.find((d) => d.name === name);
    if (!entry) return { ok: false, error: `unknown data file: ${name}` };
    try { return { ok: true, name, value: JSON.parse(readText(entry.abs)) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  });

  api.health.extend({
    root: path.basename(ROOT),
    fingerprint,
    files: files.length,
    dataFiles: dataStats.length,
    scannedAt,
  });
}

/** The game version, read from the installation rather than guessed. */
function safeApp() {
  try {
    const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')));
    return { name: pkg.name ?? null, version: pkg.version ?? null };
  } catch { return null; }
}
