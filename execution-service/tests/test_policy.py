from decimal import Decimal
import unittest

from policy import enrollment_allowed, exits_allowed, fee_usd, market_policy, open_allowed


class PolicyTests(unittest.TestCase):
    def test_fee_is_seventeen_cents_per_hundred_dollars(self) -> None:
        self.assertEqual(fee_usd(Decimal("100")), Decimal("0.17"))

    def test_crypto_and_share_caps_are_explicit(self) -> None:
        self.assertEqual(market_policy("BTC").max_leverage, 15)
        self.assertEqual(market_policy("AAPL").max_leverage, 5)
        self.assertEqual(market_policy("TSLA").max_leverage, 3)
        self.assertIsNone(market_policy("WTI"))

    def test_canary_is_scoped_to_hash_allowlist(self) -> None:
        allowed = frozenset({"abc"})
        self.assertTrue(
            open_allowed(
                "canary",
                "abc",
                opens_enabled=True,
                canary_user_hashes=allowed,
                enrolled_users=10,
                max_enrolled_users=450,
            )
        )
        self.assertFalse(
            open_allowed(
                "canary",
                "def",
                opens_enabled=True,
                canary_user_hashes=allowed,
                enrolled_users=10,
                max_enrolled_users=450,
            )
        )

    def test_enrollment_stops_at_capacity(self) -> None:
        self.assertFalse(
            enrollment_allowed(
                "limited_live",
                "abc",
                canary_user_hashes=frozenset(),
                enrolled_users=450,
                max_enrolled_users=450,
            )
        )

    def test_exit_gate_is_independent_of_execution_mode(self) -> None:
        self.assertTrue(exits_allowed(exit_only_enabled=True))


if __name__ == "__main__":
    unittest.main()

