import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { attachCombatReport, DAMAGE_TYPES } from '../mcp/battle/report.js';

class FakeBattle {
  constructor() {
    this._hooks = {};
    this.time = 0;
    this.allyUnits = [];
    this.players = [{ playerId: 'p1' }];
  }

  on(name, fn) {
    const h = { name, fn };
    (this._hooks[name] = this._hooks[name] || []).push(h);
    return h;
  }

  off(nameOrHandle, fn) {
    if (nameOrHandle && typeof nameOrHandle === 'object') {
      const h = nameOrHandle;
      const list = this._hooks[h.name];
      if (list) {
        const i = list.indexOf(h);
        if (i >= 0) list.splice(i, 1);
      }
      return;
    }
    const list = this._hooks[nameOrHandle];
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!fn || list[i].fn === fn) list.splice(i, 1);
    }
  }

  emit(name, ctx) {
    for (const h of (this._hooks[name] || []).slice()) {
      h.fn(ctx);
    }
  }

  step(dt = 1) {
    this.time += dt;
  }
}

describe('combat report', () => {
  it('exposes the standard damage types', () => {
    assert.deepEqual([...DAMAGE_TYPES], ['phys', 'arts', 'true', 'elemental']);
  });

  it('records damage types by ally units without double counting', () => {
    const battle = new FakeBattle();
    const op1 = { uid: 1, side: 'ally', kind: 'op', name: '远牙', stats: { dmg: 0 } };
    const op2 = { uid: 2, side: 'ally', kind: 'op', name: '瑕光', stats: { dmg: 0 } };
    const enemy = { side: 'enemy', name: '侦察兵' };
    battle.allyUnits = [op1, op2];

    const collector = attachCombatReport(battle, { playerId: 'p1' });

    // op1 deals 100 phys damage
    op1.stats.dmg = 100;
    battle.emit('damaged', { source: op1, target: enemy, type: 'phys', amount: 100 });

    // op2 deals 50 true damage
    op2.stats.dmg = 50;
    battle.emit('damaged', { source: op2, target: enemy, type: 'true', amount: 50 });

    // op1 deals 80 arts damage
    op1.stats.dmg = 180;
    battle.emit('damaged', { source: op1, target: enemy, type: 'arts', amount: 80 });

    // Enemy deals damage to op1 (should be ignored)
    battle.emit('damaged', { source: enemy, target: op1, type: 'phys', amount: 30 });

    const report = collector.finish({
      round: 3,
      reason: 'cleared',
      perPlayer: {
        p1: {
          killed: 1,
          total: 1,
          perfect: true,
          layerGains: { kazimierzShip: 12 },
          leaked: [],
          unitsEnd: [{ uid: 1, alive: true }, { uid: 2, alive: true }],
          unitStats: [
            { uid: 1, name: '远牙', dmg: 180, taken: 30, heal: 0, kills: 1, kind: 'op' },
            { uid: 2, name: '瑕光', dmg: 50, taken: 0, heal: 0, kills: 0, kind: 'op' },
          ],
        },
      },
    });

    assert.equal(report.round, 3);
    assert.equal(report.result, 'cleared');
    assert.equal(report.perfect, true);
    assert.deepEqual(report.damage_types, { phys: 100, arts: 80, true: 50, elemental: 0 });
    assert.deepEqual(report.layer_gains, { kazimierzShip: 12 });
    assert.equal(report.units.length, 2);
    assert.equal(report.units[0].name, '远牙');
    assert.equal(report.units[0].dmg, 180);
    assert.equal(report.units[0].alive, true);
    assert.equal(report.units[1].name, '瑕光');
    assert.equal(report.units[1].dmg, 50);
  });

  it('records casualties with timestamps', () => {
    const battle = new FakeBattle();
    const op = { uid: 10, side: 'ally', kind: 'op', name: '野鬃' };
    battle.allyUnits = [op];

    const collector = attachCombatReport(battle, { playerId: 'p1' });

    battle.step(12.45);
    battle.emit('death', { unit: op, reason: 'killed' });

    const report = collector.finish({
      round: 2,
      reason: 'leaked',
      perPlayer: {
        p1: {
          killed: 4,
          total: 5,
          perfect: false,
          layerGains: {},
          leaked: [{ enemyKey: 'enemy_1001_scout' }],
          unitsEnd: [{ uid: 10, alive: false }],
          unitStats: [{ uid: 10, name: '野鬃', dmg: 200, taken: 1500, kills: 1, kind: 'op' }],
        },
      },
    });

    assert.equal(report.result, 'leaked');
    assert.equal(report.perfect, false);
    assert.equal(report.leaks, 1);
    assert.deepEqual(report.leaked_enemies, ['enemy_1001_scout']);
    assert.equal(report.casualties.length, 1);
    assert.equal(report.casualties[0].name, '野鬃');
    assert.equal(report.casualties[0].time, 12.5);
    assert.equal(report.casualties[0].reason, 'killed');
    assert.equal(report.units[0].alive, false);
  });

  it('detaches cleanly and ignores events after finish', () => {
    const battle = new FakeBattle();
    const op = { uid: 1, side: 'ally', kind: 'op', name: '角峰', stats: { dmg: 0 } };
    battle.allyUnits = [op];

    const collector = attachCombatReport(battle, { playerId: 'p1' });
    collector.detach();

    // Emitting events after detach should not crash or record anything
    op.stats.dmg = 100;
    battle.emit('damaged', { source: op, target: null, type: 'phys', amount: 100 });
    battle.emit('death', { unit: op, reason: 'killed' });

    const report = collector.finish({
      perPlayer: {
        p1: { layerGains: {}, leaked: [], unitStats: [], unitsEnd: [] },
      },
    });

    assert.deepEqual(report.damage_types, { phys: 0, arts: 0, true: 0, elemental: 0 });
    assert.deepEqual(report.casualties, []);
  });
});
