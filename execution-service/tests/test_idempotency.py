import unittest

from store import (
    canonical_json,
    deterministic_client_order_index,
    economic_payload,
    idempotency_decision,
    request_hash,
)


class IdempotencyTests(unittest.TestCase):
    def test_canonical_hash_ignores_object_key_order(self) -> None:
        first = request_hash("order", {"side": "LONG", "nested": {"b": 2, "a": 1}})
        second = request_hash("order", {"nested": {"a": 1, "b": 2}, "side": "LONG"})
        self.assertEqual(first, second)
        self.assertEqual(canonical_json({"b": 2, "a": {"d": 4, "c": 3}}), '{"a":{"c":3,"d":4},"b":2}')

    def test_same_hash_replays_and_different_hash_conflicts(self) -> None:
        existing = {"bodyHash": "abc", "status": "SUBMITTED"}
        self.assertEqual(idempotency_decision(existing, "abc"), "replay")
        self.assertEqual(idempotency_decision(existing, "def"), "conflict")
        self.assertEqual(idempotency_decision(None, "abc"), "create")

    def test_ephemeral_authorization_is_excluded_from_economic_hash(self) -> None:
        first = {
            "marketSymbol": "BTC",
            "collateralUsd": "100",
            "authorization": {"issuedAt": 1, "expiresAt": 2, "signature": "0x01"},
        }
        second = {
            "marketSymbol": "BTC",
            "collateralUsd": "100",
            "authorization": {"issuedAt": 3, "expiresAt": 4, "signature": "0x02"},
        }
        self.assertEqual(
            request_hash("order", economic_payload(first)),
            request_hash("order", economic_payload(second)),
        )

    def test_client_order_id_is_stable_positive_uint48(self) -> None:
        first = deterministic_client_order_index("Req-AbCd-1234")
        second = deterministic_client_order_index("req-abcd-1234")
        self.assertEqual(first, second)
        self.assertGreaterEqual(first, 0)
        self.assertLess(first, 2**48)


if __name__ == "__main__":
    unittest.main()
