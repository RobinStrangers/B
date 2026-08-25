import asyncio
import unittest

from config import TREASURY_ACCOUNT_INDEX, TREASURY_ADDRESS
from errors import ServiceError
from lighter_gateway import LighterGateway


class _FakeClient:
    async def close(self):
        return None


class _FakeAccountApi:
    def __init__(self, _client, rows):
        self.rows = rows

    async def accounts_by_l1_address(self, *, l1_address, _request_timeout):
        return {"sub_accounts": self.rows}


class _FakeLighter:
    def __init__(self, rows):
        self.rows = rows

    def AccountApi(self, client):
        return _FakeAccountApi(client, self.rows)


class GatewayAccountTests(unittest.TestCase):
    def test_treasury_wallet_is_rejected_before_venue_lookup(self):
        gateway = LighterGateway()
        with self.assertRaises(ServiceError) as raised:
            asyncio.run(gateway.accounts_for_wallet(TREASURY_ADDRESS))
        self.assertEqual(raised.exception.code, "TREASURY_ACCOUNT_FORBIDDEN")
        self.assertEqual(raised.exception.http_status, 403)

    def test_treasury_account_index_is_never_returned_as_user_account(self):
        wallet = "0x" + "11" * 20
        rows = [
            {"index": TREASURY_ACCOUNT_INDEX, "l1_address": wallet},
            {"index": 43210, "l1_address": wallet},
        ]
        gateway = LighterGateway()

        async def fake_api_client():
            return _FakeLighter(rows), _FakeClient()

        gateway._api_client = fake_api_client  # type: ignore[method-assign]
        accounts = asyncio.run(gateway.accounts_for_wallet(wallet))
        self.assertEqual([row["index"] for row in accounts], [43210])

    def test_wallet_with_only_treasury_account_is_rejected(self):
        wallet = "0x" + "22" * 20
        rows = [{"index": TREASURY_ACCOUNT_INDEX, "l1_address": wallet}]
        gateway = LighterGateway()

        async def fake_api_client():
            return _FakeLighter(rows), _FakeClient()

        gateway._api_client = fake_api_client  # type: ignore[method-assign]
        with self.assertRaises(ServiceError) as raised:
            asyncio.run(gateway.accounts_for_wallet(wallet))
        self.assertEqual(raised.exception.code, "TREASURY_ACCOUNT_FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
