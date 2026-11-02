/**
 * Observation: turn the server's frames into one decision-ready snapshot.
 *
 * This makes no decisions. It only renders what the server last said, joined with the game's own data
 * files (see gamedata.js), so an agent can reason about a turn without parsing raw protocol frames.
 * `stronghold_observe` returns it; docs/observation.md says where every field comes from.
 *
 *   phase / round / seconds_left    where the match is
 *   room                            mode, difficulty, training flag, the host and every seat (the lobby's only view of them)
 *   me                              funds, shop level, deploy count, ready state, cumulative stats
 *   shop                            every slot, priced and joined with the chess/item record
 *   reward_offer / personal_choice  the modal offers that block Ready while they are open
 *   hand / temp / board             every piece, with its data and its tile; a deployed piece also lists the tiles it covers
 *   bonds                           every bond with its live layers, active tier and thresholds
 *   effects                         the counters and bounty effects this seat is holding
 *   next_enemies                    the coming wave, per spawn action, with this round's real HP and ATK
 *   enemy_scale                     this round's enemy multipliers
 *   checks                          during prep: facts a player reads off the screen at a glance
 *   players                         every seat, for co-op awareness
 *   setup                           the match's draw: rounds, enemy factions, disabled bonds, banned operators, its bosses
 *   scouted                         during prep: the last player scouted with g.watch
 *   fields / unite / unite_result   during battle: the live fields, the 联防 roles, and how a 联防 ended
 *   boss_hp / team_lp               the shared pools of the Final Assault
 *   messages                        the toasts, ticker lines and emotes that passed by
 *   comms                           with another human at the table: how long this seat has been silent, who waits on it
 *   result                          during RESULT: the settlement screen
 *   reroll_vote                     while a setup reroll vote runs: who was asked, who agreed, whether this seat still owes a vote
 *   band_draft                      during BAND_DRAFT: every strategy the draft screen offers, and whose turn it is
 *   sp_draft                        during SP_DRAFT: the 机变 event and its cards (g.choice { idx } picks one)
 *   field                           deployable tiles, the lanes enemies walk, and a rendered map
 *   battle                          the local battle runner's status, when one is attached
 *
 * The field region mirrors the game's own `GEO.FIELD` (`shared/constants.js`); override it with
 * STRONGHOLD_FIELD_REGION="r0,r1,c0,c1" for a layout it does not describe.
 */

import { EMOTES, EMOTE_REPLIES, LAYER_REFERENCE } from './guide-notes.js';

