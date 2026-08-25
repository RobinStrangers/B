from __future__ import annotations

import os
from dataclasses import dataclass

from errors import ServiceError


EXECUTION_MODES = frozenset({"off", "paper", "canary", "limited_live"})
LIGHTER_API_URL = "https://api.rh.lighter.xyz"
LIGHTER_CHAIN_ID = 466324

# These values are intentionally code constants. They are never taken from a
# request and cannot be silently changed through a deployment environment.
TREASURY_ACCOUNT_INDEX = 17005
TREASURY_ADDRESS = "0xCe8756522C90B405c9647aE6BbcA169240965225"
INTEGRATOR_FEE_UNITS = 1700  # 0.17% in Lighter's 1e6 fee scale.
TRADE_FEE_BPS = 17
FEE_CONSENT_VERSION = "2026-08-24"


def _bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ServiceError("CONFIG_INVALID", f"{name} must be an integer", http_status=503) from exc
    if not minimum <= value <= maximum:
        raise ServiceError(
            "CONFIG_INVALID",
            f"{name} must be between {minimum} and {maximum}",
            http_status=503,
        )
    return value


@dataclass(frozen=True)
class Settings:
    table_name: str
    kms_key_id: str
    execution_mode: str
    allowed_invoker_arn: str
    exit_only_enabled: bool
    opens_enabled: bool
    max_enrolled_users: int
    max_notional_usd: int
    challenge_ttl_seconds: int
    nonce_lease_seconds: int
    nonce_quarantine_seconds: int
    canary_user_hashes: frozenset[str]
    request_retention_seconds: int

    @classmethod
    def from_env(cls) -> "Settings":
        table_name = os.environ.get("TABLE_NAME", "").strip()
        kms_key_id = os.environ.get("KMS_KEY_ID", "").strip()
        mode = os.environ.get("EXECUTION_MODE", "off").strip().lower()
        allowed_invoker = os.environ.get("ALLOWED_INVOKER_ARN", "").strip()
        if not table_name:
            raise ServiceError("CONFIG_INVALID", "TABLE_NAME is required", http_status=503)
        if not kms_key_id:
            raise ServiceError("CONFIG_INVALID", "KMS_KEY_ID is required", http_status=503)
        if mode not in EXECUTION_MODES:
            raise ServiceError("CONFIG_INVALID", "EXECUTION_MODE is invalid", http_status=503)
        canaries = frozenset(
            item.strip().lower()
            for item in os.environ.get("CANARY_USER_HASHES", "").split(",")
            if item.strip()
        )
        return cls(
            table_name=table_name,
            kms_key_id=kms_key_id,
            execution_mode=mode,
            allowed_invoker_arn=allowed_invoker,
            exit_only_enabled=_bool_env("EXIT_ONLY_ENABLED", True),
            opens_enabled=_bool_env("OPENS_ENABLED", False),
            max_enrolled_users=_int_env("MAX_ENROLLED_USERS", 450, 1, 100_000),
            max_notional_usd=_int_env("MAX_NOTIONAL_USD", 25_000, 100, 10_000_000),
            challenge_ttl_seconds=_int_env("CHALLENGE_TTL_SECONDS", 600, 120, 1_800),
            nonce_lease_seconds=_int_env("NONCE_LEASE_SECONDS", 30, 5, 120),
            nonce_quarantine_seconds=_int_env(
                "NONCE_QUARANTINE_SECONDS", 86_400, 300, 604_800
            ),
            canary_user_hashes=canaries,
            request_retention_seconds=_int_env(
                "REQUEST_RETENTION_SECONDS", 31_536_000, 86_400, 31_536_000
            ),
        )
