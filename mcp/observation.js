/**
 * Observation: turn the server's frames into one decision-ready snapshot.
 *
 * This makes no decisions. It only renders what the server last said, joined with the game's own data
 * files (see gamedata.js), so an agent can reason about a turn without parsing raw protocol frames.
 * `stronghold_observe` returns it; docs/observation.md says where every field comes from.
 *
 *   phase / round / seconds_left    where the match is
 *   room                            mode, difficulty, and whether this is a training room
 *   me                              funds, shop level, deploy count, ready state, cumulative stats
 *   shop                            every slot, priced and joined with the chess/item record
 *   reward_offer / personal_choice  the modal offers that block Ready while they are open
 *   hand / temp / board             every piece, with its data and its tile
 *   bonds                           every bond with its live layers, active tier and thresholds
 *   effects                         the counters and bounty effects this seat is holding
 *   next_enemies                    the coming wave, per spawn action
 *   players                         every seat, for co-op awareness
 *   band_draft                      during BAND_DRAFT: every strategy the draft screen offers, and whose turn it is
 *   sp_draft                        during SP_DRAFT: the 机变 event and its cards (g.choice { idx } picks one)
 *   field                           deployable tiles, the lanes enemies walk, and a rendered map
 *   battle                          the local battle runner's status, when one is attached
 *
 * The field region mirrors the game's own `GEO.FIELD` (`shared/constants.js`); override it with
 * STRONGHOLD_FIELD_REGION="r0,r1,c0,c1" for a layout it does not describe.
 */

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

