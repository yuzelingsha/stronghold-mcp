"""Action shorthand: the small vocabulary an agent writes, and the protocol it expands to.

The game protocol is precise but verbose. An agent thinking about a turn wants to say "buy slot 0",
not ``{"t": "g.buy", "f": {"slot": 0}}``. This module is the only translation layer, and it stays
deliberately thin: a shorthand expands to exactly one protocol action, and anything not covered can be
sent verbatim as ``{"t": "...", "f": {...}}``.

Every action the game accepts is listed by ``stronghold_protocol``; the shorthands below are the
convenient subset. Each one is sent through the generic ``stronghold_action`` tool, which the MCP
server exposes in both its full and its compact tool mode.
"""
from __future__ import annotations

import json
from typing import Any, Callable

# One shorthand key -> (protocol action, fields builder).
ALIASES: dict[str, Callable[[Any], tuple[str, dict[str, Any]]]] = {
    "buy": lambda v: ("g.buy", {"slot": v}),
    "sell": lambda v: ("g.sell", {"uid": v}),
    "destroy": lambda v: ("g.destroy", {"uid": v}),
    "refresh": lambda v: ("g.refresh", {}),
    "freeze": lambda v: ("g.freeze", {}),
    "level": lambda v: ("g.levelUp", {}),
    "reward": lambda v: ("g.reward", {"idx": v}),
    "choice": lambda v: ("g.choice", {"idx": v}),
    "ready": lambda v: ("g.ready", {"ready": bool(v)}),
    "band": lambda v: ("g.band", {"bandId": v}),
    "bandSkip": lambda v: ("g.bandSkip", {}),
    "bandFocus": lambda v: ("g.bandFocus", {"bandId": v}),
    "infoReady": lambda v: ("g.infoReady", {}),
    "emote": lambda v: ("g.emote", {"id": v}),
    "pause": lambda v: ("g.pause", {"on": bool(v)}),
    "autoplay": lambda v: ("g.autoplay", {"on": bool(v)}),
    "watch": lambda v: ("g.watch", {"fieldId": v}),
    "leave": lambda _v: ("g.leave", {}),
    "hand": lambda v: (
        "g.move",
        {
            "uid": v["uid"] if isinstance(v, dict) else v,
            "to": {"area": "hand", "idx": (v.get("idx", 0) if isinstance(v, dict) else 0)},
        },
    ),
    "temp": lambda v: ("g.move", {"uid": v, "to": {"area": "temp"}}),
    "rotate": lambda v: ("g.move", {"uid": v["uid"], "to": {"area": v.get("area", "board")}, "dir": v["dir"]}),
    "unequip": lambda v: ("g.unequip", {"itemUid": v}),
}


def expand(action: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """One shorthand entry -> ``(protocol action, fields)``.

    A raw ``{"t": ..., "f": ...}`` pair passes straight through, so no shorthand is ever a limitation.
    """
    if "t" in action:
        return action["t"], dict(action.get("f") or {})

    if "place" in action:
        p = action["place"]
        fields: dict[str, Any] = {"uid": p["uid"], "to": {"area": "board", "row": p["row"], "col": p["col"]}}
        if p.get("dir"):
            fields["dir"] = p["dir"]
        return "g.move", fields

    if "equip" in action:
        e = action["equip"]
        fields = {"itemUid": e["item"], "targetUid": e["target"]}
        if e.get("replace") is not None:
            fields["replaceUid"] = e["replace"]
        return "g.equip", fields

    if "art" in action:
        a = action["art"]
        fields = {"itemUid": a["item"], "row": a["row"], "col": a["col"]}
        if a.get("dir"):
            fields["dir"] = a["dir"]
        return "g.art", fields

    for key, build in ALIASES.items():
        if key in action:
            return build(action[key])

    raise ValueError(f"unknown action: {json.dumps(action, ensure_ascii=False)}")


def run_actions(driver: Any, actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Execute a list of shorthands, in order, and report each one.

    A failure never aborts the batch: the caller gets one record per action and decides what to do.
    MCP success is NOT game success — the game's own verdict is folded into ``ok`` here, so an agent
    can trust the flag instead of re-reading the protocol.
    """
    out: list[dict[str, Any]] = []
    for action in actions:
        try:
            act, fields = expand(action)
        except ValueError as exc:
            out.append({"in": action, "ok": False, "error": str(exc)})
            continue

        try:
            content = driver.tool("stronghold_action", {"type": act, "fields": fields})
        except Exception as exc:  # noqa: BLE001 - transport and tool failures share one report
            out.append({"in": action, "act": act, "ok": False, "error": str(exc)})
            continue

        record: dict[str, Any] = {"in": action, "act": act, "ok": True}
        if isinstance(content, dict) and content.get("ok") is False:
            record["ok"] = False
            record["error"] = content.get("error")

        reply = (content or {}).get("reply") if isinstance(content, dict) else None
        if isinstance(reply, dict):
            if reply.get("t") == "error":
                record["ok"] = False
                record["error"] = f"{reply.get('code')}: {reply.get('msg')}"
            elif reply.get("t") not in (None, "ok"):
                record["reply"] = {k: v for k, v in reply.items() if k != "t"}
        out.append(record)
    return out
