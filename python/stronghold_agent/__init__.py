"""stronghold_agent — let an AI agent play Stronghold Protocol.

The package is deliberately split so that each layer can be used alone:

    driver        the TCP line protocol to the resident drive daemon
    actions       action shorthand -> the game's own protocol messages
    Agent         the high-level observe/act loop (what an agent actually uses)

The observation itself is rendered by the MCP server (``stronghold_observe``), so this package needs
nothing of the game on disk.

Quick start::

    from stronghold_agent import Agent

    with Agent.connect(name="Agent") as game:
        obs = game.observe()
        print(obs["phase"], obs["me"]["funds"], [b["bond"] for b in obs["bonds"] if b["active"]])

Nothing here decides anything: the agent decides, this package observes and acts.
"""
from .agent import ActionError, Agent
from .driver import Driver, DriverError

__version__ = "0.1.0"

__all__ = [
    "Agent",
    "ActionError",
    "Driver",
    "DriverError",
    "__version__",
]
