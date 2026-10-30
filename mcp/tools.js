/**
 * The MCP tools one player session exposes.
 *
 * STRONGHOLD_MCP_TOOLS
 *   full     the generic tools plus one convenience tool per protocol action
 *            (stronghold_g_buy, stronghold_room_create, …)
 *   compact  (default) the generic tools only. stronghold_action sends every one of those actions, and
 *            stronghold_protocol lists them; this keeps a client's tool list (and its context) small.
 */
import { z } from 'zod';

import { gameDataSource, lookup } from './gamedata.js';
import { createGuide } from './guide.js';
import { createObservationLog } from './observe-log.js';
import { observation } from './observation.js';
import { ACTIONS, ACTION_TYPES, actionCatalog, toolNameFor } from './protocol.js';

const ACTION_TYPE = z.enum(ACTION_TYPES);
const FIELD_SCHEMA = z.record(z.string(), z.unknown()).optional();

/** @returns {'full'|'compact'} */
export function toolMode(env = process.env) {
  return String(env.STRONGHOLD_MCP_TOOLS ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

function jsonText(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: jsonText(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

async function runSafe(fn) {
  try { return result(await fn()); }
  catch (error) { return result({ ok: false, error: error instanceof Error ? error.message : String(error) }, true); }
}

/**
 * @param {{ registerTool: Function }} server
 * @param {import('./game-client.js').StrongholdClient} client
 * @param {{ env?: Record<string,string|undefined>, gameData?: () => Promise<Record<string, object>> }} [options]
 */
export function registerTools(server, client, { env = process.env, gameData = gameDataSource(client, { env }) } = {}) {
  server.registerTool('stronghold_connect', {
    title: 'Connect to Stronghold',
    description: 'Open or resume a real Stronghold player WebSocket session. The adapter handles the private-site login cookie and the game reconnect token.',
    inputSchema: z.object({ name: z.string().min(1).max(12).optional() }),
  }, async ({ name }) => runSafe(() => client.connect(name || undefined)));

  const observeLog = createObservationLog();
  server.registerTool('stronghold_observe', {
    title: 'Observe the match',
    description: 'Read the match. Check connected and has_frames first. detail="compact" (default) puts static stats once per kind:id in catalog and leaves out default values (an absent flag is false); "full" joins stats onto every instance. Pass the rev of your last observe as since to receive only what changed: sections listed in unchanged are as in that response, removed keys are gone, catalog holds only new entries. resync:true means since was unknown and this is the whole observation. includeField/includeReport=false omit those sections.',
    inputSchema: z.object({
      detail: z.enum(['full', 'compact']).optional(),
      since: z.number().int().min(1).optional(),
      includeField: z.boolean().optional(),
      includeReport: z.boolean().optional(),
    }),
  }, async ({ detail = 'compact', since, includeField, includeReport } = {}) => runSafe(async () => {
    const state = client.snapshot(false);
    let data = {};
    let dataError = null;
    try { data = await gameData(); } catch (error) { dataError = error instanceof Error ? error.message : String(error); }
    const obs = observation(state, data, { env, detail, includeField, includeReport });
    // Without the data files the frames still render; only the joined names and stats are blank.
    if (dataError) obs.data_error = dataError;
    return observeLog(obs, { signature: JSON.stringify([detail, includeField !== false, includeReport !== false]), since: since ?? null });
  }));

  server.registerTool('stronghold_lookup', {
    title: 'Look up a game record',
    description: 'The full game-data record behind one id: a chess piece (chess_…), an item (item_…), a strategy band (band_…), an enemy key, a token, or a bond (kind: "bond" — thresholds, description and members).',
    inputSchema: z.object({ id: z.string().min(1), kind: z.enum(['chess', 'item', 'enemy', 'token', 'band', 'bond']).optional() }),
  }, async ({ id, kind }) => runSafe(async () => lookup(await gameData(), id, kind ?? null)));

  const guide = createGuide();
  server.registerTool('stronghold_guide', {
    title: 'Read the game tutorial',
    description: 'Read the game tutorial and this match\'s reference pages on demand. ids returns those sections: tutorial chapters (tutorial.flow, tutorial.board, tutorial.shop, tutorial.pieces, tutorial.bonds, tutorial.battle, tutorial.lp, tutorial.draft) with this server\'s numbers, bonds.overview, bond.<bondId> (thresholds, description, params, the operators whose traits stack it, the operators whose stats grow with it), bonds.generic and band.<bandId>. Without ids it returns a table of contents (id and title, read:true once fetched): topic "auto" (default) lists the pages for the current phase, "tutorial", "bonds" and "bands" list a whole area.',
    inputSchema: z.object({
      topic: z.enum(['auto', 'tutorial', 'bands', 'bonds']).optional(),
      ids: z.array(z.string()).optional(),
    }),
  }, async ({ topic, ids } = {}) => runSafe(async () => guide(client.snapshot(false), await gameData(), { topic, ids: ids ?? [] })));

  server.registerTool('stronghold_state', {
    title: 'Read Stronghold state',
    description: 'Read the raw server frames received by this real player session, including room.state, m.public, m.private, m.field, battle frames, and queued events. stronghold_observe renders the same frames for deciding a turn.',
    inputSchema: z.object({ includeRecent: z.boolean().optional() }),
  }, async ({ includeRecent }) => result(client.snapshot(includeRecent !== false)));

  server.registerTool('stronghold_wait_event', {
    title: 'Wait for Stronghold event',
    description: 'Wait for the next live server event. Use this after an action to observe room/match/battle updates.',
    inputSchema: z.object({ types: z.array(z.string()).optional(), timeoutMs: z.number().int().min(100).max(120000).optional() }),
  }, async ({ types, timeoutMs }) => runSafe(() => client.waitForEvent(types || null, timeoutMs || 15_000)));

  server.registerTool('stronghold_protocol', {
    title: 'Read Stronghold actions',
    description: 'Read game action fields. Filter by type (e.g. g.move) or prefix (e.g. room.) to avoid loading the entire catalog.',
    inputSchema: z.object({ type: ACTION_TYPE.optional(), prefix: z.string().optional() }),
  }, async ({ type, prefix } = {}) => result({ actions: actionCatalog().filter((action) => (!type || action.type === type) && (!prefix || action.type.startsWith(prefix))) }));

  server.registerTool('stronghold_action', {
    title: 'Send Stronghold action',
    description: 'Send any normal Stronghold client action. The game server validates the message exactly as it validates a browser player. Use stronghold_protocol for the complete action and field list.',
    inputSchema: z.object({
      type: ACTION_TYPE,
      fields: FIELD_SCHEMA,
      waitForReply: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).max(120000).optional(),
    }),
  }, async ({ type, fields, waitForReply, timeoutMs }) => runSafe(() => client.action(type, fields || {}, { waitForReply, timeoutMs })));

  if (toolMode(env) === 'full') {
    // One convenience tool per protocol action, so an agent can call stronghold_g_buy directly.
    for (const [type, description] of ACTIONS) {
      server.registerTool(toolNameFor(type), {
        title: type,
        description: `${description} This sends the real browser protocol action ${type}.`,
        inputSchema: z.object({ fields: FIELD_SCHEMA }),
      }, async ({ fields }) => runSafe(() => client.action(type, fields || {}, { waitForReply: !type.startsWith('b.') })));
    }
  }

  server.registerTool('stronghold_disconnect', {
    title: 'Disconnect Stronghold player',
    description: 'Close this MCP session’s Stronghold player connection.',
    inputSchema: z.object({}),
  }, async () => runSafe(async () => { await client.close(); return { disconnected: true }; }));
}
