import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lookup } from '../mcp/gamedata.js';
import { fieldRegion, observation, secondsLeft } from '../mcp/observation.js';
import { registerTools, toolMode } from '../mcp/tools.js';
import { ACTIONS } from '../mcp/protocol.js';

/** A few records shaped like the game's data files. */
const DATA = {
  chess: { chess_a: { name: '角峰', tier: 1, price: 2, position: 'MELEE', stats: { maxHp: 2000, blockCnt: 3 }, bonds: ['shield'] } },
  items: {},
  bonds: { shield: { name: '坚守', thresholds: [2, 4], members: ['chess_a'] } },
  enemies: {},
  tokens: {},
  stages: {
    s1: {
      rows: Array.from({ length: 14 }, (_, r) => `row${r}`),
      deployTiles: { normal: { melee: [[9, 7]], rangedOnly: [[10, 8]] } },
      groundPaths: { near: [[9, 10], [9, 2]], far: [[1, 10], [1, 2]] },
    },
  },
};

function state() {
  return {
    connection: { connected: true, framesAgeMs: 5 },
    last: {
      'm.public': { phase: 'PREP', round: 3, deadline: 10_000, serverNow: 5_000, stageId: 's1', players: [] },
      'm.private': {
        funds: 7, deployCap: 3, deployCount: 1,
        shop: { slots: [{ kind: 'chess', id: 'chess_a', price: 2 }, null] },
        hand: [null, {}],
        board: [{ uid: 5, kind: 'chess', id: 'chess_a', row: 9, col: 7, items: [] }],
        bonds: [{ bondId: 'shield', count: 2, active: true, layers: 4 }],
      },
    },
    battleSimulation: { enabled: true, current: { round: 2 } },
  };
}

