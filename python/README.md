# stronghold-mcp · Python SDK

Standard-library Python client for [stronghold-mcp](../README.md): it talks to the local drive daemon
(`node driver/drive-daemon.mjs`), which keeps one MCP session open against the game server.

```python
from stronghold_agent import Agent

with Agent.connect(name="Agent") as game:
    obs = game.wait_for_phase("PREP", timeout=300)
    game.buy(0)
    game.ready()
```

- `observe()` returns the decision snapshot rendered by the MCP server; `guide()` reads the game tutorial on demand.
- Actions raise `ActionError` when the game rejects them; `try_act()` returns per-action results instead.
- Examples: `examples/01_observe.py` → `02_play_a_turn.py` → `03_play_a_match.py`.
- Tests: `python3 -m unittest discover -s python/tests -t python` (no game server needed).

See the repository README for setup, configuration and the full API. MIT licensed.
