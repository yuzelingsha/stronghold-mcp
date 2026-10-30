"""Tests for the action shorthand and the game-level error merge."""
from __future__ import annotations

import unittest

from stronghold_agent.actions import expand, run_actions


class FakeDriver:
    """Records calls and replays a canned reply per protocol action (``g.buy``, ``g.move``, …)."""

    def __init__(self, replies=None):
        self.replies = replies or {}
        self.calls = []

    def tool(self, name, args=None, timeout_ms=None):
        self.calls.append((name, args))
        reply = self.replies.get((args or {}).get("type"), {"ok": True, "reply": {"t": "ok"}})
        if isinstance(reply, Exception):
            raise reply
        return reply


class TestExpand(unittest.TestCase):
    def test_simple_shorthands(self):
        self.assertEqual(expand({"buy": 0}), ("g.buy", {"slot": 0}))
        self.assertEqual(expand({"sell": 12}), ("g.sell", {"uid": 12}))
        self.assertEqual(expand({"refresh": 1}), ("g.refresh", {}))
        self.assertEqual(expand({"level": 1}), ("g.levelUp", {}))
        self.assertEqual(expand({"ready": True}), ("g.ready", {"ready": True}))
        self.assertEqual(expand({"reward": 2}), ("g.reward", {"idx": 2}))
        self.assertEqual(expand({"band": "band_x"}), ("g.band", {"bandId": "band_x"}))

    def test_place_carries_the_tile_and_optional_direction(self):
        action = {"place": {"uid": 12, "row": 9, "col": 5}}
        self.assertEqual(expand(action), ("g.move", {"uid": 12, "to": {"area": "board", "row": 9, "col": 5}}))
        with_dir = {"place": {"uid": 12, "row": 9, "col": 5, "dir": "RIGHT"}}
        self.assertEqual(expand(with_dir)[1]["dir"], "RIGHT")

    def test_equip_and_replace(self):
        self.assertEqual(expand({"equip": {"item": 7, "target": 12}}), ("g.equip", {"itemUid": 7, "targetUid": 12}))
        with_replace = expand({"equip": {"item": 7, "target": 12, "replace": 3}})
        self.assertEqual(with_replace[1]["replaceUid"], 3)

    def test_raw_protocol_passes_through(self):
        self.assertEqual(expand({"t": "g.offer", "f": {"idx": 0}}), ("g.offer", {"idx": 0}))
        self.assertEqual(expand({"t": "g.leave"}), ("g.leave", {}))

    def test_unknown_action_is_rejected(self):
        with self.assertRaises(ValueError):
            expand({"nonsense": 1})


class TestRunActions(unittest.TestCase):
    def test_reports_one_record_per_action(self):
        driver = FakeDriver()
        records = run_actions(driver, [{"buy": 0}, {"sell": 3}])
        self.assertEqual(len(records), 2)
        self.assertTrue(all(r["ok"] for r in records))
        self.assertEqual([c[0] for c in driver.calls], ["stronghold_action", "stronghold_action"])
        self.assertEqual([c[1]["type"] for c in driver.calls], ["g.buy", "g.sell"])

    def test_a_game_error_frame_fails_the_record(self):
        driver = FakeDriver({"g.buy": {"ok": True, "reply": {"t": "error", "code": "NO_FUNDS", "msg": "资金不足"}}})
        record = run_actions(driver, [{"buy": 0}])[0]
        self.assertFalse(record["ok"], "a game-level rejection must not read as success")
        self.assertEqual(record["error"], "NO_FUNDS: 资金不足")

    def test_a_tool_level_failure_fails_the_record(self):
        driver = FakeDriver({"g.buy": {"ok": False, "error": "boom"}})
        record = run_actions(driver, [{"buy": 0}])[0]
        self.assertFalse(record["ok"])
        self.assertEqual(record["error"], "boom")

    def test_a_transport_failure_fails_only_that_record(self):
        driver = FakeDriver({"g.buy": RuntimeError("socket closed")})
        records = run_actions(driver, [{"buy": 0}, {"sell": 3}])
        self.assertFalse(records[0]["ok"])
        self.assertIn("socket closed", records[0]["error"])
        self.assertTrue(records[1]["ok"], "the batch must continue after a failure")

    def test_an_unknown_action_is_reported_without_calling_the_driver(self):
        driver = FakeDriver()
        records = run_actions(driver, [{"nonsense": 1}])
        self.assertFalse(records[0]["ok"])
        self.assertEqual(driver.calls, [])

    def test_extra_fields_on_a_non_ok_reply_are_surfaced(self):
        # A plain `ok` is just an acknowledgement and carries nothing to report; any other frame type
        # in its place is kept, minus the type itself.
        driver = FakeDriver({"g.move": {"ok": True, "reply": {"t": "unitStats", "tile": "bad"}}})
        record = run_actions(driver, [{"hand": 5}])[0]
        self.assertTrue(record["ok"])
        self.assertEqual(record["reply"], {"tile": "bad"})

    def test_a_plain_ok_reply_is_not_reported_as_a_payload(self):
        driver = FakeDriver({"g.move": {"ok": True, "reply": {"t": "ok"}}})
        record = run_actions(driver, [{"hand": 5}])[0]
        self.assertTrue(record["ok"])
        self.assertNotIn("reply", record)


if __name__ == "__main__":
    unittest.main()
