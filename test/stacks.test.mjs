import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bondEffect, MESSAGE_LIMIT, observation } from '../mcp/observation.js';
import { registerTools } from '../mcp/tools.js';

/** Bond records cut down from the game's data/bonds.json (0.3.1): the effect text, its parameters and the numbers. */
const YAN = {
  bondId: 'yanShip', name: '炎', thresholds: [3, 6, 9], countMode: 'BOARD',
  effectDesc: '【炎】干员攻击力+{0:0%}（受层数影响）\n<在场6名不同【炎】干员>战斗开始时收集【炎】干员部分属性召唤“炎佑”',
  effectDescParams: [{ index: 0, format: '0%', base: 'base_atk', perStack: 'atk_per_stack' }],
  bb: { base_atk: 0.23, atk_per_stack: 0.009 },
};
const STEAD = {
  bondId: 'steadShip', name: '坚守', thresholds: [2, 3], countMode: 'BOARD',
  effectDesc: '所有干员生命值+{0:0%}（受层数影响）\n<在场3名不同【坚守】干员>【坚守】干员受到伤害时，伤害来源受到{1:0}点法术伤害（受层数影响，每0.2秒至多触发1次）',
  effectDescParams: [
    { index: 0, format: '0%', base: 'base_max_hp', perStack: 'max_hp_per_stack' },
    { index: 1, format: '0', base: 'base_damage_value', perStack: 'damage_value_per_stack' },
  ],
  bb: { base_max_hp: 0.25, max_hp_per_stack: 0.012, base_damage_value: 850, damage_value_per_stack: 10 },
};
const SWIFT = {
  bondId: 'swiftShip', name: '迅捷', thresholds: [2], countMode: 'BOARD',
  effectDesc: '【迅捷】干员技能结束时有{0:0%}概率（受层数影响）立刻回复12点技力',
  effectDescParams: [{ index: 0, format: '0%', base: 'base_prob', perStack: 'prob_per_stack' }],
  bb: { base_prob: 0.2, prob_per_stack: 0.0035 },
};

const DATA = {
  bonds: { yanShip: YAN, steadShip: STEAD, swiftShip: SWIFT },
  chess: {
    cliff: { chessId: 'cliff', baseId: 'cliff', name: '断崖', position: 'MELEE', dmgType: 'phys', stats: { blockCnt: 2 }, bonds: ['steadShip'], garrisonIds: ['g_cliff'] },
    gunner: { chessId: 'gunner', baseId: 'gunner', name: '灰毫', position: 'MELEE', dmgType: 'phys', stats: { blockCnt: 2 }, bonds: ['steadShip'], garrisonIds: [] },
    rose: { chessId: 'rose', baseId: 'rose', name: '刺玫', position: 'RANGED', dmgType: 'phys', stats: { blockCnt: 0 }, bonds: ['yanShip'], garrisonIds: ['g_rose'] },
    snow: { chessId: 'snow', baseId: 'snow', name: '雪猎', position: 'RANGED', dmgType: 'phys', stats: { blockCnt: 0 }, bonds: ['yanShip'], garrisonIds: ['g_snow'] },
    diver: { chessId: 'diver', baseId: 'diver', name: '深巡', position: 'MELEE', dmgType: 'phys', stats: { blockCnt: 3 }, bonds: ['egirShip'], garrisonIds: [] },
  },
  garrisons: {
    g_cliff: { desc: '<休整期结束时>使自身及身后一格干员的已激活盟约分别各层数+3' },
    g_rose: { desc: '<休整期结束时>使已激活的【炎】层数+1' },
    g_snow: { desc: '<获得时>自身所属盟约层数+5（无需激活盟约）' },
  },
  items: {
    doll: { name: '精打细算玩偶', itemType: 'EQUIP', desc: '装备时销毁，之后每回合开始时额外获得1资金' },
    scroll: { name: '画卷', itemType: 'MAGIC', desc: '拖拽至场上使用后，获得范围内的干员（包括精锐状态和装备！）' },
    hammer: { name: '维式重锤', itemType: 'EQUIP', desc: '攻击力+15%' },
  },
  config: { economy: { mergeCount: 3 } },
};

