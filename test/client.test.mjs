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

  it('forgets the room when this seat leaves it', async () => {
    for (const type of ['room.leave', 'g.leave']) {
      const seat = new StrongholdClient({ wsUrl: server.url, name: 'Leaver' });
      await seat.connect();
      await settle();
      assert.equal(seat.snapshot().last['m.public'].phase, 'PREP');
      let left = 0;
      seat.on('room.left', () => { left++; });

      await seat.action(type);
      const { last, queuedEvents, connection } = seat.snapshot();
      assert.deepEqual(Object.keys(last), ['welcome'], 'a leaver hears nothing more, so old frames would read as current');
      assert.equal(queuedEvents, 0);
      assert.equal(connection.framesAgeMs, null);
      assert.equal(connection.connected, true);
      assert.equal(left, 1);
      await seat.close();
    }
  });

  it('keeps the room when the server refuses to let the seat leave', async () => {
    const seat = new StrongholdClient({ wsUrl: server.url, name: 'Stayer' });
    await seat.connect();
    await settle();
    server.state.failNext = 'room.leave';
    await assert.rejects(() => seat.action('room.leave'), /refused by the fake server/);
    assert.equal(seat.snapshot().last['m.public'].phase, 'PREP');
    await seat.close();
  });

  it('forgets the room when the server closes it, and still reports why', async () => {
    const seat = new StrongholdClient({ wsUrl: server.url, name: 'Kicked' });
    await seat.connect();
    await settle();
    server.push({ t: 'room.closed', reason: 'kicked' });
    const event = await seat.waitForEvent(['room.closed'], 2_000);
    assert.equal(event.reason, 'kicked');
    const { last } = seat.snapshot();
    assert.equal(last['room.closed'].reason, 'kicked');
    assert.equal(last['m.public'], undefined);
    assert.equal(last['room.state'], undefined);
    await seat.close();
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

  describe('staying online', () => {
    const quick = { pingIntervalMs: 10, deadAfterMs: 40, backoff: { base: 5, factor: 2, max: 20, jitter: 0 } };
    const until = async (check, ms = 2_000) => {
      const end = Date.now() + ms;
      while (!check()) {
        assert.ok(Date.now() < end, 'timed out');
        await settle(5);
      }
    };

    it('finds a silent socket with the heartbeat and resumes the seat with its token', async () => {
      const seat = new StrongholdClient({ wsUrl: server.url, name: 'Quiet', ...quick });
      await seat.connect();
      const hellos = server.state.hellos.length;
      const token = seat.sessionToken;
      const closes = [];
      seat.on('socket.close', (info) => closes.push(info.code));

      server.goSilent();
      assert.equal(seat.connected, true, 'nothing closed: only the heartbeat can notice');
      await until(() => server.state.hellos.length > hellos);
      await until(() => seat.connected);
      assert.deepEqual(closes, [1006]);
      assert.equal(server.state.hellos.at(hellos).token, token, 'the seat comes back with its reconnect token');
      assert.equal(seat.snapshot().connection.reconnecting, false);
      assert.equal(seat.snapshot().connection.lastError, null);
      assert.equal(seat.snapshot().last['m.public'].round, server.state.round, 'hello resynced the match');
      await seat.close();
    });

    it('stays connected while the server answers, and keeps pongs out of the frames', async () => {
      const seat = new StrongholdClient({ wsUrl: server.url, name: 'Alive', ...quick });
      await seat.connect();
      const hellos = server.state.hellos.length;
      await settle(120);
      assert.equal(seat.connected, true);
      assert.equal(server.state.hellos.length, hellos);
      assert.equal(seat.snapshot().last.pong, undefined);
      await seat.close();
    });

    it('reopens a socket the server closed, and reports it meanwhile', async () => {
      const seat = new StrongholdClient({ wsUrl: server.url, name: 'Dropped', ...quick, backoff: { base: 80, factor: 1, max: 80, jitter: 0 } });
      await seat.connect();
      server.drop(1011);
      await until(() => !seat.connected);
      assert.equal(seat.snapshot().connection.reconnecting, true);
      await until(() => seat.connected);
      await seat.close();
    });

    it('leaves a replaced session alone', async () => {
      const seat = new StrongholdClient({ wsUrl: server.url, name: 'Replaced', ...quick });
      await seat.connect();
      const hellos = server.state.hellos.length;
      server.drop(4001);
      await until(() => !seat.connected);
      await settle(80);
      assert.equal(server.state.hellos.length, hellos, 'another page holds the session now');
      assert.equal(seat.snapshot().connection.reconnecting, false);
    });

    it('stops for good on close()', async () => {
      const seat = new StrongholdClient({ wsUrl: server.url, name: 'Done', ...quick });
      await seat.connect();
      const hellos = server.state.hellos.length;
      await seat.close();
      await settle(80);
      assert.equal(server.state.hellos.length, hellos);
      assert.equal(seat.connected, false);
    });
  });

  it('keeps only the newest state frame queued, in order among the events', async () => {
    const seat = new StrongholdClient({ wsUrl: server.url, name: 'Queue' });
    await seat.connect();
    await settle();
    seat.events = [];
    server.push({ t: 'm.public', round: 1 });
    server.push({ t: 'b.end', battleId: 'b1' });
    server.push({ t: 'm.field', fieldId: 'a', n: 1 });
    server.push({ t: 'm.field', fieldId: 'b', n: 2 });
    server.push({ t: 'm.emote', playerId: 'p2', id: 'x' });
    server.push({ t: 'm.emote', playerId: 'p2', id: 'y' });
    server.push({ t: 'm.field', fieldId: 'a', n: 3 });
    server.push({ t: 'm.public', round: 2 });
    await settle();
    assert.deepEqual(seat.events.map((e) => [e.t, e.round ?? e.battleId ?? e.n ?? e.id]), [
      ['b.end', 'b1'], ['m.field', 2], ['m.emote', 'x'], ['m.emote', 'y'], ['m.field', 3], ['m.public', 2],
    ]);
    assert.equal((await seat.waitForEvent(['m.public'], 500)).round, 2, 'the current state, not the oldest');
    await seat.close();
  });

  it('remembers this seat’s newest emote until the match is over', async () => {
    const seat = new StrongholdClient({ wsUrl: server.url, name: 'Talker' });
    await seat.connect();
    await settle();
    server.push({ t: 'm.public', round: 4 });
    server.push({ t: 'm.emote', playerId: 'somebody-else', id: 'x' });
    await settle();
    assert.equal(seat.snapshot().lastEmote, null);
    server.push({ t: 'm.emote', playerId: seat.playerId, id: 'x' });
    await settle();
    assert.equal(seat.snapshot().lastEmote.round, 4);
    server.push({ t: 'room.state', inMatch: true });
    await settle();
    assert.equal(seat.snapshot().lastEmote.round, 4);
    server.push({ t: 'room.state', inMatch: false });
    await settle();
    assert.equal(seat.snapshot().lastEmote, null);
    await seat.close();
  });

  it('keeps what passed by across a resync and a closed room, and ends a scout with the prep', async () => {
    const seat = new StrongholdClient({ wsUrl: server.url, name: 'Log' });
    await seat.connect();
    await settle();
    server.push({ t: 'm.emote', playerId: 'p2', id: 'x' });
    server.push({ t: 'm.field', fieldId: 'n:p2', prep: true, units: [] });
    await settle();
    assert.equal(seat.snapshot().connection.frameAgesMs['m.field'] >= 0, true);
    server.push({ t: 'm.public', round: 3, fields: [] });
    await settle();
    assert.equal(seat.snapshot().last['m.field'].fieldId, 'n:p2');
    server.push({ t: 'm.public', round: 3, fields: [{ fieldId: 'n:p1' }] });
    await settle();
    assert.equal(seat.snapshot().last['m.field'], undefined);

    await seat.rename('Log2');
    server.push({ t: 'room.closed', reason: 'kicked' });
    await settle();
    const { messages } = seat.snapshot();
    assert.deepEqual(messages.map((m) => m.frame.t), ['m.emote', 'room.closed']);
    assert.ok(messages[0].id < messages[1].id);
    assert.equal(messages[0].round, server.state.round);
    await seat.close();
  });

  it('reports framesAgeMs as null before any state frame arrives', async () => {
    const fresh = new StrongholdClient({ wsUrl: server.url, name: 'Quiet' });
    // Never connected: nothing has arrived, so there is no age to report.
    assert.equal(fresh.snapshot().connection.framesAgeMs, null);
    assert.equal(fresh.snapshot().connection.connected, false);
  });
});
