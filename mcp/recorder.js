/**
 * Local match log for post-match review.
 *
 * Off unless STRONGHOLD_RECORD_DIR is set; a public deployment leaves it unset. Each match gets one `.jsonl` file
 * there: a `match` line, a `round` line per fight with the lineup that went in, a `battle` line per report this
 * seat's runner produced, and a `result` line at the settlement.
 *
 * Every field is picked by name, so a line holds game ids and numbers. Player names and messages stay out: notes
 * written from these files last across matches, and another seat's text must not travel with them.
 *
 * Recording never gets in the way of play: a failed write lands in `client.recorder.error`.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RECORD_VERSION = 1;
/** The phases a lineup goes to battle in. UNITE is left out: it fights with the lineup COMBAT recorded. */
const BATTLE_PHASES = new Set(['COMBAT', 'FINAL_ASSAULT', 'HIDDEN_CORE']);
/** No match is being played in these. */
const IDLE_PHASES = new Set(['LOBBY', 'RESULT']);

const list = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const orNull = (value) => value ?? null;

const numbers = (raw) => Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => typeof value === 'number'));
const itemIds = (raw) => list(raw).map((item) => (isObject(item) ? orNull(item.id) : orNull(item)));

function pieceLines(raw) {
  return list(raw).filter((piece) => isObject(piece) && piece.id != null).map((piece) => {
    const line = { uid: orNull(piece.uid), kind: orNull(piece.kind), id: piece.id };
    if (piece.golden != null) line.golden = !!piece.golden;
    if (piece.count != null) line.count = piece.count;
    const items = itemIds(piece.items);
    if (items.length) line.items = items;
    if (piece.row != null) Object.assign(line, { row: piece.row, col: orNull(piece.col), dir: orNull(piece.dir) });
    return line;
  });
}

const bondLines = (raw) => list(raw).filter(isObject).map((bond) => ({
  id: orNull(bond.bondId),
  count: orNull(bond.count),
  active: orNull(bond.active),
  tier: orNull(bond.tier),
  layers: orNull(bond.layers),
}));

/** Works from m.public or, for a match that never reached a battle here, m.result: both name the setup. */
function matchLine(client, frame) {
  const room = client.last['room.state'] ?? {};
  return {
    type: 'match',
    room: orNull(room.code),
    ...(room.train ? { train: true } : {}),
    ...(room.test ? { test: true } : {}),
    content: orNull(client.welcome?.content?.vanilla),
    mode: orNull(frame.modeId),
    difficulty: orNull(frame.difficulty),
    stage: orNull(frame.stageId),
    boss: orNull(frame.bossId),
    hidden_boss: orNull(frame.hiddenBossId),
    last_round: orNull(frame.lastRound),
    boss_round: orNull(frame.bossRound),
    hidden_round: orNull(frame.hiddenRound),
    factions: list(frame.factions),
    disabled_bonds: list(frame.disabledBonds),
    banned_chess: list(frame.bannedChess),
    seat: orNull(client.last['m.private']?.seat),
  };
}

function roundLine(client, pub) {
  const priv = client.last['m.private'] ?? {};
  return {
    type: 'round',
    round: orNull(pub.round),
    phase: pub.phase,
    alive: orNull(priv.alive),
    lp: orNull(priv.lp),
    ...(pub.teamLp != null ? { team_lp: pub.teamLp } : {}),
    funds: orNull(priv.funds),
    level: orNull(priv.shop?.level),
    band: orNull(priv.bandId),
    deploy_count: orNull(priv.deployCount),
    board: pieceLines(priv.board),
    hand: pieceLines(priv.hand),
    temp: pieceLines(priv.temp),
    bonds: bondLines(priv.bonds),
    seats: list(pub.players).filter(isObject).map((p) => ({
      seat: orNull(p.seat),
      bot: orNull(p.isBot),
      alive: orNull(p.alive),
      lp: orNull(p.lp),
      band: orNull(p.bandId),
      level: orNull(p.shopLevel),
      board_count: orNull(p.boardCount),
    })),
  };
}

function battleLine(battle) {
  return {
    type: 'battle',
    round: orNull(battle.round),
    kind: orNull(battle.kind),
    reason: orNull(battle.reason),
    time: orNull(battle.time),
    killed: orNull(battle.killed),
    total: orNull(battle.total),
    report: orNull(battle.report),
  };
}

