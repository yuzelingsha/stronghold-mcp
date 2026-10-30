import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTable, idleMsFrom } from '../mcp/http-sessions.js';

describe('HTTP session table', () => {
  it('reads the idle limit from MCP_HTTP_IDLE_SECONDS', () => {
    assert.equal(idleMsFrom({}), 1_800_000);
    assert.equal(idleMsFrom({ MCP_HTTP_IDLE_SECONDS: '60' }), 60_000);
    assert.equal(idleMsFrom({ MCP_HTTP_IDLE_SECONDS: '0' }), 0);
    assert.equal(idleMsFrom({ MCP_HTTP_IDLE_SECONDS: 'soon' }), 0);
  });

  it('expires a session after the idle limit, and keeps one with a request still running', async () => {
    let t = 0;
    const expired = [];
    const table = createSessionTable({ idleMs: 1000, now: () => t, onExpire: (entry, id) => expired.push([id, entry.name]) });
    table.set('a', { name: 'idle' });
    table.set('b', { name: 'busy' });
    let finish;
    const running = table.track('b', () => new Promise((resolve) => { finish = resolve; }));
    t = 500;
    assert.deepEqual(table.sweep(), []);
    t = 1501;
    assert.deepEqual(table.sweep(), ['a']);
    assert.deepEqual(expired, [['a', 'idle']]);
    assert.equal(table.get('a'), undefined);
    assert.equal(table.get('b').name, 'busy');
    finish();
    await running;
    t = 2000;
    assert.deepEqual(table.sweep(), []);
    t = 3001;
    assert.deepEqual(table.sweep(), ['b']);
    assert.equal(table.size, 0);
  });

  it('keeps every session when the limit is 0', () => {
    let t = 0;
    const table = createSessionTable({ idleMs: 0, now: () => t });
    table.set('a', {});
    t = 1e9;
    assert.deepEqual(table.sweep(), []);
    assert.equal(table.values().length, 1);
  });
});