/** The decision-relevant slice of one shop slot or piece's record. */
function pieceInfo(data, kind, id) {
  if (kind === 'chess') {
    const raw = obj(data.chess?.[id]);
    const stats = obj(raw.stats);
    return {
      id,
      name: orNull(raw.name),
      tier: orNull(raw.tier),
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
    };
  }
  if (kind === 'token') {
    // A summon (a skill's drone or doll): it has no price and is not draggable.
    const raw = data.tokens?.[id];
    return { id, name: orNull(raw?.name), desc: raw ? raw.desc || raw.effectName || '' : null, token: true };
  }
  const raw = kind === 'item' ? data.items?.[id] : null;
  return { id, name: orNull(raw?.name), tier: orNull(raw?.tier), desc: raw ? raw.desc || raw.effectName || '' : null };
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
export function pieces(data, rawList) {
  const out = [];
  list(rawList).forEach((piece, index) => {
    if (!nonEmpty(piece)) return;
    const entry = { slot: index, uid: orNull(piece.uid), kind: orNull(piece.kind), ...pieceInfo(data, piece.kind, orNull(piece.id)) };
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

/** The deployable tiles and the lanes enemies walk on this seat's half, straight from the stage data. */
export function field(data, stageId, region = DEFAULT_FIELD_REGION) {
  const [r0, r1, c0, c1] = region;
  const stage = obj(data.stages?.[stageId ?? '']);
  const deploy = obj(obj(stage.deployTiles).normal);
  const lanes = [];
  for (const [name, lane] of Object.entries(obj(stage.groundPaths))) {
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
  const disabled = new Set(list(pub.disabledBonds));
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

/** The 机变 draft (SP_DRAFT): the event, its cards, and whose turn it is. The server already names the cards. */
export function spDraft(pub, playerId) {
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
 * Render one observation from a `stronghold_state` snapshot.
 *
 * @param {object} state  `client.snapshot()`
 * @param {Record<string, object>} [data]  gamedata.js `loadGameData()`; missing files only blank the joins
 * @param {{ env?: Record<string,string|undefined>, detail?: 'full'|'compact', includeField?: boolean, includeReport?: boolean }} [options]
 */
export function observation(state, data = {}, { env = process.env, detail = 'full', includeField = true, includeReport = true } = {}) {
  const last = obj(state?.last);
  const pub = obj(last['m.public']);
  const priv = obj(last['m.private']);
  const room = obj(last['room.state']);
  const shopState = obj(priv.shop);

  const shop = list(shopState.slots).map((slot, index) => {
    if (emptySlot(slot)) return { slot: index, empty: true };
    const info = pieceInfo(data, slot.kind, orNull(slot.id));
    return {
      ...info,
      slot: index,
      kind: orNull(slot.kind),
      price: orNull(slot.price ?? info.price),
      sold: orNull(slot.sold),
      frozen: orNull(slot.frozen),
    };
  });

  const disabled = new Set(list(pub.disabledBonds));
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
    off: orNull(bond.off),
  }));

  const nextEnemies = list(priv.nextEnemies).filter(isObject).map((enemy) => ({
    ...enemyInfo(data, enemy.enemyKey),
    at_s: orNull(enemy.t),
    count: orNull(enemy.count),
    gate: orNull(enemy.gate),
    elite: orNull(enemy.elite),
    // The simulation decides from the record (motion / hover), whatever the preview's spawn slot says.
    fly: data.enemies?.[enemy.enemyKey] ? airOf(data.enemies[enemy.enemyKey]) : orNull(enemy.fly),
    boss: orNull(enemy.boss),
  }));

  const players = list(pub.players).filter(isObject).map((player) => ({
    seat: orNull(player.seat),
    name: orNull(player.name),
    bot: orNull(player.isBot),
    alive: orNull(player.alive),
    lp: orNull(player.lp),
    level: orNull(player.shopLevel),
    board: orNull(player.boardCount),
    ready: orNull(player.ready),
    status: orNull(player.status),
    band: orNull(player.bandId),
    bonds: list(player.bonds).map((b) => (isObject(b) ? bondName(data, b.bondId) : b)).slice(0, 8),
  }));

  const board = pieces(data, priv.board);
  const deployCap = priv.deployCap || 0;
  const connection = obj(state?.connection);
  const obs = {
    // `connected` and `has_frames` guard the whole snapshot: the frames below are the LAST ones received,
    // so a disconnected seat keeps showing whatever it last saw. An agent that ignores these will
    // happily reason about a match that ended an hour ago.
    connected: !!connection.connected,
    has_frames: nonEmpty(pub) || nonEmpty(priv),
    frames_age_ms: orNull(connection.framesAgeMs),
    phase: orNull(pub.phase),
    round: orNull(pub.round),
    seconds_left: secondsLeft(pub.deadline, pub.serverNow),
    paused: orNull(pub.paused),
    stage: orNull(pub.stageId),
    combat_mode: orNull(pub.combatMode),
    room: { code: orNull(room.code), train: orNull(room.train), mode: orNull(room.mode), difficulty: orNull(room.difficulty) },
    me: {
      playerId: orNull(priv.playerId),
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
    reward_offer: orNull(shopState.rewardOffer),
    personal_choice: orNull(priv.personalChoice),
    hand: pieces(data, priv.hand),
    hand_free: list(priv.hand).filter(emptySlot).length,
    temp: pieces(data, priv.temp),
    board,
    board_tiles: Object.fromEntries(board.filter((p) => p.row != null).map((p) => [`${p.row},${p.col}`, p.uid])),
    bonds,
    effects: list(priv.effects).filter(isObject).map((e) => ({ name: orNull(e.name), desc: orNull(e.desc), counter: orNull(e.counter) })),
    next_enemies: nextEnemies,
    players,
    field: field(data, pub.stageId, fieldRegion(env)),
  };
  if (pub.phase === 'BAND_DRAFT') obs.band_draft = bandDraft(data, pub, room, priv.playerId);
  if (pub.phase === 'SP_DRAFT' && isObject(pub.sp)) obs.sp_draft = spDraft(pub, priv.playerId);

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
    if (!includeReport) delete obs.battle.report;
  }
  if (!includeField) delete obs.field;
  return detail === 'compact' ? compactObservation(obs, data) : obs;
}

/** Drop the keys whose value says nothing: null, undefined, and the listed defaults. */
function pruned(entry, defaults = {}) {
  return Object.fromEntries(Object.entries(entry).filter(([key, value]) => value != null && !(key in defaults && Object.is(defaults[key], value))
    && !(Array.isArray(value) && !value.length && key in defaults)));
}

const PIECE_DEFAULTS = Object.freeze({ golden: false, count: 1, items: [], sold: false, frozen: false });
const BOND_DEFAULTS = Object.freeze({ counts_hand: false, disabled_this_match: false });
const ENEMY_DEFAULTS = Object.freeze({ elite: false, boss: false });

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
function compactObservation(obs, data) {
  const catalog = {};
  const staticKeys = new Set(['name', 'tier', 'prof', 'pos', 'hp', 'atk', 'def', 'res', 'block', 'hit_fly', 'dmg', 'cost', 'bonds', 'trait', 'desc', 'token']);
  for (const area of ['shop', 'hand', 'temp', 'board']) {
    obs[area] = obs[area].map((piece) => {
      if (piece.empty) return piece;
      catalog[`${piece.kind}:${piece.id}`] = pruned(pieceInfo(data, piece.kind, piece.id));
      return pruned(Object.fromEntries(Object.entries(piece).filter(([key]) => !staticKeys.has(key) && (key !== 'price' || area === 'shop'))), PIECE_DEFAULTS);
    });
  }
  obs.next_enemies = obs.next_enemies.map((enemy) => {
    catalog[`enemy:${enemy.key}`] = pruned(enemyInfo(data, enemy.key));
    // `fly` stays on each entry: without the record it is the preview's own flag.
    return pruned(Object.fromEntries(['key', 'at_s', 'count', 'gate', 'elite', 'fly', 'boss'].map((key) => [key, enemy[key]])), ENEMY_DEFAULTS);
  });
  obs.bonds = obs.bonds.map(({ thresholds, bond: name, ...bond }) => {
    catalog[`bond:${bond.id}`] = { id: bond.id, name, thresholds };
    return pruned(bond, BOND_DEFAULTS);
  });
  // `deploy` repeats deploy_count / deploy_cap as a string.
  const { deploy: _deploy, ...me } = obs.me;
  obs.me = pruned(me);
  obs.room = pruned(obs.room);
  obs.effects = obs.effects.map((effect) => pruned(effect));
  obs.players = obs.players.map((player) => pruned(player));
  if (obs.band_draft) obs.band_draft = { ...pruned(obs.band_draft), options: obs.band_draft.options.map((b) => pruned(b)) };
  if (obs.sp_draft) obs.sp_draft = { ...pruned(obs.sp_draft), cards: obs.sp_draft.cards.map((c) => pruned(c)) };
  if (obs.battle) obs.battle = compactBattle(obs.battle);
  for (const key of ['reward_offer', 'personal_choice', 'paused', 'seconds_left', 'frames_age_ms']) if (obs[key] == null) delete obs[key];
  obs.catalog = catalog;
  return obs;
}
