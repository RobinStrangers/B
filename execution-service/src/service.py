from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Awaitable, Callable

from authorization import verify_execution_authorization
from config import (
    INTEGRATOR_FEE_UNITS,
    TRADE_FEE_BPS,
    TREASURY_ACCOUNT_INDEX,
    TREASURY_ADDRESS,
    Settings,
)
from errors import ServiceError, VenueAmbiguous
from lighter_gateway import LighterGateway, brief_settlement_delay, lighter_message_encoding
from policy import (
    MARKET_POLICIES,
    enrollment_allowed,
    exits_allowed,
    fee_usd,
    market_policy,
    open_allowed,
)
from store import (
    DynamoRepository,
    deterministic_client_order_index,
    economic_payload,
    request_hash,
)
from validators import (
    parse_cancel,
    parse_cancel_all,
    parse_close,
    parse_completion,
    parse_empty,
    parse_key_prepare,
    parse_order,
    parse_withdrawal,
)


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RequestContext:
    subject_hash: str
    wallet_address: str
    request_id: str | None = None


@dataclass(frozen=True)
class ServiceResult:
    status_code: int
    body: dict[str, Any]


Work = Callable[[], Awaitable[tuple[str, dict[str, Any]]]]
Preflight = Callable[[], None]
RECONCILIATION_DELAY_MS = 30_000


