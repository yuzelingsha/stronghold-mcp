import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StrongholdClient } from '../mcp/game-client.js';
import { startFakeServer } from './fake-server.mjs';

/** Give the socket a turn so frames the client just sent have been received by the fake server. */
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe('StrongholdClient', () => {
  let server;
  let client;

  before(async () => {
    server = await startFakeServer();
  });

  after(async () => {
    await client?.close();
    await server?.close();
  });

  it('connects, receives welcome and the state frames', async () => {
    client = new StrongholdClient({ wsUrl: server.url, name: 'Tester' });
    const welcome = await client.connect();

    assert.equal(client.connected, true);
    assert.equal(welcome.playerId, 'p1');
    assert.equal(welcome.name, 'Tester');
    assert.equal(welcome.token, undefined, 'the reconnect token must never leave the client');

    const snapshot = client.snapshot();
    assert.equal(snapshot.last['room.state'].code, 'TEST');
    assert.equal(snapshot.last['m.public'].round, 3);
    assert.equal(snapshot.last['m.private'].funds, 7);
    assert.equal(snapshot.connection.framesAgeMs >= 0, true);
    assert.equal(snapshot.welcome.token, undefined);
  });

  it('reads the game server\'s SP_AUTH_* credentials when STRONGHOLD_AUTH_* are unset', () => {
    const keys = ['STRONGHOLD_AUTH_USER', 'STRONGHOLD_AUTH_PASSWORD', 'SP_AUTH_USER', 'SP_AUTH_PASSWORD'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, { SP_AUTH_USER: 'sp-user', SP_AUTH_PASSWORD: 'sp-pass' });
      const fallback = new StrongholdClient({ wsUrl: 'ws://127.0.0.1:1/ws' });
      assert.deepEqual([fallback.authUser, fallback.authPassword], ['sp-user', 'sp-pass']);
      Object.assign(process.env, { STRONGHOLD_AUTH_USER: 'agent-user', STRONGHOLD_AUTH_PASSWORD: 'agent-pass' });
      const own = new StrongholdClient({ wsUrl: 'ws://127.0.0.1:1/ws' });
      assert.deepEqual([own.authUser, own.authPassword], ['agent-user', 'agent-pass']);
    } finally {
      for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('answers actions with the matching ok reply', async () => {
    const reply = await client.action('g.buy', { slot: 0 });
    assert.equal(reply.sent, true);
    assert.equal(reply.reply.t, 'ok');
    assert.equal(server.state.actions.at(-1).slot, 0, 'action fields are flattened onto the frame');
    assert.equal(server.state.actions.at(-1).t, 'g.buy');
  });

  it('rejects when the server answers an error frame', async () => {
    server.state.failNext = 'g.sell';
    await assert.rejects(() => client.action('g.sell', { uid: 1 }), /refused by the fake server/);
  });

  it('does not wait for a reply on the fire-and-forget battle reports', async () => {
    const before = server.state.actions.length;
    const result = await client.action('b.result', { battleId: 'x', result: {} });
    assert.deepEqual(result, { sent: true, type: 'b.result' });
    await settle();
    const sent = server.state.actions.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, 'b.result');
    assert.equal(sent[0].rid, undefined, 'a fire-and-forget report must not carry a request id');
  });

  it('queues push frames and resolves waitForEvent', async () => {
    server.push({ t: 'm.ticker', text: 'hello' });
    const event = await client.waitForEvent(['m.ticker'], 2_000);
    assert.equal(event.text, 'hello');
  });

  it('drops frames from the previous session when a hello resyncs', async () => {
    // A fresh round pushed before the resync must not survive it.
    server.setRound(9);
    await settle(100);
    assert.equal(client.snapshot().last['m.public'].round, 9);

    server.setRound(4);
    await client.rename('Renamed');

    const snapshot = client.snapshot();
    assert.equal(snapshot.connection.name, 'Renamed');
    assert.equal(snapshot.last['m.public'].round, 4, 'the resync must deliver the current round, not the cached one');
    assert.equal(server.state.hellos.length, 2);
    assert.equal(server.state.hellos[1].token, 'token-1', 'the reconnect token is replayed on the second hello');
  });

  it('reconnects right after a disconnect without the old socket tearing the new one down', async () => {
    const seat = new StrongholdClient({ wsUrl: server.url, name: 'Again' });
    await seat.connect();
    await seat.close();
    await seat.connect();
    await settle(100);
    assert.equal(seat.connected, true, 'the old socket finishing its close must not end the new session');
    await seat.close();
  });

  it('reports framesAgeMs as null before any state frame arrives', async () => {
    const fresh = new StrongholdClient({ wsUrl: server.url, name: 'Quiet' });
    // Never connected: nothing has arrived, so there is no age to report.
    assert.equal(fresh.snapshot().connection.framesAgeMs, null);
    assert.equal(fresh.snapshot().connection.connected, false);
  });
});
