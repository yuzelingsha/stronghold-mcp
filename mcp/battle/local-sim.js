/**
 * Run the match's battles locally, with the game's own deterministic simulation.
 *
 * Why an agent needs this: the protocol hands the client a battle *spec* (`b.start`) and expects the
 * client to simulate it and report progress (`b.progress`) and the result (`b.result`). A browser does
 * that in real time. An agent that plays thousands of matches does not need the wall-clock part.
 *
 * Two pacings, chosen PER BATTLE from the room's own state:
 *
 *   realtime  the browser's pacing — a 250 ms timer advancing `b.start.speed × 0.25 s` of battle per
 *             tick. A normal room always gets this, so nothing about a normal match is accelerated.
 *
 *   burst     the SAME simulation stepped to its end at once, so the round ends as soon as the result
 *             is known. It executes an identical tick count and returns an identical result — only the
 *             real time between ticks is gone.
 *
 * A burst is used ONLY inside a training room (`room.create { train: true }`, which surfaces as
 * `room.state.train === true`). A normal room therefore runs exactly as a browser does.
 *
 * STRONGHOLD_BATTLE_MODE
 *   'auto'      (default) burst inside a training room, realtime everywhere else
 *   'fast'      always burst — only for a machine that plays nothing but training rooms
 *   'realtime'  always the browser pacing
 *
 * The simulation itself arrives asynchronously (it is fetched from the game server on first use), so
 * the runner is attached immediately and the first `b.start` waits for it. Nothing else blocks.
 */

import { attachCombatReport } from './report.js';

/** Hard guard against a battle that never reports finished (2M steps ≈ 18.5 h of game time). */
const MAX_STEPS = 2_000_000;

/** @param {Record<string,string|undefined>} [env] @returns {'auto'|'fast'|'realtime'} */
export function battlePacing(env = process.env) {
  const v = String(env.STRONGHOLD_BATTLE_MODE ?? '').trim().toLowerCase();
  if (v === 'fast' || v === 'realtime') return v;
  return 'auto';
}

/**
 * Whether this runner may be the authority for a battle, judged by the content it names.
 *
 * The runner only ever has the server's original content (its plugin bundle, or an installation on
 * disk). A room with gameplay plugins runs on a content set: `b.start.spec.cs` names it, and the server
 * checks only that a result names the same set — so a result simulated on the original data but
 * labelled with the room's set would pass as plausible and be wrong. The browser declines such a battle
 * (public/js/battle/runner.js csAccepted) and lets the server's deadline hand the field to the server;
 * so does this runner. A spec with no `cs`, or the original content's own (`welcome.content.vanilla`),
 * is fine; so is nothing at all while the original content is unknown.
 */
export function contentAccepted(cs, welcome) {
  if (typeof cs !== 'string' || cs === '') return true;
  const vanilla = welcome?.content?.vanilla;
  return typeof vanilla === 'string' && vanilla !== '' && cs === vanilla;
}

/** Whether the session is in a training room: `room.state` carries `train: true` only for one. */
export function isTrainingRoom(client) {
  const room = client?.last?.['room.state'];
  return !!(room && room.train === true);
}

/**
 * Attach a local battle runner to a client.
 *
 * @param {import('../game-client.js').StrongholdClient} client
 * @param {() => Promise<{ spec: object, constants: { TICK: number } }>} getSim
 *   Resolves the simulation lazily. Remote loaders can revalidate between battles.
 * @param {{ mode?: 'auto'|'fast'|'realtime', env?: Record<string,string|undefined>, refreshBetweenBattles?: boolean }} [options]
 * @returns {{ mode: string, ready: boolean, fast: boolean, current: object|null, lastResult: object|null, error: string|null }}
 */