function state({ pub = {}, priv = {}, messages } = {}) {
  return {
    connection: { connected: true, framesAgeMs: 1 },
    messages,
    last: {
      'm.public': { phase: 'PREP', round: 9, players: [], ...pub },
      'm.private': { funds: 0, deployCap: 8, deployCount: 3, bandId: 'band_x', shop: { slots: [] }, hand: [], temp: [], bonds: [], nextEnemies: [], board: [], ...priv },
    },
  };
}

const at = (uid, id, row, col) => ({ uid, kind: 'chess', id, row, col, dir: 'RIGHT', items: [] });
const has = (lines, text) => assert.ok(lines.includes(text), `${text} in ${JSON.stringify(lines)}`);

describe('what the layers are worth', () => {
  it('reads a bond card at its layers, the way the game shows it', () => {
    assert.deepEqual(bondEffect(YAN, 50, 3), { effect: '【炎】干员攻击力+68%（受层数影响）', per_layer: '+0.9%' });
    assert.deepEqual(bondEffect(YAN, 0, 3), { effect: '【炎】干员攻击力+23%（受层数影响）', per_layer: '+0.9%' });
  });

  it('adds a head-count line once enough members stand on the board', () => {
    assert.equal(bondEffect(STEAD, 51, 2).effect, '所有干员生命值+86%（受层数影响）');
    assert.equal(bondEffect(STEAD, 51, 3).effect, '所有干员生命值+86%（受层数影响）；<在场3名不同【坚守】干员>【坚守】干员受到伤害时，伤害来源受到1360点法术伤害（受层数影响，每0.2秒至多触发1次）');
    assert.equal(bondEffect(STEAD, 51, 3).per_layer, '+1.2%、+10');
  });

  it('stops a chance at 100%', () => {
    assert.equal(bondEffect(SWIFT, 300, 2).effect, '【迅捷】干员技能结束时有100%概率（受层数影响）立刻回复12点技力');
  });

  it('leaves a bond without layer numbers alone', () => {
    assert.equal(bondEffect({ effectDesc: '激活时使核心盟约人数+1' }, 10, 1), null);
    assert.equal(bondEffect(undefined, 10, 1), null);
  });

  it('puts the effect on every bond of the observation', () => {
    const bonds = [{ bondId: 'yanShip', count: 3, active: true, tier: 1, layers: 50 }];
    for (const detail of ['compact', 'full']) {
      const [yan] = observation(state({ priv: { bonds } }), DATA, { env: {}, detail }).bonds;
      assert.equal(yan.effect, '【炎】干员攻击力+68%（受层数影响）');
      assert.equal(yan.per_layer, '+0.9%');
    }
  });
});

