import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import { attachRangeRule } from '../mcp/battle/index.js';
import { attachLocalBattleClient, battlePacing, contentAccepted, isTrainingRoom } from '../mcp/battle/local-sim.js';
import { describeSearch, loadAttackRange, loadSimulation, resolveSpecPath } from '../mcp/battle/resolve-sim.js';

function emptyDir() {
  return mkdtempSync(join(tmpdir(), 'stronghold-test-'));
}

/** A directory shaped like a game installation, with just enough of spec.js to load. */
function fakeInstall({ specBody = null, withConstants = true } = {}) {
  const dir = emptyDir();
  mkdirSync(join(dir, 'server', 'sim'), { recursive: true });
  writeFileSync(join(dir, 'server', 'sim', 'spec.js'), specBody ?? [
    'export const createBattleFromSpec = () => {};',
    'export const compactResult = () => {};',
    'export const battleProgress = () => {};',
    'export const attachLpMeter = () => {};',
  ].join('\n'));
  if (withConstants) writeFileSync(join(dir, 'server', 'sim', 'constants.js'), 'export const TICK = 1 / 30;\n');
  return dir;
}

describe('battle pacing', () => {
  it('defaults to auto', () => {
    assert.equal(battlePacing({}), 'auto');
    assert.equal(battlePacing({ STRONGHOLD_BATTLE_MODE: '' }), 'auto');
    assert.equal(battlePacing({ STRONGHOLD_BATTLE_MODE: 'nonsense' }), 'auto');
  });

  it('accepts only the two explicit overrides', () => {
    assert.equal(battlePacing({ STRONGHOLD_BATTLE_MODE: 'fast' }), 'fast');
    assert.equal(battlePacing({ STRONGHOLD_BATTLE_MODE: 'realtime' }), 'realtime');
    assert.equal(battlePacing({ STRONGHOLD_BATTLE_MODE: '  FAST  ' }), 'fast');
  });

  it('recognises a training room only from room.state.train', () => {
    assert.equal(isTrainingRoom({ last: { 'room.state': { train: true } } }), true);
    // A normal room omits the key entirely; anything other than a literal true is not a training room.
    assert.equal(isTrainingRoom({ last: { 'room.state': { code: 'X' } } }), false);
    assert.equal(isTrainingRoom({ last: { 'room.state': { train: 'true' } } }), false);
    assert.equal(isTrainingRoom({ last: {} }), false);
    assert.equal(isTrainingRoom(null), false);
    assert.equal(isTrainingRoom(undefined), false);
  });
});

