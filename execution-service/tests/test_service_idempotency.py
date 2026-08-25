import asyncio
import unittest

from errors import ServiceError
from service import ExecutionService, RequestContext


class MemoryRequests:
    def __init__(self) -> None:
        self.items = {}

    def begin_request(self, subject_hash, request_id, operation, body_hash):
        key = (subject_hash, request_id.lower())
        existing = self.items.get(key)
        if existing is not None:
            if existing["bodyHash"] != body_hash:
                raise ServiceError("IDEMPOTENCY_CONFLICT", "conflict", http_status=409)
            return False, existing
        item = {
            "requestId": request_id.lower(),
            "operation": operation,
            "bodyHash": body_hash,
            "status": "PENDING",
        }
        self.items[key] = item
        return True, item

    def update_request(self, subject_hash, request_id, status, *, response=None, error_code=None):
        item = self.items[(subject_hash, request_id.lower())]
        item["status"] = status
        if response is not None:
            item["response"] = response
        if error_code is not None:
            item["errorCode"] = error_code
        return item


class ServiceIdempotencyTests(unittest.TestCase):
    def test_replay_skips_expired_or_changed_authorization(self) -> None:
        repository = MemoryRequests()
        service = ExecutionService(None, repository, None)
        context = RequestContext("user-hash", "0x" + "11" * 20, "Request-Abcd")
        payload = {"marketSymbol": "BTC", "side": "LONG"}
        calls = {"preflight": 0, "work": 0}

        def first_preflight():
            calls["preflight"] += 1

        async def work():
            calls["work"] += 1
            return "SUBMITTED", {"venueTxHash": "abc"}

        first = asyncio.run(
            service._idempotent(
                context,
                "order",
                {**payload, "authorization": {"signature": "first"}},
                work,
                hash_body=payload,
                preflight=first_preflight,
            )
        )
        self.assertEqual(first.body["status"], "SUBMITTED")

        def replay_preflight():
            raise AssertionError("A replay must not revalidate an expired authorization")

        replay = asyncio.run(
            service._idempotent(
                context,
                "order",
                {**payload, "authorization": {"signature": "changed-and-expired"}},
                work,
                hash_body=payload,
                preflight=replay_preflight,
            )
        )
        self.assertEqual(replay.body["venueTxHash"], "abc")
        self.assertEqual(calls, {"preflight": 1, "work": 1})

    def test_same_key_with_different_economic_payload_conflicts(self) -> None:
        repository = MemoryRequests()
        service = ExecutionService(None, repository, None)
        context = RequestContext("user-hash", "0x" + "11" * 20, "Request-Abcd")

        async def work():
            return "SUBMITTED", {}

        asyncio.run(
            service._idempotent(
                context,
                "order",
                {},
                work,
                hash_body={"marketSymbol": "BTC"},
            )
        )
        with self.assertRaisesRegex(ServiceError, "conflict"):
            asyncio.run(
                service._idempotent(
                    context,
                    "order",
                    {},
                    work,
                    hash_body={"marketSymbol": "ETH"},
                )
            )


if __name__ == "__main__":
    unittest.main()

