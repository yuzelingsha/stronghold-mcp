# stronghold-mcp

**An MCP server that lets AI agents play *Arknights: Stronghold Protocol* the way a player does.** · [中文](README.md)

Two parts, installed independently:

| Where | What | Who installs it |
|---|---|---|
| **Game server** | A read-only `trusted` plugin (no source changes) that hands out the files an agent needs to run the battle simulation | the server operator |
| **Agent side** | An MCP server that connects to the game and plays the match like a browser does | whoever runs the agent |

This is a companion, not a bot: nothing in this repository makes a decision. What to buy, where to place,
when to level up and when to ready are all the agent's call. The code here only describes the match and sends actions.

The bridge has no privileges: every message it sends is an ordinary client message, validated by the server exactly as a
browser's. The plugin only reads files the server already serves to browsers.

The detailed documentation is in Chinese ([README.md](README.md) and [docs/](docs/)); this page is the overview.

---

## Quick start

Requires **Node.js ≥ 22**; the Python SDK needs **Python ≥ 3.10** (standard library only).

```bash
git clone https://github.com/yuzelingsha/stronghold-mcp.git && cd stronghold-mcp
npm install

# game side, once, inside the game installation — full steps in docs/plugin-install.md
cp -r plugin/ /path/to/Stronghold-Protocol/plugins/stronghold-agent/

# agent side
cp .env.example .env          # server address; login only if the site has a login gate
node driver/drive-daemon.mjs  # keeps one MCP session open for the Python SDK

pip install -e python/
python python/examples/01_observe.py
```

Tests need no game server, no credentials and no game source:

```bash
npm test
python3 -m unittest discover -s python/tests -t python
```

## MCP

```json
{
  "mcpServers": {
    "stronghold": {
      "command": "node",
      "args": ["/absolute/path/to/stronghold-mcp/mcp/index.js"],
      "env": { "STRONGHOLD_WS_URL": "wss://your-server/ws", "STRONGHOLD_LOCAL_BATTLE": "1" }
    }
  }
}
```

| Tool | Purpose |
|---|---|
| `stronghold_observe` | The decision snapshot. `detail:"compact"` (default) puts static stats once in `catalog`; pass the last `rev` as `since` to get only what changed |
| `stronghold_guide` | The game tutorial (numbers from the server's own `config.json`) and reference pages for this match, read on demand: without `ids` it returns a table of contents |
| `stronghold_lookup` | One game-data record by id: operator, item, enemy, token, band, bond |
| `stronghold_action` / `stronghold_protocol` | Send any protocol action / list actions and fields |
| `stronghold_connect` / `stronghold_disconnect` / `stronghold_state` / `stronghold_wait_event` | Session, raw frames, events |

`STRONGHOLD_MCP_TOOLS=full` adds one convenience tool per action (62 tools in total).
`MCP_TRANSPORT=http` serves Streamable HTTP at `/mcp` behind Basic Auth; see [docs/deploy.md](docs/deploy.md).

### Prompt layout and caching

On connect the server sends fixed `instructions` (`mcp/instructions.js`): the turn loop, the context rules and the
tutorial's table of contents. They and the tool definitions are code constants, byte-identical in every session,
so a client's prompt prefix can be cached across matches. Everything that changes arrives in tool results appended to
the conversation. `test/prompt.test.mjs` checks the prefix; [docs/prompting.md](docs/prompting.md) has the details.

## Battle simulation

The protocol hands each client a battle spec and expects the client to simulate it and report the result. The MCP runs
the game's own simulation code, fetched from the plugin (one ~10 MB bundle with a content fingerprint), from a local
game installation (`STRONGHOLD_SIM_ROOT`), or, without the plugin, by crawling `/sim/` (refused when incomplete).
Normal rooms run in real time like a browser; training rooms (`room.create { train: true }`, enabled by the server)
step each battle to the end at once.

## Security

- **Connecting to a server lets it run code on your machine.** With the battle runner on, the MCP downloads the
  simulation from the game server and executes it in local Node, the same code a browser runs. Connect only to servers
  you trust.
- Credentials stay in memory and are exchanged for a session cookie; `.env` is git-ignored.
- The HTTP transport always requires Basic Auth and listens on `127.0.0.1` by default; idle sessions close after
  `MCP_HTTP_IDLE_SECONDS`. Give remote clients their own `MCP_HTTP_USER` / `MCP_HTTP_PASSWORD`.
- The driver's local TCP port has no authentication; keep `DRIVER_HOST=127.0.0.1`.

## License

MIT, see [LICENSE](LICENSE).

This is tooling for a non-commercial fan work and is not affiliated with Hypergryph. *Arknights* and all related names,
characters and assets belong to their respective owners. This repository contains no game assets, data files or server
code: the simulation and data are fetched at runtime from the server you deploy yourself.
