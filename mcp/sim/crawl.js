/**
 * Fallback: fetch the simulation's module graph straight from the URLs a browser uses.
 *
 * This is what the MCP does on a server **without** the plugin. `/sim/` and `/shared/` are already
 * served to browsers (server/http/static.js), so the only thing missing is knowing which files to ask
 * for — and that can be recovered by walking the `import` graph from `/sim/spec.js`.
 *
 * It is slower (several hundred requests instead of one) and it depends on those routes staying
 * served, which is exactly why the plugin is the preferred path. It is kept because an agent should
 * not be useless against a stock server.
 */

/** Files under `server/sim/` the server never serves (server/http/static.js SIM_PRIVATE). */
const NEVER_SERVED = new Set(['nodedata.js']);

/**
 * Drop comments while leaving quoted text alone.
 *
 * Without this, a commented-out `// import './old.js'` reads as a real dependency. A full parser would
 * also have to model template `${}` nesting and regex literals; this deliberately does not, because the
 * only cost of getting one of those wrong is a speculative fetch that 404s into `missing`.
 */
export function stripComments(source) {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Pull module specifiers out of ESM source.
 *
 * Only specifiers that look like paths (`./x.js`, `../x.js`, `/x.js`) and end in `.js` are accepted.
 * That filter is what makes a regex safe here: a string literal that merely sits near an `import`
 * keyword does not start with `./` and end with `.js`, so it cannot be mistaken for a dependency.
 */
export function importSpecifiers(source) {
  const code = stripComments(source);
  const found = new Set();
  const patterns = [
    // import x from '…' | import '…' | import {a} from '…' | import * as n from '…'
    /\bimport\s*(?:[^;'"]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g,
    // export … from '…'
    /\bexport\s+[^;'"]*?\sfrom\s*['"]([^'"\n]+)['"]/g,
    // import('…') — literal only; a computed specifier is not followable statically
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of code.matchAll(re)) {
      const spec = match[1];
      if (typeof spec !== 'string') continue;
      const clean = spec.split('?')[0].split('#')[0];
      if (!/^\.{1,2}\/|^\//.test(clean)) continue;
      if (!clean.endsWith('.js')) continue;
      found.add(clean);
    }
  }
  return [...found];
}

/** Resolve a module specifier against the URL path of the file that contains it. */
export function resolveUrlPath(fromPath, spec) {
  const clean = spec.split('?')[0].split('#')[0];
  if (clean.startsWith('/')) return normalizeUrlPath(clean);
  const base = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  return normalizeUrlPath(base + clean);
}

/** Collapse `.` and `..` in a URL path without touching the filesystem. */
export function normalizeUrlPath(input) {
  const parts = [];
  for (const segment of String(input).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { parts.pop(); continue; }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

async function fetchText({ origin, urlPath, cookie, fetchImpl, timeoutMs }) {
  const res = await fetchImpl(new URL(urlPath, origin), {
    headers: cookie ? { Cookie: cookie } : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} for ${urlPath}`);
    error.status = res.status;
    throw error;
  }
  return res.text();
}

/**
 * Walk the module graph from `/sim/spec.js`.
 *
 * A missing module is not fatal: `simdata.js` dynamically imports `./nodeData.js`, which the server
 * deliberately never serves, and the simulation catches that failure itself. Anything else missing is
 * reported so the caller can say so out loud.
 *
 * @returns {Promise<{ sources: Map<string,string>, missing: object[] }>}
 */
export async function crawlModules({
  origin,
  entries = ['/sim/spec.js'],
  cookie = null,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  concurrency = 8,
  onProgress = null,
} = {}) {
  const sources = new Map();
  const missing = [];
  const queued = new Set(entries);
  let queue = [...entries];

  while (queue.length) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(batch.map(async (urlPath) => {
      try {
        return { urlPath, text: await fetchText({ origin, urlPath, cookie, fetchImpl, timeoutMs }) };
      } catch (error) {
        return { urlPath, error };
      }
    }));
    for (const result of results) {
      if (result.error) {
        const base = result.urlPath.slice(result.urlPath.lastIndexOf('/') + 1).toLowerCase();
        if (!NEVER_SERVED.has(base)) {
          missing.push({ urlPath: result.urlPath, status: result.error.status ?? null, message: result.error.message });
        }
        continue;
      }
      sources.set(result.urlPath, result.text);
      for (const spec of importSpecifiers(result.text)) {
        const next = resolveUrlPath(result.urlPath, spec);
        if (sources.has(next) || queued.has(next)) continue;
        queued.add(next);
        queue.push(next);
      }
      onProgress?.(sources.size);
    }
  }
  return { sources, missing };
}
