import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lookup } from '../mcp/gamedata.js';
import { commsView, fieldRegion, observation, rangeTiles, secondsLeft } from '../mcp/observation.js';
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

  it('names every seat the way the other frames name it', () => {
    const s = state();
    s.last['m.public'].players = [
      { playerId: 'p1', seat: 0, name: '甲', isBot: false, connected: false, alive: true, lp: 9, fieldId: 'n:p1', pendingLp: 2, uniteLeft: 3 },
      { playerId: 'p2', seat: 1, name: 'AI', isBot: true, connected: true, alive: true, lp: 8, fieldId: null },
    ];
    const [human, bot] = observation(s, DATA, { detail: 'compact' }).players;
    assert.deepEqual([human.playerId, human.connected, human.fieldId, human.pending_lp, human.unite_left], ['p1', false, 'n:p1', 2, 3]);
    assert.equal(bot.fieldId, undefined, 'a prep phase has no battle fields');
    assert.equal(bot.pending_lp, undefined);
  });

  it('joins a reward offer like the shop and catalogs its cards', () => {
    const s = state();
    s.last['m.private'].shop.rewardOffer = {
      tier: 2, source: 'merge', label: null, queued: 1,
      slots: [{ kind: 'chess', id: 'chess_b', price: 0, sold: false }, { kind: 'item', id: 'item_a', price: 0, sold: true }],
    };
    const data = {
      ...DATA,
      chess: { ...DATA.chess, chess_b: { name: '精锐角峰', tier: 2, isGolden: true, stats: {}, bonds: ['shield'] } },
      items: { item_a: { name: '头盔', tier: 2, desc: 'hp' } },
    };
    const full = observation(s, data).reward_offer;
    assert.equal(full.source, 'merge');
    assert.deepEqual(full.slots.map((c) => [c.idx, c.name, c.price]), [[0, '精锐角峰', 0], [1, '头盔', 0]]);

    const obs = observation(s, data, { detail: 'compact' });
    assert.equal(obs.reward_offer.queued, 1);
    assert.equal(obs.reward_offer.label, undefined);
    assert.deepEqual(obs.reward_offer.slots[0], { id: 'chess_b', idx: 0, kind: 'chess', price: 0, golden: true });
    assert.equal(obs.reward_offer.slots[1].sold, true);
    assert.equal(obs.catalog['chess:chess_b'].name, '精锐角峰');
    assert.equal(obs.catalog['chess:chess_b'].golden, true);
    assert.equal(obs.catalog['item:item_a'].desc, 'hp');
    assert.equal(observation(state(), data, { detail: 'compact' }).reward_offer, undefined);
  });

  it('renders the range and skill of a card, and the tiles a deployed piece covers', () => {
    const s = state();
    const range = [[0, 0], [0, 1], [1, 1]];
    const data = {
      ...DATA,
      chess: { chess_a: { ...DATA.chess.chess_a, rangeGrid: range, skill: { name: '狼眼', desc: '攻击力提升', skillType: 'PASSIVE', spType: 'ON_DEPLOY', spCost: 0, initSp: 0, duration: 0 } } },
      stages: { s1: { ...DATA.stages.s1, rows: Array.from({ length: 14 }, () => 'r'.repeat(21)) } },
    };
    const obs = observation(s, data, { detail: 'compact' });
    assert.deepEqual(obs.catalog['chess:chess_a'].range, range);
    assert.deepEqual(obs.catalog['chess:chess_a'].skill, { name: '狼眼', desc: '攻击力提升', type: 'PASSIVE', sp_type: 'ON_DEPLOY' });
    assert.equal(obs.board[0].range, undefined, 'static, so it lives in the catalog');
    assert.deepEqual(obs.board[0].range_tiles, [[9, 7], [9, 8], [10, 8]]);

    // A range counts from the game's rule once the simulation has supplied it.
    const ruled = observation(s, data, { detail: 'compact', attackRange: (rec) => [...rec.rangeGrid, [0, 2]] });
    assert.deepEqual(ruled.catalog['chess:chess_a'].range.at(-1), [0, 2]);
    assert.deepEqual(ruled.board[0].range_tiles.at(-1), [9, 9]);
  });

  it('turns a range to its facing the way the sim does, and keeps it on the map', () => {
    const range = [[1, 2]];
    assert.deepEqual(rangeTiles(range, 5, 5, 'RIGHT'), [[6, 7]]);
    assert.deepEqual(rangeTiles(range, 5, 5, 'UP'), [[7, 4]]);
    assert.deepEqual(rangeTiles(range, 5, 5, 'LEFT'), [[4, 3]]);
    assert.deepEqual(rangeTiles(range, 5, 5, 'DOWN'), [[3, 6]]);
    assert.deepEqual(rangeTiles(range, 5, 5, null), [[6, 7]], 'a piece faces RIGHT unless told otherwise');
    assert.deepEqual(rangeTiles([[0, 0], [0, 1], [0, 2]], 0, 1, 'LEFT', ['abc']), [[0, 1], [0, 0]]);
  });

  it('shows the lobby\'s seats before any match frame exists', () => {
    const obs = observation({
      connection: { connected: true, playerId: 'p1' },
      last: {
        'room.state': {
          code: 'ABCD', mode: 'coop', difficulty: 'HARD', hostId: 'p1', inMatch: false, aiPicksLast: true,
          seats: [{ seat: 0, playerId: 'p1', name: '甲', isBot: false, ready: false, connected: true }, null],
        },
      },
    }, {}, { detail: 'compact' });
    assert.deepEqual(obs.players, []);
    assert.equal(obs.me.playerId, 'p1', 'the lobby has no m.private to say who this seat is');
    assert.equal(obs.room.host_id, 'p1');
    assert.equal(obs.room.in_match, false);
    assert.equal(obs.room.ai_picks_last, true);
    assert.deepEqual(obs.room.seats, [{ seat: 0, playerId: 'p1', name: '甲', bot: false, ready: false, connected: true }, { seat: 1, empty: true }]);
    assert.equal(observation({}, {}, { detail: 'compact' }).room.seats, undefined);
  });

  it('says when a setup reroll vote is waiting on this seat', () => {
    const s = state();
    s.last['m.private'].playerId = 'p2';
    Object.assign(s.last['m.public'], { setupRevision: 2, rerollVote: { id: 7, proposerId: 'p1', voters: ['p1', 'p2'], agreed: ['p1'] } });
    const obs = observation(s, DATA, { detail: 'compact' });
    assert.equal(obs.setup_revision, 2);
    assert.deepEqual(obs.reroll_vote, { id: 7, proposerId: 'p1', voters: ['p1', 'p2'], agreed: ['p1'], awaiting_me: true });
    s.last['m.public'].rerollVote.agreed.push('p2');
    assert.equal(observation(s, DATA).reroll_vote.awaiting_me, false);
    s.last['m.public'].rerollVote = null;
    assert.equal(observation(s, DATA).reroll_vote, undefined);
  });

  it('counts the time since the frame arrived, except while the match is paused', () => {
    const s = state();
    s.connection.frameAgesMs = { 'm.public': 2_000 };
    assert.equal(observation(s, DATA).seconds_left, 3);
    s.last['m.public'].paused = true;
    assert.equal(observation(s, DATA).seconds_left, 5);
  });

  it('reports a seat that is on its way back', () => {
    const s = state();
    assert.equal(observation(s, DATA).reconnecting, undefined);
    s.connection.reconnecting = true;
    assert.equal(observation(s, DATA).reconnecting, true);
  });

  it('renders what the match drew', () => {
    const s = state();
    Object.assign(s.last['m.public'], {
      lastRound: 14, bossRound: 14, hiddenRound: 15, factions: ['f1'], disabledBonds: ['shield'],
      bannedChess: ['chess_a', 'chess_a_b'], bossId: 'boss_1', hiddenBossId: null,
    });
    const data = { ...DATA, chess: { ...DATA.chess, chess_a_b: { name: '角峰' } }, bosses: { boss_1: { name: '假想敌', enemyKey: 'enemy_1' } } };
    assert.deepEqual(observation(s, data, { detail: 'compact' }).setup, {
      last_round: 14, boss_round: 14, hidden_round: 15, factions: ['f1'], disabled_bonds: ['坚守'], banned_chess: ['角峰'],
      boss: { id: 'boss_1', name: '假想敌', enemy: 'enemy_1' },
    });
    assert.equal(observation({}, data).setup, undefined);
  });

  it('renders the 联防 and the Final Assault as the status bars show them', () => {
    const s = state();
    Object.assign(s.last['m.public'], {
      phase: 'FINAL_ASSAULT', serverNow: 1_000, overtimeAt: 31_000, teamLp: 40, bossHp: { hp: 900, max: 1_000 },
      unite: { helpers: ['p1'], leakers: ['p2'] },
      uniteResult: { through: 2, helpers: ['p1'], leakers: ['p2'], losses: { p2: 2 } },
      fields: [{ fieldId: 'b1', kind: 'boss', players: ['p1', 'p2'], live: true, progress: { killed: 1, total: 3, done: false } }],
    });
    const obs = observation(s, DATA, { detail: 'compact' });
    assert.deepEqual(obs.unite, { helpers: ['p1'], leakers: ['p2'] });
    assert.deepEqual(obs.unite_result.losses, { p2: 2 });
    assert.deepEqual(obs.boss_hp, { hp: 900, max: 1_000 });
    assert.equal(obs.team_lp, 40);
    assert.equal(obs.overtime_in_s, 30);
    assert.deepEqual(obs.fields[0].players, ['p1', 'p2']);
    assert.equal(obs.fields[0].progress.killed, 1);
    const quiet = observation(state(), DATA, { detail: 'compact' });
    for (const key of ['unite', 'unite_result', 'boss_hp', 'team_lp', 'overtime_in_s', 'fields']) assert.equal(quiet[key], undefined, key);
  });

  it('renders the last prep scout with its pieces joined', () => {
    const s = state();
    s.connection.frameAgesMs = { 'm.field': 1_500 };
    s.last['m.public'].players = [{ playerId: 'p2', name: '乙' }];
    s.last['m.field'] = {
      t: 'm.field', fieldId: 'n:p2', kind: 'normal', stageId: 's1', prep: true,
      units: [
        { kind: 'op', defId: 'chess_a', area: 'board', x: 7, y: 9, dir: 'RIGHT', side: 'ally' },
        { kind: 'item', defId: 'item_a', area: 'hand', x: 0, y: 7, side: 'ally' },
      ],
      effects: [{ name: '悬赏', desc: 'd', counter: 2 }],
      nextEnemies: [{ enemyKey: 'e1', t: 3, count: 2, fly: true }],
    };
    const data = { ...DATA, items: { item_a: { name: '头盔', tier: 2, desc: 'hp' } } };
    const full = observation(s, data).scouted;
    assert.equal(full.units[0].name, '角峰');
    const obs = observation(s, data, { detail: 'compact' });
    assert.equal(obs.scouted_age_ms, 1_500);
    assert.equal(obs.scouted.playerId, 'p2');
    assert.equal(obs.scouted.name, '乙');
    assert.deepEqual(obs.scouted.units[0], { id: 'chess_a', kind: 'chess', area: 'board', row: 9, col: 7, dir: 'RIGHT' });
    assert.equal(obs.scouted.units[1].area, 'hand');
    assert.equal(obs.catalog['item:item_a'].name, '头盔');
    assert.equal(obs.scouted.effects[0].counter, 2);
    assert.deepEqual(obs.scouted.next_enemies, [{ key: 'e1', at_s: 3, count: 2, fly: true }]);
    assert.equal(observation(state(), data, { detail: 'compact' }).scouted, undefined);
    s.last['m.field'].prep = false;
    assert.equal(observation(s, data).scouted, undefined, 'a live field is the battle, not a scout');
  });

  it('renders the settlement only while it describes the match', () => {
    const s = state();
    const stats = { dmgDealt: 10, bossDamage: 7, kills: 0 };
    s.last['m.result'] = {
      t: 'm.result', victory: true, roundsPassed: 14, reason: 'clear', hiddenReached: false, hiddenCleared: false, teamLp: 12, seed: 42, durationMs: 9,
      players: [{
        playerId: 'p1', seat: 0, name: '甲', isBot: false, left: false, alive: true, victory: true, roundsPassed: 14, creditedKills: 3, eliminatedRound: null,
        lp: 12, bandId: 'band_a', stats, title: null,
        bonds: [{ bondId: 'shield', layers: 4, tier: 1 }],
        lineup: [{ id: 'chess_a', golden: false, tier: 1, row: 9, col: 7, items: ['item_a'] }],
      }],
    };
    assert.equal(observation(s, DATA).result, undefined, 'a later match in the same room is not over');
    s.last['m.public'].phase = 'RESULT';
    const { result } = observation(s, { ...DATA, items: { item_a: { name: '头盔' } } }, { detail: 'compact' });
    assert.equal(result.victory, true);
    assert.equal(result.seed, 42);
    assert.deepEqual(result.players[0].stats, stats, 'bossDamage among them');
    assert.deepEqual(result.players[0].bonds, [{ id: 'shield', bond: '坚守', layers: 4, tier: 1 }]);
    assert.deepEqual(result.players[0].lineup, [{ id: 'chess_a', name: '角峰', tier: 1, row: 9, col: 7, items: ['头盔'] }]);
    assert.equal(result.players[0].left, undefined);
  });

  it('renders what passed by, with emotes named and labelled', () => {
    const s = state();
    s.last['m.public'].players = [{ playerId: 'p2', name: '乙' }];
    s.messages = [
      { id: 1, at: 100, round: 3, frame: { t: 'm.toast', kind: 'warn', text: '提示', msgid: 'x' } },
      { id: 2, at: 101, round: 3, frame: { t: 'm.ticker', text: '播报', playerId: null, type: 'CUSTOM' } },
      { id: 3, at: 102, round: 3, frame: { t: 'm.emote', playerId: 'p2', id: 'autochess_battle_thanks' } },
      { id: 4, at: 103, round: 3, frame: { t: 'm.emote', playerId: 'p2', id: 'autochess_battle_fooldoctor_01' } },
      { id: 5, at: 104, round: null, frame: { t: 'room.closed', reason: 'kicked' } },
    ];
    const { messages } = observation(s, DATA, { detail: 'compact' });
    assert.deepEqual(messages[0], { id: 1, at: 100, round: 3, type: 'toast', kind: 'warn', text: '提示' });
    assert.deepEqual(messages[1], { id: 2, at: 101, round: 3, type: 'ticker', text: '播报' });
    assert.deepEqual(messages[2], { id: 3, at: 102, round: 3, type: 'emote', playerId: 'p2', name: '乙', emote: 'autochess_battle_thanks', label: '谢谢' });
    assert.equal(messages[3].label, undefined, 'a numbered sticker carries no meaning');
    assert.deepEqual(messages[4], { id: 5, at: 104, type: 'room_closed', reason: 'kicked' });
    assert.equal(observation(state(), DATA, { detail: 'compact' }).messages, undefined);
    assert.deepEqual(observation(state(), DATA).messages, []);
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

describe('comms', () => {
  const me = { playerId: 'p1', name: '甲', ready: false };
  const mate = { playerId: 'p2', name: '乙', ready: false };
  const bot = { playerId: 'b1', name: 'AI', isBot: true, ready: true };
  const pub = (phase, round, ...others) => ({ phase, round, players: [me, ...others] });
  const emote = (at, round, playerId, id) => ({ id: at, at, round, frame: { t: 'm.emote', playerId, id } });

  it('stays out of solo, an all-AI table and the result screen', () => {
    assert.equal(commsView(pub('PREP', 3), [], null, 'p1'), null);
    assert.equal(commsView(pub('PREP', 3, bot), [], null, 'p1'), null);
    assert.equal(commsView(pub('RESULT', 3, mate), [], null, 'p1'), null);
    assert.equal(commsView({}, [], null, 'p1'), null);
  });

  it('counts the rounds since this seat last spoke', () => {
    assert.deepEqual(commsView(pub('PREP', 4, mate), [], null, 'p1'), { rounds_silent: 4 });
    assert.deepEqual(commsView(pub('PREP', 4, mate), [], { at: 5, round: 4 }, 'p1'), { rounds_silent: 0 });
    assert.deepEqual(commsView(pub('COMBAT', 7, mate), [], { at: 5, round: 4 }, 'p1'), { rounds_silent: 3 });
  });

  it('offers a reply to the newest emote of each teammate, once this seat is the one to answer', () => {
    const messages = [emote(10, 3, 'p2', 'autochess_battle_happy'), emote(11, 3, 'p2', 'slug_autochess_battle_thanks')];
    assert.deepEqual(commsView(pub('COMBAT', 3, mate), messages, null, 'p1').reply_to, [{ name: '乙', label: '谢谢！', reply: 'autochess_battle_noproblem' }]);
    // an emote from before this seat last spoke is answered already
    assert.equal(commsView(pub('COMBAT', 4, mate), messages, { at: 12, round: 3 }, 'p1').reply_to, undefined);
  });

  it('reads last round’s emote in this round’s prep and lets an older one go', () => {
    const said = [emote(10, 3, 'p2', 'autochess_battle_thanks')];
    assert.equal(commsView(pub('PREP', 4, mate), said, null, 'p1').reply_to.length, 1);
    assert.equal(commsView(pub('PREP', 5, mate), said, null, 'p1').reply_to, undefined);
  });

  it('never answers an AI teammate, a numbered sticker or itself, so nothing goes round in circles', () => {
    const messages = [
      emote(10, 3, 'b1', 'autochess_battle_happy'),
      emote(11, 3, 'p1', 'autochess_battle_happy'),
      emote(12, 3, 'p2', 'autochess_battle_fooldoctor_01'),
    ];
    assert.equal(commsView(pub('PREP', 3, mate, bot), messages, null, 'p1').reply_to, undefined);
  });

  it('holds replies back once this seat has spoken this round, so two agents cannot chain them', () => {
    const answer = [emote(20, 3, 'p2', 'autochess_battle_happy')];
    assert.equal(commsView(pub('COMBAT', 3, mate), answer, { at: 10, round: 3 }, 'p1').reply_to, undefined);
    assert.equal(commsView(pub('PREP', 4, mate), answer, { at: 10, round: 3 }, 'p1').reply_to.length, 1);
  });

  it('says when the table waits on this seat alone', () => {
    const ready = { ...mate, ready: true };
    assert.equal(commsView(pub('PREP', 2, ready), [], null, 'p1').waiting_on_me, true);
    assert.equal(commsView(pub('INFO_CHECK', 1, ready), [], null, 'p1').waiting_on_me, true);
    assert.equal(commsView(pub('PREP', 2, mate), [], null, 'p1').waiting_on_me, undefined);
    assert.equal(commsView(pub('COMBAT', 2, ready), [], null, 'p1').waiting_on_me, undefined);
    assert.equal(commsView({ phase: 'PREP', round: 2, players: [{ ...me, ready: true }, ready] }, [], null, 'p1').waiting_on_me, undefined);
    // a teammate who is gone is not waiting
    assert.equal(commsView(pub('PREP', 2, ready, { playerId: 'p3', ready: false, alive: false }), [], null, 'p1').waiting_on_me, true);
    assert.equal(commsView(pub('PREP', 2, { ...mate, connected: false }), [], null, 'p1').waiting_on_me, undefined);
  });

  it('reaches observe, and marks this seat’s own emote in messages', () => {
    const s = state();
    s.connection.playerId = 'p1';
    s.playerId = 'p1';
    s.last['m.private'].playerId = 'p1';
    s.last['m.public'].players = [{ ...me }, { ...mate }];
    s.messages = [emote(10, 3, 'p1', 'autochess_battle_thanks')];
    s.lastEmote = { at: 10, round: 3 };
    const obs = observation(s, DATA, { detail: 'compact' });
    assert.deepEqual(obs.comms, { rounds_silent: 0 });
    assert.equal(obs.messages[0].mine, true);
  });
});
