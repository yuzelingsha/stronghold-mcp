import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fingerprintOf, prepareSim, SIM_DATA_FILES } from '../mcp/sim/index.js';
import { cacheKeyFor, cachedDir, loadMaterialized, materialize } from '../mcp/sim/store.js';

function fixture(marker = 1) {
  const sources = {
    '/sim/spec.js': `export const marker = ${marker};\n` + [
      'createBattleFromSpec', 'compactResult', 'battleProgress', 'attachLpMeter',
    ].map((name) => `export function ${name}() {}`).join('\n'),
    '/sim/constants.js': 'export const TICK = 1 / 30;',
    '/sim/simdata.js': 'let data; export function setSimData(value) { data = value; } export function getSimData() { return data; }',
    '/sim/content/support/index.js': 'export function setGameData() {}',
    '/data.js': "export { getSimData as getData } from './sim/simdata.js';",
  };
  const data = Object.fromEntries(SIM_DATA_FILES.map((name) => [name, { marker }]));
  return { sources, data, fingerprint: fingerprintOf(sources, data) };
}

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stronghold-cache-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function server(initial = fixture()) {
  const calls = { manifest: 0, bundle: 0 };
  const state = { bundle: initial, failBundle: false, mismatch: false };
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith('/manifest')) {
      calls.manifest++;
      return Response.json({ ok: true, fingerprint: state.bundle.fingerprint, files: [], data: [] });
    }
    if (url.pathname.endsWith('/bundle')) {
      calls.bundle++;
      if (state.failBundle) throw new Error('temporary outage');
      return Response.json({ ok: true, ...state.bundle, ...(state.mismatch ? { fingerprint: 'f'.repeat(64) } : {}) });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { calls, state, fetchImpl };
}

describe('simulation cache', () => {
  it('hashes contents, including equal-length changes', () => {
    assert.notEqual(fingerprintOf({ '/a.js': 'a' }, {}), fingerprintOf({ '/a.js': 'b' }, {}));
    assert.notEqual(fingerprintOf({}, { chess: { a: 1 } }), fingerprintOf({}, { chess: { a: 2 } }));
    assert.equal(fingerprintOf({ '/a.js': 'a', '/b.js': 'b' }, {}), fingerprintOf({ '/b.js': 'b', '/a.js': 'a' }, {}));
  });

  it('publishes concurrent writers atomically and checks all recorded files', async (t) => {
    const cacheRoot = await temp(t);
    const options = { cacheRoot, cacheKey: 'server', ...fixture() };
    const dirs = await Promise.all(Array.from({ length: 8 }, () => materialize(options)));
    assert.ok(dirs.every((dir) => dir === dirs[0]));
    assert.equal(await cachedDir(options), dirs[0]);
    assert.deepEqual(await readdir(join(cacheRoot, 'server')), [options.fingerprint]);
    const [a, b] = await Promise.all([loadMaterialized(dirs[0]), loadMaterialized(dirs[0])]);
    assert.equal(a, b);
    await rm(join(dirs[0], 'server/sim/content/support/index.js'));
    assert.equal(await cachedDir(options), null);
  });

  it('coalesces downloads and reuses loaded data after one manifest check', async (t) => {
    const remote = server();
    const options = { origin: 'https://game.example', source: 'plugin', cacheRoot: await temp(t), fetchImpl: remote.fetchImpl };
    const [a, b] = await Promise.all([prepareSim(options), prepareSim(options)]);
    assert.equal(a, b);
    assert.deepEqual(remote.calls, { manifest: 1, bundle: 1 });
    const warm = await prepareSim(options);
    assert.equal(warm.reused, true);
    assert.equal(warm.raw, a.raw);
    assert.deepEqual(remote.calls, { manifest: 2, bundle: 1 });
  });

  it('does not share downloads between authentication scopes', async (t) => {
    const remote = server();
    const options = { origin: 'https://game.example', source: 'plugin', cacheRoot: await temp(t), fetchImpl: remote.fetchImpl };
    await Promise.all([prepareSim({ ...options, cookie: 'a' }), prepareSim({ ...options, cookie: 'b' })]);
    assert.deepEqual(remote.calls, { manifest: 2, bundle: 2 });
  });

  it('retries failed downloads instead of caching a rejected promise', async (t) => {
    const remote = server();
    const options = { origin: 'https://game.example', source: 'plugin', cacheRoot: await temp(t), fetchImpl: remote.fetchImpl };
    remote.state.failBundle = true;
    await assert.rejects(prepareSim(options), /temporary outage/);
    remote.state.failBundle = false;
    assert.equal((await prepareSim(options)).spec.marker, 1);
    assert.equal(remote.calls.bundle, 2);
  });

  it('rejects a version change during download without falling back to a mixed crawl', async (t) => {
    const remote = server();
    remote.state.mismatch = true;
    const cacheRoot = await temp(t);
    await assert.rejects(prepareSim({ origin: 'https://game.example', cacheRoot, fetchImpl: remote.fetchImpl }), /changed during download/);
    assert.deepEqual(await readdir(cacheRoot), []);
  });

  it('keeps older published versions when the server updates', async (t) => {
    const remote = server();
    const options = { origin: 'https://game.example', source: 'plugin', cacheRoot: await temp(t), fetchImpl: remote.fetchImpl };
    const old = await prepareSim(options);
    remote.state.bundle = fixture(2);
    const updated = await prepareSim(options);
    assert.equal(updated.spec.marker, 2);
    assert.equal(old.spec.marker, 1);
    assert.equal(await cachedDir({ cacheRoot: options.cacheRoot, cacheKey: cacheKeyFor(options.origin), fingerprint: old.fingerprint }), old.dir);
  });

  it('retains incomplete-content diagnostics across repeated imports', async (t) => {
    const options = { cacheRoot: await temp(t), cacheKey: 'server', ...fixture() };
    options.sources['/sim/content/support/index.js'] += '\nconsole.error("[content] failed to load ./missing.js");';
    const dir = await materialize(options);
    await assert.rejects(loadMaterialized(dir), /incomplete/);
    await assert.rejects(loadMaterialized(dir), /incomplete/);
    const inspected = await loadMaterialized(dir, { tolerateIncomplete: true });
    assert.deepEqual(inspected.contentFailures, ['./missing.js']);
  });
});
