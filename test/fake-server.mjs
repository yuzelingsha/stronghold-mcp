/**
 * A minimal stand-in for a Stronghold server, good enough to exercise the client.
 *
 * It speaks the same shapes the real server does: `hello` → `welcome`, then the room and match state,
 * `ok` / `error` replies keyed by `rid`, and push frames on demand. It exists so the client's
 * behaviour — resync on hello, reply matching, event queueing — can be tested without a live game.
 */
import { WebSocketServer } from 'ws';

export async function startFakeServer(options = {}) {
  const state = {
    /** Every `hello` the server saw, in order. */
    hellos: [],
    /** Every action frame the server saw. */
    actions: [],
    /** Bumped so a test can tell two sessions apart. */
    round: options.round ?? 3,
    /** When set, the next action with this `t` is answered with an error frame. */
    failNext: options.failNext ?? null,
    /** Sent right after `welcome`, in addition to the state frames. */
    extraFrames: options.extraFrames ?? [],
  };

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  const sockets = new Set();

  function sendTo(ws, frame) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  function stateFrames() {
    return [
      { t: 'room.state', code: 'TEST', mode: 'solo', difficulty: 'ABYSS', inMatch: true, seats: [], spectators: [] },
      {
        t: 'm.public',
        phase: 'PREP',
        round: state.round,
        deadline: Date.now() + 30_000,
        serverNow: Date.now(),
        stageId: 'test_stage',
        players: [{ playerId: 'p1', seat: 0, name: 'Test', isBot: false, alive: true, lp: 10, shopLevel: 3, boardCount: 0, ready: false }],
      },
      {
        t: 'm.private',
        playerId: 'p1',
        seat: 0,
        alive: true,
        lp: 10,
        funds: 7,
        ready: false,
        canReady: true,
        deployCap: 3,
        deployCount: 0,
        shop: { level: 3, maxLevel: 10, upgradePrice: 12, refreshPrice: 1, freeRefreshes: 0, frozen: false, slots: [null, null, null], rewardOffer: null },
        hand: [],
        temp: [],
        board: [],
        bonds: [],
        effects: [],
        nextEnemies: [],
      },
    ];
  }

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === 'hello') {
        state.hellos.push({ name: msg.name, token: msg.token ?? null });
        sendTo(ws, { t: 'welcome', playerId: 'p1', token: `token-${state.hellos.length}`, name: msg.name, rid: msg.rid });
        for (const frame of stateFrames()) sendTo(ws, frame);
        for (const frame of state.extraFrames) sendTo(ws, frame);
        return;
      }
      state.actions.push(msg);
      if (msg.rid == null) return;
      if (state.failNext === msg.t) {
        state.failNext = null;
        sendTo(ws, { t: 'error', rid: msg.rid, code: 'NOPE', msg: 'refused by the fake server' });
        return;
      }
      sendTo(ws, { t: 'ok', rid: msg.rid, t0: msg.t });
    });
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    httpUrl: `http://127.0.0.1:${port}`,
    state,
    /** Push a frame to every connected socket. */
    push(frame) {
      for (const ws of sockets) sendTo(ws, frame);
    },
    /** Advance the fake match's round and re-broadcast the state frames. */
    setRound(round) {
      state.round = round;
      for (const frame of stateFrames()) this.push(frame);
    },
    async close() {
      for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
