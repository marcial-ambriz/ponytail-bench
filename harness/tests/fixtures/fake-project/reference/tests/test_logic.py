import unittest

import logic


class ValidateTest(unittest.TestCase):
    def test_rejects_non_positive_qty(self):
        self.assertIsNotNone(logic.validate_item({"name": "a", "qty": 0}))
        self.assertIsNotNone(logic.validate_item({"name": "a", "qty": -1}))

    def test_accepts_valid(self):
        self.assertIsNone(logic.validate_item({"name": "a", "qty": 3}))
