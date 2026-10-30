/**
 * The Streamable HTTP transport's session table, with an idle limit.
 *
 * Each HTTP session owns a player connection to the game. A client that goes away without sending DELETE (a closed
 * laptop, a killed process) would otherwise keep that seat connected until the server restarts. A session is idle
 * when no request has arrived for `idleMs` and none is still running; `sweep()` closes those.
 *
 *   MCP_HTTP_IDLE_SECONDS   idle limit in seconds (default 1800); 0 keeps sessions until DELETE
 */

export const DEFAULT_IDLE_SECONDS = 1800;

/** @param {Record<string, string|undefined>} env */
export function idleMsFrom(env = process.env) {
  const raw = env.MCP_HTTP_IDLE_SECONDS;
  const seconds = raw === undefined || String(raw).trim() === '' ? DEFAULT_IDLE_SECONDS : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * @template {object} T
 * @param {{ idleMs?: number, now?: () => number, onExpire?: (entry: T, id: string) => void }} [options]
 */
export function createSessionTable({ idleMs = DEFAULT_IDLE_SECONDS * 1000, now = Date.now, onExpire = () => {} } = {}) {
  /** @type {Map<string, { entry: T, seenAt: number, running: number }>} */
  const sessions = new Map();
  return {
    /** @returns {T|undefined} */
    get: (id) => sessions.get(id)?.entry,
    set(id, entry) { sessions.set(id, { entry, seenAt: now(), running: 0 }); },
    delete(id) { sessions.delete(id); },
    values: () => [...sessions.values()].map((s) => s.entry),
    get size() { return sessions.size; },

    /** Run one request of session `id`; the session counts as busy while it runs. */
    async track(id, fn) {
      const slot = sessions.get(id);
      if (slot) { slot.running += 1; slot.seenAt = now(); }
      try { return await fn(); }
      finally { if (slot) { slot.running -= 1; slot.seenAt = now(); } }
    },

    /** Forget and expire every idle session. @returns {string[]} the expired ids */
    sweep() {
      if (!(idleMs > 0)) return [];
      const expired = [];
      for (const [id, slot] of sessions) {
        if (slot.running === 0 && now() - slot.seenAt > idleMs) {
          sessions.delete(id);
          expired.push(id);
          onExpire(slot.entry, id);
        }
      }
      return expired;
    },
  };
}
