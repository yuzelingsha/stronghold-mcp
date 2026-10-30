import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bondScalers, bondStackers, createGuide, genericStackers, guideIndex, guideSections, traitClauses } from '../mcp/guide.js';
import { CHAPTERS } from '../mcp/guide-notes.js';

const DATA = {
  bonds: {
    kazimierzShip: { bondId: 'kazimierzShip', name: '卡西米尔', thresholds: [3, 6], countMode: 'BOARD', desc: 'k', members: ['c_a', 'c_b'] },
    egirShip: { bondId: 'egirShip', name: '阿戈尔', thresholds: [3, 5], countMode: 'BOARD', desc: 'e', members: ['c_e'] },
    investShip: { bondId: 'investShip', name: '投资人', thresholds: [3], countMode: 'BOARD_AND_DECK', desc: 'i', members: [] },
  },
  chess: {
    c_a: { chessId: 'c_a', name: '甲', tier: 1, price: 2, bonds: ['kazimierzShip'], garrisonIds: ['g_a'] },
    c_a_b: { chessId: 'c_a_b', name: '甲', tier: 1, isGolden: true, bonds: ['kazimierzShip'], garrisonIds: ['g_a'] },
    c_b: { chessId: 'c_b', name: '乙', tier: 3, price: 3, bonds: ['kazimierzShip'], garrisonIds: ['g_b'] },
    c_x: { chessId: 'c_x', name: '丙', tier: 2, price: 3, bonds: [], garrisonIds: ['g_x'] },
    c_h: { chessId: 'c_h', name: '隐', tier: 2, isHidden: true, visible: false, bonds: [], garrisonIds: ['g_x'] },
    c_e: { chessId: 'c_e', name: '丁', tier: 2, price: 3, bonds: ['egirShip'], garrisonIds: ['g_e'] },
    c_g: { chessId: 'c_g', name: '戊', tier: 1, price: 2, bonds: [], garrisonIds: ['g_g'] },
  },
  garrisons: {
    g_a: { desc: '<获得时>自身所属盟约层数+2（无需激活盟约）' },
    g_b: { desc: '<部署时>使自身已激活的盟约层数+4' },
    g_x: { desc: '<战斗开始时>使已激活的【卡西米尔】层数+1' },
    g_e: { desc: '<战斗中>自身被击倒时，使已激活的【阿戈尔】层数+3' },
    g_g: { desc: '<休整期结束时>当前激活且层数最多的盟约层数+1' },
  },
  bands: { band_mlynar: { bandId: 'band_mlynar', name: '玛恩纳', totalHp: 24, desc: 'm', bondIds: ['kazimierzShip'] } },
  enemies: {},
  config: {
    economy: { income: [0, 4, 5, 6], incomeCap: 12, refreshPrice: 1, leftoverFundsKeptByBands: ['band_mlynar'], poolCopies: { 1: 12, 3: 18 }, mergeCount: 3, rewardOffer: { count: 3, tierOffset: 1, maxTier: 6 } },
    lpCapPerRound: 10,
    dp: { init: 10, perSec: 1, max: 99 },
    hiddenCore: { single: 350, multi: 1200, minTeamLpExclusive: 1, difficulties: ['NORMAL'] },
    bandDraft: { skipsPerPlayer: 1 },
    modes: {
      m1: { type: 'SINGLE', difficulty: 'NORMAL', lastRound: 3, bossRound: 3, hiddenRound: 4, spRounds: [2], combatTimeLimit: { 1: 45, 2: 45, 3: null }, upgradePrices: [5, 8], maxShopLevel: 3, shopSlots: { 1: { chess: 3, item: 1 } } },
    },
  },
};

function state(phase, priv = {}, pub = {}) {
  return { last: { 'm.public': { phase, round: 3, disabledBonds: [], bannedChess: [], ...pub }, 'm.private': priv } };
}

