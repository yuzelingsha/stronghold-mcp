import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { disabledBondSets, enemyScale, field, observation, spDraft } from '../mcp/observation.js';

const DATA = {
  chess: {
    guard: { chessId: 'guard', baseId: 'guard', name: '角峰', position: 'MELEE', dmgType: 'phys', attackKind: 'melee', canHitFly: false, stats: { blockCnt: 3 }, bonds: ['stead'], rangeGrid: [[0, 0], [0, 1]] },
    guard_e: { chessId: 'guard_e', baseId: 'guard', name: '角峰', isGolden: true, position: 'MELEE', dmgType: 'phys', stats: { blockCnt: 3 }, bonds: ['stead'], rangeGrid: [[0, 0], [0, 1]] },
    sniper: { chessId: 'sniper', baseId: 'sniper', name: '能天使', position: 'RANGED', dmgType: 'phys', attackKind: 'ranged', canHitFly: true, stats: { blockCnt: 0 }, bonds: ['swift'], rangeGrid: [[0, 1]] },
    medic: { chessId: 'medic', baseId: 'medic', name: '华法琳', position: 'RANGED', dmgType: 'heal', attackKind: 'heal', stats: { blockCnt: 0 }, bonds: ['arts'], rangeGrid: [[0, 1]] },
    trio: { chessId: 'trio', baseId: 'trio', name: '三名', position: 'RANGED', dmgType: 'arts', stats: { blockCnt: 0 }, bonds: ['stead'], rangeGrid: [[0, 1]] },
    pair: { chessId: 'pair', baseId: 'pair', name: '对子', upgradeNum: 2, position: 'RANGED', dmgType: 'arts', stats: { blockCnt: 0 }, bonds: [], rangeGrid: [[0, 1]] },
  },
  items: { sword: { name: '重刃' } },
  bonds: {
    stead: { bondId: 'stead', name: '坚守', thresholds: [3, 6], countMode: 'BOARD' },
    swift: { bondId: 'swift', name: '迅捷', thresholds: [2, 4], countMode: 'BOARD' },
    arts: { bondId: 'arts', name: '绝技', thresholds: [2], countMode: 'BOARD_ALL_CHESS' },
    solo: { bondId: 'solo', name: '独行', thresholds: [1], maxCount: 1, countMode: 'BOARD', thresholdTemplate: 'count_threshold_downward' },
  },
  enemies: {
    bug: { name: '源石虫', stats: { maxHp: 1000, atk: 100, def: 10, res: 0 } },
    drone: { name: '无人机', isFlyEnemy: true, stats: { maxHp: 500, atk: 50, motion: 'FLY' } },
    leader: { name: '假想敌', stats: { maxHp: 90000, atk: 900 } },
  },
  tokens: {},
  config: {
    economy: { mergeCount: 3, leftoverFundsKeptByBands: ['band_keep'] },
    modes: { mode_m: { enemyScale: { 3: { hp: 4.299817, atk: 1.61051, speed: 1.15 } } } },
  },
  stages: {
    s1: {
      rows: Array.from({ length: 14 }, () => 'x'.repeat(14)),
      deployTiles: { normal: { melee: [], rangedOnly: [] } },
      groundPaths: { road: [[9, 10], [9, 2]] },
      groundPathsWithDevices: { road: [[9, 10], [10, 9], [10, 3], [9, 2]] },
    },
  },
};

function state({ pub = {}, priv = {} } = {}) {
  return {
    connection: { connected: true, framesAgeMs: 1 },
    last: {
      'm.public': { phase: 'PREP', round: 3, modeId: 'mode_m', stageId: 's1', players: [], ...pub },
      'm.private': {
        funds: 0, deployCap: 2, deployCount: 2, bandId: 'band_x', shop: { slots: [] }, hand: [{}], temp: [], bonds: [], nextEnemies: [],
        board: [
          { uid: 1, kind: 'chess', id: 'guard', row: 10, col: 3, dir: 'RIGHT', items: [] },
          { uid: 2, kind: 'chess', id: 'sniper', row: 11, col: 3, dir: 'DOWN', items: [] },
        ],
        ...priv,
      },
    },
  };
}

const checks = (s, detail = 'compact') => observation(s, DATA, { env: {}, detail }).checks;
const has = (lines, text) => assert.ok(lines.includes(text), `${text} in ${JSON.stringify(lines)}`);