/** The game's own `GEO.FIELD` — the seat's deployable board region (r0, r1, c0, c1). */
export const DEFAULT_FIELD_REGION = Object.freeze([9, 12, 2, 10]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const obj = (value) => (isObject(value) ? value : {});
const list = (value) => (Array.isArray(value) ? value : []);
const nonEmpty = (value) => isObject(value) && Object.keys(value).length > 0;
/** An empty slot as the server sends it: null, or an empty object. */
const emptySlot = (value) => !value || (isObject(value) && !Object.keys(value).length);
const orNull = (value) => (value === undefined ? null : value);

/** The region this seat's half of the field occupies. A malformed override falls back to the default. */
export function fieldRegion(env = process.env) {
  const parts = String(env.STRONGHOLD_FIELD_REGION ?? '').split(',').map((p) => p.trim());
  if (parts.length === 4 && parts.every((p) => /^-?\d+$/.test(p))) return parts.map(Number);
  return [...DEFAULT_FIELD_REGION];
}

function finiteNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/** Milliseconds until a deadline, in seconds (one decimal), or null when there is no live deadline. */
export function secondsLeft(deadline, serverNow) {
  const delta = finiteNumber(deadline) - finiteNumber(serverNow);
  if (!Number.isFinite(delta) || delta <= 0) return null;
  return Math.round(delta / 100) / 10;
}

function bondName(data, bondId) {
  return data.bonds?.[bondId]?.name || orNull(bondId);
}

const PLACEHOLDER = /\{(\d{1,2})(?::([^{}]{1,12}))?\}/g;

/** A number in a card's own format: '0%' is a rounded percent, '0.0' one decimal (public/js/ui/richText.js formatPlaceholder). */
function cardNumber(value, fmt = '0') {
  const pct = fmt.endsWith('%');
  const core = pct ? fmt.slice(0, -1) : fmt;
  const dot = core.indexOf('.');
  const n = (pct ? value * 100 : value).toFixed(dot >= 0 ? Math.min(4, core.length - dot - 1) : 0);
  const clean = Number(n) === 0 ? n.replace('-', '') : n;
  return pct ? `${clean}%` : clean;
}

/** What one more layer adds, two decimals at most, so a 0.9% step keeps its decimal. */
function layerStep(value, fmt = '0') {
  const pct = fmt.endsWith('%');
  return `+${Number((pct ? value * 100 : value).toFixed(2))}${pct ? '%' : ''}`;
}

/**
 * A bond's layer-dependent numbers at its current layers, as the game's bond card shows them (public/js/ui/richText.js
 * formatBondEffect: {i:fmt} = bb[base] + bb[perStack] × layers, a chance stops at 100%). `effect` holds the lines of
 * effectDesc that carry such a number; a line gated on a head count (<在场N名…>) joins once `count` reaches N.
 * `per_layer` is what one more layer adds to each number.
 */
export function bondEffect(record, layers, count) {
  const params = list(record?.effectDescParams).filter((p) => isObject(p) && Number.isInteger(p.index));
  if (!params.length) return null;
  const bb = obj(record.bb);
  const at = Math.max(0, Number(layers) || 0);
  const values = [];
  const formats = [];
  const steps = [];
  for (const p of params) {
    const base = Number(bb[p.base]) || 0;
    const per = Number(bb[p.perStack]) || 0;
    const chance = /prob/i.test(`${p.base}|${p.perStack}`);
    values[p.index] = chance ? Math.max(0, Math.min(1, base + per * at)) : base + per * at;
    formats[p.index] = typeof p.format === 'string' ? p.format : '0';
    if (per) steps.push(layerStep(per, formats[p.index]));
  }
  const lines = String(record.effectDesc ?? '').split('\n').filter((line) => {
    if (!line.match(PLACEHOLDER)) return false;
    const gate = line.match(/^<在场(\d+)名/);
    return !gate || (Number(count) || 0) >= Number(gate[1]);
  });
  if (!lines.length) return null;
  const fill = (line) => line.replace(PLACEHOLDER, (whole, idx, fmt) => (values[idx] == null ? whole : cardNumber(values[idx], formats[idx] || fmt || '0')));
  return { effect: lines.map(fill).join('；'), per_layer: steps.join('、') };
}

/**
 * A bond's next layer milestone (bonds.json layerMilestones) above `layers`: "every" fires at each multiple of its
 * layer, "reach" and "first" once. The text is the card line that names that layer, without its <…> tag.
 */
export function nextMilestone(record, layers) {
  const at = Math.max(0, Number(layers) || 0);
  const lines = [...String(record?.effectDesc ?? '').split('\n'), ...String(record?.desc ?? '').split('\n')].map((l) => l.trim());
  let best = null;
  for (const m of list(record?.layerMilestones)) {
    const step = Number(m?.layer);
    if (!(step > 0)) continue;
    const every = m.mode === 'every';
    if (!every && at >= step) continue;
    const layer = every ? (Math.floor(at / step) + 1) * step : step;
    const line = lines.find((l) => new RegExp(`<[^>]*\\b${step}层[^>]*>`).test(l));
    if (!line || (best && best.layer < layer)) continue;
    const text = `${line.replace(/^<[^>]*>/, '').trim()}${every ? `（每 ${step} 层一次）` : ''}`;
    // Two milestones on one layer (远见: every 10, and first at 80) both fire there.
    best = best && best.layer === layer ? { layer, text: `${best.text}；${text}` } : { layer, text };
  }
  if (!best) return null;
  return `${best.layer} 层（差 ${best.layer - at}）：${best.text}`;
}

/**
 * The two kinds of greyed bonds of a match, as the game's screens tell them apart (public/js/ui/gameLogic/bonds.js
 * disabledBondSets). `off` is the mode's static list: those bonds never activate. `drawn` is the per-match draw: only
 * operators whose every bond was drawn leave the pool, so a drawn bond still activates and stacks with its other members.
 * m.public.disabledBonds holds both.
 */
export function disabledBondSets(data, pub) {
  const off = new Set(list(data.config?.modes?.[pub.modeId]?.inactiveBondIds));
  const source = Array.isArray(pub.drawnDisabledBonds) ? pub.drawnDisabledBonds : list(pub.disabledBonds);
  return { off, drawn: new Set(source.filter((id) => !off.has(id))) };
}

/**
 * A chess piece's 特质 text as its card shows it: the first garrison (public/js/ui/detailPanel.js nativeTrait). The
 * later ids are the same trait split into mechanical parts (their text starts with a 【152】-style back reference).
 */
export function traitOf(data, raw) {
  for (const id of list(raw?.garrisonIds)) {
    const g = data.garrisons?.[id];
    if (g && !g.operatorTrait && g.desc) return g.desc;
  }
  return null;
}

/**
 * Whether an enemy is an air unit to the simulation (server/sim/units.js isFlying): a FLY mover, or one that hovers
 * (近地悬浮, ba.float) while walking the ground path. Air units cannot be blocked and need an anti-air attacker.
 * `isFlyEnemy` alone misses both kinds.
 */
export function airOf(raw) {
  if (!raw) return null;
  return !!raw.isFlyEnemy || raw.stats?.motion === 'FLY' || hoverOf(raw);
}

function hoverOf(raw) {
  return list(raw?.abilities).some((a) => isObject(a) && String(a.textRaw ?? '').includes('ba.float'));
}

/** The range a record's own data states, used until the game's rule is loaded (client.attackRangeGrid). */
const statedRange = (raw) => raw?.rangeGrid;

/** What a skill card shows: the game's own text and its SP numbers. */
function skillInfo(raw) {
  const skill = raw?.skill;
  if (!isObject(skill)) return null;
  return pruned({
    name: skill.name,
    desc: skill.desc,
    type: skill.skillType,
    sp_type: skill.spType,
    sp_cost: skill.spCost,
    init_sp: skill.initSp,
    duration: skill.duration,
  }, SKILL_DEFAULTS);
}

/** The decision-relevant slice of one shop slot or piece's record. */
function pieceInfo(data, kind, id, rangeOf = statedRange) {
  if (kind === 'chess') {
    const raw = obj(data.chess?.[id]);
    const stats = obj(raw.stats);
    return {
      id,
      name: orNull(raw.name),
      tier: orNull(raw.tier),
      // 精锐: the merged form of an operator, a record of its own.
      golden: orNull(raw.isGolden),
      price: orNull(raw.price),
      prof: orNull(raw.profession),
      pos: orNull(raw.position),
      hp: orNull(stats.maxHp),
      atk: orNull(stats.atk),
      def: orNull(stats.def),
      res: orNull(stats.res),
      block: orNull(stats.blockCnt),
      hit_fly: orNull(raw.canHitFly),
      dmg: orNull(raw.dmgType),
      // 部署费用: what a redeploy costs (the opening deployment is free).
      cost: orNull(stats.cost),
      bonds: data.chess?.[id] ? list(raw.bonds).map((b) => bondName(data, b)) : null,
      // 特质: the card's trait line (garrisons.json), e.g. "<获得时>自身所属盟约层数+2".
      trait: traitOf(data, raw),
      // The range the unit starts a battle with, facing RIGHT, as [dRow, dCol] offsets.
      range: orNull(rangeOf(raw)),
      skill: skillInfo(raw),
    };
  }
  if (kind === 'token') {
    // A summon (a skill's drone or doll): it has no price and is not draggable.
    const raw = data.tokens?.[id];
    return { id, name: orNull(raw?.name), desc: raw ? raw.desc || raw.effectName || '' : null, token: true, range: orNull(statedRange(raw)) };
  }
  const raw = kind === 'item' ? data.items?.[id] : null;
  return {
    id,
    name: orNull(raw?.name),
    tier: orNull(raw?.tier),
    golden: orNull(raw?.isGolden),
    desc: raw ? raw.desc || raw.effectName || '' : null,
    // How it is used: a MAGIC item is dragged onto a field tile (g.art), every other item goes onto a piece (g.equip).
    use: raw ? (raw.itemType === 'MAGIC' ? 'g.art' : 'g.equip') : null,
  };
}

/**
 * The items on a piece. The server sends `[{ uid, id }]`; both halves matter — `id` says what it is,
 * `uid` is what `g.unequip` / `g.equip { replaceUid }` need. A bare id is tolerated so a partial or
 * older frame degrades to a readable list instead of failing.
 */
export function equipped(data, rawItems) {
  return list(rawItems).map((raw) => {
    if (isObject(raw)) {
      const entry = { uid: orNull(raw.uid), id: orNull(raw.id) };
      if (raw.id) entry.name = orNull(data.items?.[raw.id]?.name);
      return entry;
    }
    return { uid: null, id: orNull(raw), name: orNull(data.items?.[raw]?.name) };
  });
}

/** Hand / temp / board: each occupied slot as one joined piece, keeping its slot index. */
export function pieces(data, rawList, rangeOf = statedRange) {
  const out = [];
  list(rawList).forEach((piece, index) => {
    if (!nonEmpty(piece)) return;
    const entry = { slot: index, uid: orNull(piece.uid), kind: orNull(piece.kind), ...pieceInfo(data, piece.kind, orNull(piece.id), rangeOf) };
    // `golden` matters because golden pieces double their 获得时 effects.
    if (piece.golden != null) entry.golden = !!piece.golden;
    if (piece.count != null) entry.count = piece.count;
    if (piece.ownerUid != null) entry.ownerUid = piece.ownerUid;
    entry.items = equipped(data, piece.items);
    if (piece.row != null) Object.assign(entry, { row: piece.row, col: orNull(piece.col), dir: orNull(piece.dir) });
    out.push(entry);
  });
  return out;
}

/** A range offset turned to a facing (the sim's frame, server/sim/dir.js): ranges are written facing RIGHT. */
function turned(dRow, dCol, dir) {
  if (dir === 'UP') return [dCol, -dRow];
  if (dir === 'LEFT') return [-dRow, -dCol];
  if (dir === 'DOWN') return [-dCol, dRow];
  return [dRow, dCol];
}

/** A piece with the tiles it covers, when it stands on the board and its range is known. */
function withRangeTiles(piece, mapRows) {
  if (piece.row == null || !Array.isArray(piece.range)) return piece;
  return { ...piece, range_tiles: rangeTiles(piece.range, piece.row, piece.col, piece.dir, mapRows) };
}

/** The tiles a deployed piece covers, as the board highlights them: its range at its tile and facing, on the map. */
export function rangeTiles(range, row, col, dir, rows = []) {
  const onMap = (r, c) => r >= 0 && c >= 0 && (!rows.length || (r < rows.length && c < String(rows[r]).length));
  return range.map(([dRow, dCol]) => {
    const [r, c] = turned(dRow, dCol, dir);
    return [row + r, col + c];
  }).filter(([r, c]) => onMap(r, c));
}

/** The deployable tiles and the lanes enemies walk on this seat's half, straight from the stage data. */
export function field(data, stageId, region = DEFAULT_FIELD_REGION) {
  const [r0, r1, c0, c1] = region;
  const stage = obj(data.stages?.[stageId ?? '']);
  const deploy = obj(obj(stage.deployTiles).normal);
  const lanes = [];
  // Devices on the map reroute enemies: on some stages every lane differs from groundPaths (server/match/bot.js fieldModel).
  const rerouted = obj(stage.groundPathsWithDevices);
  for (const [name, plain] of Object.entries(obj(stage.groundPaths))) {
    const lane = Array.isArray(rerouted[name]) && rerouted[name].length ? rerouted[name] : plain;
    if (!Array.isArray(lane) || !lane.length) continue;
    const start = lane[0];
    if (!Array.isArray(start) || start.length < 2) continue;
    // Only the lanes that start in this seat's own half; the far-side ones belong to the other half.
    if (start[1] > c1 || start[0] < r0 || start[0] > r1) continue;
    lanes.push({ name, from: lane[0], to: lane.at(-1), len: lane.length, tiles: lane });
  }
  const rows = list(stage.rows);
  return {
    region: { rows: [r0, r1], cols: [c0, c1] },
    // The sim's frame (server/sim/dir.js): row 0 is the BOTTOM of the screen, so UP = row + 1; a piece faces RIGHT
    // unless told otherwise, toward the gates the enemies come from.
    axes: { row_0: 'bottom', UP: '+row', DOWN: '-row', RIGHT: '+col', LEFT: '-col', default_dir: 'RIGHT' },
    deploy_melee: list(deploy.melee),
    deploy_ranged_only: list(deploy.rangedOnly),
    lanes,
    leak_tile: [r0, c0],
    // Top of the screen first, each "row|tiles" with the string index = col.
    map_rows: Array.from({ length: r1 - r0 + 1 }, (_, i) => r1 - i).filter((r) => rows[r] != null).map((r) => `${r}|${rows[r]}`),
  };
}

/**
 * The strategy draft screen: every band the mode type allows, in sortId order, with what its card and detail pane
 * show (public/js/screens/bandDraft.js allowedBands / BandOffTag). A band built around a bond this match switches off
 * stays selectable; the screen only marks it, and so does `off_bonds`.
 */
export function bandDraft(data, pub, room, playerId) {
  const draft = obj(pub.draft);
  const modeType = room.mode === 'solo' ? 'SINGLE' : room.mode === 'coop' ? 'MULTI' : null;
  const { off: disabled } = disabledBondSets(data, pub);
  const takenBy = new Map(Object.entries(obj(draft.picks)).map(([pid, bandId]) => [bandId, pid]));
  const options = Object.values(obj(data.bands))
    .filter((b) => isObject(b) && (!modeType || !Array.isArray(b.modeTypeList) || b.modeTypeList.includes(modeType)))
    .sort((a, b) => (Number(a.sortId) || 99) - (Number(b.sortId) || 99) || (a.bandId < b.bandId ? -1 : 1))
    .map((b) => {
      const entry = { id: b.bandId, name: orNull(b.name), lp: orNull(b.totalHp), effect: orNull(b.effectName), desc: orNull(b.desc) };
      const off = list(b.bondIds).filter((id) => disabled.has(id)).map((id) => bondName(data, id));
      if (off.length) entry.off_bonds = off;
      const taker = takenBy.get(b.bandId);
      if (taker && taker !== playerId) entry.taken_by = taker;
      return entry;
    });
  return {
    my_turn: draft.turn != null ? draft.turn === playerId : null,
    turn: orNull(draft.turn),
    my_pick: orNull(obj(draft.picks)[playerId]),
    skips_left: orNull(obj(draft.skipsLeft)[playerId]),
    untimed: orNull(draft.untimed),
    options,
  };
}

/** A pick-one offer's slots (m.private.shop.rewardOffer), joined like shop slots; `idx` is what g.reward takes. */
function rewardOffer(data, offer, rangeOf) {
  if (!isObject(offer)) return null;
  const slots = list(offer.slots).filter(isObject).map((slot, idx) => {
    const info = pieceInfo(data, slot.kind, orNull(slot.id), rangeOf);
    return { ...info, idx, kind: orNull(slot.kind), price: orNull(slot.price ?? info.price), sold: orNull(slot.sold) };
  });
  return { ...offer, slots };
}

/**
 * The setup reroll vote (INFO_CHECK, server/match/match/setupVote.js). The phase's countdown stops while it runs: it
 * ends when every voter has agreed or one refuses, so a seat that stays silent holds the whole room.
 */
export function rerollVote(pub, playerId) {
  const vote = obj(pub.rerollVote);
  const voters = list(vote.voters);
  const agreed = list(vote.agreed);
  return {
    id: orNull(vote.id),
    proposerId: orNull(vote.proposerId),
    voters,
    agreed,
    awaiting_me: voters.includes(playerId) && !agreed.includes(playerId),
  };
}

/** What this match drew, as the 本局信息 screen lists it. It holds still for the whole match. */
function setupView(data, pub) {
  const boss = (id) => {
    if (!id) return null;
    const raw = data.bosses?.[id];
    return { id, name: orNull(raw?.name), enemy: orNull(raw?.enemyKey) };
  };
  const { off, drawn } = disabledBondSets(data, pub);
  return {
    last_round: orNull(pub.lastRound),
    boss_round: orNull(pub.bossRound),
    hidden_round: orNull(pub.hiddenRound),
    factions: list(pub.factions),
    disabled_bonds: [...off].map((id) => bondName(data, id)),
    partial_pool_bonds: [...drawn].map((id) => bondName(data, id)),
    // Both forms of an operator are banned together; the name says it once.
    banned_chess: [...new Set(list(pub.bannedChess).map((id) => data.chess?.[id]?.name ?? id))],
    boss: boss(pub.bossId),
    hidden_boss: boss(pub.hiddenBossId),
  };
}

/** The live battle fields, each with the server's progress line. */
function fieldsView(pub) {
  return list(pub.fields).filter(isObject).map((f) => ({
    fieldId: orNull(f.fieldId),
    kind: orNull(f.kind),
    players: list(f.players),
    live: orNull(f.live),
    progress: orNull(f.progress),
  }));
}

/** How a 联防 ended: who it cost what. `losses` is the LP settlement charged each player this round. */
function uniteResultView(raw) {
  return { through: orNull(raw.through), helpers: list(raw.helpers), leakers: list(raw.leakers), losses: obj(raw.losses) };
}

/**
 * The last scout of a prep phase (m.field with `prep`): the player's board, bench, effects and coming wave, as the
 * scouting screen draws them. Units carry the sim's axes: `y` is the row, `x` the column.
 */
function scoutedView(data, raw, pub, rangeOf, scale = null) {
  const playerId = String(raw.fieldId ?? '').replace(/^n:/, '') || null;
  const mapRows = list(obj(data.stages?.[raw.stageId ?? '']).rows);
  const units = list(raw.units).filter(isObject).map((unit) => {
    const kind = unit.kind === 'op' ? 'chess' : orNull(unit.kind);
    const piece = { ...pieceInfo(data, kind, orNull(unit.defId), rangeOf), kind, area: orNull(unit.area), items: equipped(data, unit.items) };
    if (unit.area !== 'board') return piece;
    return withRangeTiles({ ...piece, row: orNull(unit.y), col: orNull(unit.x), dir: orNull(unit.dir) }, mapRows);
  });
  return {
    playerId,
    name: orNull(list(pub.players).find((p) => p?.playerId === playerId)?.name),
    fieldId: orNull(raw.fieldId),
    units,
    effects: effectsView(raw.effects),
    next_enemies: wavePreview(data, raw.nextEnemies, scale),
  };
}

function effectsView(rawList) {
  return list(rawList).filter(isObject).map((e) => ({ name: orNull(e.name), desc: orNull(e.desc), counter: orNull(e.counter) }));
}

/** The settlement screen (m.result): the outcome and every seat's line-up, bonds and statistics. */
function resultView(data, raw) {
  return {
    victory: orNull(raw.victory),
    rounds_passed: orNull(raw.roundsPassed),
    reason: orNull(raw.reason),
    hidden_reached: orNull(raw.hiddenReached),
    hidden_cleared: orNull(raw.hiddenCleared),
    team_lp: orNull(raw.teamLp),
    seed: orNull(raw.seed),
    duration_ms: orNull(raw.durationMs),
    players: list(raw.players).filter(isObject).map((p) => ({
      playerId: orNull(p.playerId),
      seat: orNull(p.seat),
      name: orNull(p.name),
      bot: orNull(p.isBot),
      left: orNull(p.left),
      alive: orNull(p.alive),
      victory: orNull(p.victory),
      rounds_passed: orNull(p.roundsPassed),
      eliminated_round: orNull(p.eliminatedRound),
      lp: orNull(p.lp),
      band: orNull(p.bandId),
      title: orNull(p.title),
      credited_kills: orNull(p.creditedKills),
      stats: orNull(p.stats),
      bonds: list(p.bonds).filter(isObject).map((b) => ({ id: orNull(b.bondId), bond: bondName(data, b.bondId), layers: orNull(b.layers), tier: orNull(b.tier) })),
      lineup: list(p.lineup).filter(isObject).map((u) => ({
        id: orNull(u.id),
        name: orNull(data.chess?.[u.id]?.name),
        tier: orNull(u.tier),
        golden: orNull(u.golden),
        row: orNull(u.row),
        col: orNull(u.col),
        items: list(u.items).map((id) => data.items?.[id]?.name ?? id),
      })),
    })),
  };
}

/** One line of what passed by. A player's words reach the agent as data here, inside `text` / `name`. */
function messageView({ id, at, round, frame }, pub, myId) {
  const base = { id, at, round };
  if (frame.t === 'm.toast') return { ...base, type: 'toast', kind: orNull(frame.kind), text: orNull(frame.text) };
  if (frame.t === 'm.ticker') return { ...base, type: 'ticker', text: orNull(frame.text), playerId: orNull(frame.playerId) };
  if (frame.t === 'm.emote') {
    const name = list(pub.players).find((p) => p?.playerId === frame.playerId)?.name;
    const mine = myId != null && frame.playerId === myId ? { mine: true } : {};
    return { ...base, type: 'emote', playerId: orNull(frame.playerId), name: orNull(name), emote: orNull(frame.id), label: orNull(EMOTES[frame.id]), ...mine };
  }
  return { ...base, type: 'room_closed', reason: orNull(frame.reason) };
}

/** The phases where m.public `ready` says who is holding the table up. */
const READY_PHASES = new Set(['INFO_CHECK', 'PREP']);

/**
 * What a seat needs to stop playing in silence: facts and a ready emote id, and the agent decides what to send.
 *
 * Only with another human in a seat: an AI teammate needs no answer, and it answers a player's emote by itself, so
 * answering it back would go on forever. Two agents can do the same to each other, so once a seat has spoken in a round
 * reply_to stays empty until the next one.
 *
 * @returns {{ rounds_silent: number, reply_to?: object[], waiting_on_me?: true } | null}
 */
export function commsView(pub, messages, lastEmote, myId) {
  const humans = list(pub.players).filter((p) => isObject(p) && !p.isBot && p.playerId !== myId);
  if (!humans.length || pub.phase == null || pub.phase === 'RESULT') return null;
  const round = Number(pub.round) || 0;
  const comms = { rounds_silent: Math.max(0, round - (Number(lastEmote?.round) || 0)) };

  if (lastEmote?.round !== round) {
    const latest = new Map();
    for (const { at, round: said, frame } of list(messages)) {
      const reply = frame?.t === 'm.emote' ? EMOTE_REPLIES[frame.id] : null;
      // an emote from the last settlement is read in the next round's prep
      if (reply && at > (lastEmote?.at ?? 0) && said >= round - 1) latest.set(frame.playerId, { id: frame.id, reply });
    }
    const replyTo = humans.filter((p) => latest.has(p.playerId))
      .map((p) => ({ name: orNull(p.name), label: EMOTES[latest.get(p.playerId).id], reply: latest.get(p.playerId).reply }));
    if (replyTo.length) comms.reply_to = replyTo;
  }

  const seated = humans.filter((p) => p.alive !== false && p.connected !== false);
  const me = list(pub.players).find((p) => isObject(p) && p.playerId === myId);
  if (READY_PHASES.has(pub.phase) && me && !me.ready && seated.length && seated.every((p) => p.ready)) comms.waiting_on_me = true;
  return comms;
}

/** `room.state`, the only frame a lobby has: before the match starts there is no m.public to list the seats. */
function roomView(room) {
  return {
    code: orNull(room.code),
    train: orNull(room.train),
    mode: orNull(room.mode),
    difficulty: orNull(room.difficulty),
    host_id: orNull(room.hostId),
    in_match: orNull(room.inMatch),
    ai_picks_last: orNull(room.aiPicksLast),
    seats: list(room.seats).map((seat, index) => (emptySlot(seat) ? { seat: index, empty: true } : {
      seat: orNull(seat.seat),
      playerId: orNull(seat.playerId),
      name: orNull(seat.name),
      bot: orNull(seat.isBot),
      ready: orNull(seat.ready),
      connected: orNull(seat.connected),
    })),
  };
}

/** What a bounty card brings: the enemy it adds, at the strength it has this round, and what it pays. */
function bountyInfo(data, card, scale) {
  const info = enemyInfo(data, card.enemyKey);
  return {
    enemy_key: orNull(card.enemyKey),
    enemy: orNull(info.name),
    count: orNull(card.count),
    rounds: orNull(card.rounds),
    coin: orNull(card.coin),
    payout: orNull(card.payout),
    fly: orNull(info.fly),
    ...nowStats(info, scale),
    def: orNull(info.def),
    res: orNull(info.res),
  };
}

/** The 机变 draft (SP_DRAFT): the event, its cards, and whose turn it is. The server already names the cards. */
export function spDraft(pub, playerId, data = {}, scale = null) {
  const sp = obj(pub.sp);
  const takenBy = new Map(Object.entries(obj(sp.taken)).map(([pid, idx]) => [idx, pid]));
  return {
    event: orNull(sp.eventId),
    name: orNull(sp.name),
    desc: orNull(sp.desc),
    my_turn: sp.turn != null ? sp.turn === playerId : null,
    my_pick: orNull(obj(sp.picks)[playerId]),
    cards: list(sp.cards).filter(isObject).map((card) => {
      const entry = { idx: orNull(card.idx), kind: orNull(card.kind), id: orNull(card.id), name: orNull(card.name), tier: orNull(card.tier), price: orNull(card.price), desc: orNull(card.desc) };
      if (card.kind === 'bounty') Object.assign(entry, bountyInfo(data, card, scale));
      if (card.kind === 'tactic' && card.team != null) entry.team = card.team;
      if (card.soldOut) entry.sold_out = true;
      const taker = takenBy.get(card.idx);
      if (taker && taker !== playerId) entry.taken_by = taker;
      return entry;
    }),
  };
}

function enemyInfo(data, key) {
  const raw = data.enemies?.[key];
  if (!raw) return { key: orNull(key), unknown: true };
  const stats = obj(raw.stats);
  return {
    key,
    name: orNull(raw.name),
    hp: orNull(stats.maxHp),
    atk: orNull(stats.atk),
    def: orNull(stats.def),
    res: orNull(stats.res),
    fly: airOf(raw),
    ...(hoverOf(raw) ? { hover: true } : {}),
    dmg: orNull(stats.dmgType),
    motion: orNull(stats.motion),
    block: orNull(stats.blockCnt),
    // LP per leak in boss / hidden rounds only; a normal round charges 1 per counted leak (settle.js).
    boss_lp: orNull(stats.lpr),
    speed: orNull(stats.moveSpeed),
  };
}

/**
 * The multipliers enemies spawn with this round (server/match/gamedata.js baseEnemyScale). A leader's pool stays out of
 * them. The browser reads the same table from config.json.
 */
export function enemyScale(data, pub) {
  const row = data.config?.modes?.[pub.modeId]?.enemyScale?.[String(pub.round)];
  if (!isObject(row)) return null;
  const factor = (value) => (Number.isFinite(value) ? value : 1);
  return { hp: factor(row.hp), atk: factor(row.atk), speed: factor(row.speed) };
}

/** A record's HP and ATK at this round's strength. */
function nowStats(info, scale) {
  if (!scale || !Number.isFinite(info.hp)) return {};
  return { hp_now: Math.round(info.hp * scale.hp), atk_now: Number.isFinite(info.atk) ? Math.round(info.atk * scale.atk) : null };
}

/** A wave preview, per spawn action. Every seat's preview has this shape, the scouted player's included. */
function wavePreview(data, rawList, scale = null) {
  return list(rawList).filter(isObject).map((enemy) => {
    const info = enemyInfo(data, enemy.enemyKey);
    return {
      ...info,
      at_s: orNull(enemy.t),
      count: orNull(enemy.count),
      gate: orNull(enemy.gate),
      elite: orNull(enemy.elite),
      // The simulation decides from the record (motion / hover), whatever the preview's spawn slot says.
      fly: data.enemies?.[enemy.enemyKey] ? airOf(data.enemies[enemy.enemyKey]) : orNull(enemy.fly),
      boss: orNull(enemy.boss),
      bounty: enemy.source === 'bounty',
      ...(enemy.boss ? {} : nowStats(info, scale)),
    };
  });
}

const MAX_CHECKS = 16;
/** Items in the bench described one per line; the rest are named together. */
const ITEM_LINES = 2;
const multiplier = (value) => Number(value.toFixed(2));

/** Triggers that fire once, when a piece is bought or sold: on the board such a clause adds nothing more. */
const ONE_SHOT = new Set(['获得时', '售出时']);

/**
 * What a piece on the board keeps stacking, or null: a clause of its 特质 raises 层数 on a trigger that repeats
 * (休整期结束时, 战斗中, 刷新时, …). A <获得时> stacker paid out when it was bought. A clause for 已激活的【X】 feeds only
 * an active X; the result names those bonds, and is empty for a clause that feeds whichever bond it reaches.
 */
function layerFeed(piece, activeNames) {
  const text = String(piece?.trait ?? '');
  const clauses = [...text.matchAll(/<([^>]+)>([^<]*)/g)].map(([, tag, body]) => [tag, body]);
  if (!clauses.length) clauses.push(['', text]);
  let feeds = null;
  for (const [tag, body] of clauses) {
    if (ONE_SHOT.has(tag) || !/层数/.test(body) || !/\+/.test(body)) continue;
    const named = body.match(/已激活的((?:【[^】]+】)+)/);
    if (!named) { feeds ??= []; continue; }
    const live = [...named[1].matchAll(/【([^】]+)】/g)].map((m) => m[1]).filter((name) => activeNames.has(name));
    if (live.length) feeds = [...new Set([...(feeds ?? []), ...live])];
  }
  return feeds;
}

/** A bond's first effect line without the card's "（受层数影响…）" note, with what one more layer adds. */
function headline(bond) {
  const first = String(bond.effect).split('；')[0].replace(/（受层数影响[^）]*）/g, '');
  const step = String(bond.per_layer ?? '').split('、')[0];
  return step ? `${first}（每层${step}）` : first;
}

/** The built-in AI's top bond at the latest reference round this round has reached, or null before the first. */
function layerReference(round) {
  const now = Number(round);
  if (!Number.isFinite(now)) return null;
  return LAYER_REFERENCE.filter(([r]) => r <= now).at(-1) ?? null;
}

/** How many copies of an operator merge into its elite (mcp/guide.js tutorialContext reads the same two settings). */
function mergeNeed(data, record) {
  const economy = obj(data.config?.economy);
  if (Number.isInteger(record?.upgradeNum) && record.upgradeNum > 0) return record.upgradeNum;
  const override = obj(economy.mergeCountOverrides)[record?.chessId];
  if (Number.isInteger(override)) return override;
  return Number.isInteger(economy.mergeCount) ? economy.mergeCount : 3;
}

/** One operator's normal and elite records share a base id. */
const baseOf = (data, id) => data.chess?.[id]?.baseId ?? id;
const isChess = (piece) => piece?.kind === 'chess' && !piece.empty;
const isElite = (data, piece) => !!(piece.golden || data.chess?.[piece.id]?.isGolden);
const bondsOf = (data, id) => list(data.chess?.[id]?.bonds);
const downward = (bond) => bond?.thresholdTemplate === 'count_threshold_downward';

/** Bench singles worth a line: a bench this full of one-offs is funds spent on nothing. */
const BENCH_SINGLES = 4;

const sellPriceOf = (data) => (Number.isFinite(data.config?.economy?.sellPrice) ? data.config.economy.sellPrice : 1);

/** Normal operators on the bench with no second copy anywhere: each one is a purchase the board has yet to use. */
function benchSingles(obs, data) {
  const owned = new Map();
  for (const piece of [...obs.board, ...obs.hand, ...obs.temp].filter(isChess)) {
    if (isElite(data, piece)) continue;
    const base = baseOf(data, piece.id);
    owned.set(base, (owned.get(base) ?? 0) + (Number(piece.count) || 1));
  }
  return obs.hand.filter((piece) => isChess(piece) && !isElite(data, piece) && owned.get(baseOf(data, piece.id)) === 1).length;
}

/**
 * The Final Assault in numbers, on the round before it and its own prep: the leader's armour, the shared pool
 * (bloodPoint[difficulty] × the players alive, server/match/gamedata.js bossPoolShareOf) and the overtime clock
 * (config bossOvertimeAfter / bossOvertimeDrainPerSec), with the damage per second that empties the pool before it.
 */
function assaultPreview(obs, data, pub) {
  const bossRound = Number(pub.bossRound);
  const round = Number(pub.round);
  if (!Number.isFinite(bossRound) || !Number.isFinite(round) || round < bossRound - 1 || round > bossRound) return null;
  const record = data.bosses?.[pub.bossId];
  const mode = obj(data.config?.modes?.[pub.modeId]);
  const per = obj(record?.bloodPoint)[pub.difficulty ?? mode.difficulty];
  if (!record || !Number.isFinite(per)) return null;
  const scale = { ...obj(data.config?.bossHpScale), ...obj(mode.bossHpScale) };
  const pick = (key, fallback) => (Number.isFinite(scale[key]) && scale[key] > 0 ? scale[key] : fallback);
  const full = Math.max(1, Math.floor(pick('aliveFull', 4)));
  const alive = Math.min(full, list(obs.players).filter((p) => p.alive !== false).length || full);
  const solo = mode.type === 'SINGLE';
  const perPlayer = scale.perPlayer !== false;
  const share = solo ? pick('solo', 1) : perPlayer ? pick('coop', 1) * alive : pick('coop', 1);
  const pool = Math.round(per * share);
  const stats = obj(data.enemies?.[record.enemyKey]?.stats);
  const armour = [Number.isFinite(stats.def) ? `防御 ${stats.def}` : '', Number.isFinite(stats.res) ? `法抗 ${stats.res}` : ''].filter(Boolean).join('、');
  const after = Number.isFinite(data.config?.bossOvertimeAfter) ? data.config.bossOvertimeAfter : 150;
  const drain = Number.isFinite(data.config?.bossOvertimeDrainPerSec) ? data.config.bossOvertimeDrainPerSec : 1;
  const sizing = solo || !perPlayer ? `血池 ${pool}` : `血池 ${per} × 存活玩家 ${alive} 人 = ${pool}`;
  // The merged LP is Σ LP of the players alive when the fight starts.
  const lp = list(obs.players).filter((p) => p.alive !== false).reduce((sum, p) => sum + (Number(p.lp) || 0), 0);
  const team = lp > 0 ? `（现在合计 ${lp}）` : '';
  return `第 ${bossRound} 回合最终攻势：领袖 ${record.name ?? pub.bossId}${armour ? `（${armour}）` : ''}，${sizing}；开打 ${after} 秒后加时，团队生命每秒 −${drain}${team}；${after} 秒内打空血池要每秒 ${Math.ceil(pool / after)} 伤害`;
}

/**
 * What a player reads off the prep screen at a glance: a greyed-out bond, a pair waiting for its third copy, a piece
 * facing away from the road, unspent funds. The lines state facts from the observation and the data files; every
 * choice stays with the agent. Line order is the order of work, so a long list keeps what comes first.
 */
export function prepChecks(obs, data, pub) {
  const lines = [];
  const scale = obs.enemy_scale;
  const wave = list(obs.next_enemies);
  const total = wave.reduce((sum, e) => sum + (Number(e.count) || 0), 0);
  const hp = wave.filter((e) => !e.boss).reduce((sum, e) => sum + (Number(e.count) || 0) * (e.hp_now ?? e.hp ?? 0), 0);
  if (total) {
    const factors = scale ? `（生命×${multiplier(scale.hp)}，攻击×${multiplier(scale.atk)}，移速×${multiplier(scale.speed)}）` : '';
    const leader = wave.some((e) => e.boss) ? '，领袖另计' : '';
    const top = (key) => wave.filter((e) => !e.boss && Number(e[key]) > 0).sort((x, y) => Number(y[key]) - Number(x[key]))[0];
    const def = top('def');
    const res = top('res');
    const armour = [def ? `防御最高 ${def.def}（${def.name ?? def.key}）` : '', res ? `法抗最高 ${res.res}（${res.name ?? res.key}）` : ''].filter(Boolean).join('，');
    lines.push(`本回合敌人 ${total} 只，总生命约 ${hp}${leader}${factors}${armour ? `；${armour}` : ''}`);
  }
  const dealt = list(obs.battle?.report?.units).reduce((sum, unit) => sum + (Number(unit.dmg) || 0), 0);
  if (dealt > 0) {
    // The share of each damage type: physical damage is atk − def, so it is what a high-defence wave stops.
    const types = obj(obs.battle?.report?.damage_types);
    const typed = Object.values(types).reduce((sum, v) => sum + (Number(v) || 0), 0);
    const names = { phys: '物理', arts: '法术', true: '真实', elemental: '元素' };
    const split = typed > 0 ? Object.entries(names).filter(([key]) => Number(types[key]) > 0)
      .map(([key, name]) => `${name} ${Math.round((Number(types[key]) * 100) / typed)}%`).join('、') : '';
    const ratio = hp > 0 ? `，本回合敌人总生命是它的 ${Number((hp / dealt).toFixed(1))} 倍` : '';
    lines.push(`上回合总输出 ${dealt}${split ? `（${split}）` : ''}${ratio}`);
  }
  const assault = assaultPreview(obs, data, pub);
  if (assault) lines.push(assault);
  if (obs.reward_offer) lines.push('晋升奖励待领取');
  const funds = Number(obs.me.funds) || 0;
  const keeps = list(data.config?.economy?.leftoverFundsKeptByBands).includes(obs.me.band);
  if (funds > 0 && !keeps) lines.push(`资金 ${funds}，休整期结束时清零，买入或刷新用完（刷新 ${obs.me.refresh_price ?? 1} 资金一次）`);

  const live = obs.bonds.filter((b) => !b.off && !b.disabled_this_match);
  const onBoard = obs.board.filter(isChess);
  const stacked = live.filter((b) => b.active).sort((a, b) => (Number(b.layers) || 0) - (Number(a.layers) || 0));
  if (stacked.length) {
    const shown = stacked.slice(0, 2).map((b) => `【${b.bond}】${Number(b.layers) || 0} 层${b.effect ? `：${headline(b)}` : ''}${b.milestone ? `，下一质变 ${b.milestone}` : ''}`);
    const ref = layerReference(pub.round);
    lines.push(`叠层 ${shown.join('；')}${ref ? `（内置 AI 第 ${ref[0]} 回合最高盟约 ${ref[1]} 层）` : ''}`);
  }
  const activeNames = new Set(live.filter((b) => b.active).map((b) => b.bond));
  const feedOf = new Map(onBoard.map((piece) => [piece, layerFeed(piece, activeNames)]));
  if (onBoard.length) {
    const stackers = [...new Map(onBoard.filter((piece) => feedOf.get(piece)).map((piece) => [piece.name, piece])).values()];
    const named = (piece) => (feedOf.get(piece).length ? `${piece.name}（${feedOf.get(piece).join('、')}）` : piece.name);
    lines.push(`场上叠层干员 ${stackers.length} 名${stackers.length ? `：${stackers.slice(0, 5).map(named).join('、')}` : ''}`);
  }
  for (const b of live) {
    if (b.active || !(b.layers > 0)) continue;
    const need = list(b.thresholds)[0];
    const people = need != null && !downward(data.bonds?.[b.id]) ? `${b.count ?? 0}/${need} 人` : `${b.count ?? 0} 人`;
    lines.push(`【${b.bond}】${people}，未激活，累积 ${b.layers} 层当前不生效`);
  }

  const copiesOnBoard = new Map();
  for (const piece of onBoard) copiesOnBoard.set(baseOf(data, piece.id), [...(copiesOnBoard.get(baseOf(data, piece.id)) ?? []), piece]);
  for (const copies of copiesOnBoard.values()) {
    if (copies.length < 2) continue;
    const distinct = bondsOf(data, copies[0].id).some((id) => data.bonds?.[id]?.countMode !== 'BOARD_ALL_CHESS');
    if (distinct) lines.push(`${copies[0].name} 场上 ${copies.length} 张，盟约按 1 人计`);
  }

  const forSale = obs.shop.filter((slot) => isChess(slot) && !slot.sold);
  const priced = (slot) => (slot.price > funds ? `（差 ${slot.price - funds} 资金）` : '');
  const owned = [...obs.board, ...obs.hand, ...obs.temp].filter(isChess);
  const normalCopies = new Map();
  for (const piece of owned) {
    if (isElite(data, piece)) continue;
    const base = baseOf(data, piece.id);
    normalCopies.set(base, (normalCopies.get(base) ?? 0) + (Number(piece.count) || 1));
  }
  for (const [base, copies] of normalCopies) {
    const slot = forSale.find((s) => baseOf(data, s.id) === base && !isElite(data, s));
    if (slot && copies === mergeNeed(data, data.chess?.[base]) - 1) lines.push(`商店第 ${slot.slot} 格 ${slot.name} 是最后一张，合成精锐${priced(slot)}`);
  }

  for (const b of live) {
    const record = data.bonds?.[b.id];
    if (downward(record) || record?.countMode === 'BOARD_ALL_CHESS') continue;
    const next = list(b.thresholds)[Number(b.tier) || 0];
    if (next == null || next - (Number(b.count) || 0) !== 1) continue;
    const hasBond = (piece) => bondsOf(data, piece.id).includes(b.id);
    const counted = new Set(onBoard.filter(hasBond).map((piece) => baseOf(data, piece.id)));
    const bench = obs.hand.filter((piece) => isChess(piece) && hasBond(piece) && !counted.has(baseOf(data, piece.id)));
    if (record?.countMode === 'BOARD_AND_DECK') bench.forEach((piece) => counted.add(baseOf(data, piece.id)));
    else if (bench.length) lines.push(`整备区 ${bench[0].name} 上场使【${b.bond}】达到 ${next} 人`);
    const slot = forSale.find((s) => hasBond(s) && !counted.has(baseOf(data, s.id)));
    if (slot) lines.push(`商店第 ${slot.slot} 格 ${slot.name} 使【${b.bond}】达到 ${next} 人${priced(slot)}`);
  }

  // Pieces the layers pass by: every bond of theirs is inactive and their trait adds no layers while they stand there.
  const activeIds = new Set(live.filter((b) => b.active).map((b) => b.id));
  const eliteBondOn = live.some((b) => b.active && data.bonds?.[b.id]?.countMode === 'BOARD_ALL_CHESS');
  const bystanders = onBoard.filter((piece) => !feedOf.get(piece) && !(eliteBondOn && isElite(data, piece))
    && !bondsOf(data, piece.id).some((id) => activeIds.has(id)));
  const idleNames = [...new Set(bystanders.map((piece) => piece.name))];
  if (idleNames.length) lines.push(`场上 ${idleNames.slice(0, 4).join('、')}：所属盟约都未激活，在场时特质不加层`);

  // A boss field is laid out differently from the seat's own lanes.
  const road = new Set(list(obs.field?.lanes).flatMap((lane) => list(lane.tiles)).map(([r, c]) => `${r},${c}`));
  const bossBoard = pub.bossRound != null && Number(pub.round) >= Number(pub.bossRound);
  if (road.size && !bossBoard) {
    for (const piece of onBoard) {
      if (piece.pos === 'MELEE' && piece.block > 0 && !road.has(`${piece.row},${piece.col}`)) {
        lines.push(`${piece.name} 站在敌人路线之外，阻挡不到地面敌人`);
      } else if (piece.dmg !== 'heal' && data.chess?.[piece.id]?.attackKind !== 'none' && Array.isArray(piece.range_tiles)
        && !piece.range_tiles.some(([r, c]) => road.has(`${r},${c}`))) {
        lines.push(`${piece.name} 的攻击范围覆盖 0 格敌人路线`);
      }
    }
  }

  const airborne = wave.filter((e) => e.fly).reduce((sum, e) => sum + (Number(e.count) || 0), 0);
  if (airborne) lines.push(`本回合空中敌人 ${airborne} 只，场上可对空 ${onBoard.filter((piece) => piece.hit_fly).length} 名`);

  const room = (Number(obs.me.deploy_cap) || 0) - (Number(obs.me.deploy_count) || 0);
  if (room > 0) lines.push(`场上 ${obs.me.deploy_count ?? 0}/${obs.me.deploy_cap}，还能上 ${room} 名`);
  const gear = obs.hand.filter((piece) => piece.kind === 'item');
  for (const piece of gear.slice(0, ITEM_LINES)) {
    const desc = String(piece.desc ?? '').split('\n')[0];
    lines.push(`整备区道具 ${piece.name ?? piece.id}（${piece.use ?? 'g.equip'} 生效）${desc ? `：${desc.length > 60 ? `${desc.slice(0, 60)}…` : desc}` : ''}`);
  }
  if (gear.length > ITEM_LINES) lines.push(`整备区另有 ${gear.length - ITEM_LINES} 件道具：${gear.slice(ITEM_LINES).map((piece) => piece.name ?? piece.id).join('、')}`);
  const singles = benchSingles(obs, data);
  if (singles >= BENCH_SINGLES) lines.push(`整备区有 ${singles} 张单张干员，卖出价 ${sellPriceOf(data)} 资金`);
  if (obs.hand_free === 0) lines.push('整备区已满，买入前先卖出或上场');
  return lines.slice(0, MAX_CHECKS);
}

/** How many messages one observation carries at most. */
export const MESSAGE_LIMIT = 12;

/**
 * The messages an observation carries: this round's and the previous round's, the newest MESSAGE_LIMIT of them. A toast
 * or an emote is on screen for a moment; the client keeps 50 for `stronghold_state`, and every observe would otherwise
 * carry all 50 into the agent's context again.
 */
function recentMessages(messages, round) {
  const now = Number(round);
  const kept = list(messages).filter((m) => round == null || !Number.isFinite(now) || m?.round == null || Number(m.round) >= now - 1);
  return kept.slice(-MESSAGE_LIMIT);
}

/**
 * Render one observation from a `stronghold_state` snapshot.
 *
 * @param {object} state  `client.snapshot()`
 * @param {Record<string, object>} [data]  gamedata.js `loadGameData()`; missing files only blank the joins
 * @param {{ env?: Record<string,string|undefined>, detail?: 'full'|'compact', includeField?: boolean, includeReport?: boolean, attackRange?: Function|null }} [options]
 *   attackRange: the game's own attackRangeGrid (client.attackRangeGrid); until the simulation is loaded, ranges are the records' stated ones
 */
export function observation(state, data = {}, { env = process.env, detail = 'full', includeField = true, includeReport = true, attackRange = null } = {}) {
  const last = obj(state?.last);
  const pub = obj(last['m.public']);
  const priv = obj(last['m.private']);
  const room = obj(last['room.state']);
  const shopState = obj(priv.shop);
  const rangeOf = attackRange ?? statedRange;
  const connection = obj(state?.connection);
  // m.private arrives with the match; in a lobby the connection is what says who this seat is.
  const myId = priv.playerId ?? connection.playerId;

  const shop = list(shopState.slots).map((slot, index) => {
    if (emptySlot(slot)) return { slot: index, empty: true };
    const info = pieceInfo(data, slot.kind, orNull(slot.id), rangeOf);
    return {
      ...info,
      slot: index,
      kind: orNull(slot.kind),
      price: orNull(slot.price ?? info.price),
      sold: orNull(slot.sold),
      frozen: orNull(slot.frozen),
    };
  });

  const { off: disabled, drawn } = disabledBondSets(data, pub);
  const bonds = list(priv.bonds).filter(isObject).map((bond) => ({
    bond: bondName(data, bond.bondId),
    id: orNull(bond.bondId),
    count: orNull(bond.count),
    active: orNull(bond.active),
    tier: orNull(bond.tier),
    layers: orNull(bond.layers),
    thresholds: list(data.bonds?.[bond.bondId]?.thresholds),
    counts_hand: orNull(bond.countsHand),
    disabled_this_match: disabled.has(bond.bondId),
    partial_pool: drawn.has(bond.bondId),
    off: orNull(bond.off),
    // The bond card's numbers at these layers: what the layers are worth right now.
    ...bondEffect(data.bonds?.[bond.bondId], bond.layers, bond.count),
    milestone: nextMilestone(data.bonds?.[bond.bondId], bond.layers),
  }));

  const players = list(pub.players).filter(isObject).map((player) => ({
    // What every other frame names a player by: draft picks, votes, 联防 helpers, emotes, g.watch.
    playerId: orNull(player.playerId),
    seat: orNull(player.seat),
    name: orNull(player.name),
    bot: orNull(player.isBot),
    connected: orNull(player.connected),
    alive: orNull(player.alive),
    lp: orNull(player.lp),
    pending_lp: orNull(player.pendingLp),
    unite_left: orNull(player.uniteLeft),
    level: orNull(player.shopLevel),
    board: orNull(player.boardCount),
    ready: orNull(player.ready),
    status: orNull(player.status),
    band: orNull(player.bandId),
    // Set while a battle field is up; a prep phase scouts by `n:<playerId>` instead.
    fieldId: orNull(player.fieldId),
    bonds: list(player.bonds).map((b) => (isObject(b) ? bondName(data, b.bondId) : b)).slice(0, 8),
  }));

  const mapRows = list(obj(data.stages?.[pub.stageId ?? '']).rows);
  const board = pieces(data, priv.board, rangeOf).map((piece) => withRangeTiles(piece, mapRows));
  const deployCap = priv.deployCap || 0;
  const scale = enemyScale(data, pub);
  // serverNow is the clock when the frame left; the frame has aged since. A paused match's deadlines stand still.
  const frameAges = obj(connection.frameAgesMs);
  const serverClock = Number(pub.serverNow) + (pub.paused ? 0 : Number(frameAges['m.public']) || 0);
  const obs = {
    // `connected` and `has_frames` guard the whole snapshot: the frames below are the LAST ones received,
    // so a disconnected seat keeps showing whatever it last saw. An agent that ignores these will
    // happily reason about a match that ended an hour ago.
    connected: !!connection.connected,
    has_frames: nonEmpty(pub) || nonEmpty(priv),
    frames_age_ms: orNull(connection.framesAgeMs),
    phase: orNull(pub.phase),
    round: orNull(pub.round),
    seconds_left: secondsLeft(pub.deadline, serverClock),
    paused: orNull(pub.paused),
    stage: orNull(pub.stageId),
    combat_mode: orNull(pub.combatMode),
    setup_revision: orNull(pub.setupRevision),
    room: roomView(room),
    me: {
      playerId: orNull(myId),
      seat: orNull(priv.seat),
      alive: orNull(priv.alive),
      lp: orNull(priv.lp),
      funds: orNull(priv.funds),
      band: orNull(priv.bandId),
      level: orNull(shopState.level),
      max_level: orNull(shopState.maxLevel),
      upgrade_price: orNull(shopState.upgradePrice),
      refresh_price: orNull(shopState.refreshPrice),
      free_refreshes: orNull(shopState.freeRefreshes),
      shop_frozen: orNull(shopState.frozen),
      deploy: `${priv.deployCount ?? 0}/${deployCap}`,
      deploy_count: orNull(priv.deployCount),
      deploy_cap: deployCap,
      ready: orNull(priv.ready),
      can_ready: orNull(priv.canReady),
      stats: orNull(priv.stats),
    },
    shop,
    reward_offer: rewardOffer(data, shopState.rewardOffer, rangeOf),
    personal_choice: orNull(priv.personalChoice),
    hand: pieces(data, priv.hand, rangeOf),
    hand_free: list(priv.hand).filter(emptySlot).length,
    temp: pieces(data, priv.temp, rangeOf),
    board,
    board_tiles: Object.fromEntries(board.filter((p) => p.row != null).map((p) => [`${p.row},${p.col}`, p.uid])),
    bonds,
    effects: effectsView(priv.effects),
    next_enemies: wavePreview(data, priv.nextEnemies, scale),
    players,
    messages: recentMessages(state?.messages, pub.round).map((entry) => messageView(entry, pub, myId)),
    field: field(data, pub.stageId, fieldRegion(env)),
  };
  if (scale) obs.enemy_scale = scale;
  // The battle section goes in before checks: they read the last battle's report (上回合总输出).
  const battle = state?.battleSimulation;
  if (battle) {
    // The runner's status is a property of the session, not of this round: after a match ends (or the
    // seat leaves), `current` still describes the last battle it ran. A prep phase normally follows the
    // previous round's battle, so only a round that is neither this one nor the one before is flagged.
    const current = battle.current;
    const round = Number(pub.round);
    const stale = isObject(current) && current.round != null && current.round !== round && current.round !== round - 1;
    // The report is carried once, as `battle.report`; `lastResult` keeps the summary only. Copies, so the
    // runner's shared status is never mutated.
    const { report: _nested, ...summary } = obj(battle.lastResult);
    obs.battle = {
      ...battle,
      lastResult: battle.lastResult ? summary : null,
      report: battle.lastResult?.report || battle.report || null,
      ...(stale ? { stale: true, stale_reason: `battle.current.round=${current.round} but the match is at round ${pub.round ?? null}` } : {}),
    };
  }
  if (pub.phase === 'PREP') obs.checks = prepChecks(obs, data, pub);
  const comms = commsView(pub, state?.messages, state?.lastEmote, myId);
  if (comms) obs.comms = comms;
  if (connection.reconnecting) obs.reconnecting = true;
  if (nonEmpty(pub)) obs.setup = setupView(data, pub);
  if (list(pub.fields).length) obs.fields = fieldsView(pub);
  if (isObject(pub.unite)) obs.unite = { helpers: list(pub.unite.helpers), leakers: list(pub.unite.leakers) };
  if (isObject(pub.uniteResult)) obs.unite_result = uniteResultView(pub.uniteResult);
  if (isObject(pub.bossHp)) obs.boss_hp = { hp: orNull(pub.bossHp.hp), max: orNull(pub.bossHp.max) };
  if (pub.teamLp != null) obs.team_lp = pub.teamLp;
  const overtime = secondsLeft(pub.overtimeAt, serverClock);
  if (overtime != null) obs.overtime_in_s = overtime;
  if (isObject(last['m.field']) && last['m.field'].prep) {
    obs.scouted = scoutedView(data, last['m.field'], pub, rangeOf, scale);
    obs.scouted_age_ms = orNull(frameAges['m.field']);
  }
  // The frame stays in `last` after the room moves on; this phase is what says it still describes the match.
  if (pub.phase === 'RESULT' && isObject(last['m.result'])) obs.result = resultView(data, last['m.result']);
  if (isObject(pub.rerollVote)) obs.reroll_vote = rerollVote(pub, myId);
  if (pub.phase === 'BAND_DRAFT') obs.band_draft = bandDraft(data, pub, room, priv.playerId);
  if (pub.phase === 'SP_DRAFT' && isObject(pub.sp)) obs.sp_draft = spDraft(pub, priv.playerId, data, scale);

  if (obs.battle && !includeReport) delete obs.battle.report;
  if (!includeField) delete obs.field;
  return detail === 'compact' ? compactObservation(obs, data, rangeOf) : obs;
}

/** Drop the keys whose value says nothing: null, undefined, and the listed defaults. */
function pruned(entry, defaults = {}) {
  return Object.fromEntries(Object.entries(entry).filter(([key, value]) => value != null && !(key in defaults && Object.is(defaults[key], value))
    && !(Array.isArray(value) && !value.length && key in defaults)));
}

const PIECE_DEFAULTS = Object.freeze({ golden: false, count: 1, items: [], sold: false, frozen: false });
const SKILL_DEFAULTS = Object.freeze({ sp_cost: 0, init_sp: 0, duration: 0 });
const ROOM_DEFAULTS = Object.freeze({ seats: [] });
const SETUP_DEFAULTS = Object.freeze({ factions: [], disabled_bonds: [], partial_pool_bonds: [], banned_chess: [] });
const SEAT_RESULT_DEFAULTS = Object.freeze({ left: false, bonds: [], lineup: [] });
const LINEUP_DEFAULTS = Object.freeze({ golden: false, items: [] });
const BOND_DEFAULTS = Object.freeze({ counts_hand: false, disabled_this_match: false, partial_pool: false });
const ENEMY_DEFAULTS = Object.freeze({ elite: false, boss: false, bounty: false });

/** The runner's status as a turn needs it: the last battle's outcome, a live one's progress, and any fault. */
function compactBattle(battle) {
  const out = pruned({ mode: battle.mode, ready: battle.ready });
  // `current` outlives its battle; only a battle still running (b.progress done:false) is live.
  if (isObject(battle.current) && battle.current.done === false) out.live = battle.current;
  if (isObject(battle.lastResult)) {
    const { battleId: _id, ...last } = battle.lastResult;
    out.last = pruned(last);
  }
  for (const key of ['report', 'error', 'hint', 'declined', 'stale', 'stale_reason']) if (battle[key]) out[key] = battle[key];
  if (isObject(out.report) && out.last) {
    // The outcome is already in `last`; the report adds what happened during the battle.
    const { round: _round, result: _result, killed: _killed, total: _total, time: _time, ...rest } = out.report;
    out.report = rest;
  }
  if (battle.pending) out.pending = battle.pending;
  return out;
}

/**
 * Keep live instances separate from static definitions, once per id in this response, and leave out the
 * values that only repeat a default. An absent flag is its default (false / 1 / empty); an absent field is unknown.
 */
function compactObservation(obs, data, rangeOf) {
  const catalog = {};
  const staticKeys = new Set(['name', 'tier', 'prof', 'pos', 'hp', 'atk', 'def', 'res', 'block', 'hit_fly', 'dmg', 'cost', 'bonds', 'trait', 'desc', 'use', 'token', 'range', 'skill']);
  const instance = (area) => (piece) => {
    if (piece.empty) return piece;
    catalog[`${piece.kind}:${piece.id}`] = pruned(pieceInfo(data, piece.kind, piece.id, rangeOf), PIECE_DEFAULTS);
    return pruned(Object.fromEntries(Object.entries(piece).filter(([key]) => !staticKeys.has(key) && (key !== 'price' || area === 'shop'))), PIECE_DEFAULTS);
  };
  for (const area of ['shop', 'hand', 'temp', 'board']) obs[area] = obs[area].map(instance(area));
  if (obs.reward_offer) obs.reward_offer = { ...pruned(obs.reward_offer), slots: obs.reward_offer.slots.map(instance('shop')) };
  const preview = (enemy) => {
    catalog[`enemy:${enemy.key}`] = pruned(enemyInfo(data, enemy.key));
    // `fly` stays on each entry: without the record it is the preview's own flag.
    return pruned(Object.fromEntries(['key', 'at_s', 'count', 'gate', 'elite', 'fly', 'boss', 'bounty', 'hp_now', 'atk_now'].map((key) => [key, enemy[key]])), ENEMY_DEFAULTS);
  };
  obs.next_enemies = obs.next_enemies.map(preview);
  if (obs.scouted) {
    obs.scouted = {
      ...pruned(obs.scouted),
      units: obs.scouted.units.map(instance('board')),
      effects: obs.scouted.effects.map((effect) => pruned(effect)),
      next_enemies: obs.scouted.next_enemies.map(preview),
    };
  }
  obs.bonds = obs.bonds.map(({ thresholds, bond: name, ...bond }) => {
    catalog[`bond:${bond.id}`] = { id: bond.id, name, thresholds };
    return pruned(bond, BOND_DEFAULTS);
  });
  // `deploy` repeats deploy_count / deploy_cap as a string.
  const { deploy: _deploy, ...me } = obs.me;
  obs.me = pruned(me);
  obs.room = pruned(obs.room, ROOM_DEFAULTS);
  if (obs.room.seats) obs.room.seats = obs.room.seats.map((seat) => pruned(seat));
  obs.effects = obs.effects.map((effect) => pruned(effect));
  obs.players = obs.players.map((player) => pruned(player));
  if (obs.band_draft) obs.band_draft = { ...pruned(obs.band_draft), options: obs.band_draft.options.map((b) => pruned(b)) };
  if (obs.sp_draft) obs.sp_draft = { ...pruned(obs.sp_draft), cards: obs.sp_draft.cards.map((c) => pruned(c)) };
  if (obs.battle) obs.battle = compactBattle(obs.battle);
  if (obs.setup) obs.setup = pruned(obs.setup, SETUP_DEFAULTS);
  if (obs.fields) obs.fields = obs.fields.map((f) => pruned(f));
  if (obs.result) {
    obs.result = {
      ...pruned(obs.result),
      players: obs.result.players.map((p) => pruned({ ...p, bonds: p.bonds.map((b) => pruned(b)), lineup: p.lineup.map((u) => pruned(u, LINEUP_DEFAULTS)) }, SEAT_RESULT_DEFAULTS)),
    };
  }
  obs.messages = obs.messages.map((message) => pruned(message));
  if (!obs.messages.length) delete obs.messages;
  for (const key of ['reward_offer', 'personal_choice', 'paused', 'seconds_left', 'frames_age_ms', 'setup_revision']) if (obs[key] == null) delete obs[key];
  obs.catalog = catalog;
  return obs;
}
