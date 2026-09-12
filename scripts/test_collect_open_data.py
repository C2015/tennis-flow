import unittest

from scripts.collect_open_data import tournament_surface


class TournamentSurfaceTest(unittest.TestCase):
    def test_current_verified_tournaments(self):
        cases = {
            "189-2026": "硬地",
            "998-2026": "红土",
            "1076-2026": "红土",
            "964-2026": "硬地",
            "887-2026": "硬地",
            "1005-2026": "硬地",
        }
        for event_id, expected in cases.items():
            with self.subTest(event_id=event_id):
                self.assertEqual(tournament_surface({"id": event_id, "name": "Changed sponsor name"}), expected)

    def test_grand_slam_name_fallbacks(self):
        self.assertEqual(tournament_surface({"name": "Australian Open"}), "硬地")
        self.assertEqual(tournament_surface({"name": "Roland Garros"}), "红土")
        self.assertEqual(tournament_surface({"name": "Wimbledon"}), "草地")
        self.assertEqual(tournament_surface({"name": "US Open"}), "硬地")

    def test_unknown_event_is_not_guessed(self):
        self.assertIsNone(tournament_surface({"id": "new-2027", "name": "New Tennis Event"}))


if __name__ == "__main__":
    unittest.main()
