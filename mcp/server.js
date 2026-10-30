/**
 * One MCP server for one player session: the static instructions plus the tools.
 *
 * Kept apart from index.js (which starts a transport as soon as it is imported) so tests can build the exact server a
 * client talks to.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { INSTRUCTIONS } from './instructions.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'stronghold-protocol-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * @param {import('./game-client.js').StrongholdClient} client
 * @param {Parameters<typeof registerTools>[2]} [options]
 */
export function createMcpServer(client, options) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, client, options);
  return server;
}
