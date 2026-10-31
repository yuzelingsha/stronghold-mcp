import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { CHAPTERS, EMOTES, EMOTE_MOMENTS } from '../mcp/guide-notes.js';
import { INSTRUCTIONS } from '../mcp/instructions.js';
import { ACTION_TYPES } from '../mcp/protocol.js';
import { createMcpServer } from '../mcp/server.js';

/** What a client receives when it opens a session: the initialize result and the tool list. */
async function handshake(client, env) {
  const server = createMcpServer(client, { env, gameData: async () => ({}) });
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const replies = new Map();
  peer.onmessage = (message) => { if (message.id !== undefined) replies.set(message.id, message); };
  await server.connect(transport);
  await peer.start();
  const request = async (id, method, params = {}) => {
    await peer.send({ jsonrpc: '2.0', id, method, params });
    for (let i = 0; i < 100 && !replies.has(id); i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(replies.has(id), `no reply to ${method}`);
    return replies.get(id).result;
  };
  const init = await request(1, 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await request(2, 'tools/list');
  await server.close();
  return { instructions: init.instructions, tools: JSON.stringify(tools) };
}

const idle = { snapshot: () => ({}), connected: false };
const midMatch = {
  connected: true,
  snapshot: () => ({ connected: true, playerId: 'p_1', last: { 'm.public': { phase: 'PREP', round: 7, modeId: 'm1' }, 'm.private': { funds: 9 } } }),
};

describe('prompt prefix', () => {
  it('asks the agent to talk to the user while it plays, without ending its turn', async () => {
    assert.match(INSTRUCTIONS, /对局全程用普通文字告诉用户你在做什么/);
    assert.match(INSTRUCTIONS, /文字和下一个工具调用放在同一条回复里/);
    // a client can drop the instructions; every client shows the tool list
    assert.match((await handshake(idle, {})).tools, /tell the user in plain text what you are doing: one or two sentences in the same reply as your next tool call/);
  });

  it('gives the agent the players’ words, and names only actions that exist', () => {
    for (const term of ['休整期', '抓', 'D 牌', '升本', '留对子', '碰对子', '分队', '兜底', '悬赏', '叔叔', '电表倒转']) assert.ok(INSTRUCTIONS.includes(term), term);
    const named = INSTRUCTIONS.match(/\bg\.[A-Za-z]+/g);
    assert.ok(named.includes('g.levelUp'));
    assert.deepEqual([...new Set(named)].filter((type) => !ACTION_TYPES.includes(type)), []);
  });

  it('asks a seat to talk to its teammates and hands it the ids, so it needs no guide call', () => {
    assert.match(INSTRUCTIONS, /每回合至少发一个表情/);
    assert.ok(EMOTE_MOMENTS.length > 0);
    for (const [when, id] of EMOTE_MOMENTS) assert.ok(INSTRUCTIONS.includes(`  - ${when}：“${EMOTES[id]}” ${id}`), id);
  });

  it('hands every session the same instructions and tool list, whatever the match and environment', async () => {
    const a = await handshake(idle, {});
    const b = await handshake(midMatch, { STRONGHOLD_NAME: 'Other', STRONGHOLD_WS_URL: 'ws://example.invalid/ws', STRONGHOLD_LOCAL_BATTLE: '1' });
    assert.equal(a.instructions, INSTRUCTIONS);
    assert.equal(b.instructions, a.instructions);
    assert.equal(b.tools, a.tools);
    // the tool mode is a deployment setting: each mode has its own fixed list
    const full = await handshake(idle, { STRONGHOLD_MCP_TOOLS: 'full' });
    assert.equal((await handshake(midMatch, { STRONGHOLD_MCP_TOOLS: 'full' })).tools, full.tools);
  });

  it('lists every tutorial chapter in the instructions, in affirmative statements', () => {
    for (const ch of CHAPTERS) assert.ok(INSTRUCTIONS.includes(`${ch.id} ${ch.title}：${ch.summary}`), ch.id);
    // quoted emote labels are game text, verbatim (没问题, 对不起)
    for (const line of INSTRUCTIONS.split('\n')) assert.doesNotMatch(line.replace(/“[^”]*”/g, ''), /不(?!同)|没|无(?!需激活)|非|(?<!分)别|勿/, line);
    assert.doesNotMatch(INSTRUCTIONS, /\d{4}-\d{2}-\d{2}|ws:\/\/|https?:\/\//);
  });
});
