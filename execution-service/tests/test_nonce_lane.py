import unittest

from service import nonce_lane_readiness
from store import DynamoRepository


class RecordingTable:
    def __init__(self) -> None:
        self.last_update = None

    def update_item(self, **kwargs):
        self.last_update = kwargs
        return {}


class NonceLaneTests(unittest.TestCase):
    def test_active_quarantine_blocks_lane(self) -> None:
        ready, state = nonce_lane_readiness(
            {"quarantined": True, "lockExpiresAt": 20_000},
            now_ms=10_000,
        )
        self.assertFalse(ready)
        self.assertEqual(state, "QUARANTINED")

    def test_expired_quarantine_is_ready_again(self) -> None:
        ready, state = nonce_lane_readiness(
            {"quarantined": True, "lockExpiresAt": 9_999},
            now_ms=10_000,
        )
        self.assertTrue(ready)
        self.assertEqual(state, "READY")

    def test_acquire_allows_expired_quarantine_and_clears_flag(self) -> None:
        repo = DynamoRepository.__new__(DynamoRepository)
        table = RecordingTable()
        repo._table = table
        repo.acquire_nonce_lease(42, 4, "request:test", lease_seconds=30)
        expression = table.last_update["ConditionExpression"]
        self.assertIn("quarantined = :false OR lockExpiresAt < :now", expression)
        self.assertIn("REMOVE quarantined, quarantineReason", table.last_update["UpdateExpression"])


if __name__ == "__main__":
    unittest.main()
