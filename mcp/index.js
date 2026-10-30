#!/usr/bin/env node
/**
 * stronghold-mcp — MCP bridge.
 *
 * Exposes a real Stronghold Protocol player session as MCP tools, so any MCP-capable agent can
 * observe the match and act in it. The bridge adds no authority of its own: every message it sends is
 * a normal client message, and the game server validates it exactly as it validates a browser.
 *
 * Transports
 *   stdio (default)          for a local MCP client
 *   MCP_TRANSPORT=http       Streamable HTTP on MCP_HTTP_HOST:MCP_HTTP_PORT (default 127.0.0.1:8787)
 *                            guarded by HTTP Basic auth from MCP_HTTP_USER / MCP_HTTP_PASSWORD;
 *                            a session idle for MCP_HTTP_IDLE_SECONDS (default 1800) is closed
 *
 * Environment (the repository's `.env` is loaded first; variables already set win)
 *   STRONGHOLD_WS_URL / STRONGHOLD_HTTP_URL / STRONGHOLD_NAME   the session to open
 *   STRONGHOLD_AUTH_USER / STRONGHOLD_AUTH_PASSWORD             login credentials (optional; SP_AUTH_USER /
 *                                                               SP_AUTH_PASSWORD, the game server's names, also work)
 *   STRONGHOLD_LOCAL_BATTLE=1                                   attach a local battle runner
 *   STRONGHOLD_SIM_ROOT                                         where the game's sim lives (see mcp/battle/)
 *   STRONGHOLD_MCP_TOOLS=compact                                generic tools only (see mcp/tools.js)
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { loadDotEnv } from './env.js';
import { StrongholdClient } from './game-client.js';
import { createSessionTable, idleMsFrom } from './http-sessions.js';
import { SERVER_NAME, createMcpServer } from './server.js';

loadDotEnv();

/**
 * Optionally attach a battle runner. It is a separate module because it needs the game's own
 * deterministic simulation; without it the bridge still relays every protocol message and simply
 * leaves `b.start` to whoever else can run the battle.
 *
 * The simulation is fetched lazily — the first `b.start` waits for it — so an MCP server starts
 * answering tool calls immediately. `stronghold_state` reports the runner's progress under
 * `battleSimulation`.
 */
async function maybeAttachBattle(client) {
  if (!truthy(process.env.STRONGHOLD_LOCAL_BATTLE)) return;
  try {
    const { attachBattle } = await import('./battle/index.js');
    const info = await attachBattle(client, {
      onProgress: (message) => console.error(`[${SERVER_NAME}] ${message}`),
    });
    console.error(`[${SERVER_NAME}] battle runner attached (mode=${info.mode}, source=${info.source}${info.specPath ? `, spec=${info.specPath}` : ''})`);
  } catch (error) {
    console.error(`[${SERVER_NAME}] battle runner NOT attached: ${error instanceof Error ? error.message : error}`);
    client.battleSimulation = {
      enabled: false,
      error: error instanceof Error ? error.message : String(error),
      hint: 'Set STRONGHOLD_SIM_ROOT to a game installation, or leave STRONGHOLD_LOCAL_BATTLE unset.',
    };
  }
}

function truthy(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function runStdio() {
  const client = new StrongholdClient();
  await maybeAttachBattle(client);
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await client.close();
    await server.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function basicAuthOk(req) {
  const configuredUser = String(process.env.MCP_HTTP_USER || process.env.STRONGHOLD_AUTH_USER || process.env.SP_AUTH_USER || '');
  const configuredPassword = String(process.env.MCP_HTTP_PASSWORD || process.env.STRONGHOLD_AUTH_PASSWORD || process.env.SP_AUTH_PASSWORD || '');
  if (!configuredUser || !configuredPassword) return false;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), configuredUser) && safeEqual(decoded.slice(i + 1), configuredPassword);
}

async function runHttp() {
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  const port = Number(process.env.MCP_HTTP_PORT || 8787);
  const sessions = createSessionTable({
    idleMs: idleMsFrom(process.env),
    onExpire: (entry) => {
      console.error(`[${SERVER_NAME}] closing an idle MCP session`);
      void entry.client.close();
      void entry.mcp.close().catch(() => {});
    },
  });
  const reaper = setInterval(() => sessions.sweep(), 60_000);
  reaper.unref();
  const http = createHttpServer(async (req, res) => {
    if (req.url !== '/mcp' && req.url !== '/mcp/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    if (!basicAuthOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Stronghold MCP"', 'Content-Length': '0' });
      res.end();
      return;
    }
    const sessionId = String(req.headers['mcp-session-id'] || '');
    let entry = sessionId ? sessions.get(sessionId) : null;
    let fresh = false;
    try {
      if (!entry) {
        if (req.method !== 'POST' || sessionId) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'MCP session not found' }));
          return;
        }
        const client = new StrongholdClient();
        await maybeAttachBattle(client);
        const mcp = createMcpServer(client);
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        entry = { client, mcp, transport };
        fresh = true;
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
          void client.close();
        };
        await mcp.connect(transport);
      }
      const known = entry;
      if (fresh) await known.transport.handleRequest(req, res);
      else await sessions.track(sessionId, () => known.transport.handleRequest(req, res));
      if (fresh && entry.transport.sessionId) sessions.set(entry.transport.sessionId, entry);
      if (req.method === 'DELETE') {
        const id = entry.transport.sessionId;
        if (id) sessions.delete(id);
        await entry.client.close();
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } else {
        res.end();
      }
      if (fresh) await entry?.mcp?.close().catch(() => {});
    }
  });
  http.listen(port, host, () => console.error(`[${SERVER_NAME}] HTTP listening on ${host}:${port}`));
  const shutdown = async () => {
    clearInterval(reaper);
    for (const entry of sessions.values()) {
      await entry.client.close();
      await entry.mcp.close().catch(() => {});
    }
    http.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (process.env.MCP_TRANSPORT === 'http') await runHttp();
else await runStdio();
