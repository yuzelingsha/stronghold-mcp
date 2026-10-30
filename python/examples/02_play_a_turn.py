#!/usr/bin/env python3
"""02 — play one prep phase.

A complete, deliberately simple turn: wait for prep, spend the funds on the shop, put what we bought
on the board, then Ready. The *policy* here is trivial on purpose — the point is the loop shape an
agent plugs its own decisions into.

    python examples/02_play_a_turn.py
"""
from __future__ import annotations

from stronghold_agent import Agent, ActionError


def main() -> int:
    with Agent.connect(name="Player") as game:
        obs = game.wait_for_phase("PREP", timeout=300)
        print(f"round {obs['round']}  funds={obs['me']['funds']}  deploy={obs['me']['deploy']}")

        # ---- 1. buy whatever we can afford, cheapest first -------------------
        affordable = sorted(
            (s for s in obs["shop"] if not s.get("empty") and not s.get("sold") and s.get("price") is not None),
            key=lambda s: s["price"],
        )
        for slot in affordable:
            if not game.can_afford(obs, slot["price"]):
                break
            try:
                game.buy(slot["slot"])
                print(f"  bought {slot.get('name')} for {slot['price']}G")
            except ActionError as exc:
                print(f"  buy {slot['slot']} rejected: {exc}")
                break

        # ---- 2. deploy whatever is sitting in hand ---------------------------
        obs = game.observe()
        for piece in list(obs["hand"]):
            tiles = game.tiles_for(piece, obs)
            if not tiles:
                print(f"  no free tile for {piece.get('name')}")
                continue
            row, col = tiles[0]
            try:
                game.place(piece["uid"], row, col, direction="RIGHT")
                print(f"  placed {piece.get('name')} at {row},{col}")
            except ActionError as exc:
                print(f"  place at {row},{col} rejected: {exc}")
                continue
            obs = game.observe()

        # ---- 3. Ready --------------------------------------------------------
        # Ready is refused while the temp bench is not empty or a personal choice is open.
        obs = game.observe()
        if not obs["me"]["can_ready"]:
            print(f"  cannot ready yet (temp={len(obs['temp'])}, choice={bool(obs['personal_choice'])})")
            return 0
        game.ready()
        print("  ready")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