describe('observation', () => {
  it('joins frames with the game data', () => {
    const obs = observation(state(), DATA, { env: {} });
    assert.equal(obs.seconds_left, 5);
    assert.equal(obs.shop[0].name, '角峰');
    assert.deepEqual(obs.shop[1], { slot: 1, empty: true });
    assert.equal(obs.hand_free, 2);
    assert.deepEqual(obs.board_tiles, { '9,7': 5 });
    assert.deepEqual(obs.bonds[0].thresholds, [2, 4]);
    assert.equal(obs.me.deploy, '1/3');
  });

  it('keeps only this half’s lanes and flags a stale battle', () => {
    const obs = observation(state(), DATA, { env: {} });
    assert.deepEqual(obs.field.lanes.map((lane) => lane.name), ['near']);
    // Top of the screen first: row 0 is the bottom, so the highest row leads.
    assert.deepEqual(obs.field.map_rows, ['12|row12', '11|row11', '10|row10', '9|row9']);
    assert.equal(obs.field.axes.UP, '+row');
    assert.equal(obs.field.axes.default_dir, 'RIGHT');
    // A prep phase follows the previous round's battle: that is the normal case, not a stale one.
    assert.equal(obs.battle.stale, undefined);
    const s = state();
    s.battleSimulation.current.round = 12;
    const stale = observation(s, DATA, { env: {} });
    assert.equal(stale.battle.stale, true);
    assert.match(stale.battle.stale_reason, /round=12/);
  });

  it('renders an empty snapshot without data', () => {
    const obs = observation({});
    assert.equal(obs.connected, false);
    assert.equal(obs.has_frames, false);
    assert.deepEqual(obs.shop, []);
  });

  it('keeps server prices, and decides air units the way the simulation does', () => {
    const s = state();
    s.last['m.private'].shop.slots[0].price = 1;
    s.last['m.private'].nextEnemies = [
      { enemyKey: 'flagged', fly: false },
      { enemyKey: 'mover', fly: false },
      { enemyKey: 'hover', fly: false },
      { enemyKey: 'walker', fly: false },
      { enemyKey: 'unknown', fly: true },
    ];
    const enemies = {
      flagged: { isFlyEnemy: true, stats: { motion: 'FLY' } },
      // motion FLY without the flag: units.js isFlying still says air
      mover: { isFlyEnemy: false, stats: { motion: 'FLY' } },
      // 近地悬浮 walks the ground path but is an air unit
      hover: { isFlyEnemy: false, stats: { motion: 'WALK', lpr: 2 }, abilities: [{ text: '近地悬浮', textRaw: '<$ba.float>近地悬浮</>' }] },
      walker: { isFlyEnemy: false, stats: { motion: 'WALK' } },
    };
    const obs = observation(s, { ...DATA, enemies });
    assert.equal(obs.shop[0].price, 1);
    assert.deepEqual(obs.next_enemies.map((e) => e.fly), [true, true, true, false, true]);
    assert.equal(obs.next_enemies[2].hover, true);
    assert.equal(obs.next_enemies[2].boss_lp, 2);
  });

  it('deduplicates static definitions while retaining live instance fields', () => {
    const s = state();
    s.last['m.private'].shop.slots[0].price = 1;
    s.last['m.private'].board[0].golden = true;
    const obs = observation(s, DATA, { detail: 'compact' });
    assert.equal(obs.shop[0].price, 1);
    assert.equal(obs.board[0].uid, 5);
    assert.equal(obs.board[0].row, 9);
    assert.equal(obs.board[0].golden, true);
    // Defaults are left out: no items, a count of 1, an unsold slot.
    assert.equal(obs.board[0].items, undefined);
    assert.equal(obs.shop[0].sold, undefined);
    assert.equal(obs.me.deploy, undefined);
    assert.equal(obs.me.deploy_cap, 3);
    assert.equal(obs.bonds[0].bond, undefined);
    assert.equal(obs.catalog['bond:shield'].name, '坚守');
    assert.equal(obs.board[0].hp, undefined);
    assert.equal(obs.catalog['chess:chess_a'].hp, 2000);
    assert.equal(obs.catalog['chess:chess_a'].price, 2);
    assert.deepEqual(obs.catalog['bond:shield'].thresholds, [2, 4]);
  });

  it('can omit known sections without mutating shared runner state', () => {
    const s = state();
    const report = { result: 'cleared' };
    s.battleSimulation.report = report;
    s.battleSimulation.lastResult = { round: 2, report };
    const full = observation(s, DATA);
    assert.equal(full.battle.report, report);
    assert.equal(full.battle.lastResult.report, undefined);
    const compact = observation(s, DATA, { detail: 'compact' });
    // compact: the outcome once in `last`, the report without repeating it, none of the runner internals.
    assert.deepEqual(compact.battle, { last: { round: 2 }, report: {} });
    const hidden = observation(s, DATA, { includeField: false, includeReport: false });
    assert.equal(hidden.field, undefined);
    assert.equal(hidden.battle.report, undefined);
    assert.equal(hidden.battle.lastResult.report, undefined);
    assert.equal(s.battleSimulation.lastResult.report, report);
  });

  it('parses the deadline and the field region defensively', () => {
    assert.equal(secondsLeft(5_000, 10_000), null);
    assert.equal(secondsLeft(null, 0), null);
    assert.deepEqual(fieldRegion({ STRONGHOLD_FIELD_REGION: '0,5,0,20' }), [0, 5, 0, 20]);
    assert.deepEqual(fieldRegion({ STRONGHOLD_FIELD_REGION: 'garbage' }), [9, 12, 2, 10]);
  });

  it('looks up a bond with its members', () => {
    const bond = lookup(DATA, 'shield', 'bond');
    assert.equal(bond.found, true);
    assert.deepEqual(bond.record.members, [{ id: 'chess_a', name: '角峰', tier: 1 }]);
    assert.equal(lookup(DATA, 'chess_a').record.name, '角峰');
    assert.equal(lookup(DATA, 'nope').found, false);
  });

  it('renders the strategy draft the way the draft screen lists it', () => {
    const s = state();
    Object.assign(s.last['m.public'], {
      phase: 'BAND_DRAFT', disabledBonds: ['shield'],
      draft: { order: ['p1', 'p2'], turn: 'p1', picks: { p2: 'band_b' }, skipsLeft: { p1: 1 }, untimed: true },
    });
    s.last['m.private'].playerId = 'p1';
    s.last['room.state'] = { mode: 'coop' };
    const bands = {
      band_b: { bandId: 'band_b', sortId: 2, name: '乙', totalHp: 28, effectName: 'B', desc: 'b', modeTypeList: ['SINGLE', 'MULTI'], bondIds: [] },
      band_a: { bandId: 'band_a', sortId: 1, name: '甲', totalHp: 45, effectName: 'A', desc: 'a', modeTypeList: ['MULTI'], bondIds: ['shield'] },
      band_s: { bandId: 'band_s', sortId: 0, name: '单', totalHp: 28, desc: 's', modeTypeList: ['SINGLE'], bondIds: [] },
    };
    const obs = observation(s, { ...DATA, bands });
    assert.equal(obs.band_draft.my_turn, true);
    assert.equal(obs.band_draft.skips_left, 1);
    assert.deepEqual(obs.band_draft.options.map((b) => b.id), ['band_a', 'band_b']);
    assert.deepEqual(obs.band_draft.options[0].off_bonds, ['坚守']);
    assert.equal(obs.band_draft.options[0].lp, 45);
    assert.equal(obs.band_draft.options[1].taken_by, 'p2');
    assert.equal(observation(state(), { ...DATA, bands }).band_draft, undefined);
    assert.equal(lookup({ bands }, 'band_a').record.name, '甲');
  });

  it('renders the 机变 draft cards and the card traits a human reads', () => {
    const s = state();
    Object.assign(s.last['m.public'], {
      phase: 'SP_DRAFT',
      sp: { eventId: 'ev', name: '道具补给', desc: 'd', turn: 'p1', picks: {}, taken: { p2: 1 }, cards: [
        { idx: 0, kind: 'item', id: 'item_a', name: '头盔', desc: 'hp', tier: 3, price: 0, soldOut: false },
        { idx: 1, kind: 'item', id: 'item_b', name: '玩偶', desc: 'coin', tier: 2, price: 0, soldOut: true },
      ] },
    });
    s.last['m.private'].playerId = 'p1';
    const data = {
      ...DATA,
      chess: { chess_a: { ...DATA.chess.chess_a, stats: { ...DATA.chess.chess_a.stats, cost: 17 }, garrisonIds: ['g1', 'g2'] } },
      garrisons: { g1: { desc: '<获得时>自身所属盟约层数+2' }, g2: { desc: '【152】<获得时>自身所属盟约层数+2' } },
    };
    const obs = observation(s, data, { detail: 'compact' });
    assert.equal(obs.sp_draft.my_turn, true);
    assert.deepEqual(obs.sp_draft.cards.map((c) => [c.idx, c.name, c.sold_out, c.taken_by]), [[0, '头盔', undefined, undefined], [1, '玩偶', true, 'p2']]);
    assert.equal(obs.catalog['chess:chess_a'].cost, 17);
    assert.equal(obs.catalog['chess:chess_a'].trait, '<获得时>自身所属盟约层数+2');
  });

  it('surfaces the combat report in obs.battle.report', () => {
    const s = state();
    s.battleSimulation.lastResult = {
      round: 3,
      report: {
        result: 'cleared',
        layer_gains: { kazimierzShip: 24 },
        damage_types: { phys: 100, arts: 0, true: 50, elemental: 0 },
      },
    };
    const obs = observation(s, DATA, { env: {} });
    assert.deepEqual(obs.battle.report, {
      result: 'cleared',
      layer_gains: { kazimierzShip: 24 },
      damage_types: { phys: 100, arts: 0, true: 50, elemental: 0 },
    });
  });
});

