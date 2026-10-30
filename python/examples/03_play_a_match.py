#!/usr/bin/env python3
"""03 — play a whole match, one prep phase at a time.

This is the loop shape a real agent uses: for every round, observe, decide, act, Ready, then wait for
the next round. The policy is intentionally naive (buy what is affordable, fill the board, level when
rich) — replace :func:`decide` with your own and the rest is unchanged.

    python examples/03_play_a_match.py

It joins whatever room the seat is already in. Create one first with, for example::

    python -c "from stronghold_agent import Agent; a=Agent.connect('Bot'); \\
               print(a.create_room(mode='solo', difficulty='ABYSS'))"
"""
from __future__ import annotations

from typing import Any

from stronghold_agent import ActionError, Agent

MAX_ROUNDS = 30


def decide(game: Agent, obs: dict[str, Any]) -> None:
    """One round's policy. Everything here is the agent's call, not the SDK's."""
    me = obs["me"]

    # Level up while it is cheap relative to what we are holding.
    upgrade = me.get("upgrade_price") or 0
    if upgrade and me["funds"] >= upgrade + 4 and (me["level"] or 0) < (me["max_level"] or 0):
        try:
            game.level_up()
            print("    level up")
        except ActionError as exc:
            print(f"    level up rejected: {exc}")

    # Buy everything affordable, cheapest first, until the hand is full.
    obs = game.observe()
    for slot in sorted(
        (s for s in obs["shop"] if not s.get("empty") and not s.get("sold") and s.get("price") is not None),
        key=lambda s: s["price"],
    ):
        if obs["hand_free"] <= 0 or not game.can_afford(obs, slot["price"]):
            break
        try:
            game.buy(slot["slot"])
            print(f"    buy {slot.get('name')} ({slot['price']}G)")
        except ActionError as exc:
            print(f"    buy {slot['slot']} rejected: {exc}")
            break
        obs = game.observe()

    # Fill the board with whatever is in hand.
    for piece in list(obs["hand"]):
        tiles = game.tiles_for(piece, obs)
        if not tiles:
            break
        row, col = tiles[0]
        try:
            game.place(piece["uid"], row, col, direction="RIGHT")
            print(f"    deploy {piece.get('name')} at {row},{col}")
        except ActionError as exc:
            print(f"    deploy rejected: {exc}")
            break
        obs = game.observe()

    # A personal choice blocks Ready; take the first card.
    if obs.get("personal_choice"):
        try:
            game.choice(0)
            print("    took choice 0")
        except ActionError as exc:
            print(f"    choice rejected: {exc}")

    if game.observe()["me"]["can_ready"]:
        game.ready()
        print("    ready")
    else:
        print("    cannot ready (temp bench not empty?)")


def main() -> int:
    with Agent.connect(name="Player") as game:
        last_round = None
        for _ in range(MAX_ROUNDS):
            obs = game.wait_for_phase("PREP", timeout=600)
            if obs["round"] == last_round:
                continue
            last_round = obs["round"]

            print(f"round {last_round}  funds={obs['me']['funds']}  lp={obs['me']['lp']}  deploy={obs['me']['deploy']}")
            decide(game, obs)

            # Wait out the combat so the next PREP is the next round.
            game.wait_until(lambda o: o["phase"] != "PREP", timeout=600)

            if not game.observe()["me"]["alive"]:
                print("eliminated — leaving")
                game.leave_match()
                break
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
