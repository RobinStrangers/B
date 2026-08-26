from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

from config import Settings
from errors import ServiceError
from lighter_gateway import LighterGateway
from service import ExecutionService, RequestContext, ServiceResult
from store import DynamoRepository, user_hash
from validators import normalize_wallet, validate_request_id


logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 32 * 1024
_SERVICE: ExecutionService | None = None


def _service() -> ExecutionService:
    global _SERVICE
    if _SERVICE is None:
        settings = Settings.from_env()
        repository = DynamoRepository(
            settings.table_name,
            settings.kms_key_id,
            retention_seconds=settings.request_retention_seconds,
        )
        _SERVICE = ExecutionService(settings, repository, LighterGateway())
    return _SERVICE


def _response(result: ServiceResult) -> dict[str, Any]:
    return {
        "statusCode": result.status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store, max-age=0",
            "x-content-type-options": "nosniff",
        },
        "body": json.dumps(result.body, separators=(",", ":"), ensure_ascii=False),
        "isBase64Encoded": False,
    }


def _error(error: ServiceError) -> dict[str, Any]:
    return _response(
        ServiceResult(
            error.http_status,
            {
                "errorCode": error.code,
                "message": error.message,
                "retryable": error.retryable,
            },
        )
    )


def _headers(event: dict[str, Any]) -> dict[str, str]:
    raw = event.get("headers") or {}
    return {str(key).lower(): str(value) for key, value in raw.items() if value is not None}


def _authorize_iam_caller(event: dict[str, Any], settings: Settings) -> None:
    iam = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("iam", {})
    )
    caller_arn = str(iam.get("userArn", ""))
    if not settings.allowed_invoker_arn:
        raise ServiceError(
            "INVOKER_NOT_CONFIGURED",
            "Execution invoker is not configured",
            http_status=503,
        )
    if not caller_arn or caller_arn != settings.allowed_invoker_arn:
        raise ServiceError("INVOKER_FORBIDDEN", "Caller is not authorized", http_status=403)


def _identity(event: dict[str, Any], *, mutation: bool) -> RequestContext:
    headers = _headers(event)
    user_id = headers.get("x-aventa-user-id", "").strip()
    if not user_id or len(user_id) > 256 or any(ord(char) < 32 for char in user_id):
        raise ServiceError("IDENTITY_REQUIRED", "Verified Aventa identity is required", http_status=401)
    wallet = normalize_wallet(headers.get("x-aventa-wallet-address", ""))
    request_id = None
    if mutation:
        request_id = validate_request_id(headers.get("idempotency-key", ""))
    return RequestContext(user_hash(user_id), wallet, request_id)


def _json_body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body")
    if raw in {None, ""}:
        return {}
    try:
        encoded = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
        if event.get("isBase64Encoded"):
            encoded = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise ServiceError("BODY_INVALID", "Request body encoding is invalid") from exc
    if len(encoded) > MAX_BODY_BYTES:
        raise ServiceError("BODY_TOO_LARGE", "Request body exceeds 32 KiB", http_status=413)
    try:
        body = json.loads(encoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ServiceError("BODY_INVALID", "Request body must be valid JSON") from exc
    if not isinstance(body, dict):
        raise ServiceError("BODY_INVALID", "Request body must be a JSON object")
    return body


async def _dispatch(event: dict[str, Any]) -> ServiceResult:
    service = _service()
    _authorize_iam_caller(event, service.settings)
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = str(http.get("method") or event.get("httpMethod") or "").upper()
    path = str(event.get("rawPath") or event.get("path") or "/").rstrip("/") or "/"

    if method == "GET" and path == "/v1/readiness":
        market_symbol = (event.get("queryStringParameters") or {}).get("market")
        return await service.readiness(
            _identity(event, mutation=False),
            str(market_symbol) if market_symbol else None,
        )
    if method == "GET" and path == "/v1/activity":
        context = _identity(event, mutation=False)
        raw_limit = (event.get("queryStringParameters") or {}).get("limit", "50")
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError) as exc:
            raise ServiceError("LIMIT_INVALID", "limit must be an integer") from exc
        return await service.activity(context, limit=max(1, min(limit, 100)))
    if method == "GET" and path.startswith("/v1/requests/"):
        context = _identity(event, mutation=False)
        requested_id = validate_request_id(path.removeprefix("/v1/requests/"))
        return await service.request_status(context, requested_id)

    if method != "POST":
        raise ServiceError("ROUTE_NOT_FOUND", "Execution route was not found", http_status=404)
    context = _identity(event, mutation=True)
    body = _json_body(event)
    routes = {
        "/v1/enrollment/key/prepare": service.prepare_key_enrollment,
        "/v1/enrollment/key/complete": service.complete_key_enrollment,
        "/v1/enrollment/integrator/prepare": service.prepare_integrator,
        "/v1/enrollment/integrator/complete": service.complete_integrator,
        "/v1/enrollment/revoke/prepare": service.prepare_key_revocation,
        "/v1/enrollment/revoke/complete": service.complete_key_revocation,
        "/v1/orders": service.create_order,
        "/v1/orders/cancel": service.cancel_order,
        "/v1/orders/cancel-all": service.cancel_all,
        "/v1/positions/close": service.close_position,
        "/v1/withdrawals": service.withdraw,
    }
    route = routes.get(path)
    if route is None:
        raise ServiceError("ROUTE_NOT_FOUND", "Execution route was not found", http_status=404)
    return await route(context, body)


def lambda_handler(event: dict[str, Any], _lambda_context: Any) -> dict[str, Any]:
    try:
        return _response(asyncio.run(_dispatch(event)))
    except ServiceError as exc:
        return _error(exc)
    except Exception as exc:
        # Never return signer, AWS, or venue exception text to the caller.
        logger.error("Unhandled execution service error", extra={"error_type": type(exc).__name__})
        return _error(
            ServiceError(
                "SERVICE_UNAVAILABLE",
                "Execution service is temporarily unavailable",
                http_status=503,
                retryable=True,
            )
        )
