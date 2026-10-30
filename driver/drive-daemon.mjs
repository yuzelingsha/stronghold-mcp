#!/usr/bin/env node
/**
 * drive-daemon — keep one stdio MCP process alive and expose it over a local TCP line protocol.
 *
 * Why: an MCP stdio server is a child process whose lifetime is owned by one client. A long-running
 * agent (or several short scripts) wants a *resident* game session instead — connect once, then send
 * many small requests. This daemon owns the MCP process and answers newline-delimited JSON requests.
 *
 * Request:   {"tool":"stronghold_state","args":{}}
 *            {"method":"tools/list","params":{}}
 *            {"tool":"stronghold_action","args":{"type":"g.buy","fields":{"slot":0}},"timeoutMs":30000}
 * Response:  {"ok":true,"result":<MCP tool result>} | {"ok":false,"error":"..."}
 *
 * Environment
 *   DRIVER_PORT     TCP port on 127.0.0.1 (default 8899)
 *   DRIVER_HOST     bind address (default 127.0.0.1 — do not expose this publicly)
 *   DRIVER_LOG      append a log file (default: stderr only)
 *   DRIVER_MCP      path to the MCP entry point (default ../mcp/index.js)
 *   DRIVER_TIMEOUT  default per-request timeout in seconds (default 180)
 *
 * The repository's `.env` is loaded first (variables already in the environment win). Everything the
 * MCP server reads (STRONGHOLD_WS_URL, STRONGHOLD_AUTH_*, STRONGHOLD_LOCAL_BATTLE, …) is inherited from
 * this process's environment.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadDotEnv } from '../mcp/env.js';
import { driverConfig } from './config.mjs';

loadDotEnv();
const { mcp: MCP, host: HOST, port: PORT, timeoutMs: DEFAULT_TIMEOUT, log: LOG } = driverConfig();

const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  if (LOG) { try { appendFileSync(LOG, line + '\n'); } catch { /* ignore */ } }
  else process.stderr.write(line + '\n');
};

const child = spawn(process.execPath, [MCP], {
  cwd: dirname(MCP),
  // A resident driver exists to play, so it runs battles unless told otherwise. These are defaults only:
  // the environment and `.env` both override them.
  env: { STRONGHOLD_LOCAL_BATTLE: '1', STRONGHOLD_NAME: 'AgentDriver', ...process.env, MCP_TRANSPORT: 'stdio' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdin.on('error', (err) => log('stdin error: ' + err.message));

let exited = false;
let exitInfo = null;
child.on('exit', (code, sig) => {
  exited = true;
  exitInfo = { code, sig };
  log(`MCP exited code=${code} sig=${sig}; daemon exiting`);
  for (const { reject } of pending.values()) reject(new Error(`MCP process exited (code=${code} sig=${sig})`));
  pending.clear();
  process.exit(code ?? 1);
});
child.stderr.on('data', (d) => log('mcp-stderr: ' + String(d).trimEnd()));

let nextId = 1;
const pending = new Map();

createInterface({ input: child.stdout }).on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log('mcp-nonjson: ' + line.slice(0, 300)); return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve: done } = pending.get(msg.id);
    pending.delete(msg.id);
    done(msg);
  } else if (msg.method) {
    log('mcp-notify: ' + String(msg.method));
  }
});

function send(method, params, timeoutMs = DEFAULT_TIMEOUT) {
  if (exited) return Promise.reject(new Error(`MCP process has exited (${JSON.stringify(exitInfo)})`));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout after ${timeoutMs}ms: ${method}`)); }
    }, timeoutMs).unref();
  });
}

// MCP handshake — must complete before the daemon accepts clients.
const initRes = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'stronghold-drive-daemon', version: '1.0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
log('initialized: ' + JSON.stringify(initRes.result?.serverInfo ?? initRes.error ?? null));

createServer((sock) => {
  sock.on('error', (err) => log('client sock error: ' + err.message));
  const rl = createInterface({ input: sock });
  rl.on('error', (err) => log('client rl error: ' + err.message));
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let out;
    let reqId = null;
    try {
      const req = JSON.parse(line);
      reqId = req.id ?? null;
      if (req.method === 'tools/list') {
        out = { ok: true, result: await send('tools/list', {}, req.timeoutMs || DEFAULT_TIMEOUT) };
      } else if (req.method) {
        out = { ok: true, result: await send(req.method, req.params || {}, req.timeoutMs || DEFAULT_TIMEOUT) };
      } else if (req.tool) {
        const res = await send('tools/call', { name: req.tool, arguments: req.args || {} }, req.timeoutMs || DEFAULT_TIMEOUT);
        out = res.error ? { ok: false, error: res.error } : { ok: true, result: res.result };
      } else {
        out = { ok: false, error: 'need {tool,args} or {method,params}' };
      }
    } catch (e) {
      out = { ok: false, error: String(e?.message || e) };
    }
    if (reqId != null) out.id = reqId;
    try { sock.write(JSON.stringify(out) + '\n'); } catch { /* client went away */ }
  });
}).listen(PORT, HOST, () => log(`driver listening on ${HOST}:${PORT} (mcp=${MCP})`));

const shutdown = () => {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