describe('guide', () => {
  it('derives each bond’s stackers from the operators’ traits', () => {
    assert.deepEqual(bondStackers(DATA, 'kazimierzShip').map((s) => [s.name, s.triggers]), [['甲', ['获得时']], ['丙', ['战斗开始时']], ['乙', ['部署时']]]);
    assert.deepEqual(bondStackers(DATA, 'kazimierzShip', new Set(['c_x'])).map((s) => s.name), ['甲', '乙']);
    assert.deepEqual(genericStackers(DATA).map((s) => s.name), ['戊']);
  });

  it('splits a trait at its top-level triggers and keeps a granted trait with its grant', () => {
    assert.deepEqual(traitClauses('<部署时>使已激活的【卡西米尔】层数+1\n<被击倒时>使已激活的【不屈】层数+2').map((c) => c.tags), [['部署时'], ['被击倒时']]);
    assert.deepEqual(traitClauses('<进入休整期时><休整期结束时>使已激活的【远见】层数+4').map((c) => c.tags), [['进入休整期时', '休整期结束时']]);
    const grant = traitClauses('<战斗开始时>使同一行最右边一名干员获得特质“<部署时>使已激活的【卡西米尔】层数+4”');
    assert.equal(grant.length, 1);
    assert.deepEqual(grant[0].tags, ['战斗开始时']);
  });

  it('gives each bond the trigger of its own clause, and sorts out grants, neighbours and payoffs', () => {
    const data = {
      bonds: {
        k: { bondId: 'k', name: '卡西米尔', isCore: true, members: ['c_gravel'] },
        i: { bondId: 'i', name: '不屈', members: ['c_gravel'] },
        m: { bondId: 'm', name: '奇迹', members: ['c_warfarin'] },
      },
      chess: {
        c_gravel: { chessId: 'c_gravel', name: '砾', tier: 2, bonds: ['k', 'i'], garrisonIds: ['g1'] },
        c_warfarin: { chessId: 'c_warfarin', name: '华法琳', tier: 3, bonds: ['m'], garrisonIds: ['g2'] },
        c_star: { chessId: 'c_star', name: '引星棘刺', tier: 4, bonds: ['m'], garrisonIds: ['g3'] },
        c_mlynar: { chessId: 'c_mlynar', name: '玛恩纳', tier: 6, bonds: ['k'], garrisonIds: ['g4'] },
      },
      garrisons: {
        g1: { desc: '<部署时>使已激活的【卡西米尔】层数+1\n<被击倒时>使已激活的【不屈】层数+2' },
        g2: { desc: '<战斗开始时>使身前一格干员获得特质“开启技能时使自身所属已激活盟约层数+1”' },
        g3: { desc: '<休整期结束时>使自身及身前一格干员的已激活盟约分别各层数+4' },
        g4: { desc: '【卡西米尔】每叠加5层，本干员部署后100秒内基础攻击力+10' },
      },
    };
    assert.deepEqual(bondStackers(data, 'k').map((s) => s.triggers), [['部署时']]);
    assert.deepEqual(bondStackers(data, 'i').map((s) => s.triggers), [['被击倒时']]);
    // 华法琳 raises the bonds of the piece in front, not its own; 引星棘刺 raises both
    assert.deepEqual(bondStackers(data, 'm').map((s) => s.name), ['引星棘刺']);
    assert.deepEqual(genericStackers(data).map((s) => s.name), ['华法琳', '引星棘刺']);
    assert.deepEqual(bondScalers(data, 'k').map((s) => s.name), ['玛恩纳']);
  });

  it('lists the tutorial and the bond map during the draft, as a table of contents', () => {
    const s = state('BAND_DRAFT', {}, { disabledBonds: ['kazimierzShip'] });
    const pages = guideIndex(s, DATA);
    assert.deepEqual(pages.map((p) => p.id), [...CHAPTERS.map((ch) => ch.id), 'bonds.overview']);
    assert.ok(pages.every((p) => Object.keys(p).join() === 'id,title'));
    const { sections } = guideSections(s, DATA, ['bonds.overview']);
    assert.deepEqual(sections[0].bonds.map((b) => b.id), ['egirShip', 'investShip']);
    assert.deepEqual(guideIndex(s, DATA, 'bonds').map((p) => p.id), ['bonds.overview', 'bond.egirShip', 'bond.investShip', 'bonds.generic']);
    assert.deepEqual(guideIndex(s, DATA, 'bands').map((p) => p.id), ['band.band_mlynar']);
  });

  const TUTORIAL = CHAPTERS.map((ch) => ch.id);

  it('quotes this mode’s numbers from config.json', () => {
    const { sections } = guideSections(state('BAND_DRAFT', {}, { modeId: 'm1', difficulty: 'NORMAL', lastRound: 3, bossRound: 3, hiddenRound: 4 }), DATA, TUTORIAL);
    const text = (id) => sections.find((s) => s.id === id).text.join('\n');
    assert.match(text('tutorial.flow'), /一局共 3 回合/);
    assert.match(text('tutorial.flow'), /第 2 回合在休整期之前有机变阶段/);
    assert.match(text('tutorial.flow'), /1–2:45/);
    assert.match(text('tutorial.shop'), /依次为 4、5、6/);
    assert.match(text('tutorial.shop'), /持有玛恩纳（band_mlynar）/);
    assert.match(text('tutorial.shop'), /基础价依次为 5、8，最高 3 级/);
    assert.match(text('tutorial.shop'), /1阶2、2阶3、3阶3/);
    assert.match(text('tutorial.lp'), /层数总和大于 350/);
    // solo: the co-op lines stay out
    assert.doesNotMatch(text('tutorial.flow'), /联防/);
  });

  it('writes the tutorial as affirmative statements about things in the data', () => {
    const { sections } = guideSections(state('BAND_DRAFT', {}, { modeId: 'm1', difficulty: 'NORMAL' }), DATA, TUTORIAL);
    assert.equal(sections.length, CHAPTERS.length);
    for (const line of sections.flatMap((s) => s.text)) {
      // 不同 (different) and 分别 (each) are not negations; quoted game text is verbatim
      assert.doesNotMatch(line.replace(/“[^”]*”/g, ''), /不(?!同)|没|无(?!需激活)|非|(?<!分)别|勿/, line);
    }
  });

  it('follows what the seat can see during prep', () => {
    const priv = {
      bandId: 'band_mlynar',
      shop: { slots: [{ kind: 'chess', id: 'c_e' }, null] },
      board: [{ kind: 'chess', id: 'c_a' }],
    };
    const ids = guideIndex(state('PREP', priv), DATA).map((p) => p.id);
    assert.deepEqual(ids, ['band.band_mlynar', 'bond.kazimierzShip', 'bond.egirShip', 'bonds.generic']);
    const off = guideIndex(state('PREP', priv, { disabledBonds: ['egirShip'] }), DATA).map((p) => p.id);
    assert.ok(!off.includes('bond.egirShip'));
    const [kaz] = guideSections(state('PREP', priv), DATA, ['bond.kazimierzShip']).sections;
    assert.ok(kaz.mechanics && kaz.count_mode === 'BOARD');
  });

  it('returns what is asked for and marks it read in the next table of contents', () => {
    const guide = createGuide();
    const s = state('PREP', { board: [{ kind: 'chess', id: 'c_e' }] });
    const index = guide(s, DATA);
    assert.equal(index.sections, undefined);
    assert.deepEqual(index.pages.map((p) => p.id), ['bond.egirShip', 'bonds.generic']);
    const got = guide(s, DATA, { ids: ['bond.egirShip', 'tutorial.lp', 'bond.nope', 'rules.nope'] });
    assert.deepEqual(got.sections.map((x) => x.id), ['bond.egirShip', 'tutorial.lp']);
    assert.deepEqual(got.unknown, ['bond.nope', 'rules.nope']);
    assert.deepEqual(guide(s, DATA).pages, [{ id: 'bond.egirShip', title: '盟约：阿戈尔', read: true }, { id: 'bonds.generic', title: '给其他盟约加层的干员' }]);
    // asking again always answers
    assert.deepEqual(guide(s, DATA, { ids: ['bond.egirShip'] }).sections.map((x) => x.id), ['bond.egirShip']);
  });
});
