/**
 * stronghold_review: the numbers of one match, for a player reviewing it.
 *
 * It reads the match log recorder.js keeps and joins it with the game's data files. The output holds game names and
 * numbers, and seats by number: another player's name and words stay out, because a review ends up in notes that last
 * across matches. `findings` state gaps as facts; what to change is the player's call.
 */

/**
 * The built-in AI, measured with the real engine: mean of the alive seats at the start of each fight, co-op ABYSS with 3
 * seats, 4 seeds, no rehearsal. Later rounds count survivors only. It is a reference for pace, a competent line of play
 * and no target: on ABYSS these seats lost every match.
 */
const AI_CURVE = Object.freeze({
  1: { level: 1, elites: 0, items: 0.1, top_layers: 1 },
  2: { level: 1, elites: 0.1, items: 0.6, top_layers: 2 },
  3: { level: 1, elites: 0.3, items: 0.7, top_layers: 4 },
  4: { level: 2, elites: 0.8, items: 0.9, top_layers: 6 },
  5: { level: 2.9, elites: 1.1, items: 1.1, top_layers: 8 },
  6: { level: 3, elites: 1.3, items: 1.8, top_layers: 11 },
  7: { level: 4, elites: 1.3, items: 2.1, top_layers: 15 },
  8: { level: 4, elites: 1.3, items: 3.2, top_layers: 23 },
  9: { level: 4, elites: 1.7, items: 4.3, top_layers: 32 },
  10: { level: 5, elites: 1.8, items: 4.6, top_layers: 36 },
  11: { level: 5, elites: 1.8, items: 5.8, top_layers: 54 },
  12: { level: 5.8, elites: 1.8, items: 6.8, top_layers: 69 },
  13: { level: 6, elites: 2.3, items: 9.7, top_layers: 85 },
});

/** What makes a round worth a finding: layers lying idle, funds lost at prep end, LP lost in one fight. */
const IDLE_LAYERS = 20;
const WASTED_FUNDS = 3;
const HEAVY_LOSS = 5;
const FULL_BOARD_FROM = 4;
const TOP_UNITS = 3;
const TURNING_POINTS = 3;

const list = (value) => (Array.isArray(value) ? value : []);
const orNull = (value) => value ?? null;

/** `第 5～8 回合` for runs of consecutive rounds. */
function roundSpans(rounds) {
  const spans = [];
  for (const round of rounds) {
    const last = spans.at(-1);
    if (last && last.to === round - 1) last.to = round;
    else spans.push({ from: round, to: round });
  }
  return spans.map(({ from, to }) => (from === to ? `第 ${from} 回合` : `第 ${from}～${to} 回合`)).join('、');
}

function roundView(line, battle, data) {
  const chessName = (id) => data.chess?.[id]?.name ?? id;
  const bondName = (id) => data.bonds?.[id]?.name ?? id;
  const board = list(line.board).filter((piece) => piece.kind === 'chess');
  const bonds = list(line.bonds);
  const report = battle?.report ?? {};
  const leaked = {};
  for (const [enemy, count] of Object.entries(report.leaked_by_enemy ?? {})) leaked[data.enemies?.[enemy]?.name ?? enemy] = count;
  return {
    round: line.round,
    lp: orNull(line.lp),
    lp_lost: null,
    level: orNull(line.level),
    funds_left: list(data.config?.economy?.leftoverFundsKeptByBands).includes(line.band) ? 0 : orNull(line.funds_left),
    deployed: orNull(line.deploy_count),
    deploy_cap: orNull(line.deploy_cap),
    elites: board.filter((piece) => piece.golden || data.chess?.[piece.id]?.isGolden).length,
    items_on_board: board.reduce((sum, piece) => sum + list(piece.items).length, 0),
    items_in_hand: list(line.hand).filter((piece) => piece.kind === 'item').length,
    lineup: board.map((piece) => chessName(piece.id)),
    active_bonds: bonds.filter((b) => b.active).sort((a, b) => (b.layers ?? 0) - (a.layers ?? 0))
      .map((b) => ({ bond: bondName(b.id), count: b.count, tier: b.tier, layers: b.layers })),
    idle_bonds: bonds.filter((b) => !b.active && b.layers > 0)
      .map((b) => ({ bond: bondName(b.id), count: b.count, needs: orNull(list(data.bonds?.[b.id]?.thresholds)[0]), layers: b.layers })),
    killed: orNull(battle?.killed),
    total: orNull(battle?.total),
    leaks: orNull(report.leaks),
    leaked,
    top_damage: list(report.units).slice(0, TOP_UNITS).map((unit) => ({ name: orNull(unit.name), dmg: orNull(unit.dmg) })),
    casualties: list(report.casualties).length,
  };
}

function seatView(player, data) {
  const stats = player.stats ?? {};
  return {
    seat: orNull(player.seat),
    me: !!player.me,
    bot: orNull(player.bot),
    band: data.bands?.[player.band]?.name ?? orNull(player.band),
    lp: orNull(player.lp),
    alive: orNull(player.alive),
    eliminated_round: orNull(player.eliminated_round),
    boss_damage: stats.bossDamage ?? 0,
    damage: stats.dmgDealt ?? 0,
    top_bonds: list(player.bonds).slice().sort((a, b) => (b.layers ?? 0) - (a.layers ?? 0)).slice(0, 3)
      .map((b) => ({ bond: data.bonds?.[b.id]?.name ?? b.id, layers: b.layers })),
    lineup: list(player.lineup).map((unit) => data.chess?.[unit.id]?.name ?? unit.id),
  };
}

