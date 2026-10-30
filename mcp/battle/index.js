/**
 * Battle adapter entry point.
 *
 * `attachBattle(client)` is the only thing `mcp/index.js` calls. It decides where the game's
 * deterministic simulation comes from and attaches the runner. It returns immediately: the simulation
 * is fetched in the background and the first `b.start` waits for it, so an MCP server starts serving
 * tool calls without waiting for a download.
 *
 * Two sources, in order:
 *
 *   1. `STRONGHOLD_SIM_ROOT` / `STRONGHOLD_SIM_SPEC` — a game installation on this machine. Fastest,
 *      and the right choice when the agent runs next to the server.
 *   2. The running server itself — the `stronghold-agent` plugin's endpoint when it is installed, else
 *      a crawl of `/sim/` + `/shared/` + `/data/`. Nothing needs to be installed on the agent's side
 *      beyond this package.
 */
import { attachLocalBattleClient, battlePacing } from './local-sim.js';
import { describeSearch, loadSimulation, resolveSpecPath } from './resolve-sim.js';

export { attachLocalBattleClient, battlePacing, contentAccepted, isTrainingRoom } from './local-sim.js';
export { loadSimulation, resolveSpecPath, describeSearch } from './resolve-sim.js';

/**
 * @param {import('../game-client.js').StrongholdClient} client
 * @param {{ env?: Record<string,string|undefined>, startDir?: string, mode?: string, source?: string,
 *           cacheRoot?: string, force?: boolean, onProgress?: Function }} [options]
 * @returns {Promise<{ enabled: true, mode: string, source: string, whenReady: Function }>}
 */
export async function attachBattle(client, options = {}) {
  const env = options.env || process.env;
  const startDir = options.startDir || process.cwd();
  const localSpec = resolveSpecPath(env, startDir);

  if (localSpec) {
    // A game installation is right here: use it directly, no fetching at all.
    const sim = await loadSimulation(env, startDir);
    const { status } = attachLocalBattleClient(client, async () => ({ ...sim, source: `local:${sim.specPath}` }), { mode: options.mode, env });
    return { enabled: true, mode: status.mode, source: 'local', whenReady: async () => sim, specPath: sim.specPath };
  }

  // Otherwise fetch it from the server, lazily, on the first battle.
  const getSim = async () => {
    const { prepareSim } = await import('../sim/index.js');
    const origin = client.httpUrl;
    const contentVersion = client.welcome?.content?.vanilla ?? null;
    const cookie = await client.ensureAuthCookie().catch(() => null);
    const prepared = await prepareSim({
      origin,
      cookie,
      source: options.source || 'auto',
      cacheRoot: options.cacheRoot,
      force: options.force,
      onProgress: options.onProgress,
    });
    // Observation can reuse the same immutable records instead of fetching/parsing them again.
    client.simulationData = { origin, contentVersion, fingerprint: prepared.fingerprint, raw: prepared.raw };
    return prepared;
  };

  const { status, whenReady } = attachLocalBattleClient(client, getSim, { mode: options.mode, env, refreshBetweenBattles: true });
  return { enabled: true, mode: status.mode, source: 'remote', whenReady };
}

/** The paths the local resolver considered, for a caller that wants to explain a failure. */
export { describeSearch as describeLocalSearch };
