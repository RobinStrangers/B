from decimal import Decimal
import unittest

from lighter_gateway import LighterGateway, VenueMarket


class GatewayMathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.market = VenueMarket(
            symbol="BTC",
            market_index=1,
            mark_price=Decimal("100.00"),
            size_decimals=3,
            price_decimals=2,
            min_base_amount=Decimal("0.001"),
            min_quote_amount=Decimal("1"),
            force_reduce_only=False,
            venue_max_leverage=20,
        )

    def test_limit_tick_rounding_never_makes_limit_more_aggressive(self) -> None:
        buy_ticks = self.market.price_ticks(
            Decimal("100.001"), is_ask=False, market_protection=False
        )
        sell_ticks = self.market.price_ticks(
            Decimal("100.001"), is_ask=True, market_protection=False
        )
        self.assertEqual(buy_ticks, 10_000)
        self.assertEqual(sell_ticks, 10_001)

    def test_market_slippage_price_protects_correct_side(self) -> None:
        self.assertEqual(
            self.market.price_ticks(Decimal("100.001"), is_ask=True, market_protection=True),
            10_001,
        )
        self.assertEqual(
            self.market.price_ticks(Decimal("100.001"), is_ask=False, market_protection=True),
            10_000,
        )
        base, buy_price, actual = LighterGateway.order_amounts(
            self.market,
            notional_usd=Decimal("100"),
            is_ask=False,
            order_type="MARKET",
            limit_price=None,
            slippage_percent=Decimal("0.5"),
        )
        self.assertEqual(base, 1000)
        self.assertEqual(actual, Decimal("1"))
        self.assertEqual(buy_price, 10_050)


if __name__ == "__main__":
    unittest.main()
