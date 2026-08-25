import asyncio
import unittest
from types import SimpleNamespace

from service import ExecutionService, RequestContext


class RecoveryRepository:
    def __init__(self, *, signer_pending=True):
        self.profile = None
        self.secret = {
            "state": "PENDING" if signer_pending else "ACTIVE",
            "challengeId": "ab" * 16,
            "accountIndex": 123,
            "apiKeyIndex": 4,
            "privateKey": "private-key",
            "publicKey": "public-key",
        }
        self.challenge = {
            "challengeId": "ab" * 16,
            "kind": "CHANGE_API_KEY",
            "state": "PENDING",
            "walletAddress": "0x" + "11" * 20,
            "accountIndex": 123,
            "apiKeyIndex": 4,
            "leaseOwner": "key-enrollment:test",
        }
        self.released = False

    def get_profile(self, subject_hash):
        return dict(self.profile) if self.profile else None

    def get_secret(self, subject_hash):
        return dict(self.secret)

    def get_challenge(self, subject_hash, challenge_id):
        if challenge_id != self.challenge["challengeId"]:
            return None
        return dict(self.challenge)

    def create_profile(self, subject_hash, profile, *, maximum):
        if self.profile is not None:
            raise AssertionError("profile already exists")
        self.profile = dict(profile)

    def put_secret(self, subject_hash, value):
        self.secret = dict(value)

    def consume_challenge(self, subject_hash, challenge_id):
        self.challenge["state"] = "CONSUMED"

    def release_user_lease(self, subject_hash, purpose, owner):
        self.released = True

    def update_profile(self, subject_hash, fields):
        self.profile.update(fields)
        return dict(self.profile)


class RecoveryGateway:
    def __init__(self, active):
        self.active = active
        self.checks = 0

    async def check_signer(self, account_index, api_key_index, private_key):
        self.checks += 1
        return self.active


class EnrollmentRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.context = RequestContext("user-hash", "0x" + "11" * 20)
        self.settings = SimpleNamespace(max_enrolled_users=1)

    def test_pending_key_is_finalized_when_lighter_confirms_it_active(self):
        repo = RecoveryRepository()
        gateway = RecoveryGateway(True)
        service = ExecutionService(self.settings, repo, gateway)

        profile = asyncio.run(service._reconcile_pending_key_enrollment(self.context))

        self.assertIsNotNone(profile)
        self.assertEqual(profile["keyStatus"], "ACTIVE")
        self.assertEqual(profile["accountIndex"], 123)
        self.assertEqual(repo.secret["state"], "ACTIVE")
        self.assertEqual(repo.challenge["state"], "CONSUMED")
        self.assertTrue(repo.released)
        self.assertEqual(gateway.checks, 1)

    def test_pending_key_is_not_finalized_until_lighter_confirms_it(self):
        repo = RecoveryRepository()
        gateway = RecoveryGateway(False)
        service = ExecutionService(self.settings, repo, gateway)

        profile = asyncio.run(service._reconcile_pending_key_enrollment(self.context))

        self.assertIsNone(profile)
        self.assertIsNone(repo.profile)
        self.assertEqual(repo.secret["state"], "PENDING")
        self.assertEqual(repo.challenge["state"], "PENDING")
        self.assertFalse(repo.released)
        self.assertEqual(gateway.checks, 1)


if __name__ == "__main__":
    unittest.main()
