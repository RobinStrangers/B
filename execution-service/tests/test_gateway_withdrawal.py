import asyncio
from decimal import Decimal
import unittest

from errors import VenueAmbiguous
from lighter_gateway import LighterGateway, VenueAsset


class Response:
    def __init__(self, tx_hash="venue-hash") -> None:
        self.code = 200
        self.message = "accepted"
        self.tx_hash = tx_hash
        self.predicted_execution_time_ms = 0

    def to_dict(self):
        return {
            "code": self.code,
            "message": self.message,
            "tx_hash": self.tx_hash,
            "predicted_execution_time_ms": self.predicted_execution_time_ms,
        }


class FakeClient:
    ROUTE_PERP = 0

    def __init__(self, *, fail_send=False) -> None:
        self.fail_send = fail_send
        self.signed = None

    def sign_withdraw(self, asset_id, route, amount, *, nonce, api_key_index):
        self.signed = (asset_id, route, amount, nonce, api_key_index)
        return 8, '{"Amount":1250000}', "signed-hash", None

    async def send_tx(self, *, tx_type, tx_info):
        if self.fail_send:
            raise TimeoutError("venue timeout")
        return Response()


class GatewayWithdrawalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = LighterGateway()
        self.asset = VenueAsset("USDG", 3, 6, Decimal("1"))

    def test_asset_precision_is_exact(self) -> None:
        self.assertEqual(self.asset.amount_units(Decimal("1.25")), 1_250_000)
        with self.assertRaisesRegex(Exception, "at most 6 decimals"):
            self.asset.amount_units(Decimal("1.0000001"))

    def test_withdrawal_signs_integer_units_and_perp_route(self) -> None:
        client = FakeClient()
        submission = asyncio.run(
            self.gateway.withdraw(client, self.asset, Decimal("1.25"), 7, 4)
        )
        self.assertEqual(client.signed, (3, 0, 1_250_000, 7, 4))
        self.assertEqual(submission.tx_hash, "venue-hash")

    def test_ambiguous_send_retains_the_signed_transaction_hash(self) -> None:
        client = FakeClient(fail_send=True)
        with self.assertRaises(VenueAmbiguous) as raised:
            asyncio.run(self.gateway.withdraw(client, self.asset, Decimal("1.25"), 7, 4))
        self.assertEqual(raised.exception.signed_tx_hash, "signed-hash")


if __name__ == "__main__":
    unittest.main()