function findingsOf(rounds) {
  const findings = [];
  const span = (test, text) => {
    const hits = rounds.filter(test).map((r) => r.round);
    if (hits.length) findings.push(`${roundSpans(hits)}${text}`);
  };
  const ref = (r) => AI_CURVE[r.round];
  span((r) => r.level != null && ref(r) && r.level + 0.25 < ref(r).level, '调度中心等级低于参考曲线');
  span((r) => r.round >= FULL_BOARD_FROM && r.deployed != null && r.deploy_cap != null && r.deployed < r.deploy_cap, '场上没有站满');
  span((r) => ref(r) && r.elites + 1 < ref(r).elites, '精锐数比参考曲线少 1 个以上');
  span((r) => r.idle_bonds.some((b) => b.layers >= IDLE_LAYERS), `有未激活的盟约堆着 ${IDLE_LAYERS} 层以上`);
  span((r) => (r.funds_left ?? 0) >= WASTED_FUNDS, `休整期结束时剩下 ${WASTED_FUNDS} 资金以上`);
  span((r) => r.items_in_hand >= 1, '整备区留着没穿的装备');
  const wasted = rounds.reduce((sum, r) => sum + (r.funds_left ?? 0), 0);
  if (wasted > 0) findings.push(`全局在休整期结束时丢掉 ${wasted} 资金`);
  for (const r of rounds) {
    if ((r.lp_lost ?? 0) < HEAVY_LOSS) continue;
    const who = Object.entries(r.leaked).map(([name, n]) => `${name}×${n}`).join('、');
    findings.push(`第 ${r.round} 回合掉了 ${r.lp_lost} 点生命值${who ? `，漏掉 ${who}` : ''}`);
  }
  return findings;
}

/**
 * @param {{ id: string, lines: object[] }|null|undefined} log  `client.matchLog`
 * @param {Record<string, object>} [data]  gamedata.js `loadGameData()`; missing files leave ids in place of names
 */
export function reviewMatch(log, data = {}) {
  const lines = list(log?.lines);
  if (!lines.length) return { available: false, reason: '本会话还没有对局记录：第一场作战开始后才有数据' };
  const match = lines.find((line) => line.type === 'match') ?? {};
  const result = lines.find((line) => line.type === 'result') ?? null;
  const me = list(result?.players).find((player) => player.me) ?? null;

  // A 联防 round has a second battle line; the seat's own fight is the one the lineup went into.
  const battles = new Map();
  for (const line of lines) if (line.type === 'battle' && line.kind !== 'unite' && !battles.has(line.round)) battles.set(line.round, line);
  const rounds = lines.filter((line) => line.type === 'round').map((line) => roundView(line, battles.get(line.round), data));
  rounds.forEach((round, i) => {
    const after = rounds[i + 1]?.lp ?? me?.lp;
    if (round.lp != null && after != null) round.lp_lost = Math.max(0, round.lp - after);
  });

  const seats = list(result?.players).map((player) => seatView(player, data)).sort((a, b) => Number(b.me) - Number(a.me));
  const teamBoss = seats.reduce((sum, seat) => sum + seat.boss_damage, 0);
  const myBoss = seats.find((seat) => seat.me)?.boss_damage ?? null;
  const worst = rounds.filter((r) => r.lp_lost > 0).sort((a, b) => b.lp_lost - a.lp_lost).slice(0, TURNING_POINTS);

  return {
    available: true,
    match: {
      id: log.id,
      mode: orNull(match.mode),
      difficulty: orNull(match.difficulty),
      stage: orNull(match.stage),
      boss: data.bosses?.[match.boss]?.name ?? orNull(match.boss),
      factions: list(match.factions),
      disabled_bonds: list(match.disabled_bonds).filter((id) => !list(match.drawn_disabled_bonds).includes(id)).map((id) => data.bonds?.[id]?.name ?? id),
      partial_pool_bonds: list(match.drawn_disabled_bonds).map((id) => data.bonds?.[id]?.name ?? id),
    },
    outcome: {
      finished: !!result,
      victory: orNull(result?.victory),
      rounds_passed: orNull(result?.rounds_passed),
      reason: orNull(result?.reason),
      lp: orNull(me?.lp),
      boss_damage: myBoss,
      boss_damage_share: teamBoss > 0 && myBoss != null ? Number((myBoss / teamBoss).toFixed(3)) : null,
    },
    findings: findingsOf(rounds),
    turning_points: worst.map(({ round, lp_lost, leaked, lineup, top_damage }) => ({ round, lp_lost, leaked, lineup, top_damage })),
    rounds,
    seats,
    benchmark: {
      source: '内置 AI 实测的平均值：同盟 ABYSS，3 座，4 个种子，后期回合只含存活者',
      rounds: Object.fromEntries(rounds.filter((r) => AI_CURVE[r.round]).map((r) => [r.round, AI_CURVE[r.round]])),
    },
  };
}