describe('what a player sees of the enemies', () => {
  it('walks the lanes the devices leave open', () => {
    assert.deepEqual(field(DATA, 's1').lanes[0].tiles, [[9, 10], [10, 9], [10, 3], [9, 2]]);
    assert.equal(field(DATA, 's1').lanes[0].len, 4);
    const plain = { stages: { s1: { ...DATA.stages.s1, groundPathsWithDevices: undefined } } };
    assert.deepEqual(field(plain, 's1').lanes[0].tiles, [[9, 10], [9, 2]]);
  });

  it('reads the round\'s multipliers', () => {
    assert.deepEqual(enemyScale(DATA, { modeId: 'mode_m', round: 3 }), { hp: 4.299817, atk: 1.61051, speed: 1.15 });
    assert.equal(enemyScale(DATA, { modeId: 'mode_m', round: 4 }), null);
    assert.equal(enemyScale({}, { modeId: 'mode_m', round: 3 }), null);
  });

  it('gives each enemy its real strength, and leaves the leader\'s pool alone', () => {
    const wave = [{ enemyKey: 'bug', count: 2 }, { enemyKey: 'drone', count: 1, source: 'bounty' }, { enemyKey: 'leader', count: 1, boss: true }];
    for (const detail of ['compact', 'full']) {
      const obs = observation(state({ priv: { nextEnemies: wave } }), DATA, { env: {}, detail });
      assert.deepEqual([obs.next_enemies[0].hp_now, obs.next_enemies[0].atk_now], [4300, 161]);
      assert.equal(obs.next_enemies[1].bounty, true);
      assert.equal(obs.next_enemies[2].hp_now, undefined);
    }
    const compact = observation(state({ priv: { nextEnemies: wave } }), DATA, { env: {}, detail: 'compact' });
    assert.equal(compact.catalog['enemy:bug'].hp, 1000);
    assert.deepEqual(compact.enemy_scale, { hp: 4.299817, atk: 1.61051, speed: 1.15 });
  });

  it('shows what a bounty card brings', () => {
    const sp = { eventId: 'e', cards: [{ idx: 0, kind: 'bounty', id: 'c', name: '悬赏', enemyKey: 'bug', count: 2, rounds: 2, coin: 3, payout: 'kill' }, { idx: 1, kind: 'tactic', id: 't', team: true }, { idx: 2, kind: 'item', id: 'sword' }] };
    const [bounty, tactic, item] = spDraft({ sp }, 'me', DATA, { hp: 2, atk: 3, speed: 1 }).cards;
    assert.deepEqual([bounty.enemy, bounty.enemy_key, bounty.count, bounty.rounds, bounty.coin, bounty.hp_now, bounty.atk_now, bounty.fly], ['源石虫', 'bug', 2, 2, 3, 2000, 300, false]);
    assert.equal(tactic.team, true);
    assert.equal(item.enemy_key, undefined);
  });
});

describe('the two kinds of disabled bond', () => {
  const data = { ...DATA, config: { ...DATA.config, modes: { mode_m: { ...DATA.config.modes.mode_m, inactiveBondIds: ['arts'] } } } };
  const pub = { disabledBonds: ['arts', 'stead', 'swift'], drawnDisabledBonds: ['stead', 'swift'] };

  it('tells a mode\'s closed bonds from the ones drawn for this match, as the game\'s screens do', () => {
    assert.deepEqual([...disabledBondSets(data, { ...pub, modeId: 'mode_m' }).off], ['arts']);
    assert.deepEqual([...disabledBondSets(data, { ...pub, modeId: 'mode_m' }).drawn], ['stead', 'swift']);
    // older frames: disabledBonds minus the static list
    assert.deepEqual([...disabledBondSets(data, { disabledBonds: ['arts', 'stead'], modeId: 'mode_m' }).drawn], ['stead']);
  });

  it('marks a drawn bond as a thinner pool, and it stays a live bond', () => {
    const bonds = [{ bondId: 'stead', count: 2, active: true, tier: 1, layers: 40 }, { bondId: 'arts', count: 1, active: false, tier: 0, layers: 3, off: true }];
    const obs = observation(state({ pub, priv: { bonds } }), data, { env: {}, detail: 'full' });
    const byId = Object.fromEntries(obs.bonds.map((b) => [b.id, b]));
    assert.deepEqual([byId.stead.disabled_this_match, byId.stead.partial_pool], [false, true]);
    assert.deepEqual([byId.arts.disabled_this_match, byId.arts.partial_pool], [true, false]);
    assert.deepEqual(obs.setup.disabled_bonds, ['绝技']);
    assert.deepEqual(obs.setup.partial_pool_bonds, ['坚守', '迅捷']);
  });

  it('keeps a drawn bond in the checks', () => {
    const bonds = [{ bondId: 'stead', count: 2, active: false, tier: 0, layers: 40 }];
    has(observation(state({ pub, priv: { bonds } }), data, { env: {}, detail: 'compact' }).checks, '【坚守】2/3 人，未激活，累积 40 层当前不生效');
  });

  it('keeps a band that leans on a drawn bond free of off_bonds', () => {
    const bands = { band_a: { bandId: 'band_a', name: '甲', bondIds: ['stead'], modeTypeList: ['SINGLE'] }, band_b: { bandId: 'band_b', name: '乙', bondIds: ['arts'], modeTypeList: ['SINGLE'] } };
    const obs = observation({ ...state({ pub: { ...pub, phase: 'BAND_DRAFT' } }) }, { ...data, bands }, { env: {}, detail: 'full' });
    const off = Object.fromEntries(obs.band_draft.options.map((b) => [b.id, b.off_bonds]));
    assert.equal(off.band_a, undefined);
    assert.deepEqual(off.band_b, ['绝技']);
  });
});