class ExecutionService:
    def __init__(self, settings: Settings, repository: DynamoRepository, gateway: LighterGateway) -> None:
        self.settings = settings
        self.repo = repository
        self.gateway = gateway
        self._treasury_verified_at = 0.0
        self._treasury_verified = False

    @staticmethod
    def _integrator_current(profile: dict[str, Any]) -> bool:
        return bool(
            profile.get("integratorApproved")
            and int(profile.get("integratorApprovalExpiry", 0)) > int(time.time() * 1000) + 60_000
        )

    @staticmethod
    def _public_request(item: dict[str, Any]) -> dict[str, Any]:
        response = item.get("response")
        if isinstance(response, dict):
            return response
        return {
            "requestId": item.get("requestId"),
            "operation": item.get("operation"),
            "status": item.get("status", "PENDING"),
            "errorCode": item.get("errorCode"),
            "updatedAt": item.get("updatedAt"),
        }

    async def _idempotent(
        self,
        context: RequestContext,
        operation: str,
        raw_body: dict[str, Any],
        work: Work,
        *,
        hash_body: dict[str, Any] | None = None,
        preflight: Preflight | None = None,
        reconciliation: dict[str, Any] | None = None,
    ) -> ServiceResult:
        if context.request_id is None:
            raise ServiceError("REQUEST_ID_REQUIRED", "Idempotency request id is required")
        created, item = self.repo.begin_request(
            context.subject_hash,
            context.request_id,
            operation,
            request_hash(operation, raw_body if hash_body is None else hash_body),
        )
        if not created:
            status = str(item.get("status", "PENDING"))
            if status == "UNKNOWN":
                try:
                    await self._reconcile_unknown_requests(
                        context,
                        request_id=context.request_id,
                    )
                    refreshed = self.repo.get_request(
                        context.subject_hash,
                        context.request_id,
                    )
                    if refreshed is not None:
                        item = refreshed
                        status = str(item.get("status", "PENDING"))
                except Exception:
                    logger.exception(
                        "Idempotent retry reconciliation failed closed",
                        extra={
                            "subject_hash": context.subject_hash,
                            "request_id": context.request_id,
                        },
                    )
            code = 202 if status in {"PENDING", "SUBMITTED", "UNKNOWN"} else 200
            if status in {"FAILED", "BLOCKED"}:
                code = 409
            return ServiceResult(code, self._public_request(item))
        try:
            if preflight is not None:
                preflight()
            state, details = await work()
            public = {
                "requestId": context.request_id.lower(),
                "operation": operation,
                "status": state,
                **details,
            }
            self.repo.update_request(
                context.subject_hash,
                context.request_id,
                state,
                response=public,
            )
            return ServiceResult(202 if state == "SUBMITTED" else 200, public)
        except VenueAmbiguous as exc:
            reconciliation_record = dict(reconciliation or {})
            reconciliation_record["ambiguousAt"] = int(time.time() * 1000)
            if exc.signed_tx_hash:
                reconciliation_record["signedTxHash"] = exc.signed_tx_hash
            public = {
                "requestId": context.request_id.lower(),
                "operation": operation,
                "status": "UNKNOWN",
                "errorCode": exc.code,
                "message": exc.message,
                "retryable": False,
            }
            self.repo.update_request(
                context.subject_hash,
                context.request_id,
                "UNKNOWN",
                response=public,
                error_code=exc.code,
                reconciliation=reconciliation_record or None,
            )
            return ServiceResult(202, public)
        except ServiceError as exc:
            state = "BLOCKED" if exc.http_status == 423 else "FAILED"
            public = {
                "requestId": context.request_id.lower(),
                "operation": operation,
                "status": state,
                "errorCode": exc.code,
                "message": exc.message,
                "retryable": exc.retryable,
            }
            self.repo.update_request(
                context.subject_hash,
                context.request_id,
                state,
                response=public,
                error_code=exc.code,
            )
            return ServiceResult(exc.http_status, public)
        except Exception as exc:
            logger.error(
                "Unhandled execution request failure",
                extra={"request_id": context.request_id, "error_type": type(exc).__name__},
            )
            public = {
                "requestId": context.request_id.lower(),
                "operation": operation,
                "status": "UNKNOWN",
                "errorCode": "INTERNAL_OUTCOME_UNKNOWN",
                "message": "Execution outcome could not be established",
                "retryable": False,
            }
            self.repo.update_request(
                context.subject_hash,
                context.request_id,
                "UNKNOWN",
                response=public,
                error_code="INTERNAL_OUTCOME_UNKNOWN",
            )
            return ServiceResult(202, public)

    async def _reconcile_unknown_requests(
        self,
        context: RequestContext,
        profile: dict[str, Any] | None = None,
        *,
        request_id: str | None = None,
    ) -> None:
        """Resolve quarantined signer lanes from venue tx or nonce evidence."""
        profile = profile or self.repo.get_profile(context.subject_hash)
        if (
            profile is None
            or str(profile.get("walletAddress", "")).lower() != context.wallet_address.lower()
            or profile.get("keyStatus") != "ACTIVE"
        ):
            return
        account_index = int(profile["accountIndex"])
        api_key_index = int(profile["apiKeyIndex"])
        if request_id is not None:
            candidate = self.repo.get_request(context.subject_hash, request_id)
            candidates = [candidate] if candidate else []
        else:
            candidates = self.repo.list_requests(context.subject_hash, limit=100)
        now_ms = int(time.time() * 1000)
        for item in candidates:
            if not item or item.get("status") != "UNKNOWN":
                continue
            details = item.get("reconciliation")
            if not isinstance(details, dict):
                continue
            try:
                if int(details.get("accountIndex", -1)) != account_index:
                    continue
                if int(details.get("apiKeyIndex", -1)) != api_key_index:
                    continue
                attempted_nonce = int(details["attemptedNonce"])
            except (KeyError, TypeError, ValueError):
                continue
            stage = str(details.get("stage", "")).upper()
            signed_tx_hash = details.get("signedTxHash")
            accepted = False
            if isinstance(signed_tx_hash, str) and signed_tx_hash:
                try:
                    transaction = await self.gateway.transaction(signed_tx_hash)
                except Exception:
                    transaction = None
                if transaction is not None:
                    try:
                        accepted = (
                            int(transaction.get("account_index", -1)) == account_index
                            and int(transaction.get("api_key_index", -1)) == api_key_index
                            and int(transaction.get("nonce", -1)) == attempted_nonce
                        )
                    except (TypeError, ValueError):
                        accepted = False
            if not accepted:
                ambiguous_at = int(details.get("ambiguousAt", item.get("updatedAt", now_ms)))
                if now_ms - ambiguous_at < RECONCILIATION_DELAY_MS:
                    continue
                try:
                    accepted = await self.gateway.next_nonce(account_index, api_key_index) > attempted_nonce
                except Exception:
                    continue

            original = self._public_request(item)
            if accepted and stage != "LEVERAGE":
                state = "SUBMITTED"
                message = "Venue acceptance was recovered automatically from signed transaction evidence."
            elif accepted:
                state = "FAILED"
                message = (
                    "The leverage update was accepted, but the order was not submitted. "
                    "It is safe to review and submit a new order."
                )
            else:
                state = "FAILED"
                message = "The venue did not consume this transaction nonce; it is safe to retry."
            public = {
                **original,
                "status": state,
                "message": message,
                "reconciled": True,
                "retryable": state == "FAILED",
            }
            public.pop("errorCode", None)
            if accepted and isinstance(signed_tx_hash, str) and signed_tx_hash:
                public["venueTxHash"] = signed_tx_hash
            request_key = str(item.get("requestId", ""))
            if not request_key:
                continue
            self.repo.update_request(
                context.subject_hash,
                request_key,
                state,
                response=public,
                clear_reconciliation=True,
            )
            self.repo.release_nonce_lease(
                account_index,
                api_key_index,
                f"request:{request_key.lower()}",
            )

    def _profile(self, context: RequestContext, *, require_integrator: bool = False) -> dict[str, Any]:
        profile = self.repo.get_profile(context.subject_hash)
        if profile is None:
            raise ServiceError(
                "EXECUTION_PROFILE_REQUIRED",
                "Complete execution key enrollment first",
                http_status=409,
            )
        if str(profile.get("walletAddress", "")).lower() != context.wallet_address.lower():
            raise ServiceError(
                "PROFILE_WALLET_MISMATCH",
                "The verified wallet does not match this execution profile",
                http_status=403,
            )
        if profile.get("keyStatus") != "ACTIVE":
            raise ServiceError(
                "SIGNER_KEY_NOT_READY",
                "The Lighter execution key is not active yet",
                http_status=409,
            )
        if require_integrator and not self._integrator_current(profile):
            raise ServiceError(
                "INTEGRATOR_APPROVAL_REQUIRED",
                "Approve the Aventa 0.17% integrator fee before trading",
                http_status=409,
            )
        return profile

    async def _treasury_ready(self) -> bool:
        now = time.monotonic()
        if now - self._treasury_verified_at < 60:
            return self._treasury_verified
        verified = await self.gateway.verify_treasury()
        self._treasury_verified = verified
        self._treasury_verified_at = now
        return verified

    def _pending_key_material(
        self, context: RequestContext
    ) -> tuple[dict[str, Any], dict[str, Any] | None] | None:
        try:
            secret = self.repo.get_secret(context.subject_hash)
        except ServiceError:
            return None
        if secret.get("state") != "PENDING":
            return None
        try:
            int(secret["accountIndex"])
            int(secret["apiKeyIndex"])
        except (KeyError, TypeError, ValueError):
            return None

        challenge = None
        challenge_id = secret.get("challengeId")
        if isinstance(challenge_id, str) and challenge_id:
            challenge = self.repo.get_challenge(context.subject_hash, challenge_id)
        # DynamoDB TTL may remove an expired challenge before readiness has a
        # chance to reconcile an ambiguous venue submission. The encrypted
        # signer secret intentionally outlives that short-lived challenge, so
        # keep it as recovery material and re-validate wallet ownership below.
        if challenge is None:
            return secret, None
        if challenge.get("kind") != "CHANGE_API_KEY":
            return None
        if str(challenge.get("walletAddress", "")).lower() != context.wallet_address.lower():
            return None
        try:
            if int(challenge["accountIndex"]) != int(secret["accountIndex"]):
                return None
            if int(challenge["apiKeyIndex"]) != int(secret["apiKeyIndex"]):
                return None
        except (KeyError, TypeError, ValueError):
            return None
        return secret, challenge

    def _finish_local_key_activation(
        self,
        context: RequestContext,
        profile: dict[str, Any],
        secret: dict[str, Any],
        challenge: dict[str, Any] | None,
    ) -> dict[str, Any]:
        if secret.get("state") != "ACTIVE":
            self.repo.put_secret(
                context.subject_hash,
                {
                    **secret,
                    "state": "ACTIVE",
                    "activatedAt": int(time.time()),
                },
            )
        if challenge is not None and challenge.get("state") == "PENDING":
            try:
                self.repo.consume_challenge(
                    context.subject_hash,
                    str(challenge["challengeId"]),
                )
            except ServiceError as exc:
                if exc.code != "CHALLENGE_USED":
                    raise
        if challenge is not None and challenge.get("leaseOwner"):
            self.repo.release_user_lease(
                context.subject_hash,
                "KEY_ENROLLMENT",
                str(challenge["leaseOwner"]),
            )
        if profile.get("keyStatus") != "ACTIVE":
            profile = self.repo.update_profile(
                context.subject_hash,
                {"keyStatus": "ACTIVE"},
            )
        return profile

    async def _reconcile_pending_key_enrollment(
        self, context: RequestContext
    ) -> dict[str, Any] | None:
        pending = self._pending_key_material(context)
        if pending is None:
            return None
        secret, challenge = pending
        account_index = int(secret["accountIndex"])
        api_key_index = int(secret["apiKeyIndex"])
        if challenge is None:
            # The challenge was short-lived and may already have been removed
            # by TTL. Re-bind the retained signer material to the currently
            # authenticated wallet before using it for recovery.
            try:
                accounts = await self.gateway.accounts_for_wallet(context.wallet_address)
            except Exception:
                logger.warning(
                    "Pending signer ownership reconciliation failed",
                    extra={"subject_hash": context.subject_hash},
                )
                return None
            if account_index not in {int(account["index"]) for account in accounts}:
                return None
        try:
            active = await self.gateway.check_signer(
                account_index,
                api_key_index,
                secret["privateKey"],
            )
        except Exception:
            logger.warning(
                "Pending Lighter key reconciliation check failed",
                extra={"subject_hash": context.subject_hash},
            )
            return None
        if not active:
            return None

        profile = self.repo.get_profile(context.subject_hash)
        if profile is None:
            try:
                self.repo.create_profile(
                    context.subject_hash,
                    {
                        "walletAddress": context.wallet_address,
                        "accountIndex": account_index,
                        "apiKeyIndex": api_key_index,
                        "keyStatus": "PROVISIONING",
                        "integratorApproved": False,
                    },
                    maximum=self.settings.max_enrolled_users,
                )
            except Exception:
                profile = self.repo.get_profile(context.subject_hash)
                if profile is None:
                    logger.exception(
                        "Venue key is active but execution profile recovery failed",
                        extra={"subject_hash": context.subject_hash},
                    )
                    return None
            else:
                profile = self.repo.get_profile(context.subject_hash)
        if profile is None:
            return None
        if str(profile.get("walletAddress", "")).lower() != context.wallet_address.lower():
            return None
        if int(profile.get("accountIndex", -1)) != account_index:
            return None
        if int(profile.get("apiKeyIndex", -1)) != api_key_index:
            return None
        try:
            profile = self._finish_local_key_activation(
                context, profile, secret, challenge
            )
        except Exception:
            logger.exception(
                "Venue key is active but local activation cleanup is incomplete",
                extra={"subject_hash": context.subject_hash},
            )
            return self.repo.get_profile(context.subject_hash)
        logger.info(
            "Recovered Lighter key enrollment after ambiguous venue submission",
            extra={"subject_hash": context.subject_hash},
        )
        return profile

    async def readiness(
        self,
        context: RequestContext,
        market_symbol: str | None = None,
    ) -> ServiceResult:
        profile = self.repo.get_profile(context.subject_hash)
        if profile is None:
            profile = await self._reconcile_pending_key_enrollment(context)
        count = self.repo.enrolled_count()
        profile_bound = bool(
            profile
            and str(profile.get("walletAddress", "")).lower() == context.wallet_address.lower()
        )
        key_active = bool(profile_bound and profile and profile.get("keyStatus") == "ACTIVE")
        if profile_bound and profile and profile.get("keyStatus") in {"REVOKING", "REVOKING_UNKNOWN"}:
            try:
                secret = self.repo.get_secret(context.subject_hash)
                old_key_still_active = await self.gateway.check_signer(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    secret["privateKey"],
                )
                if not old_key_still_active:
                    self.repo.delete_execution_identity(context.subject_hash)
                    profile = None
                    profile_bound = False
            except Exception:
                pass
            key_active = False
        if profile_bound and profile and profile.get("keyStatus") == "PROVISIONING":
            try:
                secret = self.repo.get_secret(context.subject_hash)
                key_active = await self.gateway.check_signer(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    secret["privateKey"],
                )
                if key_active:
                    challenge = None
                    challenge_id = secret.get("challengeId")
                    if isinstance(challenge_id, str) and challenge_id:
                        challenge = self.repo.get_challenge(
                            context.subject_hash, challenge_id
                        )
                    profile = self._finish_local_key_activation(
                        context, profile, secret, challenge
                    )
            except Exception:
                key_active = False
        if key_active and profile_bound and profile:
            try:
                await self._reconcile_unknown_requests(context, profile)
            except Exception:
                logger.exception(
                    "Automatic execution reconciliation failed closed",
                    extra={"subject_hash": context.subject_hash},
                )
        try:
            treasury_ready = await self._treasury_ready()
        except Exception:
            treasury_ready = False
        can_open_by_mode = open_allowed(
            self.settings.execution_mode,
            context.subject_hash,
            opens_enabled=self.settings.opens_enabled,
            canary_user_hashes=self.settings.canary_user_hashes,
            enrolled_users=count,
            max_enrolled_users=self.settings.max_enrolled_users,
        )
        can_enroll = enrollment_allowed(
            self.settings.execution_mode,
            context.subject_hash,
            canary_user_hashes=self.settings.canary_user_hashes,
            enrolled_users=count,
            max_enrolled_users=self.settings.max_enrolled_users,
        )
        integrator_approved = bool(profile_bound and profile and self._integrator_current(profile))
        if key_active and profile_bound and profile:
            last_verified = int(profile.get("integratorVerifiedAt", 0))
            if int(time.time() * 1000) - last_verified >= 60_000:
                try:
                    integrator_approved = await self.gateway.integrator_approval_active(
                        int(profile["accountIndex"])
                    )
                    profile = self.repo.update_profile(
                        context.subject_hash,
                        {
                            "integratorApproved": integrator_approved,
                            "integratorStatus": "ACTIVE" if integrator_approved else "NOT_ACTIVE",
                            "integratorVerifiedAt": int(time.time() * 1000),
                        },
                    )
                except Exception:
                    integrator_approved = False
        market_executable = market_symbol is None
        normalized_market = market_symbol.strip().upper() if market_symbol else None
        if normalized_market and market_policy(normalized_market) is not None:
            try:
                await self.gateway.market(normalized_market)
                market_executable = True
            except Exception:
                market_executable = False
        withdrawal_state = None
        if key_active and profile_bound and profile:
            try:
                withdrawal_state = await self.gateway.withdrawal_state(
                    int(profile["accountIndex"]),
                    "USDG",
                )
            except Exception:
                withdrawal_state = None
        nonce_lane = None
        nonce_lane_ready = True
        if key_active and profile:
            nonce_lane = self.repo.get_nonce_lane(
                int(profile["accountIndex"]),
                int(profile["apiKeyIndex"]),
            )
            if nonce_lane and (
                nonce_lane.get("quarantined")
                or int(nonce_lane.get("lockExpiresAt", 0)) > int(time.time() * 1000)
            ):
                nonce_lane_ready = False
        nonce_lane_state = (
            "QUARANTINED"
            if not nonce_lane_ready and nonce_lane and nonce_lane.get("quarantined")
            else "BUSY"
            if not nonce_lane_ready
            else "READY"
        )
        body = {
            "mode": self.settings.execution_mode,
            "venue": "Robinhood Lighter",
            "network": "Robinhood Chain",
            "walletBound": profile_bound,
            "accountIndex": int(profile["accountIndex"]) if profile_bound and profile else None,
            "keyStatus": profile.get("keyStatus") if profile_bound and profile else "NOT_ENROLLED",
            "integratorApproved": integrator_approved,
            "integratorApprovalExpiry": profile.get("integratorApprovalExpiry") if profile_bound and profile else None,
            "treasuryVerified": treasury_ready,
            "marketSymbol": normalized_market,
            "marketExecutable": market_executable,
            "canEnroll": can_enroll and not profile_bound,
            "canOpen": (
                can_open_by_mode
                and key_active
                and integrator_approved
                and treasury_ready
                and nonce_lane_ready
                and market_executable
            ),
            "canCancel": (
                exits_allowed(exit_only_enabled=self.settings.exit_only_enabled)
                and key_active
                and nonce_lane_ready
            ),
            "canClose": (
                exits_allowed(exit_only_enabled=self.settings.exit_only_enabled)
                and key_active
                and nonce_lane_ready
                and market_executable
            ),
            "canWithdraw": (
                exits_allowed(exit_only_enabled=self.settings.exit_only_enabled)
                and key_active
                and nonce_lane_ready
                and withdrawal_state is not None
                and not withdrawal_state.has_open_positions
                and withdrawal_state.pending_order_count == 0
                and withdrawal_state.available_balance
                >= withdrawal_state.asset.min_withdrawal_amount
                and withdrawal_state.available_balance > 0
            ),
            "withdrawal": {
                "asset": "USDG",
                "route": "PERP",
                "destinationWallet": context.wallet_address,
                "availableBalance": (
                    format(withdrawal_state.available_balance, "f")
                    if withdrawal_state is not None
                    else "0"
                ),
                "minimumAmount": (
                    format(withdrawal_state.asset.min_withdrawal_amount, "f")
                    if withdrawal_state is not None
                    else None
                ),
                "openPositions": (
                    withdrawal_state.has_open_positions
                    if withdrawal_state is not None
                    else None
                ),
                "pendingOrderCount": (
                    withdrawal_state.pending_order_count
                    if withdrawal_state is not None
                    else None
                ),
            },
            "nonceLane": {
                "state": nonce_lane_state,
                "lockedUntil": nonce_lane.get("lockExpiresAt") if not nonce_lane_ready and nonce_lane else None,
            },
            "openKillSwitch": not self.settings.opens_enabled,
            "enrollment": {"current": count, "limit": self.settings.max_enrolled_users},
            "fee": {
                "basisPoints": TRADE_FEE_BPS,
                "percent": "0.17",
                "venueUnits": INTEGRATOR_FEE_UNITS,
                "treasuryAccountIndex": TREASURY_ACCOUNT_INDEX,
                "treasuryAddress": TREASURY_ADDRESS,
            },
            "markets": [
                {
                    "symbol": policy.symbol,
                    "category": policy.category,
                    "maxLeverage": policy.max_leverage,
                }
                for policy in MARKET_POLICIES.values()
            ],
        }
        return ServiceResult(200, body)

    async def prepare_key_enrollment(
        self, context: RequestContext, body: dict[str, Any]
    ) -> ServiceResult:
        requested_account_index = parse_key_prepare(body)
        count = self.repo.enrolled_count()
        if not enrollment_allowed(
            self.settings.execution_mode,
            context.subject_hash,
            canary_user_hashes=self.settings.canary_user_hashes,
            enrolled_users=count,
            max_enrolled_users=self.settings.max_enrolled_users,
        ):
            raise ServiceError("ENROLLMENT_LOCKED", "Live execution enrollment is closed", http_status=423)
        if self.repo.get_profile(context.subject_hash) is not None:
            raise ServiceError("PROFILE_EXISTS", "An execution profile already exists", http_status=409)

        async def work() -> tuple[str, dict[str, Any]]:
            accounts = await self.gateway.accounts_for_wallet(context.wallet_address)
            if requested_account_index is None and len(accounts) > 1:
                return "ACCOUNT_SELECTION_REQUIRED", {
                    "selectionRequired": True,
                    "accounts": accounts,
                }
            account_index = (
                requested_account_index
                if requested_account_index is not None
                else int(accounts[0]["index"])
            )
            if account_index not in {int(account["index"]) for account in accounts}:
                raise ServiceError(
                    "LIGHTER_ACCOUNT_MISMATCH",
                    "The selected Lighter account is not owned by this wallet",
                    http_status=403,
                )
            challenge_id = secrets.token_hex(16)
            lease_owner = f"key-enrollment:{challenge_id}"
            self.repo.acquire_user_lease(
                context.subject_hash,
                "KEY_ENROLLMENT",
                lease_owner,
                lease_seconds=self.settings.challenge_ttl_seconds,
            )
            try:
                api_key_index = await self.gateway.first_available_api_key_index(account_index)
                private_key, public_key = self.gateway.generate_api_key()
                tx_type, tx_info, tx_hash, message = await self.gateway.prepare_change_key(
                    account_index,
                    api_key_index,
                    private_key,
                    public_key,
                )
                message_encoding = lighter_message_encoding(message)
                now = int(time.time())
                expires = now + self.settings.challenge_ttl_seconds
                self.repo.put_secret(
                    context.subject_hash,
                    {
                        "version": 1,
                        "state": "PENDING",
                        "challengeId": challenge_id,
                        "accountIndex": account_index,
                        "apiKeyIndex": api_key_index,
                        "privateKey": private_key,
                        "publicKey": public_key,
                        "createdAt": now,
                    },
                )
                self.repo.put_challenge(
                    context.subject_hash,
                    {
                        "challengeId": challenge_id,
                        "kind": "CHANGE_API_KEY",
                        "walletAddress": context.wallet_address,
                        "accountIndex": account_index,
                        "apiKeyIndex": api_key_index,
                        "leaseOwner": lease_owner,
                        "txType": tx_type,
                        "txInfo": tx_info,
                        "txHash": tx_hash or "",
                        "messageToSign": message,
                        "messageEncoding": message_encoding,
                        "createdAt": now,
                        "expiresAt": expires,
                    },
                )
            except Exception:
                self.repo.release_user_lease(
                    context.subject_hash,
                    "KEY_ENROLLMENT",
                    lease_owner,
                )
                raise
            return "AWAITING_SIGNATURE", {
                "challengeId": challenge_id,
                "messageToSign": message,
                "messageEncoding": message_encoding,
                "expiresAt": expires * 1000,
                "lighterAccountIndex": account_index,
                "apiKeyIndex": api_key_index,
                "signatureMethod": "personal_sign",
            }

        return await self._idempotent(context, "enrollment-key-prepare", body, work)

    async def complete_key_enrollment(
        self, context: RequestContext, body: dict[str, Any]
    ) -> ServiceResult:
        completion = parse_completion(body)

        async def work() -> tuple[str, dict[str, Any]]:
            challenge = self.repo.get_challenge(context.subject_hash, completion.challenge_id)
            if not challenge or challenge.get("kind") != "CHANGE_API_KEY":
                raise ServiceError("CHALLENGE_NOT_FOUND", "Signing challenge was not found", http_status=404)
            if challenge.get("state") != "PENDING":
                raise ServiceError("CHALLENGE_USED", "Signing challenge was already used", http_status=409)
            if int(challenge.get("expiresAt", 0)) < int(time.time()):
                raise ServiceError("CHALLENGE_EXPIRED", "Signing challenge has expired", http_status=409)
            if str(challenge.get("walletAddress", "")).lower() != context.wallet_address.lower():
                raise ServiceError("CHALLENGE_WALLET_MISMATCH", "Signing challenge wallet mismatch", http_status=403)
            secret = self.repo.get_secret(context.subject_hash)
            if secret.get("state") != "PENDING" or secret.get("challengeId") != completion.challenge_id:
                raise ServiceError("SIGNER_KEY_STATE_INVALID", "Pending execution key is unavailable", http_status=409)
            submission = None
            venue_outcome_reconciled = False
            try:
                submission = await self.gateway.submit_l1_signed_tx(
                    int(challenge["accountIndex"]),
                    int(challenge["apiKeyIndex"]),
                    secret["privateKey"],
                    tx_type=int(challenge["txType"]),
                    tx_info=str(challenge["txInfo"]),
                    message=str(challenge["messageToSign"]),
                    message_encoding=str(challenge["messageEncoding"]),
                    signature=completion.signature,
                    expected_wallet=context.wallet_address,
                )
            except VenueAmbiguous as ambiguous:
                # A timeout can happen after Lighter has accepted ChangePubKey.
                # Never blindly resubmit: first ask the venue whether our key is active.
                try:
                    await brief_settlement_delay()
                    venue_outcome_reconciled = await self.gateway.check_signer(
                        int(challenge["accountIndex"]),
                        int(challenge["apiKeyIndex"]),
                        secret["privateKey"],
                    )
                except Exception:
                    venue_outcome_reconciled = False
                if not venue_outcome_reconciled:
                    raise ambiguous

            key_status = "ACTIVE" if venue_outcome_reconciled else "PROVISIONING"
            if not venue_outcome_reconciled:
                try:
                    await brief_settlement_delay(submission)
                    if await self.gateway.check_signer(
                        int(challenge["accountIndex"]),
                        int(challenge["apiKeyIndex"]),
                        secret["privateKey"],
                    ):
                        key_status = "ACTIVE"
                except Exception:
                    key_status = "PROVISIONING"
            try:
                self.repo.create_profile(
                    context.subject_hash,
                    {
                        "walletAddress": context.wallet_address,
                        "accountIndex": int(challenge["accountIndex"]),
                        "apiKeyIndex": int(challenge["apiKeyIndex"]),
                        "keyStatus": key_status,
                        "integratorApproved": False,
                    },
                    maximum=self.settings.max_enrolled_users,
                )
                self.repo.put_secret(
                    context.subject_hash,
                    {
                        **secret,
                        "state": "ACTIVE",
                        "activatedAt": int(time.time()),
                    },
                )
                self.repo.consume_challenge(context.subject_hash, completion.challenge_id)
                self.repo.release_user_lease(
                    context.subject_hash,
                    "KEY_ENROLLMENT",
                    str(challenge["leaseOwner"]),
                )
            except Exception as exc:
                raise VenueAmbiguous(
                    "The venue accepted the key, but local enrollment finalization is incomplete"
                ) from exc
            submission_details = (
                submission.public()
                if submission is not None
                else {
                    "venueCode": None,
                    "venueTxHash": None,
                    "venueMessage": "Lighter key activation confirmed after ambiguous submission",
                    "predictedExecutionTimeMs": None,
                }
            )
            return "SUBMITTED", {
                "keyStatus": key_status,
                "venueOutcomeReconciled": venue_outcome_reconciled,
                **submission_details,
            }

        return await self._idempotent(context, "enrollment-key-complete", body, work)

    async def prepare_integrator(
        self, context: RequestContext, body: dict[str, Any]
    ) -> ServiceResult:
        parse_empty(body)
        profile = self._profile(context)

        async def work() -> tuple[str, dict[str, Any]]:
            if not await self._treasury_ready():
                raise ServiceError("TREASURY_MISMATCH", "Configured treasury ownership is invalid", http_status=423)
            secret = self.repo.get_secret(context.subject_hash)
            challenge_id = secrets.token_hex(16)
            lease_owner = f"integrator:{challenge_id}"
            account_index = int(profile["accountIndex"])
            api_key_index = int(profile["apiKeyIndex"])
            self.repo.acquire_nonce_lease(
                account_index,
                api_key_index,
                lease_owner,
                lease_seconds=self.settings.challenge_ttl_seconds,
            )
            try:
                nonce = await self.gateway.next_nonce(account_index, api_key_index)
                approval_expiry = int(time.time() * 1000) + 90 * 24 * 60 * 60 * 1000
                tx_type, tx_info, tx_hash, message = await self.gateway.prepare_integrator_approval(
                    account_index,
                    api_key_index,
                    secret["privateKey"],
                    nonce,
                    approval_expiry,
                )
                message_encoding = lighter_message_encoding(message)
                now = int(time.time())
                expires = now + self.settings.challenge_ttl_seconds
                self.repo.put_challenge(
                    context.subject_hash,
                    {
                        "challengeId": challenge_id,
                        "kind": "APPROVE_INTEGRATOR",
                        "walletAddress": context.wallet_address,
                        "accountIndex": account_index,
                        "apiKeyIndex": api_key_index,
                        "nonce": nonce,
                        "leaseOwner": lease_owner,
                        "approvalExpiry": approval_expiry,
                        "txType": tx_type,
                        "txInfo": tx_info,
                        "txHash": tx_hash or "",
                        "messageToSign": message,
                        "messageEncoding": message_encoding,
                        "createdAt": now,
                        "expiresAt": expires,
                    },
                )
            except Exception:
                self.repo.release_nonce_lease(account_index, api_key_index, lease_owner)
                raise
            return "AWAITING_SIGNATURE", {
                "challengeId": challenge_id,
                "messageToSign": message,
                "messageEncoding": message_encoding,
                "expiresAt": expires * 1000,
                "approvalExpiry": approval_expiry,
                "feePercent": "0.17",
                "treasuryAccountIndex": TREASURY_ACCOUNT_INDEX,
                "signatureMethod": "personal_sign",
            }

        return await self._idempotent(context, "enrollment-integrator-prepare", body, work)

    async def complete_integrator(
        self, context: RequestContext, body: dict[str, Any]
    ) -> ServiceResult:
        completion = parse_completion(body)
        profile = self._profile(context)

        async def work() -> tuple[str, dict[str, Any]]:
            challenge = self.repo.get_challenge(context.subject_hash, completion.challenge_id)
            if not challenge or challenge.get("kind") != "APPROVE_INTEGRATOR":
                raise ServiceError("CHALLENGE_NOT_FOUND", "Signing challenge was not found", http_status=404)
            if challenge.get("state") != "PENDING":
                raise ServiceError("CHALLENGE_USED", "Signing challenge was already used", http_status=409)
            if int(challenge.get("expiresAt", 0)) < int(time.time()):
                raise ServiceError("CHALLENGE_EXPIRED", "Signing challenge has expired", http_status=409)
            if str(challenge.get("walletAddress", "")).lower() != context.wallet_address.lower():
                raise ServiceError("CHALLENGE_WALLET_MISMATCH", "Signing challenge wallet mismatch", http_status=403)
            if (
                int(challenge["accountIndex"]) != int(profile["accountIndex"])
                or int(challenge["apiKeyIndex"]) != int(profile["apiKeyIndex"])
            ):
                raise ServiceError("CHALLENGE_PROFILE_MISMATCH", "Signing challenge profile mismatch", http_status=409)
            secret = self.repo.get_secret(context.subject_hash)
            release = True
            try:
                # Extend to the fail-closed quarantine window before the first
                # network byte is sent. A hard Lambda stop after submission
                # must not reopen this nonce lane when the challenge TTL ends.
                self.repo.quarantine_nonce_lease(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    str(challenge["leaseOwner"]),
                    quarantine_seconds=self.settings.nonce_quarantine_seconds,
                )
                submission = await self.gateway.submit_l1_signed_tx(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    secret["privateKey"],
                    tx_type=int(challenge["txType"]),
                    tx_info=str(challenge["txInfo"]),
                    message=str(challenge["messageToSign"]),
                    message_encoding=str(challenge["messageEncoding"]),
                    signature=completion.signature,
                    expected_wallet=context.wallet_address,
                )
                integrator_active = False
                try:
                    await brief_settlement_delay(submission)
                    integrator_active = await self.gateway.integrator_approval_active(
                        int(profile["accountIndex"])
                    )
                except Exception:
                    integrator_active = False
                self.repo.update_profile(
                    context.subject_hash,
                    {
                        "integratorApproved": integrator_active,
                        "integratorStatus": "ACTIVE" if integrator_active else "PROVISIONING",
                        "integratorApprovalExpiry": int(challenge["approvalExpiry"]),
                        "integratorVerifiedAt": int(time.time() * 1000),
                    },
                )
                self.repo.consume_challenge(context.subject_hash, completion.challenge_id)
            except VenueAmbiguous:
                release = False
                self.repo.quarantine_nonce_lease(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    str(challenge["leaseOwner"]),
                    quarantine_seconds=self.settings.nonce_quarantine_seconds,
                )
                raise
            finally:
                if release:
                    self.repo.release_nonce_lease(
                        int(profile["accountIndex"]),
                        int(profile["apiKeyIndex"]),
                        str(challenge["leaseOwner"]),
                    )
            return "SUBMITTED", {
                "integratorApproved": integrator_active,
                "integratorStatus": "ACTIVE" if integrator_active else "PROVISIONING",
                **submission.public(),
            }

        return await self._idempotent(context, "enrollment-integrator-complete", body, work)

    async def prepare_key_revocation(
        self, context: RequestContext, body: dict[str, Any]
    ) -> ServiceResult:
        parse_empty(body)
        profile = self._profile(context, require_integrator=False)

        async def work() -> tuple[str, dict[str, Any]]:
            secret = self.repo.get_secret(context.subject_hash)
            challenge_id = secrets.token_hex(16)
            lease_owner = f"key-revocation:{challenge_id}"
            self.repo.acquire_user_lease(
                context.subject_hash,
                "KEY_REVOCATION",
                lease_owner,
                lease_seconds=self.settings.challenge_ttl_seconds,
            )
            try:
                _, replacement_public_key = self.gateway.generate_api_key()
                tx_type, tx_info, tx_hash, message = await self.gateway.prepare_change_key(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    secret["privateKey"],
                    replacement_public_key,
                )
                message_encoding = lighter_message_encoding(message)
                now = int(time.time())
                expires = now + self.settings.challenge_ttl_seconds
                self.repo.put_challenge(
                    context.subject_hash,
                    {
                        "challengeId": challenge_id,
                        "kind": "REVOKE_API_KEY",
                        "walletAddress": context.wallet_address,
                        "accountIndex": int(profile["accountIndex"]),
                        "apiKeyIndex": int(profile["apiKeyIndex"]),
                        "leaseOwner": lease_owner,
                        "txType": tx_type,
                        "txInfo": tx_info,
                        "txHash": tx_hash or "",
                        "messageToSign": message,
                        "messageEncoding": message_encoding,
                        "createdAt": now,
                        "expiresAt": expires,
                    },
                )
            except Exception:
                self.repo.release_user_lease(
                    context.subject_hash,
                    "KEY_REVOCATION",
                    lease_owner,
                )
                raise
            return "AWAITING_SIGNATURE", {
                "challengeId": challenge_id,
                "messageToSign": message,
                "messageEncoding": message_encoding,
                "expiresAt": expires * 1000,
                "signatureMethod": "personal_sign",
            }

        return await self._idempotent(context, "enrollment-revoke-prepare", body, work)

    async def complete_key_revocation(
        self, context: RequestContext, body: dict[str, Any]
    ) -> ServiceResult:
        completion = parse_completion(body)
        profile = self._profile(context, require_integrator=False)

        async def work() -> tuple[str, dict[str, Any]]:
            challenge = self.repo.get_challenge(context.subject_hash, completion.challenge_id)
            if not challenge or challenge.get("kind") != "REVOKE_API_KEY":
                raise ServiceError("CHALLENGE_NOT_FOUND", "Revocation challenge was not found", http_status=404)
            if challenge.get("state") != "PENDING":
                raise ServiceError("CHALLENGE_USED", "Revocation challenge was already used", http_status=409)
            if int(challenge.get("expiresAt", 0)) < int(time.time()):
                raise ServiceError("CHALLENGE_EXPIRED", "Revocation challenge has expired", http_status=409)
            if str(challenge.get("walletAddress", "")).lower() != context.wallet_address.lower():
                raise ServiceError("CHALLENGE_WALLET_MISMATCH", "Revocation wallet mismatch", http_status=403)
            if (
                int(challenge["accountIndex"]) != int(profile["accountIndex"])
                or int(challenge["apiKeyIndex"]) != int(profile["apiKeyIndex"])
            ):
                raise ServiceError("CHALLENGE_PROFILE_MISMATCH", "Revocation profile mismatch", http_status=409)
            secret = self.repo.get_secret(context.subject_hash)
            try:
                submission = await self.gateway.submit_l1_signed_tx(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    secret["privateKey"],
                    tx_type=int(challenge["txType"]),
                    tx_info=str(challenge["txInfo"]),
                    message=str(challenge["messageToSign"]),
                    message_encoding=str(challenge["messageEncoding"]),
                    signature=completion.signature,
                    expected_wallet=context.wallet_address,
                )
                await brief_settlement_delay(submission)
                old_key_still_active = await self.gateway.check_signer(
                    int(profile["accountIndex"]),
                    int(profile["apiKeyIndex"]),
                    secret["privateKey"],
                )
                self.repo.consume_challenge(context.subject_hash, completion.challenge_id)
                if old_key_still_active:
                    self.repo.update_profile(context.subject_hash, {"keyStatus": "REVOKING"})
                    state = "SUBMITTED"
                else:
                    self.repo.delete_execution_identity(context.subject_hash)
                    state = "REVOKED"
            except VenueAmbiguous:
                self.repo.update_profile(context.subject_hash, {"keyStatus": "REVOKING_UNKNOWN"})
                raise
            finally:
                self.repo.release_user_lease(
                    context.subject_hash,
                    "KEY_REVOCATION",
                    str(challenge["leaseOwner"]),
                )
            return state, {
                "keyStatus": "REVOKING" if old_key_still_active else "REVOKED",
                **submission.public(),
            }

        return await self._idempotent(context, "enrollment-revoke-complete", body, work)

    @staticmethod
    def _economic_payload(body: dict[str, Any]) -> dict[str, Any]:
        return economic_payload(body)

    async def create_order(self, context: RequestContext, body: dict[str, Any]) -> ServiceResult:
        payload = self._economic_payload(body)
        prepared: dict[str, Any] = {}
        reconciliation: dict[str, Any] = {}

        def preflight() -> None:
            profile = self._profile(context, require_integrator=True)
            assert context.request_id is not None
            verify_execution_authorization(
                body,
                action="order",
                request_id=context.request_id,
                expected_wallet=str(profile["walletAddress"]),
            )
            prepared["profile"] = profile
            prepared["order"] = parse_order(
                payload,
                max_notional_usd=self.settings.max_notional_usd,
            )

        async def work() -> tuple[str, dict[str, Any]]:
            profile = prepared["profile"]
            order = prepared["order"]
            if self.settings.execution_mode != "paper":
                count = self.repo.enrolled_count()
                if not open_allowed(
                    self.settings.execution_mode,
                    context.subject_hash,
                    opens_enabled=self.settings.opens_enabled,
                    canary_user_hashes=self.settings.canary_user_hashes,
                    enrolled_users=count,
                    max_enrolled_users=self.settings.max_enrolled_users,
                ):
                    raise ServiceError(
                        "OPENS_LOCKED",
                        "New positions are currently disabled",
                        http_status=423,
                    )
            market = await self.gateway.market(order.market_symbol)
            if order.leverage > market.venue_max_leverage:
                raise ServiceError(
                    "VENUE_LEVERAGE_LIMIT",
                    f"The venue currently limits {order.market_symbol} to {market.venue_max_leverage}x",
                    http_status=423,
                )
            is_ask = order.side == "SHORT"
            base_ticks, price_ticks, actual_base = self.gateway.order_amounts(
                market,
                notional_usd=order.notional_usd,
                is_ask=is_ask,
                order_type=order.order_type,
                limit_price=order.limit_price,
                slippage_percent=order.slippage_percent,
            )
            if self.settings.execution_mode == "paper":
                return "PAPER", {
                    "marketSymbol": order.market_symbol,
                    "side": order.side,
                    "baseAmount": format(actual_base, "f"),
                    "notionalUsd": format(order.notional_usd, "f"),
                    "estimatedFeeUsd": format(fee_usd(order.notional_usd), "f"),
                }
            if not await self._treasury_ready():
                raise ServiceError(
                    "TREASURY_MISMATCH",
                    "Configured treasury ownership is invalid",
                    http_status=423,
                )
            return await self._execute_new_order(
                context,
                profile,
                market,
                order,
                base_ticks,
                price_ticks,
                actual_base,
                is_ask,
                reconciliation,
            )

        return await self._idempotent(
            context,
            "order",
            body,
            work,
            hash_body=payload,
            preflight=preflight,
            reconciliation=reconciliation,
        )

    async def _execute_new_order(
        self,
        context: RequestContext,
        profile: dict[str, Any],
        market: Any,
        order: Any,
        base_ticks: int,
        price_ticks: int,
        actual_base: Decimal,
        is_ask: bool,
        reconciliation: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        assert context.request_id is not None
        account_index = int(profile["accountIndex"])
        api_key_index = int(profile["apiKeyIndex"])
        reconciliation.update(
            {
                "accountIndex": account_index,
                "apiKeyIndex": api_key_index,
                "clientOrderId": deterministic_client_order_index(context.request_id),
            }
        )
        lease_owner = f"request:{context.request_id.lower()}"
        self.repo.acquire_nonce_lease(
            account_index,
            api_key_index,
            lease_owner,
            # Start with the full fail-closed quarantine window. A definite
            # success or rejection releases it; a process crash cannot silently
            # reopen the nonce lane after only a few seconds.
            lease_seconds=self.settings.nonce_quarantine_seconds,
        )
        release = True
        client = None
        try:
            secret = self.repo.get_secret(context.subject_hash)
            client = self.gateway.signer(account_index, api_key_index, secret["privateKey"])
            leverage_nonce = await self.gateway.next_nonce(account_index, api_key_index)
            reconciliation.update({"stage": "LEVERAGE", "attemptedNonce": leverage_nonce})
            leverage_submission = await self.gateway.update_leverage(
                client,
                market,
                order.leverage,
                order.margin_mode,
                leverage_nonce,
                api_key_index,
            )
            await brief_settlement_delay(leverage_submission)
            order_nonce = await self.gateway.next_nonce(account_index, api_key_index)
            reconciliation.update({"stage": "ORDER", "attemptedNonce": order_nonce})
            submission = await self.gateway.submit_order(
                client,
                market,
                client_order_index=deterministic_client_order_index(context.request_id),
                base_ticks=base_ticks,
                price_ticks=price_ticks,
                is_ask=is_ask,
                order_type=order.order_type,
                reduce_only=False,
                nonce=order_nonce,
                api_key_index=api_key_index,
            )
            await brief_settlement_delay(submission)
        except VenueAmbiguous:
            if "attemptedNonce" not in reconciliation:
                raise ServiceError(
                    "VENUE_NONCE_UNAVAILABLE",
                    "The venue nonce could not be established before submission",
                    http_status=503,
                    retryable=True,
                )
            release = False
            self.repo.quarantine_nonce_lease(
                account_index,
                api_key_index,
                lease_owner,
                quarantine_seconds=self.settings.nonce_quarantine_seconds,
            )
            raise
        finally:
            if client is not None:
                await client.close()
            if release:
                self.repo.release_nonce_lease(account_index, api_key_index, lease_owner)
        return "SUBMITTED", {
            "marketSymbol": order.market_symbol,
            "side": order.side,
            "orderType": order.order_type,
            "baseAmount": format(actual_base, "f"),
            "notionalUsd": format(order.notional_usd, "f"),
            "estimatedFeeUsd": format(fee_usd(order.notional_usd), "f"),
            "clientOrderId": deterministic_client_order_index(context.request_id),
            "leverageTxHash": leverage_submission.tx_hash,
            **submission.public(),
        }

    async def cancel_order(self, context: RequestContext, body: dict[str, Any]) -> ServiceResult:
        payload = self._economic_payload(body)
        prepared: dict[str, Any] = {}
        reconciliation: dict[str, Any] = {}

        def preflight() -> None:
            profile = self._profile(context, require_integrator=False)
            assert context.request_id is not None
            verify_execution_authorization(
                body,
                action="cancel",
                request_id=context.request_id,
                expected_wallet=str(profile["walletAddress"]),
            )
            prepared["profile"] = profile
            prepared["cancellation"] = parse_cancel(payload)

        async def work() -> tuple[str, dict[str, Any]]:
            profile = prepared["profile"]
            cancellation = prepared["cancellation"]
            if not exits_allowed(exit_only_enabled=self.settings.exit_only_enabled):
                raise ServiceError("EXITS_LOCKED", "Order cancellation is disabled", http_status=423)
            market_index = await self.gateway.market_index(cancellation.market_symbol)
            submission = await self._with_nonce(
                context,
                profile,
                lambda client, nonce, api_key: self.gateway.cancel_order(
                    client, market_index, cancellation.order_id, nonce, api_key
                ),
                reconciliation=reconciliation,
                stage="CANCEL",
            )
            return "SUBMITTED", {
                "marketSymbol": cancellation.market_symbol,
                "orderId": cancellation.order_id,
                **submission.public(),
            }

        return await self._idempotent(
            context,
            "cancel",
            body,
            work,
            hash_body=payload,
            preflight=preflight,
            reconciliation=reconciliation,
        )

    async def cancel_all(self, context: RequestContext, body: dict[str, Any]) -> ServiceResult:
        payload = self._economic_payload(body)
        prepared: dict[str, Any] = {}
        reconciliation: dict[str, Any] = {}

        def preflight() -> None:
            profile = self._profile(context, require_integrator=False)
            assert context.request_id is not None
            verify_execution_authorization(
                body,
                action="cancel-all",
                request_id=context.request_id,
                expected_wallet=str(profile["walletAddress"]),
            )
            prepared["profile"] = profile
            prepared["symbol"] = parse_cancel_all(payload)

        async def work() -> tuple[str, dict[str, Any]]:
            profile = prepared["profile"]
            symbol = prepared["symbol"]
            if not exits_allowed(exit_only_enabled=self.settings.exit_only_enabled):
                raise ServiceError("EXITS_LOCKED", "Order cancellation is disabled", http_status=423)
            market_index = 255
            if symbol is not None:
                market_index = await self.gateway.market_index(symbol)
            submission = await self._with_nonce(
                context,
                profile,
                lambda client, nonce, api_key: self.gateway.cancel_all(
                    client, market_index, nonce, api_key
                ),
                reconciliation=reconciliation,
                stage="CANCEL_ALL",
            )
            return "SUBMITTED", {"marketSymbol": symbol, **submission.public()}

        return await self._idempotent(
            context,
            "cancel-all",
            body,
            work,
            hash_body=payload,
            preflight=preflight,
            reconciliation=reconciliation,
        )

    async def close_position(self, context: RequestContext, body: dict[str, Any]) -> ServiceResult:
        payload = self._economic_payload(body)
        prepared: dict[str, Any] = {}
        reconciliation: dict[str, Any] = {}

        def preflight() -> None:
            profile = self._profile(context, require_integrator=False)
            assert context.request_id is not None
            verify_execution_authorization(
                body,
                action="close",
                request_id=context.request_id,
                expected_wallet=str(profile["walletAddress"]),
            )
            prepared["profile"] = profile
            prepared["close"] = parse_close(payload)

        async def work() -> tuple[str, dict[str, Any]]:
            profile = prepared["profile"]
            close = prepared["close"]
            if not exits_allowed(exit_only_enabled=self.settings.exit_only_enabled):
                raise ServiceError("EXITS_LOCKED", "Position closing is disabled", http_status=423)
            collect_integrator_fee = self._integrator_current(profile)
            if collect_integrator_fee:
                try:
                    collect_integrator_fee = await self._treasury_ready()
                except Exception:
                    collect_integrator_fee = False
            market = await self.gateway.market(close.market_symbol, allow_force_reduce=True)
            position = await self.gateway.position(int(profile["accountIndex"]), market)
            requested_base = position.base_amount * close.close_percent / Decimal(100)
            base_ticks = market.base_ticks(requested_base)
            if base_ticks <= 0 or base_ticks > (1 << 48) - 1:
                raise ServiceError("CLOSE_BELOW_MINIMUM", "Close amount is below venue precision", http_status=409)
            actual_base = Decimal(base_ticks) / (Decimal(10) ** market.size_decimals)
            if actual_base > position.base_amount:
                actual_base = position.base_amount
                base_ticks = market.base_ticks(actual_base)
            is_ask = not position.is_short
            slippage = close.slippage_percent / Decimal(100)
            worst_price = market.mark_price * (
                Decimal(1) - slippage if is_ask else Decimal(1) + slippage
            )
            price_ticks = market.price_ticks(worst_price, is_ask=is_ask)
            if price_ticks <= 0 or price_ticks > (1 << 32) - 1:
                raise ServiceError("CLOSE_PRICE_INVALID", "Close protection price is invalid", http_status=409)

            async def submit(client: Any, nonce: int, api_key: int) -> Any:
                assert context.request_id is not None
                return await self.gateway.submit_order(
                    client,
                    market,
                    client_order_index=deterministic_client_order_index(context.request_id),
                    base_ticks=base_ticks,
                    price_ticks=price_ticks,
                    is_ask=is_ask,
                    order_type="MARKET",
                    reduce_only=True,
                    collect_integrator_fee=collect_integrator_fee,
                    nonce=nonce,
                    api_key_index=api_key,
                )

            submission = await self._with_nonce(
                context,
                profile,
                submit,
                reconciliation=reconciliation,
                stage="CLOSE",
            )
            close_notional = actual_base * market.mark_price
            return "SUBMITTED", {
                "marketSymbol": close.market_symbol,
                "closePercent": format(close.close_percent, "f"),
                "baseAmount": format(actual_base, "f"),
                "estimatedFeeUsd": format(
                    fee_usd(close_notional) if collect_integrator_fee else Decimal(0),
                    "f",
                ),
                "feeWaivedForExit": not collect_integrator_fee,
                "reduceOnly": True,
                **submission.public(),
            }

        return await self._idempotent(
            context,
            "close",
            body,
            work,
            hash_body=payload,
            preflight=preflight,
            reconciliation=reconciliation,
        )

    async def withdraw(self, context: RequestContext, body: dict[str, Any]) -> ServiceResult:
        payload = self._economic_payload(body)
        prepared: dict[str, Any] = {}
        reconciliation: dict[str, Any] = {}

        def preflight() -> None:
            profile = self._profile(context, require_integrator=False)
            assert context.request_id is not None
            verify_execution_authorization(
                body,
                action="withdraw",
                request_id=context.request_id,
                expected_wallet=str(profile["walletAddress"]),
            )
            prepared["profile"] = profile
            prepared["withdrawal"] = parse_withdrawal(payload)

        async def work() -> tuple[str, dict[str, Any]]:
            profile = prepared["profile"]
            withdrawal = prepared["withdrawal"]
            if not exits_allowed(exit_only_enabled=self.settings.exit_only_enabled):
                raise ServiceError(
                    "WITHDRAWALS_LOCKED",
                    "Withdrawals are currently disabled",
                    http_status=423,
                )

            async def submit(client: Any, nonce: int, api_key: int) -> Any:
                state = await self.gateway.withdrawal_state(
                    int(profile["accountIndex"]),
                    "USDG",
                )
                if state.has_open_positions or state.pending_order_count > 0:
                    raise ServiceError(
                        "WITHDRAWAL_EXPOSURE_ACTIVE",
                        "Cancel all orders and close all positions before withdrawing",
                        http_status=423,
                    )
                if withdrawal.amount < state.asset.min_withdrawal_amount:
                    raise ServiceError(
                        "WITHDRAWAL_BELOW_MINIMUM",
                        (
                            "Withdrawal must be at least "
                            f"{format(state.asset.min_withdrawal_amount, 'f')} USDG"
                        ),
                        http_status=409,
                    )
                if withdrawal.amount > state.available_balance:
                    raise ServiceError(
                        "INSUFFICIENT_WITHDRAWABLE_BALANCE",
                        "Withdrawal exceeds the authoritative available venue balance",
                        http_status=409,
                    )
                prepared["withdrawalState"] = state
                return await self.gateway.withdraw(
                    client,
                    state.asset,
                    withdrawal.amount,
                    nonce,
                    api_key,
                )

            submission = await self._with_nonce(
                context,
                profile,
                submit,
                reconciliation=reconciliation,
                stage="WITHDRAW",
            )
            state = prepared["withdrawalState"]
            return "SUBMITTED", {
                "asset": state.asset.symbol,
                "amount": format(withdrawal.amount, "f"),
                "route": "PERP",
                "destinationWallet": str(profile["walletAddress"]),
                **submission.public(),
            }

        return await self._idempotent(
            context,
            "withdraw",
            body,
            work,
            hash_body=payload,
            preflight=preflight,
            reconciliation=reconciliation,
        )

    async def _with_nonce(
        self,
        context: RequestContext,
        profile: dict[str, Any],
        submitter: Callable[[Any, int, int], Awaitable[Any]],
        *,
        reconciliation: dict[str, Any],
        stage: str,
    ) -> Any:
        assert context.request_id is not None
        account_index = int(profile["accountIndex"])
        api_key_index = int(profile["apiKeyIndex"])
        reconciliation.update(
            {
                "accountIndex": account_index,
                "apiKeyIndex": api_key_index,
                "stage": stage,
            }
        )
        lease_owner = f"request:{context.request_id.lower()}"
        self.repo.acquire_nonce_lease(
            account_index,
            api_key_index,
            lease_owner,
            lease_seconds=self.settings.nonce_quarantine_seconds,
        )
        release = True
        client = None
        try:
            secret = self.repo.get_secret(context.subject_hash)
            client = self.gateway.signer(account_index, api_key_index, secret["privateKey"])
            nonce = await self.gateway.next_nonce(account_index, api_key_index)
            reconciliation["attemptedNonce"] = nonce
            submission = await submitter(client, nonce, api_key_index)
            await brief_settlement_delay(submission)
            return submission
        except VenueAmbiguous:
            if "attemptedNonce" not in reconciliation:
                raise ServiceError(
                    "VENUE_NONCE_UNAVAILABLE",
                    "The venue nonce could not be established before submission",
                    http_status=503,
                    retryable=True,
                )
            release = False
            self.repo.quarantine_nonce_lease(
                account_index,
                api_key_index,
                lease_owner,
                quarantine_seconds=self.settings.nonce_quarantine_seconds,
            )
            raise
        finally:
            if client is not None:
                await client.close()
            if release:
                self.repo.release_nonce_lease(account_index, api_key_index, lease_owner)

    async def activity(self, context: RequestContext, *, limit: int) -> ServiceResult:
        profile = self.repo.get_profile(context.subject_hash)
        try:
            await self._reconcile_unknown_requests(context, profile)
        except Exception:
            logger.exception(
                "Activity reconciliation failed closed",
                extra={"subject_hash": context.subject_hash},
            )
        requests = self.repo.list_requests(context.subject_hash, limit=limit)
        empty: dict[str, Any] = {
            "account": None,
            "positions": [],
            "openOrders": [],
            "orderHistory": [],
            "tradeHistory": [],
            "withdrawalHistory": [],
        }
        if (
            profile is None
            or str(profile.get("walletAddress", "")).lower() != context.wallet_address.lower()
            or profile.get("keyStatus") != "ACTIVE"
        ):
            return ServiceResult(
                200,
                {**empty, "items": [self._public_request(item) for item in requests]},
            )
        secret = self.repo.get_secret(context.subject_hash)
        activity = await self.gateway.private_activity(
            int(profile["accountIndex"]),
            int(profile["apiKeyIndex"]),
            secret["privateKey"],
            limit=limit,
        )
        return ServiceResult(
            200,
            {**activity, "items": [self._public_request(item) for item in requests]},
        )

    async def request_status(self, context: RequestContext, request_id: str) -> ServiceResult:
        try:
            await self._reconcile_unknown_requests(context, request_id=request_id)
        except Exception:
            logger.exception(
                "Request reconciliation failed closed",
                extra={"subject_hash": context.subject_hash, "request_id": request_id},
            )
        item = self.repo.get_request(context.subject_hash, request_id)
        if item is None:
            raise ServiceError("REQUEST_NOT_FOUND", "Execution request was not found", http_status=404)
        return ServiceResult(200, self._public_request(item))