export function attachLocalBattleClient(client, getSim, options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || battlePacing(env);
  const battles = new Map();
  /** Battles the server ended while we were still waiting for the simulation. */
  const endedEarly = new Set();
  const status = client.battleSimulation = {
    enabled: true, mode, ready: false, fast: false, current: null, lastResult: null, report: null, error: null,
    pending: 0, source: null, fingerprint: null, declined: null,
  };

  let simPromise = null;

  /** Keep successful loads, with optional revalidation when no battle is using the runner. */
  function sim(refresh = false) {
    if (refresh && status.pending === 0 && battles.size === 0) simPromise = null;
    if (!simPromise) {
      status.pending += 1;
      status.ready = false;
      simPromise = Promise.resolve()
        .then(() => getSim())
        .then((loaded) => {
          status.ready = true;
          // `source` for a local installation, `via` for a fetched tree ('plugin' or 'crawl').
          status.source = loaded.source ?? loaded.via ?? null;
          status.fingerprint = loaded.fingerprint ?? null;
          status.error = null;
          return loaded;
        })
        .catch((error) => {
          simPromise = null;
          status.ready = false;
          status.error = `simulation unavailable: ${error?.message ?? error}`;
          client.lastError = status.error;
          throw error;
        })
        .finally(() => { status.pending -= 1; });
    }
    return simPromise;
  }

  /** The pacing of the battle now being run: burst only for a training room (or a forced 'fast'). */
  const burst = () => mode === 'fast' || (mode === 'auto' && isTrainingRoom(client));

  function stop(entry) {
    clearTimeout(entry.timer);
    entry.meter?.detach();
    entry.reportCollector?.detach();
    battles.delete(entry.id);
  }

  function fail(error, entry) {
    status.error = error?.message ?? String(error);
    client.lastError = `Battle simulation: ${status.error}`;
    console.error('[stronghold-mcp] battle simulation failed:', error);
    if (entry) stop(entry);
  }

  /** The progress object both pacings send (the protocol's b.progress). */
  function progressOf(spec, entry) {
    const p = spec.battleProgress(entry.battle);
    const boss = entry.spec.kind === 'boss' || entry.spec.kind === 'hidden';
    const progress = {
      battleId: entry.id,
      gt: p.gt,
      killed: Math.min(p.killed, p.total),
      total: p.total,
      done: p.done,
      leaks: boss ? entry.meter.lp : p.leaks,
    };
    if (Number.isFinite(p.resolved)) progress.resolved = Math.min(p.resolved, p.total);
    if (p.left) progress.left = p.left;
    if (boss) {
      progress.bossDmg = entry.battle.sharedBoss?.cum || 0;
      if (entry.battle.sharedBoss?.byPlayer) progress.by = { ...entry.battle.sharedBoss.byPlayer };
      if (p.leaksBy) progress.leaksBy = p.leaksBy;
    }
    return progress;
  }

  /**
   * Send b.result and finish the entry. It never names a content set: the runner only simulates the
   * original content (see contentAccepted), whose result names none, exactly as a browser's.
   */
  function finish(spec, entry, extra = {}) {
    const rawResult = entry.battle.result();
    const report = entry.reportCollector?.finish(rawResult) ?? null;
    // The simulation's raw result does not carry the round; the battle spec does.
    if (report && report.round == null) report.round = entry.spec.round ?? null;
    const result = spec.compactResult(rawResult);
    client._send({ t: 'b.result', battleId: entry.id, result });
    entry.sent = true;
    status.lastResult = {
      battleId: entry.id, round: entry.spec.round, kind: entry.spec.kind,
      reason: result.reason, time: result.time, killed: result.killed, total: result.total,
      report, ...extra,
    };
    status.report = report;
    entry.meter?.detach();
  }

  /** The browser's pacing: one 250 ms slice at a time. */
  function tick(spec, entry) {
    try {
      if (!client.connected || !entry.authoritative || entry.sent) return;
      // The battle speed the SERVER declared (b.start.speed = Match.gameSpeed, 2× on a normal
      // deployment). m.public carries no gameSpeed, so the field's own speed is the truthful source.
      const speed = Number(entry.speed) || Number(client.last['m.public']?.gameSpeed) || 2;
      const ticks = Math.max(1, Math.round(speed * 0.25 / entry.loaded.constants.TICK));
      for (let i = 0; i < ticks && !entry.battle.finished; i++) entry.battle.step();
      const progress = progressOf(spec, entry);
      client._send({ t: 'b.progress', ...progress });
      status.current = { round: entry.spec.round, kind: entry.spec.kind, ...progress };
      if (entry.battle.finished) finish(spec, entry);
      else entry.timer = setTimeout(() => tick(spec, entry), 250);
    } catch (error) {
      fail(error, entry);
    }
  }

  /** The training pacing: step to the end now, report once. */
  function run(spec, entry) {
    try {
      if (!client.connected || !entry.authoritative || entry.sent) return;
      const t0 = Date.now();
      let steps = 0;
      while (!entry.battle.finished && steps < MAX_STEPS) { entry.battle.step(); steps++; }
      const simMs = Date.now() - t0;
      const progress = progressOf(spec, entry);
      client._send({ t: 'b.progress', ...progress });
      status.current = { round: entry.spec.round, kind: entry.spec.kind, ...progress, steps, simMs };
      if (!entry.battle.finished) {
        status.error = `battle did not finish within ${MAX_STEPS} steps`;
        return;
      }
      finish(spec, entry, { steps, simMs });
    } catch (error) {
      fail(error, entry);
    }
  }

  /** Step once with the pacing this battle is entitled to. */
  function step(spec, entry) {
    status.fast = burst();
    if (status.fast) run(spec, entry);
    else tick(spec, entry);
  }

  async function onStart(msg) {
    if (!msg.authoritative) return;
    if (battles.has(msg.battleId)) return;
    if (!contentAccepted(msg.spec?.cs, client.welcome)) {
      status.declined = {
        battleId: msg.battleId, round: msg.spec?.round ?? null, cs: String(msg.spec.cs).slice(0, 12),
        reason: 'the battle runs on a content set this runner does not have; the server simulates it',
      };
      return;
    }
    let loaded;
    try {
      loaded = await sim(options.refreshBetweenBattles === true);
    } catch (error) {
      fail(error, null);
      return;
    }
    // The simulation took a moment to arrive; the server may have ended this battle meanwhile.
    if (endedEarly.has(msg.battleId)) { endedEarly.delete(msg.battleId); return; }
    if (battles.has(msg.battleId)) return;
    let entry = null;
    try {
      const battle = loaded.spec.createBattleFromSpec(msg.spec, null, { recordEvents: false, quiet: true });
      const reportCollector = attachCombatReport(battle, { playerId: client.playerId || msg.playerId });
      entry = {
        id: msg.battleId, fieldId: msg.fieldId, spec: msg.spec, battle, loaded,
        meter: loaded.spec.attachLpMeter(battle), reportCollector, authoritative: true, sent: false, timer: null,
        speed: Number(msg.speed) || 0,
      };
      battles.set(entry.id, entry);
      // Catch up to whatever the server already simulated before handing us the battle.
      let steps = 0;
      while (!battle.finished && battle.time < (Number(msg.elapsed) || 0) && steps < MAX_STEPS) { battle.step(); steps++; }
      status.error = null;
      status.fast = burst();
      status.current = { battleId: entry.id, round: msg.spec.round, kind: msg.spec.kind, gt: battle.time };
      if (status.fast) run(loaded.spec, entry);
      else entry.timer = setTimeout(() => tick(loaded.spec, entry), 0);
    } catch (error) {
      fail(error, entry);
    }
  }

  client.on('b.start', (msg) => { void onStart(msg); });

  client.on('b.pool', (msg) => {
    for (const entry of battles.values()) entry.battle.sharedBoss?.sync(msg.hp, msg.acked?.[entry.fieldId]);
  });

  client.on('b.end', (msg) => {
    const entry = battles.get(msg.battleId);
    if (!entry) { endedEarly.add(msg.battleId); return; }
    if (msg.reason === 'takeover' || entry.sent) {
      stop(entry);
    } else {
      entry.battle.forceEnd(msg.reason === 'timeout' ? 'timeout' : 'forced');
      clearTimeout(entry.timer);
      Promise.resolve(entry.loaded).then((loaded) => step(loaded.spec, entry)).catch(() => {}).finally(() => stop(entry));
    }
  });

  client.on('socket.close', () => {
    for (const entry of battles.values()) stop(entry);
  });

  // `status` is what goes into a snapshot, so it must stay plain JSON — the awaitable handle is
  // returned beside it instead of hanging off it.
  return { status, whenReady: () => sim() };
}
