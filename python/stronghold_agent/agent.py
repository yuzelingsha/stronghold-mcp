"""Agent — the high-level, decision-free interface an AI agent plays through.

Nothing in this package decides anything. It observes and it acts. Which piece to buy, what to sell,
where to stand, when to level, when to Ready — all of that is the agent's call, made once per turn
against :meth:`Agent.observe`.

    from stronghold_agent import Agent

    with Agent.connect(name="Agent") as game:
        game.join("EUYV")
        game.wait_for_phase("PREP")
        obs = game.observe()
        game.buy(0)
        game.place(uid=12, row=9, col=5, dir="RIGHT")
        game.ready()

Failures are loud by default: :meth:`act` raises :class:`ActionError` when the *game* rejects an
action, not merely when the transport fails. Silent rejection is the one thing an agent must never
have to guess about. Use :meth:`try_act` when a rejected action is expected and informative.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Iterable

from .actions import run_actions
from .driver import Driver

__all__ = ["Agent", "ActionError"]


class ActionError(RuntimeError):
    """The game rejected an action (or the tool call failed outright)."""

    def __init__(self, record: dict[str, Any]):
        self.record = record
        action = record.get("in")
        super().__init__(f"{record.get('act') or 'action'} failed: {record.get('error')} (in={action!r})")


class Agent:
    """One persistent seat at the table."""

    def __init__(self, driver: Driver):
        self.driver = driver

    # ---------------------------------------------------------------- lifecycle
    @classmethod
    def connect(
        cls,
        name: str | None = None,
        *,
        host: str | None = None,
        port: int | None = None,
        timeout: float | None = None,
    ) -> "Agent":
        """Open the session, connecting the seat if it is not connected yet."""
        kwargs: dict[str, Any] = {}
        if host is not None:
            kwargs["host"] = host
        if port is not None:
            kwargs["port"] = port
        if timeout is not None:
            kwargs["timeout"] = timeout
        agent = cls(Driver(**kwargs))
        agent.driver.tool("stronghold_connect", {"name": name} if name else {})
        return agent

    def close(self) -> None:
        self.driver.close()

    def __enter__(self) -> "Agent":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ---------------------------------------------------------------- observation
    def state(self, include_recent: bool = True) -> dict[str, Any]:
        """The raw ``stronghold_state`` snapshot: connection facts plus the latest frame per type."""
        return self.driver.tool("stronghold_state", {"includeRecent": include_recent})

    def observe(
        self,
        *,
        detail: str = "full",
        include_field: bool = True,
        include_report: bool = True,
        since: int | None = None,
    ) -> dict[str, Any]:
        """One decision-ready snapshot. This is what a turn is decided against.

        Rendered by the MCP server (``stronghold_observe``), which joins the frames with the game's own
        data files fetched from the server, so nothing of the game needs to be on this machine.
        ``detail="compact"`` moves static stats into ``catalog["kind:id"]`` and leaves out default values.
        Live prices and instance fields remain in place; known maps and reports may be omitted explicitly.

        Every observation carries a ``rev``. ``since=<rev>`` returns only what changed from that response
        (``unchanged`` / ``removed`` name the rest); ``resync: True`` means the server no longer had it and
        sent everything.
        """
        args: dict[str, Any] = {"detail": detail, "includeField": include_field, "includeReport": include_report}
        if since is not None:
            args["since"] = since
        return self.driver.tool("stronghold_observe", args)

    def guide(self, *, topic: str = "auto", ids: list[str] | None = None) -> dict[str, Any]:
        """The game tutorial and this match's reference pages (``stronghold_guide``), read on demand.

        ``ids`` returns those sections (``tutorial.shop``, ``bond.<bondId>``, ``band.<bandId>``, ``bonds.overview`` …);
        without ``ids`` the reply is a table of contents for ``topic`` (``auto``, ``tutorial``, ``bonds``, ``bands``).
        """
        args: dict[str, Any] = {"topic": topic}
        if ids:
            args["ids"] = list(ids)
        return self.driver.tool("stronghold_guide", args)

    def piece(self, piece_id: str) -> dict[str, Any]:
        """The full record of one chess piece (``chess_…``), item (``item_…``) or enemy, or ``{}``."""
        return self.driver.tool("stronghold_lookup", {"id": piece_id}).get("record") or {}

    def bond(self, bond_id: str) -> dict[str, Any]:
        """One bond's thresholds, description and members, or ``{}``."""
        return self.driver.tool("stronghold_lookup", {"id": bond_id, "kind": "bond"}).get("record") or {}

    def protocol(self) -> list[dict[str, Any]]:
        """Every action the bridge exposes, with the fields the game expects."""
        return (self.driver.tool("stronghold_protocol") or {}).get("actions") or []

    def last_report(self) -> dict[str, Any] | None:
        """The combat report of the most recently finished battle, or ``None``."""
        obs = self.observe()
        battle = obs.get("battle") or {}
        return battle.get("report") or battle.get("lastResult", {}).get("report")

    # ---------------------------------------------------------------- acting
    def act(self, *actions: dict[str, Any]) -> list[dict[str, Any]]:
        """Run shorthands in order, raising on the first rejection.

        ``game.act({"buy": 0}, {"place": {"uid": 12, "row": 9, "col": 5}})``
        """
        records = run_actions(self.driver, list(actions))
        for record in records:
            if not record.get("ok"):
                raise ActionError(record)
        return records

    def try_act(self, *actions: dict[str, Any]) -> list[dict[str, Any]]:
        """Run shorthands and report each outcome without raising."""
        return run_actions(self.driver, list(actions))

    def send(self, action_type: str, **fields: Any) -> dict[str, Any]:
        """Send one raw protocol action (``game.send("g.buy", slot=0)``)."""
        return self.act({"t": action_type, "f": fields})[0]

    # ---------------------------------------------------------------- shorthands
    def buy(self, slot: int) -> dict[str, Any]:
        return self.act({"buy": slot})[0]

    def sell(self, uid: int) -> dict[str, Any]:
        return self.act({"sell": uid})[0]

    def destroy(self, uid: int) -> dict[str, Any]:
        return self.act({"destroy": uid})[0]

    def refresh(self, times: int = 1) -> list[dict[str, Any]]:
        return self.act(*[{"refresh": 1} for _ in range(max(1, times))])

    def freeze(self, on: bool | None = None) -> dict[str, Any]:
        return self.act({"freeze": on})[0]

    def level_up(self, times: int = 1) -> list[dict[str, Any]]:
        return self.act(*[{"level": 1} for _ in range(max(1, times))])

    def place(self, uid: int, row: int, col: int, direction: str | None = None) -> dict[str, Any]:
        entry: dict[str, Any] = {"uid": uid, "row": row, "col": col}
        if direction:
            entry["dir"] = direction
        return self.act({"place": entry})[0]

    def to_hand(self, uid: int, idx: int = 0) -> dict[str, Any]:
        return self.act({"hand": {"uid": uid, "idx": idx}})[0]

    def to_temp(self, uid: int) -> dict[str, Any]:
        return self.act({"temp": uid})[0]

    def rotate(self, uid: int, direction: str) -> dict[str, Any]:
        return self.act({"t": "g.move", "f": {"uid": uid, "to": {"area": "board"}, "dir": direction}})[0]

    def equip(self, item_uid: int, target_uid: int, replace_uid: int | None = None) -> dict[str, Any]:
        entry: dict[str, Any] = {"item": item_uid, "target": target_uid}
        if replace_uid is not None:
            entry["replace"] = replace_uid
        return self.act({"equip": entry})[0]

    def unequip(self, item_uid: int) -> dict[str, Any]:
        return self.act({"unequip": item_uid})[0]

    def deploy_art(self, item_uid: int, row: int, col: int, direction: str | None = None) -> dict[str, Any]:
        entry: dict[str, Any] = {"item": item_uid, "row": row, "col": col}
        if direction:
            entry["dir"] = direction
        return self.act({"art": entry})[0]

    def reward(self, idx: int) -> dict[str, Any]:
        return self.act({"reward": idx})[0]

    def choice(self, idx: int, choice_id: str | None = None) -> dict[str, Any]:
        if choice_id is None:
            return self.act({"choice": idx})[0]
        return self.act({"t": "g.choice", "f": {"idx": idx, "choiceId": choice_id}})[0]

    def band(self, band_id: str) -> dict[str, Any]:
        return self.act({"band": band_id})[0]

    def info_ready(self) -> dict[str, Any]:
        return self.act({"infoReady": True})[0]

    def ready(self, value: bool = True) -> dict[str, Any]:
        return self.act({"ready": value})[0]

    def emote(self, emote_id: str) -> dict[str, Any]:
        return self.act({"emote": emote_id})[0]

    # ---------------------------------------------------------------- room & match
    def create_room(self, mode: str = "solo", difficulty: str = "NORMAL", **extra: Any) -> dict[str, Any]:
        return self.send("room.create", mode=mode, difficulty=difficulty, **extra)

    def join(self, code: str, **extra: Any) -> dict[str, Any]:
        return self.send("room.join", code=code, **extra)

    def leave_room(self) -> dict[str, Any]:
        return self.send("room.leave")

    def leave_match(self) -> dict[str, Any]:
        return self.send("g.leave")

    def room_ready(self, value: bool = True) -> dict[str, Any]:
        return self.send("room.ready", ready=value)

    def start_room(self) -> dict[str, Any]:
        return self.send("room.start")

    def set_difficulty(self, difficulty: str) -> dict[str, Any]:
        return self.send("room.setDifficulty", difficulty=difficulty)

    # ---------------------------------------------------------------- flow control
    def connected(self) -> bool:
        """Whether the seat currently holds a live connection.

        Worth checking before a long wait: a disconnected seat keeps reporting the last frames it
        received, so a poll loop would otherwise sit until its timeout on a match that is already over.
        """
        return bool((self.state(include_recent=False).get("connection") or {}).get("connected"))

    def phase(self) -> str | None:
        return ((self.state().get("last") or {}).get("m.public") or {}).get("phase")

    def round(self) -> int | None:
        return ((self.state().get("last") or {}).get("m.public") or {}).get("round")

    def wait_for_phase(self, phase: str, timeout: float = 120.0, poll: float = 0.5) -> dict[str, Any]:
        """Block until ``m.public.phase`` equals ``phase``, then return a fresh observation.

        Raises :class:`TimeoutError` if it never does, and :class:`ConnectionError` if the seat is not
        connected when the wait starts (rather than silently burning the whole timeout).
        """
        if not self.connected():
            raise ConnectionError(f"the seat is not connected; cannot wait for phase {phase!r}")
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.phase() == phase:
                return self.observe()
            time.sleep(poll)
        raise TimeoutError(f"phase {phase!r} was not reached within {timeout}s (now {self.phase()!r})")

    def wait_until(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        timeout: float = 120.0,
        poll: float = 0.5,
    ) -> dict[str, Any]:
        """Block until ``predicate(observation)`` is true, then return that observation."""
        deadline = time.time() + timeout
        last: dict[str, Any] = {}
        while time.time() < deadline:
            last = self.observe()
            if predicate(last):
                return last
            time.sleep(poll)
        raise TimeoutError(f"condition was not met within {timeout}s (phase={last.get('phase')!r}, connected={last.get('connected')})")

    def wait_for_event(self, types: Iterable[str] | None = None, timeout_ms: int = 15_000) -> dict[str, Any]:
        """Wait for the next live server event (rather than polling state)."""
        args: dict[str, Any] = {"timeoutMs": timeout_ms}
        if types is not None:
            args["types"] = list(types)
        return self.driver.tool("stronghold_wait_event", args, timeout_ms=timeout_ms + 5_000)

    # ---------------------------------------------------------------- helpers
    def free_board_tiles(self, obs: dict[str, Any] | None = None) -> list[list[int]]:
        """Every deployable tile with nothing standing on it."""
        obs = obs or self.observe()
        field = obs.get("field") or {}
        occupied = set((obs.get("board_tiles") or {}).keys())
        tiles = [tuple(t) for t in (field.get("deploy_melee") or [])]
        tiles += [tuple(t) for t in (field.get("deploy_ranged_only") or [])]
        return [[r, c] for r, c in tiles if f"{r},{c}" not in occupied]

    def tiles_for(self, piece: dict[str, Any], obs: dict[str, Any] | None = None) -> list[list[int]]:
        """The tiles one piece may legally stand on, with occupied ones removed.

        A melee operator needs a melee tile. A ranged operator may use any deploy tile, including the
        ranged-only ones. Placing a ranged operator on a melee-only tile is rejected by the game with
        ``BAD_TILE``, so filtering here saves a round trip per attempt.
        """
        obs = obs or self.observe()
        field = obs.get("field") or {}
        melee = [tuple(t) for t in (field.get("deploy_melee") or [])]
        ranged_only = [tuple(t) for t in (field.get("deploy_ranged_only") or [])]
        definition = (obs.get("catalog") or {}).get(f"{piece.get('kind')}:{piece.get('id')}") or {}
        position = piece.get("pos") or definition.get("pos")
        tiles = melee + ranged_only if position == "RANGED" else melee
        occupied = set((obs.get("board_tiles") or {}).keys())
        return [[r, c] for r, c in tiles if f"{r},{c}" not in occupied]

    def can_afford(self, obs: dict[str, Any], price: Any) -> bool:
        try:
            return float((obs.get("me") or {}).get("funds") or 0) >= float(price)
        except (TypeError, ValueError):
            return False