function resultLine(client, raw) {
  return {
    type: 'result',
    seed: orNull(raw.seed),
    victory: orNull(raw.victory),
    rounds_passed: orNull(raw.roundsPassed),
    reason: orNull(raw.reason),
    hidden_reached: orNull(raw.hiddenReached),
    hidden_cleared: orNull(raw.hiddenCleared),
    team_lp: orNull(raw.teamLp),
    duration_ms: orNull(raw.durationMs),
    ...(raw.test ? { test: true } : {}),
    players: list(raw.players).filter(isObject).map((p) => ({
      me: p.playerId === client.playerId,
      seat: orNull(p.seat),
      bot: orNull(p.isBot),
      left: orNull(p.left),
      alive: orNull(p.alive),
      victory: orNull(p.victory),
      rounds_passed: orNull(p.roundsPassed),
      eliminated_round: orNull(p.eliminatedRound),
      lp: orNull(p.lp),
      band: orNull(p.bandId),
      title: orNull(isObject(p.title) ? p.title.id : p.title),
      credited_kills: orNull(p.creditedKills),
      stats: numbers(p.stats),
      bonds: bondLines(p.bonds),
      lineup: list(p.lineup).filter(isObject).map((unit) => ({
        id: orNull(unit.id),
        tier: orNull(unit.tier),
        golden: orNull(unit.golden),
        row: orNull(unit.row),
        col: orNull(unit.col),
        items: itemIds(unit.items),
      })),
    })),
  };
}

/** `2026-10-31T06:25:39.123Z` -> `20261031T062539Z`: the file names sort by start time. */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d+/g, '');

/**
 * Record this seat's matches, when the environment asks for it.
 *
 * @param {import('./game-client.js').StrongholdClient} client
 * @param {{ env?: Record<string,string|undefined>, now?: () => number }} [options]
 * @returns {{ dir: string, match: string|null, file: string|null, records: number, error: string|null }|null}
 *   the status also kept on `client.recorder`, or null when recording is off
 */
export function attachRecorder(client, { env = process.env, now = Date.now } = {}) {
  const configured = String(env.STRONGHOLD_RECORD_DIR ?? '').trim();
  if (!configured) return null;
  const dir = resolve(configured);
  const status = client.recorder = { dir, match: null, file: null, records: 0, error: null };
  /** The match being written; null between matches. `status` keeps naming the last one for a review. */
  let current = null;
  /** The seed of the last settlement written: a resync in the lobby replays its frame. */
  let settled = null;

  function append(line) {
    const record = { v: RECORD_VERSION, match: current.id, at: new Date(now()).toISOString(), ...line };
    appendFileSync(current.file, `${JSON.stringify(record)}\n`);
    status.records += 1;
    status.error = null;
  }

  function open(frame) {
    mkdirSync(dir, { recursive: true });
    const id = `${stamp(now())}-${randomBytes(3).toString('hex')}`;
    current = { id, file: join(dir, `${id}.jsonl`), round: 0, seen: new Set() };
    Object.assign(status, { match: id, file: current.file, records: 0 });
    append(matchLine(client, frame));
  }

  const guarded = (handler) => (frame) => {
    try {
      handler(frame);
    } catch (error) {
      status.error = error?.message ?? String(error);
      console.error('[stronghold-mcp] match record failed:', status.error);
    }
  };

  // The first battle opens the file, not the first frame: the setup can still be rerolled before it. A resync sends
  // m.public before m.private, into a cache the hello emptied, so either frame can be the one that completes a round.
  const recordRound = guarded(() => {
    const pub = client.last['m.public'];
    if (!client.last['m.private'] || !BATTLE_PHASES.has(pub?.phase)) return;
    // A round going backwards is a new match, after one whose settlement never reached this seat.
    if (current && pub.round < current.round) current = null;
    if (!current) open(pub);
    const key = `${pub.round}/${pub.phase}`;
    if (current.seen.has(key)) return;
    current.seen.add(key);
    current.round = pub.round;
    append(roundLine(client, pub));
  });
  client.on('m.public', recordRound);
  client.on('m.private', recordRound);

  // A fast runner finishes before the m.public announcing the battle arrives, so a report can be a match's first
  // word. After a settlement the phase is RESULT: a straggler from the last battle opens nothing.
  client.on('battle.report', guarded((battle) => {
    const pub = client.last['m.public'];
    if (!current && pub && !IDLE_PHASES.has(pub.phase)) open(pub);
    if (current) append(battleLine(battle));
  }));

  client.on('m.result', guarded((result) => {
    if (!current && result.seed != null && result.seed === settled) return;
    if (!current) open(client.last['m.public'] ?? result);
    append(resultLine(client, result));
    settled = result.seed ?? null;
    current = null;
  }));

  client.on('room.left', () => { current = null; });

  return status;
}
