import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, ACTION_TYPES, actionCatalog, toolNameFor } from '../mcp/protocol.js';

describe('protocol table', () => {
  it('has no duplicate action types', () => {
    assert.equal(new Set(ACTION_TYPES).size, ACTION_TYPES.length);
  });

  it('produces unique MCP tool names', () => {
    const names = ACTION_TYPES.map(toolNameFor);
    assert.equal(new Set(names).size, names.length, 'two actions must never map to the same tool');
  });

  it('names tools the way the MCP server registers them', () => {
    assert.equal(toolNameFor('g.buy'), 'stronghold_g_buy');
    assert.equal(toolNameFor('room.create'), 'stronghold_room_create');
    assert.equal(toolNameFor('ping'), 'stronghold_ping');
  });

  it('gives every action a non-empty description and a type of the expected shape', () => {
    for (const [type, description] of ACTIONS) {
      // `ping` is the one bare action; every other is `<family>.<verb>`.
      assert.match(type, /^[a-z]+(\.[A-Za-z]+)*$/, `unexpected action type ${type}`);
      assert.equal(typeof description, 'string');
      assert.ok(description.length > 10, `${type} needs a usable description`);
    }
  });

  it('exposes the same catalog the tool returns', () => {
    const catalog = actionCatalog();
    assert.equal(catalog.length, ACTIONS.length);
    assert.deepEqual(catalog[0], { type: ACTIONS[0][0], description: ACTIONS[0][1] });
  });

  it('covers the action families the SDK depends on', () => {
    for (const required of ['g.buy', 'g.sell', 'g.move', 'g.ready', 'g.choice', 'room.create', 'room.join', 'b.result']) {
      assert.ok(ACTION_TYPES.includes(required), `${required} must stay in the table`);
    }
  });
});
