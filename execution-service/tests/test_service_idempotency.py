import asyncio
import unittest

from errors import ServiceError
from service import ExecutionService, RequestContext
from store import request_hash


class MemoryRequests:
    def __init__(self) -> None:
        self.items = {}
        self.profile = {
            "walletAddress": "0x" + "11" * 20,
            "keyStatus": "ACTIVE",
            "accountIndex": 42,
            "apiKeyIndex": 4,
        }
        self.released = []

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

    def update_request(
        self,
        subject_hash,
        request_id,
        status,
        *,
        response=None,
        error_code=None,
        reconciliation=None,
        clear_reconciliation=False,
    ):
        item = self.items[(subject_hash, request_id.lower())]
        item["status"] = status
        if response is not None:
            item["response"] = response
        if error_code is not None:
            item["errorCode"] = error_code
        if reconciliation is not None:
            item["reconciliation"] = reconciliation
        if clear_reconciliation:
            item.pop("reconciliation", None)
        return item

    def get_request(self, subject_hash, request_id):
        return self.items.get((subject_hash, request_id.lower()))

    def list_requests(self, subject_hash, *, limit=50):
        return [
            item
            for (stored_subject, _), item in self.items.items()
            if stored_subject == subject_hash
        ][:limit]

    def get_profile(self, subject_hash):
        return self.profile

    def release_nonce_lease(self, account_index, api_key_index, owner):
        self.released.append((account_index, api_key_index, owner))


class ReconciliationGateway:
    async def transaction(self, tx_hash):
        return {
            "hash": tx_hash,
            "account_index": 42,
            "api_key_index": 4,
            "nonce": 9,
        }

    async def next_nonce(self, account_index, api_key_index):
        return 10


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

    def test_unknown_request_is_reconciled_and_nonce_lane_is_released(self) -> None:
        repository = MemoryRequests()
        request_id = "request-abcd"
        repository.items[("user-hash", request_id)] = {
            "requestId": request_id,
            "operation": "order",
            "status": "UNKNOWN",
            "response": {
                "requestId": request_id,
                "operation": "order",
                "status": "UNKNOWN",
                "errorCode": "VENUE_OUTCOME_UNKNOWN",
            },
            "reconciliation": {
                "accountIndex": 42,
                "apiKeyIndex": 4,
                "attemptedNonce": 9,
                "stage": "ORDER",
                "signedTxHash": "signed-hash",
                "ambiguousAt": 0,
            },
        }
        service = ExecutionService(None, repository, ReconciliationGateway())
        context = RequestContext("user-hash", "0x" + "11" * 20)

        asyncio.run(service._reconcile_unknown_requests(context))

        item = repository.items[("user-hash", request_id)]
        self.assertEqual(item["status"], "SUBMITTED")
        self.assertEqual(item["response"]["venueTxHash"], "signed-hash")
        self.assertNotIn("reconciliation", item)
        self.assertEqual(repository.released, [(42, 4, "request:request-abcd")])

    def test_idempotent_retry_reconciles_unknown_before_returning(self) -> None:
        repository = MemoryRequests()
        request_id = "request-abcd"
        payload = {"marketSymbol": "BTC", "side": "LONG"}
        repository.items[("user-hash", request_id)] = {
            "requestId": request_id,
            "operation": "order",
            "bodyHash": request_hash("order", payload),
            "status": "UNKNOWN",
            "response": {
                "requestId": request_id,
                "operation": "order",
                "status": "UNKNOWN",
            },
            "reconciliation": {
                "accountIndex": 42,
                "apiKeyIndex": 4,
                "attemptedNonce": 9,
                "stage": "ORDER",
                "signedTxHash": "signed-hash",
                "ambiguousAt": 0,
            },
        }
        service = ExecutionService(None, repository, ReconciliationGateway())
        context = RequestContext(
            "user-hash",
            "0x" + "11" * 20,
            request_id,
        )
        calls = {"work": 0}

        async def work():
            calls["work"] += 1
            return "SUBMITTED", {}

        replay = asyncio.run(
            service._idempotent(
                context,
                "order",
                payload,
                work,
            )
        )

        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.body["status"], "SUBMITTED")
        self.assertEqual(replay.body["venueTxHash"], "signed-hash")
        self.assertEqual(calls["work"], 0)


if __name__ == "__main__":
    unittest.main()