describe('checks on layers, the board and the bench', () => {
  const checks = (s) => observation(s, DATA, { env: {} }).checks;

  it('sets the top bonds beside the built-in AI\'s layers', () => {
    const bonds = [
      { bondId: 'steadShip', count: 2, active: true, tier: 1, layers: 51 },
      { bondId: 'yanShip', count: 3, active: true, tier: 1, layers: 60 },
      { bondId: 'swiftShip', count: 2, active: true, tier: 1, layers: 2 },
    ];
    has(checks(state({ priv: { bonds } })), '叠层 【炎】60 层：【炎】干员攻击力+77%（每层+0.9%）；【坚守】51 层：所有干员生命值+86%（每层+1.2%）（内置 AI 第 8 回合最高盟约 23 层）');
    const early = checks(state({ pub: { round: 3 }, priv: { bonds } }));
    assert.ok(early.some((line) => line.startsWith('叠层 【炎】60 层') && !line.includes('内置 AI')));
  });

  it('names the pieces that stack and the ones the layers pass by', () => {
    const bonds = [{ bondId: 'steadShip', count: 2, active: true, tier: 1, layers: 10 }];
    const board = [at(1, 'cliff', 9, 5), at(2, 'gunner', 9, 6), at(3, 'diver', 9, 7)];
    const lines = checks(state({ priv: { bonds, board } }));
    has(lines, '场上叠层干员 1 名：断崖');
    has(lines, '场上 深巡：所属盟约都未激活，在场时特质不加层');
    assert.ok(!lines.some((line) => line.startsWith('场上 灰毫')), 'a member of an active bond');
    has(checks(state({ priv: { board: [at(3, 'diver', 9, 7)] } })), '场上叠层干员 0 名');
  });

  it('counts a stacker only while its trait still adds layers there', () => {
    const board = [at(1, 'rose', 9, 5), at(2, 'snow', 9, 6)];
    const idle = checks(state({ priv: { board, bonds: [{ bondId: 'yanShip', count: 2, active: false, tier: 0, layers: 4 }] } }));
    has(idle, '场上叠层干员 0 名');
    has(idle, '场上 刺玫、雪猎：所属盟约都未激活，在场时特质不加层');
    const live = checks(state({ priv: { board, bonds: [{ bondId: 'yanShip', count: 3, active: true, tier: 1, layers: 4 }] } }));
    has(live, '场上叠层干员 1 名：刺玫（炎）');
    assert.ok(!live.some((line) => line.includes('在场时特质不加层')));
  });

  it('says what each item in the bench does and how it is used', () => {
    const hand = [
      { uid: 5, kind: 'item', id: 'doll', items: [] },
      { uid: 6, kind: 'item', id: 'scroll', items: [] },
      { uid: 7, kind: 'item', id: 'hammer', items: [] },
    ];
    const lines = checks(state({ priv: { hand } }));
    has(lines, '整备区道具 精打细算玩偶（g.equip 生效）：装备时销毁，之后每回合开始时额外获得1资金');
    has(lines, '整备区道具 画卷（g.art 生效）：拖拽至场上使用后，获得范围内的干员（包括精锐状态和装备！）');
    has(lines, '整备区另有 1 件道具：维式重锤');
  });

  it('keeps the item\'s use in the catalog', () => {
    const obs = observation(state({ priv: { hand: [{ uid: 6, kind: 'item', id: 'scroll', items: [] }] } }), DATA, { env: {}, detail: 'compact' });
    assert.equal(obs.catalog['item:scroll'].use, 'g.art');
    assert.equal(obs.hand[0].use, undefined);
  });
});

describe('messages in an observation', () => {
  it('carries this round\'s and the last round\'s, the newest few', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, at: i, round: i < 10 ? 6 : 8 + (i % 2), frame: { t: 'toast', text: `m${i}` } }));
    const shown = observation(state({ messages }), DATA, { env: {}, detail: 'full' }).messages;
    assert.equal(shown.length, MESSAGE_LIMIT);
    assert.ok(shown.every((m) => m.round >= 8));
    assert.equal(shown.at(-1).id, 30);
  });
});

describe('observe within one phase', () => {
  function tools(snapshot) {
    const map = new Map();
    const client = { snapshot: () => snapshot.current, connected: true };
    registerTools({ registerTool: (name, _meta, handler) => map.set(name, handler) }, client, { env: {}, gameData: async () => DATA });
    return map.get('stronghold_observe');
  }

  it('answers a repeat call with what changed, and a new phase whole', async () => {
    const snapshot = { current: state({ priv: { funds: 5 } }) };
    const observe = tools(snapshot);
    const first = (await observe({})).structuredContent;
    assert.equal(first.since, undefined);
    snapshot.current = state({ priv: { funds: 2 } });
    const second = (await observe({})).structuredContent;
    assert.equal(second.since, first.rev);
    assert.equal(second.me.funds, 2);
    assert.ok(second.unchanged.includes('board'));
    assert.equal(second.board, undefined);

    const whole = (await observe({ resync: true })).structuredContent;
    assert.equal(whole.since, undefined);
    assert.deepEqual(whole.board, []);

    snapshot.current = state({ pub: { phase: 'COMBAT' }, priv: { funds: 2 } });
    const combat = (await observe({})).structuredContent;
    assert.equal(combat.since, undefined);
    assert.ok(combat.board);
  });

  it('takes a different detail as a fresh start', async () => {
    const snapshot = { current: state() };
    const observe = tools(snapshot);
    await observe({});
    const full = (await observe({ detail: 'full' })).structuredContent;
    assert.equal(full.since, undefined);
  });
});
