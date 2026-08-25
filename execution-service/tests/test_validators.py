import unittest

from errors import ServiceError
from validators import parse_cancel, parse_close, parse_order, reject_forbidden_keys


class ValidatorTests(unittest.TestCase):
    def test_valid_crypto_order(self) -> None:
        order = parse_order(
            {
                "marketSymbol": "BTC/USDG",
                "side": "long",
                "orderType": "market",
                "collateralUsd": "100",
                "leverage": 15,
                "slippagePercent": "0.5",
                "consentVersion": "2026-08-24",
            },
            max_notional_usd=25_000,
        )
        self.assertEqual(order.market_symbol, "BTC")
        self.assertEqual(str(order.notional_usd), "1500")

    def test_crypto_cap_is_fifteen(self) -> None:
        with self.assertRaisesRegex(ServiceError, "between 1x and 15x"):
            parse_order(
                {
                    "marketSymbol": "BTC",
                    "side": "LONG",
                    "orderType": "MARKET",
                    "collateralUsd": "100",
                    "leverage": 16,
                    "consentVersion": "2026-08-24",
                },
                max_notional_usd=25_000,
            )

    def test_volatile_share_cap_is_three(self) -> None:
        with self.assertRaises(ServiceError):
            parse_order(
                {
                    "marketSymbol": "TSLA",
                    "side": "LONG",
                    "orderType": "MARKET",
                    "collateralUsd": "100",
                    "leverage": 4,
                    "consentVersion": "2026-08-24",
                },
                max_notional_usd=25_000,
            )

    def test_server_controlled_fields_are_rejected_recursively(self) -> None:
        for body in (
            {"marketIndex": 1},
            {"nested": {"feeBps": 1}},
            {"authorization": {"privateKey": "never"}},
            {"treasuryAddress": "0x0"},
        ):
            with self.subTest(body=body), self.assertRaises(ServiceError):
                reject_forbidden_keys(body)

    def test_cancel_accepts_order_identifier_not_market_index(self) -> None:
        value = parse_cancel({"marketSymbol": "ETH", "orderId": "42"})
        self.assertEqual(value.order_id, 42)

    def test_close_never_accepts_position_size(self) -> None:
        with self.assertRaises(ServiceError):
            parse_close({"marketSymbol": "ETH", "positionSize": "1"})


if __name__ == "__main__":
    unittest.main()