describe('checks', () => {
  it('appears during prep only', () => {
    assert.ok(Array.isArray(checks(state())));
    assert.equal(checks(state({ pub: { phase: 'COMBAT' } })), undefined);
  });

  it('sizes up the wave with the multipliers, the leader apart', () => {
    const lines = checks(state({ priv: { nextEnemies: [{ enemyKey: 'bug', count: 2 }, { enemyKey: 'leader', count: 1, boss: true }] } }));
    has(lines, '本回合敌人 3 只，总生命约 8600，领袖另计（生命×4.3，攻击×1.61，移速×1.15）');
  });

  it('flags layers lying idle in an inactive bond', () => {
    const bonds = [
      { bondId: 'stead', count: 2, active: false, tier: 0, layers: 80 },
      { bondId: 'swift', count: 2, active: true, tier: 1, layers: 9 },
      { bondId: 'solo', count: 2, active: false, tier: 0, layers: 5 },
      { bondId: 'arts', count: 1, active: false, tier: 0, layers: 5, off: true },
    ];
    const lines = checks(state({ priv: { bonds } }));
    has(lines, '【坚守】2/3 人，未激活，累积 80 层当前不生效');
    has(lines, '【独行】2 人，未激活，累积 5 层当前不生效');
    assert.equal(lines.filter((line) => line.includes('绝技')).length, 0);
    assert.equal(lines.filter((line) => line.includes('迅捷')).length, 0);
  });

  it('counts copies of one operator once, elites included', () => {
    const board = [
      { uid: 1, kind: 'chess', id: 'guard', row: 10, col: 3, dir: 'RIGHT', items: [] },
      { uid: 2, kind: 'chess', id: 'guard_e', row: 10, col: 4, dir: 'RIGHT', items: [] },
    ];
    has(checks(state({ priv: { board } })), '角峰 场上 2 张，盟约按 1 人计');
  });

  it('points at the last copy of a merge, and the funds it lacks', () => {
    const hand = [{ uid: 3, kind: 'chess', id: 'sniper', items: [] }];
    const slots = [{ kind: 'chess', id: 'sniper', price: 3 }];
    has(checks(state({ priv: { hand, funds: 1, shop: { slots: [null, ...slots] } } })).slice(), '商店第 1 格 能天使 是最后一张，合成精锐（差 2 资金）');
    assert.ok(!checks(state({ priv: { shop: { slots } } })).some((line) => line.includes('合成')), 'one copy owned, two more to go');
  });

  it('follows an operator\'s own merge count', () => {
    const slots = [{ kind: 'chess', id: 'pair', price: 1 }];
    const hand = [{ uid: 3, kind: 'chess', id: 'pair', items: [] }];
    has(checks(state({ priv: { hand, funds: 5, shop: { slots } } })), '商店第 0 格 对子 是最后一张，合成精锐');
  });

  it('names the new operator that reaches the next threshold', () => {
    const bonds = [{ bondId: 'stead', count: 2, active: false, tier: 0, layers: 0 }];
    const board = [
      { uid: 1, kind: 'chess', id: 'guard', row: 10, col: 3, dir: 'RIGHT', items: [] },
      { uid: 2, kind: 'chess', id: 'guard', row: 10, col: 4, dir: 'RIGHT', items: [] },
    ];
    const shop = { slots: [{ kind: 'chess', id: 'guard', price: 2 }, { kind: 'chess', id: 'trio', price: 2 }] };
    const lines = checks(state({ priv: { bonds, board, shop, funds: 9 } }));
    has(lines, '商店第 1 格 三名 使【坚守】达到 3 人');
    assert.ok(!lines.some((line) => line.includes('商店第 0 格 角峰 使')), 'a counted operator adds nobody');
    const bench = checks(state({ priv: { bonds, board, hand: [{ uid: 9, kind: 'chess', id: 'trio', items: [] }] } }));
    has(bench, '整备区 三名 上场使【坚守】达到 3 人');
  });

  it('leaves the thresholds of downward and elite-count bonds alone', () => {
    const bonds = [{ bondId: 'arts', count: 1, active: false, tier: 0, layers: 0 }, { bondId: 'solo', count: 0, active: false, tier: 0, layers: 0 }];
    const shop = { slots: [{ kind: 'chess', id: 'medic', price: 2 }] };
    assert.ok(!checks(state({ priv: { bonds, shop } })).some((line) => line.includes('达到')));
  });

  it('sees who covers the road', () => {
    const board = [
      { uid: 1, kind: 'chess', id: 'guard', row: 12, col: 12, dir: 'RIGHT', items: [] },
      { uid: 2, kind: 'chess', id: 'sniper', row: 12, col: 2, dir: 'LEFT', items: [] },
      { uid: 3, kind: 'chess', id: 'medic', row: 12, col: 5, dir: 'LEFT', items: [] },
      { uid: 4, kind: 'chess', id: 'trio', row: 11, col: 3, dir: 'DOWN', items: [] },
    ];
    const lines = checks(state({ priv: { board } }));
    has(lines, '角峰 站在敌人路线之外，阻挡不到地面敌人');
    has(lines, '能天使 的攻击范围覆盖 0 格敌人路线');
    assert.ok(!lines.some((line) => line.includes('华法琳')), 'a healer covers allies');
    assert.ok(!lines.some((line) => line.includes('三名')), 'it covers the road');
  });

  it('leaves the boss field to the player', () => {
    const board = [{ uid: 1, kind: 'chess', id: 'guard', row: 12, col: 12, dir: 'RIGHT', items: [] }];
    assert.ok(!checks(state({ pub: { round: 14, bossRound: 14 }, priv: { board } })).some((line) => line.includes('路线')));
  });

  it('counts anti-air against the flyers', () => {
    has(checks(state({ priv: { nextEnemies: [{ enemyKey: 'drone', count: 4 }] } })), '本回合空中敌人 4 只，场上可对空 1 名');
  });

  it('lists room on the board, gear, a full bench and funds about to vanish', () => {
    const hand = [{ uid: 7, kind: 'item', id: 'sword', items: [] }];
    const lines = checks(state({ priv: { deployCount: 1, deployCap: 8, funds: 4, hand } }));
    has(lines, '场上 1/8，还能上 7 名');
    has(lines, '整备区有 1 件装备待穿戴：重刃');
    has(lines, '整备区已满，买入前先卖出或上场');
    has(lines, '资金 4，休整期结束时清零，买入或刷新用完（刷新 1 资金一次）');
  });

  it('puts funds about to vanish ahead of the rest of the work', () => {
    const lines = checks(state({ priv: { deployCount: 1, deployCap: 8, funds: 4, nextEnemies: [{ enemyKey: 'drone', count: 1 }] } }));
    assert.match(lines[1], /^资金 4/);
  });

  it('counts bench singles and leaves pairs and elites out', () => {
    const piece = (uid, id) => ({ uid, kind: 'chess', id, items: [] });
    const singles = [piece(1, 'trio'), piece(2, 'pair'), piece(3, 'medic'), piece(4, 'sniper')];
    assert.ok(checks(state({ priv: { board: [], hand: singles, hand_free: 3 } })).some((line) => line.startsWith('整备区有 4 张单张干员')));
    const pair = [piece(1, 'trio'), piece(2, 'trio'), piece(3, 'medic'), piece(4, 'sniper'), piece(5, 'guard_e')];
    assert.ok(!checks(state({ priv: { board: [], hand: pair } })).some((line) => line.includes('单张干员')));
  });

  it('keeps funds a band carries over out of it', () => {
    assert.ok(!checks(state({ priv: { funds: 4, bandId: 'band_keep' } })).some((line) => line.includes('清零')));
  });

  it('stays short, keeping the first lines', () => {
    const bonds = Array.from({ length: 20 }, (_, i) => ({ bondId: `b${i}`, count: 1, active: false, tier: 0, layers: 3 }));
    const lines = checks(state({ priv: { bonds, funds: 3 } }));
    assert.equal(lines.length, 14);
  });

  it('works without the data files', () => {
    assert.doesNotThrow(() => observation(state({ priv: { nextEnemies: [{ enemyKey: 'bug', count: 1 }] } }), {}, { env: {} }));
  });

  it('holds affirmative statements of fact', () => {
    const lines = checks(state({ priv: { deployCount: 1, deployCap: 8, funds: 4, nextEnemies: [{ enemyKey: 'drone', count: 4 }] } }));
    for (const line of lines) assert.doesNotMatch(line, /应该|建议|不要/);
  });
});
