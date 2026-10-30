/**
 * stronghold_guide: the game's tutorial, plus reference pages generated for the match in front of the agent.
 *
 *   tutorial   guide-notes.js CHAPTERS: how each system works (flow, board, shop, pieces, bonds, battle, LP, draft),
 *              with the numbers of this server's config.json for the current mode
 *   reference  bond pages (thresholds, description, params, the operators whose 特质 stack it, the operators whose
 *              stats grow with it) and band pages, built from the data files at call time
 *   emotes     the g.emote ids and what they mean
 *
 * The agent reads on demand. A call with `ids` returns those sections; a call without them returns a table of contents
 * (`pages`: id and title, `read: true` once this session fetched it): the pages for the current phase (`auto`: the
 * tutorial and the bond map during the draft, the seat's band and the bonds it can see during prep), or a whole area
 * (`tutorial`, `bonds`, `bands`). Pages cover the bonds this match uses and the operators in its pool.
 *
 * The chapter ids and what each covers also sit in the server's static instructions (instructions.js), so the
 * agent can ask for a chapter directly. It explains the game; the choices stay with the agent.
 */
import { BOND_MECHANICS, CHAPTERS, EMOTES } from './guide-notes.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const obj = (value) => (isObject(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * A trait split at its top-level trigger tags: `<获得时>A <部署时>B` → [{ tags: ['获得时'], body: 'A ' }, { tags: ['部署时'],
 * body: 'B' }]. Consecutive tags share a clause (`<进入休整期时><休整期结束时>…`); tags inside a granted trait's quotes
 * (`获得特质“<部署时>…”`) stay in the body, so the clause keeps the trigger of the grant.
 */
export function traitClauses(text) {
  const s = String(text ?? '');
  const out = [];
  let cur = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '“') depth++;
    else if (ch === '”') depth = Math.max(0, depth - 1);
    else if (ch === '<' && depth === 0) {
      const end = s.indexOf('>', i);
      if (end > i) {
        if (!cur || cur.body.trim()) out.push(cur = { tags: [], body: '' });
        cur.tags.push(s.slice(i + 1, end));
        i = end;
        continue;
      }
    }
    if (!cur) out.push(cur = { tags: [], body: '' });
    cur.body += ch;
  }
  return out.filter((c) => c.body.trim() || c.tags.length);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text a granted trait's quotes say about the unit that receives it, removed. */
const unquoted = (body) => body.replace(/“[^”]*”/g, '');
/** "自身所属盟约" / "自身已激活的盟约" / "自身及身前一格干员的已激活盟约": the trait owner's own bonds. */
const OWN_BONDS = /自身(?:及身[前后]一格干员)?的?(?:所属|已激活)的?盟约/;
/**
 * Layers for whatever bonds some other piece has, or the highest one: they help any line-up. 层数最多的盟约 (波登可),
 * 所有已激活盟约, 整备区中每名干员所在的 (流明), 身前/身后一格干员的 (引星棘刺), a granted "自身所属…盟约" (华法琳),
 * 额外层数 (魔王).
 */
const ANY_BONDS = /层数最多的盟约|所有已激活盟约|整备区中每名干员所在的已激活盟约|身[前后]一格干员的已激活盟约|获得特质“[^”]*自身(?:所属|已激活)|额外层数/;

