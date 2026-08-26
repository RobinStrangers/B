from __future__ import annotations

import base64
import hashlib
import json
import time
from decimal import Decimal
from typing import Any, Literal

from errors import ServiceError


def user_hash(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def request_hash(operation: str, body: dict[str, Any]) -> str:
    material = f"{operation}\n{canonical_json(body)}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def economic_payload(body: dict[str, Any]) -> dict[str, Any]:
    """Strip ephemeral wallet authorization before idempotency comparison."""
    return {key: value for key, value in body.items() if key != "authorization"}


def deterministic_client_order_index(request_id: str) -> int:
    # Lighter requires a positive uint48 client order index.
    raw = hashlib.sha256(request_id.lower().encode("utf-8")).digest()[:8]
    return (int.from_bytes(raw, "big") & ((1 << 48) - 1)) or 1


IdempotencyDecision = Literal["create", "replay", "conflict"]


def idempotency_decision(existing: dict[str, Any] | None, body_hash: str) -> IdempotencyDecision:
    if existing is None:
        return "create"
    if existing.get("bodyHash") == body_hash:
        return "replay"
    return "conflict"


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return format(value, "f")
    if isinstance(value, dict):
        return {str(key): json_safe(child) for key, child in value.items()}
    if isinstance(value, list):
        return [json_safe(child) for child in value]
    return value


def _is_conditional_failure(exc: Exception) -> bool:
    response = getattr(exc, "response", {})
    return response.get("Error", {}).get("Code") in {
        "ConditionalCheckFailedException",
        "TransactionCanceledException",
    }


class DynamoRepository:
    def __init__(self, table_name: str, kms_key_id: str, *, retention_seconds: int) -> None:
        import boto3

        self._dynamodb = boto3.resource("dynamodb")
        self._table = self._dynamodb.Table(table_name)
        self._kms = boto3.client("kms")
        self._kms_key_id = kms_key_id
        self._retention_seconds = retention_seconds

    @staticmethod
    def _user_pk(subject_hash: str) -> str:
        return f"USER#{subject_hash}"

    @staticmethod
    def _request_sk(request_id: str) -> str:
        return f"REQ#{request_id.lower()}"

    def begin_request(
        self,
        subject_hash: str,
        request_id: str,
        operation: str,
        body_hash: str,
    ) -> tuple[bool, dict[str, Any]]:
        now = int(time.time() * 1000)
        item = {
            "PK": self._user_pk(subject_hash),
            "SK": self._request_sk(request_id),
            "GSI1PK": self._user_pk(subject_hash),
            "GSI1SK": f"{now:013d}#REQ#{request_id.lower()}",
            "entity": "request",
            "requestId": request_id.lower(),
            "operation": operation,
            "bodyHash": body_hash,
            "status": "PENDING",
            "createdAt": now,
            "updatedAt": now,
            "expiresAt": now // 1000 + self._retention_seconds,
        }
        try:
            self._table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
            )
            return True, item
        except Exception as exc:
            if not _is_conditional_failure(exc):
                raise
        existing = self.get_request(subject_hash, request_id)
        decision = idempotency_decision(existing, body_hash)
        if decision == "replay":
            return False, existing or item
        raise ServiceError(
            "IDEMPOTENCY_CONFLICT",
            "This request id is already bound to a different payload",
            http_status=409,
        )

    def get_request(self, subject_hash: str, request_id: str) -> dict[str, Any] | None:
        response = self._table.get_item(
            Key={"PK": self._user_pk(subject_hash), "SK": self._request_sk(request_id)},
            ConsistentRead=True,
        )
        item = response.get("Item")
        return json_safe(item) if item else None

    def update_request(
        self,
        subject_hash: str,
        request_id: str,
        status: str,
        *,
        response: dict[str, Any] | None = None,
        error_code: str | None = None,
        reconciliation: dict[str, Any] | None = None,
        clear_reconciliation: bool = False,
    ) -> dict[str, Any]:
        values: dict[str, Any] = {":status": status, ":updated": int(time.time() * 1000)}
        names = {"#status": "status"}
        updates = "SET #status = :status, updatedAt = :updated"
        if response is not None:
            names["#response"] = "response"
            values[":response"] = response
            updates += ", #response = :response"
        if error_code is not None:
            values[":error"] = error_code
            updates += ", errorCode = :error"
        if reconciliation is not None:
            names["#reconciliation"] = "reconciliation"
            values[":reconciliation"] = reconciliation
            updates += ", #reconciliation = :reconciliation"
        if clear_reconciliation:
            names["#reconciliation"] = "reconciliation"
            updates += " REMOVE #reconciliation"
        result = self._table.update_item(
            Key={"PK": self._user_pk(subject_hash), "SK": self._request_sk(request_id)},
            UpdateExpression=updates,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(PK) AND attribute_exists(SK)",
            ReturnValues="ALL_NEW",
        )
        return json_safe(result["Attributes"])

    def list_requests(self, subject_hash: str, *, limit: int = 50) -> list[dict[str, Any]]:
        result = self._table.query(
            IndexName="ActivityIndex",
            KeyConditionExpression="GSI1PK = :pk",
            ExpressionAttributeValues={
                ":pk": self._user_pk(subject_hash),
            },
            ScanIndexForward=False,
            Limit=max(1, min(limit, 100)),
        )
        return [json_safe(item) for item in result.get("Items", [])]

    def get_profile(self, subject_hash: str) -> dict[str, Any] | None:
        result = self._table.get_item(
            Key={"PK": self._user_pk(subject_hash), "SK": "PROFILE"},
            ConsistentRead=True,
        )
        item = result.get("Item")
        return json_safe(item) if item else None

    def enrolled_count(self) -> int:
        result = self._table.get_item(
            Key={"PK": "SYSTEM#ENROLLMENT", "SK": "COUNT"},
            ConsistentRead=True,
        )
        return int(result.get("Item", {}).get("enrolledCount", 0))

    def create_profile(self, subject_hash: str, profile: dict[str, Any], *, maximum: int) -> None:
        from boto3.dynamodb.types import TypeSerializer

        serializer = TypeSerializer()

        def encoded(item: dict[str, Any]) -> dict[str, Any]:
            return {key: serializer.serialize(value) for key, value in item.items()}

        now = int(time.time())
        full_profile = {
            "PK": self._user_pk(subject_hash),
            "SK": "PROFILE",
            "entity": "profile",
            "createdAt": now,
            "updatedAt": now,
            **profile,
        }
        try:
            self._table.meta.client.transact_write_items(
                TransactItems=[
                    {
                        "Put": {
                            "TableName": self._table.name,
                            "Item": encoded(full_profile),
                            "ConditionExpression": "attribute_not_exists(PK) AND attribute_not_exists(SK)",
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table.name,
                            "Key": encoded({"PK": "SYSTEM#ENROLLMENT", "SK": "COUNT"}),
                            "UpdateExpression": "SET enrolledCount = if_not_exists(enrolledCount, :zero) + :one",
                            "ConditionExpression": "attribute_not_exists(enrolledCount) OR enrolledCount < :maximum",
                            "ExpressionAttributeValues": encoded(
                                {":zero": 0, ":one": 1, ":maximum": maximum}
                            ),
                        }
                    },
                ]
            )
        except Exception as exc:
            if _is_conditional_failure(exc):
                raise ServiceError(
                    "ENROLLMENT_LIMIT",
                    "Enrollment capacity is currently closed",
                    http_status=423,
                ) from exc
            raise

    def update_profile(self, subject_hash: str, fields: dict[str, Any]) -> dict[str, Any]:
        if not fields:
            profile = self.get_profile(subject_hash)
            if profile is None:
                raise ServiceError("PROFILE_NOT_FOUND", "Execution profile is not configured", http_status=409)
            return profile
        names: dict[str, str] = {}
        values: dict[str, Any] = {":updated": int(time.time())}
        assignments = ["updatedAt = :updated"]
        for offset, (key, value) in enumerate(fields.items()):
            name_key = f"#field{offset}"
            value_key = f":field{offset}"
            names[name_key] = key
            values[value_key] = value
            assignments.append(f"{name_key} = {value_key}")
        result = self._table.update_item(
            Key={"PK": self._user_pk(subject_hash), "SK": "PROFILE"},
            UpdateExpression="SET " + ", ".join(assignments),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(PK) AND attribute_exists(SK)",
            ReturnValues="ALL_NEW",
        )
        return json_safe(result["Attributes"])

    def delete_execution_identity(self, subject_hash: str) -> None:
        """Atomically remove the profile and encrypted signer key after venue revocation."""
        from boto3.dynamodb.types import TypeSerializer

        serializer = TypeSerializer()

        def encoded(item: dict[str, Any]) -> dict[str, Any]:
            return {key: serializer.serialize(value) for key, value in item.items()}

        try:
            self._table.meta.client.transact_write_items(
                TransactItems=[
                    {
                        "Delete": {
                            "TableName": self._table.name,
                            "Key": encoded({"PK": self._user_pk(subject_hash), "SK": "PROFILE"}),
                            "ConditionExpression": "attribute_exists(PK) AND attribute_exists(SK)",
                        }
                    },
                    {
                        "Delete": {
                            "TableName": self._table.name,
                            "Key": encoded(
                                {
                                    "PK": self._user_pk(subject_hash),
                                    "SK": "SECRET#LIGHTER_API_KEY",
                                }
                            ),
                        }
                    },
                    {
                        "Update": {
                            "TableName": self._table.name,
                            "Key": encoded({"PK": "SYSTEM#ENROLLMENT", "SK": "COUNT"}),
                            "UpdateExpression": "SET enrolledCount = enrolledCount - :one",
                            "ConditionExpression": "enrolledCount >= :one",
                            "ExpressionAttributeValues": encoded({":one": 1}),
                        }
                    },
                ]
            )
        except Exception as exc:
            if _is_conditional_failure(exc):
                raise ServiceError(
                    "REVOCATION_STATE_INVALID",
                    "Execution identity is not in a revocable state",
                    http_status=409,
                ) from exc
            raise

    def put_challenge(self, subject_hash: str, challenge: dict[str, Any]) -> None:
        item = {
            "PK": self._user_pk(subject_hash),
            "SK": f"CHALLENGE#{challenge['challengeId']}",
            "entity": "challenge",
            "state": "PENDING",
            **challenge,
        }
        self._table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
        )

    def get_challenge(self, subject_hash: str, challenge_id: str) -> dict[str, Any] | None:
        result = self._table.get_item(
            Key={"PK": self._user_pk(subject_hash), "SK": f"CHALLENGE#{challenge_id}"},
            ConsistentRead=True,
        )
        item = result.get("Item")
        return json_safe(item) if item else None

    def consume_challenge(self, subject_hash: str, challenge_id: str) -> None:
        try:
            self._table.update_item(
                Key={"PK": self._user_pk(subject_hash), "SK": f"CHALLENGE#{challenge_id}"},
                UpdateExpression="SET #state = :consumed, consumedAt = :now",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={":pending": "PENDING", ":consumed": "CONSUMED", ":now": int(time.time())},
                ConditionExpression="#state = :pending",
            )
        except Exception as exc:
            if _is_conditional_failure(exc):
                raise ServiceError("CHALLENGE_USED", "Challenge was already used", http_status=409) from exc
            raise

    def acquire_nonce_lease(
        self,
        account_index: int,
        api_key_index: int,
        owner: str,
        *,
        lease_seconds: int,
    ) -> None:
        now_ms = int(time.time() * 1000)
        try:
            self._table.update_item(
                Key={"PK": f"ACCOUNT#{account_index}#KEY#{api_key_index}", "SK": "NONCE"},
                UpdateExpression=(
                    "SET lockOwner = :owner, lockExpiresAt = :expires, updatedAt = :now "
                    "REMOVE quarantined, quarantineReason"
                ),
                ExpressionAttributeValues={
                    ":owner": owner,
                    ":expires": now_ms + lease_seconds * 1000,
                    ":now": now_ms,
                    ":false": False,
                },
                ConditionExpression=(
                    "(attribute_not_exists(quarantined) OR quarantined = :false) AND "
                    "(attribute_not_exists(lockOwner) OR lockExpiresAt < :now)"
                ),
            )
        except Exception as exc:
            if _is_conditional_failure(exc):
                raise ServiceError(
                    "NONCE_LANE_BUSY",
                    "Another transaction is being signed for this account",
                    http_status=409,
                    retryable=True,
                ) from exc
            raise

    def acquire_user_lease(
        self,
        subject_hash: str,
        purpose: str,
        owner: str,
        *,
        lease_seconds: int,
    ) -> None:
        now_ms = int(time.time() * 1000)
        try:
            self._table.update_item(
                Key={"PK": self._user_pk(subject_hash), "SK": f"LOCK#{purpose.upper()}"},
                UpdateExpression="SET lockOwner = :owner, lockExpiresAt = :expires, updatedAt = :now",
                ExpressionAttributeValues={
                    ":owner": owner,
                    ":expires": now_ms + lease_seconds * 1000,
                    ":now": now_ms,
                },
                ConditionExpression="attribute_not_exists(lockOwner) OR lockExpiresAt < :now",
            )
        except Exception as exc:
            if _is_conditional_failure(exc):
                raise ServiceError(
                    "ENROLLMENT_IN_PROGRESS",
                    "Another enrollment challenge is still active",
                    http_status=409,
                    retryable=True,
                ) from exc
            raise

    def release_user_lease(
        self,
        subject_hash: str,
        purpose: str,
        owner: str,
    ) -> None:
        try:
            self._table.update_item(
                Key={"PK": self._user_pk(subject_hash), "SK": f"LOCK#{purpose.upper()}"},
                UpdateExpression="SET updatedAt = :now REMOVE lockOwner, lockExpiresAt",
                ExpressionAttributeValues={":owner": owner, ":now": int(time.time() * 1000)},
                ConditionExpression="lockOwner = :owner",
            )
        except Exception as exc:
            if not _is_conditional_failure(exc):
                raise

    def release_nonce_lease(self, account_index: int, api_key_index: int, owner: str) -> None:
        try:
            self._table.update_item(
                Key={"PK": f"ACCOUNT#{account_index}#KEY#{api_key_index}", "SK": "NONCE"},
                UpdateExpression=(
                    "SET updatedAt = :now "
                    "REMOVE lockOwner, lockExpiresAt, quarantined, quarantineReason"
                ),
                ExpressionAttributeValues={":owner": owner, ":now": int(time.time() * 1000)},
                ConditionExpression="lockOwner = :owner",
            )
        except Exception as exc:
            if not _is_conditional_failure(exc):
                raise

    def quarantine_nonce_lease(
        self,
        account_index: int,
        api_key_index: int,
        owner: str,
        *,
        quarantine_seconds: int,
    ) -> None:
        now_ms = int(time.time() * 1000)
        self._table.update_item(
            Key={"PK": f"ACCOUNT#{account_index}#KEY#{api_key_index}", "SK": "NONCE"},
            UpdateExpression=(
                "SET lockExpiresAt = :expires, quarantined = :true, "
                "quarantineReason = :reason, updatedAt = :now"
            ),
            ExpressionAttributeValues={
                ":owner": owner,
                ":expires": now_ms + quarantine_seconds * 1000,
                ":true": True,
                ":reason": "AMBIGUOUS_VENUE_OUTCOME",
                ":now": now_ms,
            },
            ConditionExpression="lockOwner = :owner",
        )

    def get_nonce_lane(self, account_index: int, api_key_index: int) -> dict[str, Any] | None:
        result = self._table.get_item(
            Key={"PK": f"ACCOUNT#{account_index}#KEY#{api_key_index}", "SK": "NONCE"},
            ConsistentRead=True,
        )
        item = result.get("Item")
        return json_safe(item) if item else None

    @staticmethod
    def _secret_context(subject_hash: str) -> dict[str, str]:
        return {
            "AventaUser": subject_hash,
            "Purpose": "lighter-api-key",
            "Version": "1",
        }

    def put_secret(self, subject_hash: str, value: dict[str, Any]) -> str:
        ciphertext = self._kms.encrypt(
            KeyId=self._kms_key_id,
            Plaintext=canonical_json(value).encode("utf-8"),
            EncryptionContext=self._secret_context(subject_hash),
            EncryptionAlgorithm="SYMMETRIC_DEFAULT",
        )["CiphertextBlob"]
        self._table.put_item(
            Item={
                "PK": self._user_pk(subject_hash),
                "SK": "SECRET#LIGHTER_API_KEY",
                "entity": "encrypted-secret",
                "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
                "keyVersion": 1,
                "updatedAt": int(time.time() * 1000),
            }
        )
        return "SECRET#LIGHTER_API_KEY"

    def get_secret(self, subject_hash: str) -> dict[str, Any]:
        try:
            item = self._table.get_item(
                Key={"PK": self._user_pk(subject_hash), "SK": "SECRET#LIGHTER_API_KEY"},
                ConsistentRead=True,
            ).get("Item")
            if not item or not isinstance(item.get("ciphertext"), str):
                raise KeyError("secret missing")
            ciphertext = base64.b64decode(item["ciphertext"], validate=True)
            plaintext = self._kms.decrypt(
                KeyId=self._kms_key_id,
                CiphertextBlob=ciphertext,
                EncryptionContext=self._secret_context(subject_hash),
                EncryptionAlgorithm="SYMMETRIC_DEFAULT",
            )["Plaintext"]
        except Exception as exc:
            raise ServiceError(
                "SIGNER_KEY_UNAVAILABLE",
                "The execution signing key is unavailable",
                http_status=503,
            ) from exc
        try:
            value = json.loads(plaintext.decode("utf-8"))
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ServiceError("SIGNER_KEY_INVALID", "The execution signing key is invalid", http_status=503) from exc
        if not isinstance(value, dict) or not isinstance(value.get("privateKey"), str):
            raise ServiceError("SIGNER_KEY_INVALID", "The execution signing key is invalid", http_status=503)
        return value

    def delete_secret(self, subject_hash: str) -> None:
        self._table.delete_item(
            Key={"PK": self._user_pk(subject_hash), "SK": "SECRET#LIGHTER_API_KEY"}
        )
