/**
 * Load the repository's `.env`, so the documented `cp .env.example .env` actually configures the
 * Node processes (the MCP server and the drive daemon).
 *
 * The file sits beside `package.json`, wherever the process was started from. A variable already set in
 * the environment always wins over the file, so an MCP client's own `env` block, or a systemd unit,
 * keeps the last word. A missing file is not an error: every setting has a default.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

/** @returns {string|null} the file that was loaded, or null when there was none */
export function loadDotEnv(file = DEFAULT_ENV_FILE) {
  try {
    process.loadEnvFile(file);
    return file;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