function memberIds(bond) {
  const ids = [];
  for (const key of ['members', 'visibleMembers']) {
    for (const member of list(bond[key])) {
      const id = isObject(member) ? member.chessId : member;
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** The card's trait: the first garrison (the later ones are its mechanical parts; see observation.js traitOf). */
function traitText(data, chess) {
  for (const id of list(chess?.garrisonIds)) {
    const g = data.garrisons?.[id];
    if (g && !g.operatorTrait && g.desc) return g.desc;
  }
  return '';
}

/** A record the shop can offer: not a golden copy, not hidden, not banned this match. */
function shopRecord(chess, banned) {
  return isObject(chess) && !chess.isGolden && !chess.isHidden && chess.visible !== false && !banned.has(chess.chessId);
}

function entryOf(chess, trait, clauses) {
  const entry = { id: chess.chessId, name: chess.name ?? null, tier: chess.tier ?? null, price: chess.price ?? null };
  const triggers = [...new Set(clauses.flatMap((c) => c.tags))];
  entry.triggers = triggers;
  if (clauses.some((c) => c.body.includes('整备区时也有效'))) entry.bench = true;
  entry.trait = trait;
  return entry;
}

const byTier = (a, b) => (a.tier ?? 9) - (b.tier ?? 9) || String(a.id).localeCompare(String(b.id));

/**
 * The operators whose 特质 add layers to `bondId`, with the triggers of the clauses that do it: a clause naming
 * 【bond】 before 层数, or a member's clause raising its own bonds. Shop records only (shopRecord).
 */
export function bondStackers(data, bondId, banned = new Set()) {
  const bond = data.bonds?.[bondId];
  if (!bond) return [];
  const members = new Set(memberIds(bond));
  const named = new RegExp(`【${escapeRe(String(bond.name))}】(?:【[^】]+】)*层数`);
  const out = [];
  for (const chess of Object.values(obj(data.chess))) {
    if (!shopRecord(chess, banned)) continue;
    const trait = traitText(data, chess);
    if (!trait.includes('层数')) continue;
    const isMember = members.has(chess.chessId) || list(chess.bonds).includes(bondId);
    const hits = traitClauses(trait).filter((c) => named.test(c.body) || (isMember && OWN_BONDS.test(unquoted(c.body))));
    if (hits.length) out.push(entryOf(chess, trait, hits));
  }
  return out.sort(byTier);
}

/** Operators whose stats grow with `bondId`'s layers (每叠加N层…): what the layers pay into, besides the bond itself. */
export function bondScalers(data, bondId, banned = new Set()) {
  const bond = data.bonds?.[bondId];
  if (!bond) return [];
  const named = new RegExp(`【${escapeRe(String(bond.name))}】(?:【[^】]+】|/)*每叠加\\d+层`);
  const out = [];
  for (const chess of Object.values(obj(data.chess))) {
    if (!shopRecord(chess, banned)) continue;
    const trait = traitText(data, chess);
    if (named.test(trait) || (bond.isCore && /核心盟约每叠加\d+层/.test(trait))) {
      out.push({ id: chess.chessId, name: chess.name ?? null, tier: chess.tier ?? null, price: chess.price ?? null, trait });
    }
  }
  return out.sort(byTier);
}

/** Operators whose trait adds layers to bonds other pieces bring, or to the highest one: they help any line-up. */
export function genericStackers(data, banned = new Set()) {
  const out = [];
  for (const chess of Object.values(obj(data.chess))) {
    if (!shopRecord(chess, banned)) continue;
    const trait = traitText(data, chess);
    const hits = traitClauses(trait).filter((c) => ANY_BONDS.test(c.body));
    if (hits.length) out.push(entryOf(chess, trait, hits));
  }
  return out.sort(byTier);
}

/** A bond's numbers as its effect reads them (bonds.json buffs[].bb): base values, per-layer values, thresholds. */
function bondParams(bond) {
  const out = {};
  for (const buff of list(bond.buffs)) for (const [key, value] of Object.entries(obj(buff?.bb))) if (typeof value === 'number') out[key] = value;
  return out;
}

function bondSection(data, bondId, banned) {
  const bond = data.bonds?.[bondId];
  if (!bond) return null;
  const section = {
    id: `bond.${bondId}`,
    title: `盟约：${bond.name}`,
    thresholds: list(bond.thresholds),
    count_mode: bond.countMode ?? null,
    desc: bond.desc ?? null,
    params: bondParams(bond),
    stackers: bondStackers(data, bondId, banned),
  };
  const scalers = bondScalers(data, bondId, banned);
  if (scalers.length) section.scalers = scalers;
  if (BOND_MECHANICS[bondId]) section.mechanics = BOND_MECHANICS[bondId];
  return section;
}

function bandSection(data, bandId, disabled) {
  const band = data.bands?.[bandId];
  if (!band) return null;
  const section = { id: `band.${bandId}`, title: `策略：${band.name}`, lp: band.totalHp ?? null, effect: band.effectName ?? null, desc: band.desc ?? null };
  const off = list(band.bondIds).filter((id) => disabled.has(id)).map((id) => data.bonds?.[id]?.name ?? id);
  if (off.length) section.off_bonds = off;
  return section;
}

const OVERVIEW_TITLE = '本局盟约';
const GENERIC_TITLE = '给其他盟约加层的干员';

/** The bonds this match uses, one line each. */
function bondOverview(data, disabled) {
  const bonds = Object.values(obj(data.bonds)).filter((b) => isObject(b) && !disabled.has(b.bondId));
  return {
    id: 'bonds.overview',
    title: OVERVIEW_TITLE,
    bonds: bonds.map((b) => ({ id: b.bondId, name: b.name ?? null, core: !!b.isCore, thresholds: list(b.thresholds), count_mode: b.countMode ?? null })),
  };
}

const EMOTES_TITLE = '表情';

function emotesSection() {
  return {
    id: 'emotes',
    title: EMOTES_TITLE,
    text: ['g.emote { id } 发送表情，全部玩家都能看到，冷却 1 秒。收到的表情在 observe 的 messages 里，type 为 emote。'],
    emotes: Object.entries(EMOTES).map(([id, label]) => ({ id, label })),
  };
}

/** The bonds a seat can see during prep: on its pieces, in its shop, and already counted. */
function visibleBonds(data, priv) {
  const ids = new Set();
  const addPiece = (piece) => { if (isObject(piece) && piece.kind === 'chess') for (const b of list(data.chess?.[piece.id]?.bonds)) ids.add(b); };
  for (const area of ['hand', 'temp', 'board']) list(priv[area]).forEach(addPiece);
  list(obj(priv.shop).slots).forEach(addPiece);
  for (const bond of list(priv.bonds)) if (isObject(bond) && bond.bondId) ids.add(bond.bondId);
  return [...ids];
}

const genericSection = (data, banned) => ({ id: 'bonds.generic', title: GENERIC_TITLE, stackers: genericStackers(data, banned) });

/** The bands a mode type offers (bands.json modeTypeList; room.mode solo = SINGLE, coop = MULTI). */
function modeBands(data, room) {
  const modeType = room.mode === 'solo' ? 'SINGLE' : room.mode === 'coop' ? 'MULTI' : null;
  return Object.values(obj(data.bands))
    .filter((band) => isObject(band) && (!modeType || !Array.isArray(band.modeTypeList) || band.modeTypeList.includes(modeType)))
    .map((band) => band.bandId);
}

// ---------------------------------------------------------------------------------------------------------------
// tutorial context: this server's numbers, read the way server/match/gamedata.js reads them

const DRAFT_PHASES = new Set(['LOBBY', 'INFO_CHECK', 'BAND_DRAFT']);

/** Consecutive rounds with the same value, as "1–2:45、3–5:55". */
function ranges(pairs) {
  const out = [];
  for (const [r, v] of pairs) {
    const lastRun = out.at(-1);
    if (lastRun && lastRun.v === v && lastRun.to === r - 1) lastRun.to = r;
    else out.push({ from: r, to: r, v });
  }
  return out.map(({ from, to, v }) => `${from === to ? from : `${from}–${to}`}:${v}`).join('、');
}

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback);

/**
 * The numbers the tutorial quotes, from config.json (the current mode first, then the global economy) and the chess
 * records. Fallbacks are server/match/gamedata.js DEFAULTS.
 */
export function tutorialContext(data, pub, room = {}) {
  const config = obj(data.config);
  const mode = obj(obj(config.modes)[pub.modeId]);
  const economy = obj(config.economy);
  const solo = mode.type ? mode.type === 'SINGLE' : room.mode !== 'coop';
  const disabled = new Set(list(pub.disabledBonds));
  const bondName = (id) => data.bonds?.[id]?.name ?? id;
  const lastRound = num(pub.lastRound ?? mode.lastRound, 14);
  const bossRound = num(pub.bossRound ?? mode.bossRound, lastRound);
  const hiddenRound = pub.hiddenRound ?? mode.hiddenRound ?? null;
  const hc = obj(config.hiddenCore);
  const difficulty = pub.difficulty ?? mode.difficulty;
  const hidden = hiddenRound && (!Array.isArray(hc.difficulties) || hc.difficulties.includes(difficulty))
    ? { difficulties: list(hc.difficulties).join('/') || String(difficulty), threshold: num(solo ? hc.single : hc.multi, solo ? 350 : 1200), minLp: num(hc.minTeamLpExclusive, 1) }
    : null;

  const incomeArr = list(economy.income);
  const cap = num(economy.incomeCap, 12);
  const incomeOf = (r) => (Number.isFinite(incomeArr[r]) && incomeArr[r] >= 0 ? incomeArr[r] : Math.max(0, Math.min(cap, 3 + r)));
  const limits = obj(mode.combatTimeLimit);
  const limitPairs = Array.from({ length: lastRound }, (_, i) => i + 1).filter((r) => Number.isFinite(limits[r])).map((r) => [r, limits[r]]);

  const shopChess = Object.values(obj(data.chess)).filter((c) => isObject(c) && !c.isGolden && !c.isHidden && c.visible !== false && !c.isDiy);
  const byTier = (field) => {
    const seen = new Map();
    for (const c of shopChess) if (Number.isFinite(c[field]) && Number.isInteger(c.tier)) (seen.get(c.tier) || seen.set(c.tier, new Set()).get(c.tier)).add(c[field]);
    return [...seen.keys()].sort((a, b) => a - b).map((t) => [t, [...seen.get(t)].join('/')]);
  };
  const sells = [...new Set(shopChess.map((c) => c.sellPrice).filter(Number.isFinite))];
  const mergeCount = num(economy.mergeCount, 3);
  const mergeOverrides = obj(economy.mergeCountOverrides);
  const mergeExceptions = shopChess
    .map((c) => [c, Number.isInteger(c.upgradeNum) && c.upgradeNum > 0 ? c.upgradeNum : mergeOverrides[c.chessId]])
    .filter(([, n]) => Number.isInteger(n) && n !== mergeCount)
    .map(([c, n]) => `${c.name}需要${n}个`).join('，');
  const poolCopies = obj(economy.poolCopies);
  const ro = obj(economy.rewardOffer);
  const slots = obj(mode.shopSlots);
  const enabledOf = (mode2) => Object.values(obj(data.bonds)).filter((b) => isObject(b) && b.countMode === mode2 && !disabled.has(b.bondId)).map((b) => b.name);
  const countModes = {
    BOARD_AND_DECK: enabledOf('BOARD_AND_DECK').join('、'),
    BOARD_ALL_CHESS: enabledOf('BOARD_ALL_CHESS').join('、'),
  };
  const specialCounting = [];
  if (!disabled.has('maniShip') && data.bonds?.maniShip) specialCounting.push(`${bondName('maniShip')}激活时，场上已有成员的核心盟约人数各+1，${bondName('maniShip')}干员享受已激活核心盟约的效果。`);
  if (!disabled.has('deputShip') && data.bonds?.deputShip) specialCounting.push(`${bondName('deputShip')}的第1档按不同干员计；更高档位按名字或精锐状态区分，同一干员的普通版和精锐版各算1名。`);
  if (!disabled.has('soloShip') && data.bonds?.soloShip) {
    const max = num(data.bonds.soloShip.maxCount, 1);
    specialCounting.push(`${bondName('soloShip')}在场上${max === 1 ? '恰好有1名' : `有1到${max}名`}${bondName('soloShip')}干员时激活。`);
  }
  const dp = obj(config.dp);
  const keep = list(economy.leftoverFundsKeptByBands).filter((id) => data.bands?.[id]).map((id) => `${data.bands[id].name}（${id}）`).join('、');

  return {
    solo,
    lastRound,
    bossRound,
    hiddenRound,
    hidden,
    spRounds: list(mode.spRounds),
    maxHelpers: num(obj(config.unite).maxHelpers, 2),
    timeLimits: ranges(limitPairs) || '见对局设置',
    income: Array.from({ length: lastRound }, (_, i) => incomeOf(i + 1)).join('、'),
    keepBands: keep,
    refreshPrice: num(economy.refreshPrice, 1),
    upgradePrices: list(mode.upgradePrices).length ? list(mode.upgradePrices).join('、') : '5、8、11、12、13',
    maxShopLevel: num(mode.maxShopLevel, 6),
    shopSlots: Object.keys(slots).sort((a, b) => a - b).map((lv) => `${lv}级 ${num(slots[lv].chess, 0)}干员+${num(slots[lv].item, 0)}装备`).join('，') || '见 shop',
    poolCopies: Object.keys(poolCopies).sort((a, b) => a - b).map((t) => `${t}阶${poolCopies[t]}份`).join('、'),
    coopMultiplier: num(economy.coopPoolMultiplier, 2),
    goldenCopies: num(economy.goldenCopies, 3),
    prices: byTier('price').map(([t, p]) => `${t}阶${p}`).join('、'),
    sellPrices: sells.join('/') || '1',
    benchSize: num(economy.benchSize, 10),
    tempSize: num(economy.tempSize, 5),
    deployCap: num(economy.deployCap, 8),
    mergeCount,
    mergeExceptions,
    reward: { count: num(ro.count, 3), tierOffset: num(ro.tierOffset, 1), maxTier: num(ro.maxTier, 6) },
    equipPerChess: num(economy.equipPerChess, 2),
    itemMergeCount: num(economy.itemMergeCount, 2),
    itemDestroyRefund: num(economy.itemDestroyRefund, 0),
    countModes,
    specialCounting,
    dp: { init: num(dp.init, 10), perSec: num(dp.perSec, 1), max: num(dp.max, 99) },
    lpCap: num(config.lpCapPerRound, 10),
    skips: num(obj(config.bandDraft).skipsPerPlayer, 1),
  };
}

function chapterSections(data, pub, room) {
  const c = tutorialContext(data, pub, room);
  return CHAPTERS.map((ch) => ({ id: ch.id, title: ch.title, text: ch.lines(c).filter(Boolean), source: ch.source }));
}

function matchOf(state) {
  const last = obj(state?.last);
  const pub = obj(last['m.public']);
  return {
    pub,
    priv: obj(last['m.private']),
    room: obj(last['room.state']),
    disabled: new Set(list(pub.disabledBonds)),
    banned: new Set(list(pub.bannedChess)),
  };
}

/**
 * The sections named by `ids`, in order. Ids this match has no section for come back in `unknown`.
 * @param {object} state  `client.snapshot()`
 * @param {Record<string, object>} data
 * @param {string[]} ids
 */
export function guideSections(state, data, ids = []) {
  const { pub, room, disabled, banned } = matchOf(state);
  let chapters = null;
  const sections = [];
  const unknown = [];
  for (const id of new Set(list(ids).map(String))) {
    const [kind, ...rest] = id.split('.');
    const key = rest.join('.');
    let section = null;
    if (kind === 'tutorial') section = (chapters ??= chapterSections(data, pub, room)).find((s) => s.id === id) ?? null;
    else if (kind === 'bond' && !disabled.has(key)) section = bondSection(data, key, banned);
    else if (kind === 'band') section = bandSection(data, key, disabled);
    else if (id === 'bonds.overview') section = bondOverview(data, disabled);
    else if (id === 'bonds.generic') section = genericSection(data, banned);
    else if (id === 'emotes') section = emotesSection();
    if (section) sections.push(section);
    else unknown.push(id);
  }
  return { sections, unknown };
}

/**
 * A table of contents: `{ id, title }` for each page of a topic. `auto` follows the phase.
 * @param {object} state  `client.snapshot()`
 * @param {Record<string, object>} data
 * @param {'auto'|'tutorial'|'bonds'|'bands'} [topic]
 */
export function guideIndex(state, data, topic = 'auto') {
  const { pub, priv, room, disabled } = matchOf(state);
  const pages = [];
  const add = (id, title) => { if (!pages.some((p) => p.id === id)) pages.push({ id, title }); };
  const bond = (bondId) => { const b = data.bonds?.[bondId]; if (isObject(b) && !disabled.has(bondId)) add(`bond.${bondId}`, `盟约：${b.name ?? bondId}`); };
  const band = (bandId) => { const b = data.bands?.[bandId]; if (isObject(b)) add(`band.${bandId}`, `策略：${b.name ?? bandId}`); };
  const draft = !pub.phase || DRAFT_PHASES.has(pub.phase);

  if (topic === 'tutorial' || (topic === 'auto' && draft)) for (const ch of CHAPTERS) add(ch.id, ch.title);
  if (topic === 'bonds' || (topic === 'auto' && draft)) add('bonds.overview', OVERVIEW_TITLE);
  if (topic === 'bonds') {
    Object.keys(obj(data.bonds)).forEach(bond);
    add('bonds.generic', GENERIC_TITLE);
  }
  if (topic === 'bands') modeBands(data, room).forEach(band);
  if (topic === 'auto' && !draft) {
    if (priv.bandId) band(priv.bandId);
    visibleBonds(data, priv).forEach(bond);
    add('bonds.generic', GENERIC_TITLE);
  }
  if (topic === 'auto' && room.mode === 'coop') add('emotes', EMOTES_TITLE);
  return pages;
}

/**
 * One session's guide. It remembers which pages it handed out, so a table of contents can mark them `read`.
 * @returns {(state: object, data: object, options?: { topic?: string, ids?: string[] }) => object}
 */
export function createGuide() {
  const read = new Set();
  return function guide(state, data, { topic = 'auto', ids = [] } = {}) {
    const pub = obj(obj(state?.last)['m.public']);
    const head = { phase: pub.phase ?? null, round: pub.round ?? null };
    if (list(ids).length) {
      const { sections, unknown } = guideSections(state, data, ids);
      for (const section of sections) read.add(section.id);
      return { ...head, sections, ...(unknown.length ? { unknown } : {}) };
    }
    return { ...head, topic, pages: guideIndex(state, data, topic).map((page) => (read.has(page.id) ? { ...page, read: true } : page)) };
  };
}
