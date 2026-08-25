from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

from errors import ServiceError
from validators import ETH_ADDRESS_RE, SIGNATURE_RE


AUTHORIZATION_CHAIN_ID = 4663
MAX_AUTHORIZATION_TTL_MS = 30_000
MAX_CLOCK_SKEW_MS = 5_000


@dataclass(frozen=True)
class VerifiedAuthorization:
    wallet_address: str
    issued_at: int
    expires_at: int
    signature: str
    message: str
    payload: dict[str, Any]


def canonical_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def authorization_message(
    action: str,
    request_id: str,
    issued_at: int,
    expires_at: int,
    payload: dict[str, Any],
) -> str:
    return (
        "Aventa Execution Authorization\n"
        "Version: 1\n"
        "Audience: aventa-execution-v1\n"
        "Venue: Robinhood Lighter\n"
        "Execution Chain ID: 466324\n"
        "Fee Policy: 2026-08-24/17-bps\n"
        f"Chain ID: {AUTHORIZATION_CHAIN_ID}\n"
        f"Action: {action}\n"
        f"Request ID: {request_id.lower()}\n"
        f"Issued At: {issued_at}\n"
        f"Expires At: {expires_at}\n"
        f"Payload: {canonical_payload(payload)}"
    )


def _integer_ms(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ServiceError("AUTHORIZATION_INVALID", f"authorization.{field} must be integer milliseconds")
    return value


def verify_execution_authorization(
    body: dict[str, Any],
    *,
    action: str,
    request_id: str,
    expected_wallet: str,
    now_ms: int | None = None,
) -> VerifiedAuthorization:
    raw = body.get("authorization")
    if not isinstance(raw, dict):
        raise ServiceError("AUTHORIZATION_REQUIRED", "A wallet execution authorization is required", http_status=401)
    expected_keys = {"walletAddress", "issuedAt", "expiresAt", "signature"}
    if set(raw) != expected_keys:
        raise ServiceError("AUTHORIZATION_INVALID", "Execution authorization fields are invalid", http_status=401)
    wallet = str(raw.get("walletAddress", "")).strip().lower()
    signature = str(raw.get("signature", "")).strip()
    if not ETH_ADDRESS_RE.fullmatch(wallet) or not SIGNATURE_RE.fullmatch(signature):
        raise ServiceError("AUTHORIZATION_INVALID", "Execution authorization is malformed", http_status=401)
    issued_at = _integer_ms(raw.get("issuedAt"), "issuedAt")
    expires_at = _integer_ms(raw.get("expiresAt"), "expiresAt")
    if expires_at <= issued_at or expires_at - issued_at > MAX_AUTHORIZATION_TTL_MS:
        raise ServiceError(
            "AUTHORIZATION_WINDOW_INVALID",
            "Execution authorization must expire within 30 seconds",
            http_status=401,
        )
    current = int(time.time() * 1000) if now_ms is None else now_ms
    if issued_at > current + MAX_CLOCK_SKEW_MS or expires_at < current - MAX_CLOCK_SKEW_MS:
        raise ServiceError("AUTHORIZATION_EXPIRED", "Execution authorization has expired", http_status=401)
    if issued_at < current - MAX_AUTHORIZATION_TTL_MS - MAX_CLOCK_SKEW_MS:
        raise ServiceError("AUTHORIZATION_EXPIRED", "Execution authorization is too old", http_status=401)
    expected = expected_wallet.strip().lower()
    if wallet != expected:
        raise ServiceError(
            "AUTHORIZATION_WALLET_MISMATCH",
            "Execution authorization wallet does not match the enrolled wallet",
            http_status=403,
        )
    payload = {key: value for key, value in body.items() if key != "authorization"}
    message = authorization_message(action, request_id, issued_at, expires_at, payload)
    try:
        from eth_account import Account
        from eth_account.messages import encode_defunct

        recovered = Account.recover_message(encode_defunct(text=message), signature=signature)
    except Exception as exc:
        raise ServiceError("AUTHORIZATION_SIGNATURE_INVALID", "Wallet signature is invalid", http_status=401) from exc
    if recovered.lower() != expected:
        raise ServiceError(
            "AUTHORIZATION_SIGNATURE_INVALID",
            "Wallet signature does not match the enrolled wallet",
            http_status=403,
        )
    return VerifiedAuthorization(wallet, issued_at, expires_at, signature, message, payload)
