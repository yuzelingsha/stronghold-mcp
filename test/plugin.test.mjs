/**
 * Tests the plugin's routes against a synthetic game installation.
 *
 * `plugin/server.js` resolves the installation at module load (from `process.argv[1]`, falling back to
 * the working directory), so this file builds a fake one and changes into it *before* the dynamic
 * import. `node --test` runs each file in its own process, so the `chdir` is contained.
 */
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DATA_FILES = ['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups'];

function makeInstall() {
  const root = mkdtempSync(join(tmpdir(), 'stronghold-plugin-'));
  const write = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write('package.json', JSON.stringify({ name: 'stronghold-protocol-alliance', version: '0.3.1' }));
  write('server/sim/spec.js', 'export const spec = 1;\n');
  write('server/sim/constants.js', 'export const TICK = 1 / 30;\n');
  write('server/sim/simdata.js', 'export const simdata = 1;\n');
  write('server/sim/content/support/index.js', 'export const support = 1;\n');
  write('server/sim/nodedata.js', '// never served\n');
  write('server/sim/.hidden.js', '// never served\n');
  write('shared/plugins/officialBounds.js', 'export const bounds = 1;\n');
  for (const name of DATA_FILES) write(`data/${name}.json`, JSON.stringify({ [name]: true }));
  return root;
}

const install = makeInstall();
process.chdir(install);

const plugin = await import('../plugin/server.js');

/** Collect the routes `activate` registers, the way server/plugins/trustedEntry.js does. */
const routes = new Map();
let health = null;
await plugin.activate({
  http: { route(route, fn) { routes.set(route, fn); } },
  health: { extend(value) { health = value; } },
});

/** Call a route the way the trusted runtime does: one frozen `{ method, path, url }`. */
function call(path, query = '') {
  const handler = routes.get(path);
  assert.ok(handler, `route ${path} is registered`);
  return handler(Object.freeze({ method: 'GET', path, url: `${path}${query}` }));
}

describe('plugin routes', () => {
  it('registers exactly the documented routes', () => {
    assert.deepEqual([...routes.keys()].sort(), [
      '/x/stronghold-agent/bundle',
      '/x/stronghold-agent/data',
      '/x/stronghold-agent/file',
      '/x/stronghold-agent/manifest',
    ]);
    // Every route must stay inside the plugin's own namespace (trustedApi.js trustedRouteAllowed).
    for (const route of routes.keys()) assert.match(route, /^\/x\/stronghold-agent\//);
  });

  it('reports a manifest with the file list and a fingerprint', () => {
    const body = call('/x/stronghold-agent/manifest');
    assert.equal(body.ok, true);
    assert.equal(body.app.version, '0.3.1');
    assert.match(body.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(body.data.map((d) => d.name).sort(), [...DATA_FILES].sort());

    const urls = body.files.map((f) => f.url);
    assert.ok(urls.includes('/sim/spec.js'));
    assert.ok(urls.includes('/shared/plugins/officialBounds.js'));
    assert.ok(!urls.includes('/sim/nodedata.js'), 'the Node-only loader is never served');
    assert.ok(!urls.some((u) => u.includes('.hidden')), 'dot files are skipped');
  });

  it('serves a whole bundle in one response', () => {
    const body = call('/x/stronghold-agent/bundle');
    assert.equal(body.ok, true);
    assert.equal(body.sources['/sim/spec.js'], 'export const spec = 1;\n');
    assert.equal(body.sources['/shared/plugins/officialBounds.js'], 'export const bounds = 1;\n');
    assert.match(body.sources['/data.js'], /setSimData/, 'the /data.js stand-in is included');
    assert.match(body.sources['/data.js'], /getSimData/);
    assert.equal(body.data.chess.chess, true);
    assert.equal(body.fingerprint, call('/x/stronghold-agent/manifest').fingerprint);
  });

  it('serves one module by path', () => {
    const body = call('/x/stronghold-agent/file', '?path=/sim/constants.js');
    assert.equal(body.ok, true);
    assert.equal(body.source, 'export const TICK = 1 / 30;\n');
  });

  it('serves the stand-in for /data.js', () => {
    const body = call('/x/stronghold-agent/file', '?path=/data.js');
    assert.equal(body.ok, true);
    assert.match(body.source, /export function getData/);
  });

  it('refuses a path outside the servable set', () => {
    assert.equal(call('/x/stronghold-agent/file', '?path=/sim/nodedata.js').ok, false);
    assert.equal(call('/x/stronghold-agent/file', '?path=/etc/passwd').ok, false);
    assert.equal(call('/x/stronghold-agent/file', '?path=').ok, false);
  });

  it('serves one data file by name', () => {
    const body = call('/x/stronghold-agent/data', '?name=bonds');
    assert.equal(body.ok, true);
    assert.equal(body.name, 'bonds');
    assert.deepEqual(body.value, { bonds: true });
    assert.equal(call('/x/stronghold-agent/data', '?name=nope').ok, false);
  });

  it('publishes a health summary', () => {
    assert.equal(health.files, 5, 'spec, constants, simdata, support, officialBounds');
    assert.equal(health.dataFiles, DATA_FILES.length);
    assert.match(health.fingerprint, /^[a-f0-9]{64}$/);
  });

  it('reuses the decoded bundle until file contents change', (t) => {
    const before = call('/x/stronghold-agent/bundle');
    assert.equal(call('/x/stronghold-agent/bundle'), before);
    const file = join(install, 'data/chess.json');
    const original = readFileSync(file, 'utf8');
    t.after(() => writeFileSync(file, original));
    writeFileSync(file, '{"chess":false}');
    const updated = call('/x/stronghold-agent/bundle');
    assert.notEqual(updated, before);
    assert.notEqual(updated.fingerprint, before.fingerprint);
    assert.equal(updated.data.chess.chess, false);
    assert.equal(call('/x/stronghold-agent/bundle'), updated);
  });

  it('detects equal-length edits even when the modification time is restored', (t) => {
    const file = join(install, 'server/sim/spec.js');
    const original = readFileSync(file, 'utf8');
    const before = call('/x/stronghold-agent/manifest');
    const metadata = statSync(file);
    t.after(() => writeFileSync(file, original));
    writeFileSync(file, original.replace('= 1', '= 2'));
    utimesSync(file, metadata.atime, metadata.mtime);
    assert.equal(statSync(file).size, metadata.size);
    const updated = call('/x/stronghold-agent/bundle');
    assert.notEqual(updated.fingerprint, before.fingerprint);
    assert.match(updated.sources['/sim/spec.js'], /= 2/);
  });
});
