import unittest

from authorization import authorization_message, canonical_payload, verify_execution_authorization
from errors import ServiceError
from lighter_gateway import lighter_message_encoding


class AuthorizationTests(unittest.TestCase):
    def test_exact_message_and_recursive_canonical_payload(self) -> None:
        payload = {"side": "LONG", "nested": {"z": 2, "a": 1}, "marketSymbol": "BTC"}
        message = authorization_message("order", "REQ-ABC-1234", 1000, 31000, payload)
        self.assertEqual(
            message,
            "Aventa Execution Authorization\n"
            "Version: 1\n"
            "Audience: aventa-execution-v1\n"
            "Venue: Robinhood Lighter\n"
            "Execution Chain ID: 466324\n"
            "Fee Policy: 2026-08-24/17-bps\n"
            "Chain ID: 4663\n"
            "Action: order\n"
            "Request ID: req-abc-1234\n"
            "Issued At: 1000\n"
            "Expires At: 31000\n"
            'Payload: {"marketSymbol":"BTC","nested":{"a":1,"z":2},"side":"LONG"}',
        )
        self.assertEqual(canonical_payload(payload), '{"marketSymbol":"BTC","nested":{"a":1,"z":2},"side":"LONG"}')

    def test_expired_authorization_fails_before_recovery(self) -> None:
        body = {
            "marketSymbol": "BTC",
            "authorization": {
                "walletAddress": "0x1111111111111111111111111111111111111111",
                "issuedAt": 1_000,
                "expiresAt": 31_000,
                "signature": "0x" + "11" * 65,
            },
        }
        with self.assertRaisesRegex(ServiceError, "expired"):
            verify_execution_authorization(
                body,
                action="order",
                request_id="request-1234",
                expected_wallet="0x1111111111111111111111111111111111111111",
                now_ms=100_000,
            )

    def test_lighter_message_encoding_preserves_provider_interoperability(self) -> None:
        self.assertEqual(lighter_message_encoding("0x0102ff"), "utf8")
        self.assertEqual(lighter_message_encoding("Approve Aventa"), "utf8")
        with self.assertRaises(ServiceError):
            lighter_message_encoding("invalid\x00message")


if __name__ == "__main__":
    unittest.main()
