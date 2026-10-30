import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createObservationLog } from '../mcp/observe-log.js';

function obs(overrides = {}) {
  return {
    connected: true, phase: 'PREP', round: 3, frames_age_ms: 10, seconds_left: 20,
    me: { funds: 7 },
    shop: [{ slot: 0, id: 'chess_a', price: 2 }],
    field: { lanes: [1, 2, 3] },
    reward_offer: { tier: 1 },
    catalog: { 'chess:chess_a': { name: '角峰' } },
    ...overrides,
  };
}

describe('observation log (rev / since)', () => {
  it('numbers each distinct observation and returns it whole without since', () => {
    const log = createObservationLog();
    const first = log(obs());
    assert.equal(first.rev, 1);
    assert.deepEqual(first.field, { lanes: [1, 2, 3] });
    // Only the volatile scalars moved: the same revision.
    assert.equal(log(obs({ frames_age_ms: 900, seconds_left: 3 })).rev, 1);
    assert.equal(log(obs({ me: { funds: 5 } })).rev, 2);
  });

  it('sends only the new messages, and keeps the volatile ages out of the revision', () => {
    const log = createObservationLog();
    const one = { id: 1, text: 'a' };
    const two = { id: 2, text: 'b' };
    const first = log(obs({ messages: [one] }));
    const same = log(obs({ messages: [one], scouted_age_ms: 5, overtime_in_s: 3 }), { since: first.rev });
    assert.equal(same.rev, first.rev);
    assert.ok(same.unchanged.includes('messages'));
    const next = log(obs({ messages: [one, two] }), { since: first.rev });
    assert.deepEqual(next.messages, [two]);
    const fromNothing = log(obs({ messages: [one, two] }), { since: log(obs()).rev });
    assert.deepEqual(fromNothing.messages, [one, two]);
  });

  it('sends only the changed sections, the removed keys and the new catalog entries', () => {
    const log = createObservationLog();
    const { rev } = log(obs());
    const { reward_offer: _closed, ...next } = obs({
      me: { funds: 5 },
      shop: [{ slot: 0, id: 'chess_b', price: 3 }],
      catalog: { 'chess:chess_a': { name: '角峰' }, 'chess:chess_b': { name: '古米' } },
    });
    const delta = log(next, { since: rev });
    assert.equal(delta.rev, 2);
    assert.equal(delta.since, 1);
    assert.equal(delta.phase, 'PREP');
    assert.equal(delta.frames_age_ms, 10);
    assert.deepEqual(delta.me, { funds: 5 });
    assert.deepEqual(delta.shop, [{ slot: 0, id: 'chess_b', price: 3 }]);
    assert.equal(delta.field, undefined);
    assert.deepEqual(delta.unchanged, ['field']);
    assert.deepEqual(delta.removed, ['reward_offer']);
    assert.deepEqual(delta.catalog, { 'chess:chess_b': { name: '古米' } });
  });

  it('answers an unchanged match with nothing but the scalars', () => {
    const log = createObservationLog();
    const { rev } = log(obs());
    const delta = log(obs({ frames_age_ms: 50 }), { since: rev });
    assert.deepEqual(delta.unchanged.sort(), ['field', 'me', 'reward_offer', 'shop']);
    assert.equal(delta.catalog, undefined);
    assert.equal(delta.removed, undefined);
  });

  it('resyncs with the whole observation when since is unknown, evicted or taken with other options', () => {
    const log = createObservationLog({ limit: 2 });
    const unknown = log(obs(), { since: 99 });
    assert.equal(unknown.resync, true);
    assert.deepEqual(unknown.field, { lanes: [1, 2, 3] });
    assert.deepEqual(unknown.catalog, { 'chess:chess_a': { name: '角峰' } });

    log(obs({ round: 4 }));
    log(obs({ round: 5 }));
    assert.equal(log(obs({ round: 6 }), { since: 1 }).resync, true);

    const other = createObservationLog();
    const { rev } = other(obs(), { signature: 'compact' });
    assert.equal(other(obs(), { signature: 'full', since: rev }).resync, true);
  });
});