describe('MCP tools', () => {
  function register(env) {
    const tools = new Map();
    const server = { registerTool: (name, _meta, handler) => tools.set(name, handler) };
    const client = { snapshot: () => ({}), connected: false };
    registerTools(server, client, { env, gameData: async () => { throw new Error('offline'); } });
    return tools;
  }

  it('drops the per-action tools in compact mode', () => {
    assert.equal(toolMode({}), 'compact');
    const compact = register({ STRONGHOLD_MCP_TOOLS: 'compact' });
    assert.equal(register({ STRONGHOLD_MCP_TOOLS: 'full' }).size, compact.size + ACTIONS.length);
    assert.ok(compact.has('stronghold_action') && compact.has('stronghold_observe'));
  });

  it('filters protocol descriptions and forwards observation projections', async () => {
    const tools = register({});
    const reply = await tools.get('stronghold_protocol')({ type: 'g.move' });
    assert.deepEqual(reply.structuredContent.actions.map((a) => a.type), ['g.move']);
    const room = await tools.get('stronghold_protocol')({ prefix: 'room.' });
    assert.ok(room.structuredContent.actions.every((a) => a.type.startsWith('room.')));
    const obs = await tools.get('stronghold_observe')({ detail: 'compact', includeField: false });
    assert.equal(obs.structuredContent.field, undefined);
    assert.deepEqual(obs.structuredContent.catalog, {});
    assert.deepEqual(JSON.parse(obs.content[0].text), obs.structuredContent);
    assert.equal(obs.content[0].text.includes('\n'), false);
  });

  it('observes compact by default and answers since with a delta', async () => {
    const tools = register({});
    const first = (await tools.get('stronghold_observe')({})).structuredContent;
    assert.equal(first.rev, 1);
    assert.ok(first.catalog);
    const delta = (await tools.get('stronghold_observe')({ since: first.rev })).structuredContent;
    assert.equal(delta.since, 1);
    assert.ok(delta.unchanged.includes('field'));
    assert.equal(delta.field, undefined);
    const again = (await tools.get('stronghold_observe')({ detail: 'full', since: first.rev })).structuredContent;
    assert.equal(again.resync, true);
  });

  it('observes without the data files and says why the joins are blank', async () => {
    const reply = await register({}).get('stronghold_observe')({});
    assert.equal(reply.structuredContent.connected, false);
    assert.equal(reply.structuredContent.data_error, 'offline');
  });
});
