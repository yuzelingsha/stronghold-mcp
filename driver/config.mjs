/**
 * The drive daemon's settings, read from the environment.
 *
 * DRIVER_TIMEOUT is in **seconds**, the same unit the Python SDK, the README and `.env.example` use, so
 * one value in `.env` means the same thing on both sides of the socket.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_S = 180;

export function driverConfig(env = process.env) {
  const timeoutS = Number(env.DRIVER_TIMEOUT);
  return {
    mcp: env.DRIVER_MCP || resolve(HERE, '..', 'mcp', 'index.js'),
    host: env.DRIVER_HOST || '127.0.0.1',
    port: Number(env.DRIVER_PORT || 8899),
    timeoutMs: (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : DEFAULT_TIMEOUT_S) * 1000,
    log: env.DRIVER_LOG || '',
  };
}
