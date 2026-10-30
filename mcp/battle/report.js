/**
 * Combat report collector for local battle simulations.
 *
 * Keeps a compact, decision-relevant diagnosis of the completed battle:
 *   - layer_gains:    exact bond layers added in this battle (e.g. { kazimierzShip: 24 })
 *   - damage_types:   aggregate physical, arts, true, and elemental damage dealt by allies
 *   - casualties:     ally operators / summon tokens knocked out, with seconds and reasons
 *   - leaks:          number of leaked enemies and distinct enemy keys
 *   - units:          per-piece combat metrics (damage, taken, healing, alive status)
 *
 * Zero-side-effect:
 *   - read-only hooks on 'damaged' and 'death'
 *   - cleanly detached when the battle finishes or is aborted
 *   - no modification to units or simulation state
 */

export const DAMAGE_TYPES = Object.freeze(['phys', 'arts', 'true', 'elemental']);

/**
 * Attach a combat report collector to an active battle instance.
 *
 * Must be attached before stepping the battle so damage and casualties from the
 * initial ticks (or catch-up) are recorded.
 *
 * @param {object} battle The simulation instance
 * @param {{ playerId?: string }} [options]
 * @returns {{ finish: (rawResult: object) => object, detach: () => void }}
 */
export function attachCombatReport(battle, options = {}) {
  const damageTypes = { phys: 0, arts: 0, true: 0, elemental: 0 };
  const damageMarks = new WeakMap();
  for (const u of battle.allyUnits || []) {
    damageMarks.set(u, Math.max(0, u.stats?.dmg || 0));
  }

  const onDamaged = ({ source, credit, type }) => {
    const src = credit || source;
    if (!src || src.side !== 'ally') return;
    const total = Math.max(0, src.stats?.dmg || 0);
    const delta = Math.max(0, total - (damageMarks.get(src) || 0));
    damageMarks.set(src, total);
    if (!delta) return;
    const t = DAMAGE_TYPES.includes(type) ? type : (type === 'element' ? 'elemental' : 'true');
    damageTypes[t] = (damageTypes[t] || 0) + delta;
  };

  const casualties = [];
  const onDeath = ({ unit, reason }) => {
    if (unit && unit.side === 'ally' && (unit.kind === 'op' || (unit.kind === 'token' && unit.uid != null))) {
      if (casualties.length < 16) {
        casualties.push({
          uid: unit.uid ?? null,
          name: unit.name || unit.defId || 'unknown',
          time: Math.round((battle.time || 0) * 10) / 10,
          reason: reason || 'killed',
        });
      }
    }
  };

  const damagedHook = typeof battle.on === 'function'
    ? battle.on('damaged', onDamaged, { priority: Number.MAX_VALUE })
    : null;
  const deathHook = typeof battle.on === 'function'
    ? battle.on('death', onDeath)
    : null;

  let finished = false;
  function detach() {
    if (finished) return;
    finished = true;
    if (typeof battle.off === 'function') {
      try {
        if (damagedHook) battle.off(damagedHook);
      } catch {
        try { battle.off('damaged', onDamaged); } catch { /* ignore */ }
      }
      try {
        if (deathHook) battle.off(deathHook);
      } catch {
        try { battle.off('death', onDeath); } catch { /* ignore */ }
      }
    }
  }

  function finish(rawResult) {
    detach();
    const pid = options.playerId
      || battle.players?.[0]?.playerId
      || Object.keys(rawResult?.perPlayer || {})[0];
    const pp = rawResult?.perPlayer?.[pid] || {};

    // 1. Layer gains: only non-zero gains
    const layerGains = {};
    for (const [bondId, n] of Object.entries(pp.layerGains || {})) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) layerGains[bondId] = Math.round(num);
    }

    // 2. Leaks
    const leakedList = Array.isArray(pp.leaked) ? pp.leaked : [];
    const leaks = leakedList.length;
    const leakedEnemies = [...new Set(leakedList.map((l) => l?.enemyKey).filter(Boolean))].slice(0, 8);

    // 3. Units summary
    const endMap = new Map();
    for (const u of pp.unitsEnd || []) {
      if (u && u.uid != null) endMap.set(u.uid, u);
    }

    const units = (pp.unitStats || [])
      .filter((u) => u && (u.kind === 'op' || u.uid != null))
      .map((u) => {
        const end = endMap.get(u.uid);
        return {
          uid: u.uid ?? null,
          name: u.name || u.defId || 'unknown',
          dmg: Math.round(u.dmg || 0),
          taken: Math.round(u.taken || 0),
          heal: Math.round(u.heal || 0),
          kills: u.kills || 0,
          alive: end ? !!end.alive : true,
        };
      })
      .sort((a, b) => b.dmg - a.dmg || b.taken - a.taken)
      .slice(0, 10);

    return {
      round: rawResult?.round ?? null,
      result: rawResult?.reason || 'cleared',
      perfect: pp.perfect !== undefined ? !!pp.perfect : (leaks === 0),
      killed: Math.max(0, pp.killed ?? rawResult?.killed ?? 0),
      total: Math.max(0, pp.total ?? rawResult?.total ?? 0),
      time: Math.round((rawResult?.time ?? battle.time ?? 0) * 10) / 10,
      layer_gains: layerGains,
      damage_types: Object.fromEntries(Object.entries(damageTypes).map(([type, amount]) => [type, Math.round(amount)])),
      casualties,
      leaks,
      leaked_enemies: leakedEnemies,
      units,
    };
  }

  return { finish, detach };
}
