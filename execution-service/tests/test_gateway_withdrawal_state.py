import asyncio
from decimal import Decimal
import unittest

from lighter_gateway import LighterGateway


class _FakeClient:
    async def close(self):
        return None


class _FakeAccountApi:
    def __init__(self, account):
        self.account_row = account

    async def account(self, *, by, value, active_only, _request_timeout):
        return {"accounts": [self.account_row]}


class _FakeOrderApi:
    def __init__(self, asset_payload):
        self.asset_payload = asset_payload

    async def asset_details(self, *, _request_timeout):
        return self.asset_payload


class _FakeLighter:
    def __init__(self, account, asset_payload):
        self.account_row = account
        self.asset_payload = asset_payload

    def AccountApi(self, _client):
        return _FakeAccountApi(self.account_row)

    def OrderApi(self, _client):
        return _FakeOrderApi(self.asset_payload)


class GatewayWithdrawalStateTests(unittest.TestCase):
    def _gateway(self, *, account=None, asset_payload=None):
        account = account or {
            "index": 43210,
            "available_balance": "1.000000",
            "collateral": "1.000000",
            "pending_order_count": 0,
            "positions": [],
        }
        # Robinhood Lighter currently serializes this collection as
        # `assets_details` on the wire. Keep this fixture exact so a parser
        # regression cannot silently turn a funded account into 0 withdrawable.
        asset_payload = asset_payload or {
            "assets_details": [
                {
                    "asset_id": 3,
                    "symbol": "USDG",
                    "decimals": 6,
                    "min_withdrawal_amount": "1",
                }
            ]
        }
        gateway = LighterGateway()

        async def fake_api_client():
            return _FakeLighter(account, asset_payload), _FakeClient()

        gateway._api_client = fake_api_client  # type: ignore[method-assign]
        return gateway

    def test_withdrawal_asset_accepts_assets_details_wire_key(self):
        asset = asyncio.run(self._gateway().withdrawal_asset("USDG"))
        self.assertEqual(asset.symbol, "USDG")
        self.assertEqual(asset.asset_id, 3)
        self.assertEqual(asset.decimals, 6)
        self.assertEqual(asset.min_withdrawal_amount, Decimal("1"))

    def test_funded_account_balance_is_exposed_for_withdrawal(self):
        state = asyncio.run(self._gateway().withdrawal_state(43210, "USDG"))
        self.assertEqual(state.available_balance, Decimal("1.000000"))
        self.assertFalse(state.has_open_positions)
        self.assertEqual(state.pending_order_count, 0)
        self.assertEqual(state.asset.asset_id, 3)

    def test_unified_account_uses_usdg_asset_balance_when_top_level_available_is_zero(self):
        account = {
            "index": 43210,
            "account_trading_mode": 1,
            "available_balance": "0.000000",
            "collateral": "0.000000",
            "total_asset_value": "1.000000",
            "pending_order_count": 0,
            "positions": [],
            "assets": [
                {
                    "symbol": "USDG",
                    "asset_id": 3,
                    "balance": "1.000000",
                    "locked_balance": "0.000000",
                    "margin_balance": "1.000000",
                }
            ],
        }
        state = asyncio.run(self._gateway(account=account).withdrawal_state(43210, "USDG"))
        self.assertEqual(state.available_balance, Decimal("1.000000"))

    def test_unified_account_excludes_locked_usdg_from_withdrawable_balance(self):
        account = {
            "index": 43210,
            "account_trading_mode": 1,
            "available_balance": "0.000000",
            "pending_order_count": 0,
            "positions": [],
            "assets": [
                {
                    "symbol": "USDG",
                    "asset_id": 3,
                    "balance": "1.000000",
                    "locked_balance": "0.250000",
                }
            ],
        }
        state = asyncio.run(self._gateway(account=account).withdrawal_state(43210, "USDG"))
        self.assertEqual(state.available_balance, Decimal("0.750000"))

    def test_live_top_level_free_collateral_wins_when_asset_row_is_zero(self):
        # Exact regression from the live Robinhood account UI: the perp account
        # reports 1 USDG free collateral while the unified asset row is present
        # but zero. Wallet/withdrawal must match the live perp collateral source.
        account = {
            "index": 43210,
            "available_balance": "1.000000",
            "collateral": "1.000000",
            "total_asset_value": "1.000000",
            "pending_order_count": 0,
            "positions": [],
            "assets": [
                {
                    "symbol": "USDG",
                    "asset_id": 3,
                    "balance": "0.000000",
                    "locked_balance": "0.000000",
                }
            ],
        }
        state = asyncio.run(self._gateway(account=account).withdrawal_state(43210, "USDG"))
        self.assertEqual(state.available_balance, Decimal("1.000000"))

    def test_open_position_still_blocks_exposure_gate(self):
        account = {
            "index": 43210,
            "available_balance": "1.000000",
            "pending_order_count": 0,
            "positions": [{"position": "0.25"}],
        }
        state = asyncio.run(self._gateway(account=account).withdrawal_state(43210, "USDG"))
        self.assertTrue(state.has_open_positions)


if __name__ == "__main__":
    unittest.main()
