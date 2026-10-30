/**
 * The game's own data files, for rendering an observation and answering lookups.
 *
 * These are the JSON files the server already serves to every browser at `/data/<name>.json`, so an
 * agent reasons about exactly the numbers the game uses, with nothing installed on its side. When the
 * game installation is on this machine, STRONGHOLD_DATA_DIR points at its `data/` directory instead and
 * nothing is downloaded.
 *
 * They describe the server's original content. A room with gameplay plugins can change some records;
 * the observation still shows the original ones.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The files an observation and the guide join against (about 3 MB together); browsers load the same files. */
export const GAME_DATA_FILES = Object.freeze(['chess', 'items', 'bonds', 'enemies', 'stages', 'tokens', 'bands', 'garrisons', 'config']);

async function readLocal(dir, name) {
  const file = join(dir, `${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${file} (${error?.message ?? error}); STRONGHOLD_DATA_DIR must be the game's data/ directory`);
  }
}

async function fetchRemote({ origin, name, cookie, fetchImpl, timeoutMs }) {
  const res = await fetchImpl(new URL(`/data/${name}.json`, origin), {
    headers: cookie ? { Cookie: cookie } : undefined,
    // A login-gated site answers an unauthenticated request with a redirect to its login page; following
    // it would hand back that page instead of the data and fail later with a confusing parse error.
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`the server redirected /data/${name}.json to ${res.headers.get('location') || 'another page'}: the site needs a login (STRONGHOLD_AUTH_USER / STRONGHOLD_AUTH_PASSWORD)`);
  }
  if (!res.ok) throw new Error(`could not read /data/${name}.json (HTTP ${res.status})`);
  return res.json();
}

/**
 * Load every file in GAME_DATA_FILES.
 * @returns {Promise<Record<string, object>>} `{ chess, items, bonds, enemies, stages, tokens }`
 */
export async function loadGameData({ dataDir = null, origin = null, cookie = null, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (!dataDir && !origin) throw new Error('loadGameData needs STRONGHOLD_DATA_DIR or the game server origin');
  const entries = await Promise.all(GAME_DATA_FILES.map(async (name) => [
    name,
    dataDir ? await readLocal(dataDir, name) : await fetchRemote({ origin, name, cookie, fetchImpl, timeoutMs }),
  ]));
  return Object.fromEntries(entries);
}

/**
 * Reuse the simulation's immutable data when available. Otherwise load once per welcome content
 * version; a failed load is not kept, so the next call can retry.
 *
 * @param {import('./game-client.js').StrongholdClient} client
 * @returns {() => Promise<Record<string, object>>}
 */
export function gameDataSource(client, { env = process.env, fetchImpl = fetch } = {}) {
  let loading = null;
  let sourceKey = null;
  return () => {
    const dataDir = String(env.STRONGHOLD_DATA_DIR || '').trim() || null;
    const version = client.welcome?.content?.vanilla ?? null;
    const simulation = client.simulationData;
    if (!dataDir && simulation?.origin === client.httpUrl && simulation.contentVersion === version && GAME_DATA_FILES.every((name) => simulation.raw?.[name])) {
      return Promise.resolve(simulation.raw);
    }
    const key = JSON.stringify([dataDir, client.httpUrl, version]);
    if (key !== sourceKey) {
      sourceKey = key;
      loading = null;
    }
    if (!loading) {
      const pending = (async () => loadGameData({
        dataDir,
        origin: client.httpUrl,
        cookie: dataDir ? null : await client.ensureAuthCookie(),
        fetchImpl,
      }))();
      loading = pending;
      pending.catch(() => { if (loading === pending) loading = null; });
    }
    return loading;
  };
}

/** One bond's thresholds, description and members, as an agent asks about it. */
function bondSummary(data, bondId) {
  const raw = data.bonds?.[bondId];
  if (!raw) return null;
  const out = {};
  for (const key of ['bondId', 'name', 'activeCount', 'thresholds', 'maxCount', 'countMode', 'desc', 'effectName', 'effectDesc']) {
    out[key] = raw[key] ?? null;
  }
  const members = [];
  for (const key of ['members', 'visibleMembers']) {
    for (const member of raw[key] || []) {
      const chessId = member && typeof member === 'object' ? member.chessId : member;
      if (typeof chessId === 'string' && !members.includes(chessId)) members.push(chessId);
    }
  }
  out.members = members.map((id) => ({ id, name: data.chess?.[id]?.name ?? null, tier: data.chess?.[id]?.tier ?? null }));
  return out;
}

const LOOKUP_FILES = Object.freeze({ chess: 'chess', item: 'items', enemy: 'enemies', token: 'tokens', band: 'bands' });

/**
 * The full record behind one id: a chess piece, an item, an enemy, a token, a strategy band, or a bond
 * (summarized with its members). Without `kind`, `chess_…`, `item_…` and `band_…` ids say what they are and
 * anything else is taken to be an enemy key.
 */
export function lookup(data, id, kind = null) {
  const key = String(id);
  const resolved = kind || (key.startsWith('chess_') ? 'chess' : key.startsWith('item_') ? 'item' : key.startsWith('band_') ? 'band' : 'enemy');
  const record = resolved === 'bond' ? bondSummary(data, key) : data[LOOKUP_FILES[resolved]]?.[key] ?? null;
  return { kind: resolved, id: key, found: record != null, record };
}
