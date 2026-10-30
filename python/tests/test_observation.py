"""Observation projections must retain enough information for SDK placement helpers."""
import unittest

from stronghold_agent.agent import Agent


class TestCompactPlacement(unittest.TestCase):
    def test_catalog_keeps_ranged_placement_and_occupied_tile_filtering(self):
        game = Agent(None)
        obs = {
            "catalog": {"chess:chess_a": {"pos": "RANGED"}},
            "field": {"deploy_melee": [[9, 7]], "deploy_ranged_only": [[10, 8]]},
            "board_tiles": {"9,7": 5},
        }
        piece = {"kind": "chess", "id": "chess_a", "uid": 8}
        self.assertEqual(game.tiles_for(piece, obs), [[10, 8]])
        self.assertEqual(game.tiles_for({**piece, "pos": "MELEE"}, obs), [])


if __name__ == "__main__":
    unittest.main()