describe('content sets', () => {
  const welcome = { content: { vanilla: 'v'.repeat(16) } };

  it('accepts only the original content', () => {
    assert.equal(contentAccepted(undefined, welcome), true);
    assert.equal(contentAccepted('v'.repeat(16), welcome), true);
    assert.equal(contentAccepted('m'.repeat(16), welcome), false, 'a room content set is not the original content');
    assert.equal(contentAccepted('v'.repeat(16), {}), false, 'unknown original content: nothing named can be trusted');
  });

  it('leaves a battle on another content set to the server', async () => {
    const client = Object.assign(new EventEmitter(), { welcome, last: {}, connected: true, sent: [] });
    client._send = (frame) => client.sent.push(frame);
    let loads = 0;
    const { status } = attachLocalBattleClient(client, async () => { loads++; throw new Error('not reached'); }, { mode: 'fast' });
    client.emit('b.start', { authoritative: true, battleId: 'b1', spec: { cs: 'm'.repeat(16), round: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(client.sent, [], 'no b.progress and no b.result');
    assert.equal(loads, 0);
    assert.equal(status.declined.battleId, 'b1');
  });
});

describe('local installation resolution', () => {
  it('honours an explicit STRONGHOLD_SIM_SPEC', () => {
    const dir = emptyDir();
    const spec = join(dir, 'spec.js');
    writeFileSync(spec, 'export const marker = 1;\n');
    assert.equal(resolveSpecPath({ STRONGHOLD_SIM_SPEC: spec }, dir), spec);
  });

  it('returns null for an explicit path that does not exist', () => {
    const dir = emptyDir();
    assert.equal(resolveSpecPath({ STRONGHOLD_SIM_SPEC: join(dir, 'nope.js') }, dir), null);
  });

  it('finds server/sim/spec.js under a configured root', () => {
    const dir = fakeInstall();
    assert.equal(resolveSpecPath({ STRONGHOLD_SIM_ROOT: dir }, tmpdir()), join(dir, 'server', 'sim', 'spec.js'));
  });

  it('does NOT walk up from the working directory unless asked to', () => {
    // A silent upward search would pick up whatever checkout happens to sit nearby and mask the
    // remote source, which is exactly what a distributed agent must not do.
    const dir = fakeInstall();
    const nested = join(dir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    assert.equal(resolveSpecPath({}, nested), null, 'auto-discovery must be opt-in');
  });

  it('walks up from the working directory when STRONGHOLD_SIM_AUTODISCOVER=1', () => {
    const dir = fakeInstall();
    const nested = join(dir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const env = { STRONGHOLD_SIM_AUTODISCOVER: '1' };
    assert.equal(resolveSpecPath(env, nested), join(dir, 'server', 'sim', 'spec.js'));
  });

  it('reports null and lists nothing when no root is configured', () => {
    const dir = emptyDir();
    assert.equal(resolveSpecPath({}, dir), null);
    assert.deepEqual(describeSearch({}, dir), [], 'with no configuration there is nothing to search');
  });

  it('lists the candidates it would try under a configured root', () => {
    const dir = emptyDir();
    const tried = describeSearch({ STRONGHOLD_SIM_ROOT: dir }, dir);
    assert.deepEqual(tried, [
      join(dir, 'server/sim/spec.js'),
      join(dir, 'sim/spec.js'),
      join(dir, 'spec.js'),
    ]);
  });

  it('fails with an actionable message when the simulation is absent', async () => {
    await assert.rejects(
      () => loadSimulation({}, emptyDir()),
      (error) => {
        assert.match(error.message, /could not find the game's sim\/spec\.js/);
        assert.match(error.message, /STRONGHOLD_SIM_ROOT/);
        assert.match(error.message, /STRONGHOLD_SIM_SPEC/);
        return true;
      },
    );
  });

  it('loads a well-formed installation', async () => {
    const dir = fakeInstall();
    const sim = await loadSimulation({ STRONGHOLD_SIM_ROOT: dir }, tmpdir());
    assert.equal(typeof sim.spec.createBattleFromSpec, 'function');
    assert.equal(sim.constants.TICK, 1 / 30);
  });

  it('rejects a spec.js that is not the expected module', async () => {
    const dir = fakeInstall({ specBody: 'export const somethingElse = 1;\n' });
    await assert.rejects(() => loadSimulation({ STRONGHOLD_SIM_ROOT: dir }, tmpdir()), /does not export createBattleFromSpec/);
  });

  it('rejects a spec.js whose sibling constants.js is missing', async () => {
    const dir = fakeInstall({ withConstants: false });
    await assert.rejects(() => loadSimulation({ STRONGHOLD_SIM_ROOT: dir }, tmpdir()), /sibling constants\.js/);
  });
});

describe('the game\'s range rule', () => {
  it('comes from the tree spec.js sits in', async () => {
    const dir = fakeInstall();
    mkdirSync(join(dir, 'shared'), { recursive: true });
    writeFileSync(join(dir, 'shared', 'loadoutRecord.js'), 'export const attackRangeGrid = (rec) => rec.marker;\n');
    const rule = await loadAttackRange(join(dir, 'server', 'sim', 'spec.js'));
    assert.equal(rule({ marker: 'the game' }), 'the game');
  });

  it('is null when the tree has none, so ranges fall back to the records', async () => {
    const dir = fakeInstall();
    assert.equal(await loadAttackRange(join(dir, 'server', 'sim', 'spec.js')), null);
  });

  it('reaches a seat without a battle runner through a configured installation', async () => {
    const dir = fakeInstall();
    mkdirSync(join(dir, 'shared'), { recursive: true });
    writeFileSync(join(dir, 'shared', 'loadoutRecord.js'), 'export const attackRangeGrid = (rec) => rec.marker;\n');
    const client = { attackRangeGrid: null };
    await attachRangeRule(client, { env: { STRONGHOLD_SIM_ROOT: dir }, startDir: tmpdir() });
    assert.equal(client.attackRangeGrid({ marker: 'the game' }), 'the game');
  });

  it('stays with the records when no installation is configured', async () => {
    const client = { attackRangeGrid: null };
    await attachRangeRule(client, { env: {}, startDir: emptyDir() });
    assert.equal(client.attackRangeGrid, null);
  });
});

describe('leaving the room', () => {
  it('ends the runner\'s status with the room it described', () => {
    const client = new EventEmitter();
    const { status } = attachLocalBattleClient(client, async () => ({ constants: { TICK: 1 / 30 } }), { env: {} });
    Object.assign(status, { current: { round: 4 }, lastResult: { round: 4 }, report: { result: 'cleared' } });
    client.emit('room.left');
    assert.deepEqual([status.current, status.lastResult, status.report], [null, null, null]);
    assert.equal(status.enabled, true, 'the runner stays attached for the next room');
  });
});

describe('simulation retry', () => {
  it('shares pending work, retries a failure, then reuses a successful load', async () => {
    const client = new EventEmitter();
    let loads = 0;
    const loaded = { constants: { TICK: 1 / 30 } };
    const { status, whenReady } = attachLocalBattleClient(client, async () => {
      loads++;
      if (loads === 1) throw new Error('temporary outage');
      return loaded;
    }, { env: {} });
    await Promise.all([assert.rejects(whenReady(), /temporary outage/), assert.rejects(whenReady(), /temporary outage/)]);
    assert.equal(loads, 1);
    assert.equal(status.pending, 0);
    assert.equal(await whenReady(), loaded);
    assert.equal(await whenReady(), loaded);
    assert.equal(loads, 2);
    assert.equal(status.ready, true);
    assert.equal(status.error, null);
  });

  it('revalidates between completed battles and keeps each battle on its loaded version', { timeout: 2000 }, async () => {
    const client = Object.assign(new EventEmitter(), { last: {}, connected: true, sent: [] });
    client._send = (frame) => {
      client.sent.push(frame);
      if (frame.t === 'b.result') client.emit('finished', frame);
    };
    let loads = 0;
    const getSim = async () => {
      const version = ++loads;
      return {
        constants: { TICK: 1 / 30 }, fingerprint: `version${version}`,
        spec: {
          createBattleFromSpec: () => ({ finished: true, time: 0, result: () => ({ reason: `version${version}`, killed: 0, total: 0 }) }),
          compactResult: (result) => result,
          battleProgress: () => ({ killed: 0, total: 0, done: true }),
          attachLpMeter: () => ({ detach() {} }),
        },
      };
    };
    const { status } = attachLocalBattleClient(client, getSim, { mode: 'fast', refreshBetweenBattles: true });
    for (let round = 1; round <= 2; round++) {
      const done = new Promise((resolve) => client.once('finished', resolve));
      const battleId = `b${round}`;
      client.emit('b.start', { authoritative: true, battleId, spec: { round } });
      assert.equal((await done).result.reason, `version${round}`);
      client.emit('b.end', { battleId });
    }
    assert.equal(loads, 2);
    assert.equal(status.fingerprint, 'version2');
  });
});
