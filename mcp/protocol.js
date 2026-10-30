/**
 * The game's client → server action surface, exactly as a browser sends it.
 *
 * Keeping this table in one place means the MCP tool list, the documented protocol and the Python
 * SDK's shorthand all stay in sync, and a new action only has to be added here.
 *
 * Each entry is `[type, description]`. The description is what an agent reads when it calls
 * `stronghold_protocol`, so it states the fields the game actually expects.
 */
export const ACTIONS = [
  ['ping', 'Heartbeat; fields: { c: number }.'],
  ['room.create', 'Create a room; fields: { mode: "solo"|"coop", difficulty: "FUNNY"|"NORMAL"|"HARD"|"ABYSS", test?: true, train?: true }. train: true asks for the AI-training pacing of THIS match only (the fixed presentation delays are skipped); the server must have a training knob set, else TRAIN_DISABLED.'],
  ['room.join', 'Join a room; fields: { code: string, testAck?: true }.'],
  ['room.leave', 'Leave the current room; fields: {}.'],
  ['room.ready', 'Toggle lobby ready; fields: { ready: boolean }.'],
  ['room.setDifficulty', 'Host changes difficulty; fields: { difficulty: "FUNNY"|"NORMAL"|"HARD"|"ABYSS" }.'],
  ['room.setAiPicksLast', 'Host changes AI pick order; fields: { on: boolean }.'],
  ['room.addBot', 'Add an AI seat; fields: {}.'],
  ['room.removeBot', 'Remove an AI seat; fields: { seat: number }.'],
  ['room.kick', 'Host removes a human; fields: { seat: number, playerId: string }.'],
  ['room.start', 'Host starts the room; fields: {}.'],
  ['room.rerollSetup', 'Vote to reroll setup; fields: { setupRevision: number }.'],
  ['room.cancelReroll', 'Cancel a reroll vote; fields: { voteId: number }.'],
  ['room.loadout', 'Set operator loadout; fields: { entries: object, ops?: object }.'],
  ['room.skins', 'Set operator skins; fields: { skins: object }.'],
  ['room.ownership', 'Set owned operators; fields: { notOwned: string[] }.'],
  ['room.diy', 'Set DIY picks; fields: { picks: object }.'],
  ['room.spectate', 'Join a spectator seat; fields: { code: string, testAck?: true }.'],
  ['room.removeSpectator', 'Host removes a spectator; fields: { playerId: string }.'],
  ['room.setPlugins', 'Host sets room plugins; fields: { plugins: object[] }.'],
  ['room.setMode', 'Host changes mode; fields: { modeId: string }.'],
  ['room.consent', 'Accept or reject room content; fields: { cs: string, accept: boolean }.'],
  ['room.contentReady', 'Report content readiness; fields: { cs: string, ok?: boolean }.'],
  ['g.infoReady', 'Confirm match information; fields: { setupRevision?: number }.'],
  ['g.rerollVote', 'Vote on setup reroll; fields: { voteId: number, agree: boolean }.'],
  ['g.band', 'Pick a strategy band; fields: { bandId: string }.'],
  ['g.bandSkip', 'Skip strategy selection; fields: {}.'],
  ['g.bandFocus', 'Focus a highlighted strategy; fields: { bandId?: string|null }.'],
  ['g.buy', 'Buy a shop slot; fields: { slot: number }.'],
  ['g.refresh', 'Refresh the shop; fields: {}.'],
  ['g.freeze', 'Freeze or unfreeze the shop; fields: {}.'],
  ['g.levelUp', 'Buy an experience level; fields: {}.'],
  ['g.sell', 'Sell a piece; fields: { uid: number }.'],
  ['g.move', 'Move or rotate a piece; fields: { uid: number, to: { area: "board"|"hand", row?: number, col?: number, idx?: number }, dir?: "UP"|"RIGHT"|"DOWN"|"LEFT" }.'],
  ['g.equip', 'Equip an item; fields: { itemUid: number, targetUid: number, replaceUid?: number|null }.'],
  ['g.art', 'Deploy an item/art; fields: { itemUid: number, row: number, col: number, dir?: "UP"|"RIGHT"|"DOWN"|"LEFT" }.'],
  ['g.destroy', 'Destroy a piece; fields: { uid: number }.'],
  ['g.unequip', 'Unequip an item; fields: { itemUid: number }.'],
  ['g.reward', 'Choose a reward; fields: { idx: number }.'],
  ['g.choice', 'Choose a card: with choiceId, a personal choice (personal_choice.id); without it, a 机变 draft card (sp_draft.cards[].idx); fields: { idx: number, choiceId?: string }.'],
  ['g.offer', 'Choose a plugin offer; fields: { offerId: string, pluginId: string, seq: number, cardId?: string, idx: number }.'],
  ['g.offerRefresh', 'Refresh a plugin offer slot; fields: { offerId: string, pluginId: string, seq: number, cardId?: string, idx: number }.'],
  ['g.ready', 'Ready for the next phase; fields: { ready: boolean }.'],
  ['g.emote', 'Send an emote; fields: { id: string }.'],
  ['g.watch', 'Watch a field/player; fields: { fieldId: string, playerId?: string }.'],
  ['g.autoplay', 'Toggle the normal in-game autoplay control; fields: { on: boolean }.'],
  ['g.pause', 'Pause or resume a solo battle; fields: { on: boolean }.'],
  ['g.unitStats', 'Answer a unit-stats request; fields: { seq?: number }.'],
  ['g.leave', 'Leave the current match; fields: {}.'],
  ['g.test', 'Server test-room command; fields: { cmd: string, args?: object }.'],
  ['b.progress', 'Report a client-side battle progress frame; fields: protocol-defined progress object.'],
  ['b.result', 'Report a client-side battle result; fields: protocol-defined result object.'],
  ['b.rehearsalResult', 'Answer a delegated battle rehearsal; fields: { taskId: string, choice?: number, error?: true }.'],
];

export const ACTION_TYPES = ACTIONS.map(([type]) => type);

/** `g.buy` → `stronghold_g_buy`, the MCP tool name for one action. */
export function toolNameFor(actionType) {
  return `stronghold_${String(actionType).replaceAll('.', '_')}`;
}

export function actionCatalog() {
  return ACTIONS.map(([type, description]) => ({ type, description }));
}
