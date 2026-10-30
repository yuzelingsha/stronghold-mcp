#!/usr/bin/env python3
"""01 — connect and observe.

The smallest useful thing: open a seat, print one decision-ready snapshot, close.

    python examples/01_observe.py
"""
from __future__ import annotations

import json

from stronghold_agent import Agent


def main() -> int:
    with Agent.connect(name="Observer") as game:
        obs = game.observe()

        print(json.dumps(obs, ensure_ascii=False, indent=1))
        print()

        # The few fields a decision usually starts from.
        me = obs["me"]
        print(f"phase={obs['phase']}  round={obs['round']}  in={obs['seconds_left']}s")
        print(f"funds={me['funds']}  level={me['level']}/{me['max_level']}  deploy={me['deploy']}  ready={me['ready']}")
        active = [f"{b['bond']} x{b['count']} (L{b['layers']})" for b in obs["bonds"] if b["active"]]
        print("active bonds:", ", ".join(active) or "none")
        print("shop:", ", ".join(
            f"[{s['slot']}] {s.get('name')} {s.get('price')}G" for s in obs["shop"] if not s.get("empty")
        ) or "empty")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
