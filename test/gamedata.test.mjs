import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { gameDataSource, GAME_DATA_FILES } from '../mcp/gamedata.js';

function client() {
  return { httpUrl: 'https://game.example', welcome: { content: { vanilla: 'v1' } }, ensureAuthCookie: async () => null };
}

describe('versioned game data', () => {
  it('coalesces loads and invalidates them when welcome announces new content', async () => {
    const seat = client();
    let requests = 0;
    const source = gameDataSource(seat, { env: {}, fetchImpl: async () => {
      requests++;
      return Response.json({ version: seat.welcome.content.vanilla });
    } });
    const [a, b] = await Promise.all([source(), source()]);
    assert.equal(a, b);
    assert.equal(requests, GAME_DATA_FILES.length);
    seat.welcome.content.vanilla = 'v2';
    const updated = await source();
    assert.equal(updated.chess.version, 'v2');
    assert.equal(requests, GAME_DATA_FILES.length * 2);
  });

  it('uses already-loaded simulation records without another download', async () => {
    const seat = client();
    const raw = Object.fromEntries(GAME_DATA_FILES.map((name) => [name, Object.freeze({ record: true })]));
    seat.simulationData = { origin: seat.httpUrl, contentVersion: 'v1', raw };
    const source = gameDataSource(seat, { env: {}, fetchImpl: () => { throw new Error('unexpected download'); } });
    assert.equal(await source(), raw);
    assert.equal((await source()).chess, raw.chess);
  });

  it('does not reuse simulation records from an older welcome version', async () => {
    const seat = client();
    seat.simulationData = { origin: seat.httpUrl, contentVersion: 'v0', raw: Object.fromEntries(GAME_DATA_FILES.map((name) => [name, {}])) };
    const source = gameDataSource(seat, { env: {}, fetchImpl: async () => Response.json({ current: true }) });
    assert.equal((await source()).chess.current, true);
  });

  it('retries a failed data load', async () => {
    const seat = client();
    let fail = true;
    const source = gameDataSource(seat, { env: {}, fetchImpl: async () => {
      if (fail) throw new Error('temporary outage');
      return Response.json({ current: true });
    } });
    await assert.rejects(source(), /temporary outage/);
    fail = false;
    assert.equal((await source()).chess.current, true);
  });
});
