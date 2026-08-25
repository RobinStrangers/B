from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from config import FEE_CONSENT_VERSION
from errors import ServiceError
from policy import market_policy


ETH_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")
CHALLENGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$")

FORBIDDEN_REQUEST_KEYS = frozenset(
    {
        "account",
        "accountindex",
        "apikey",
        "apikeyindex",
        "apiprivatekey",
        "chainid",
        "ethprivatekey",
        "fee",
        "feebps",
        "integratoraccountindex",
        "integratorfee",
        "marketindex",
        "privatekey",
        "treasury",
        "treasuryaccountindex",
        "treasuryaddress",
    }
)


def _fail(code: str, message: str) -> ServiceError:
    return ServiceError(code, message, http_status=400)


def reject_forbidden_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in FORBIDDEN_REQUEST_KEYS:
                raise _fail("FORBIDDEN_FIELD", f"Field '{key}' is server controlled")
            reject_forbidden_keys(child)
    elif isinstance(value, list):
        for child in value:
            reject_forbidden_keys(child)


def _exact_keys(body: dict[str, Any], allowed: set[str], required: set[str]) -> None:
    reject_forbidden_keys(body)
    unknown = set(body) - allowed
    missing = required - set(body)
    if unknown:
        raise _fail("UNKNOWN_FIELD", f"Unsupported field: {sorted(unknown)[0]}")
    if missing:
        raise _fail("MISSING_FIELD", f"Required field missing: {sorted(missing)[0]}")


def normalize_wallet(value: str) -> str:
    if not ETH_ADDRESS_RE.fullmatch(value.strip()):
        raise _fail("WALLET_INVALID", "Verified wallet address is invalid")
    return value.strip().lower()


def validate_request_id(value: str) -> str:
    request_id = value.strip()
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise _fail("REQUEST_ID_INVALID", "A valid idempotency request id is required")
    return request_id


def _decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool):
        raise _fail("FIELD_INVALID", f"{field} must be numeric")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise _fail("FIELD_INVALID", f"{field} must be numeric") from exc
    if not result.is_finite():
        raise _fail("FIELD_INVALID", f"{field} must be finite")
    return result


def _symbol(value: Any) -> str:
    if not isinstance(value, str):
        raise _fail("MARKET_INVALID", "marketSymbol must be a string")
    symbol = value.strip().upper().replace("/USDG", "").replace("-USDG", "")
    policy = market_policy(symbol)
    if policy is None:
        raise _fail("MARKET_NOT_EXECUTABLE", "This market is reference-only")
    return symbol


def _consent(body: dict[str, Any]) -> None:
    if body.get("consentVersion") != FEE_CONSENT_VERSION:
        raise _fail("CONSENT_VERSION_INVALID", "The current 0.17% fee consent is required")


def parse_key_prepare(body: dict[str, Any]) -> int | None:
    _exact_keys(body, {"accountIndex"}, set())
    value = body.get("accountIndex")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > (1 << 48) - 1:
        raise _fail("ACCOUNT_INDEX_INVALID", "accountIndex is invalid")
    return value


@dataclass(frozen=True)
class OrderInput:
    market_symbol: str
    side: str
    order_type: str
    collateral_usd: Decimal
    leverage: int
    limit_price: Decimal | None
    slippage_percent: Decimal
    margin_mode: str

    @property
    def notional_usd(self) -> Decimal:
        return self.collateral_usd * Decimal(self.leverage)


def parse_order(body: dict[str, Any], *, max_notional_usd: int) -> OrderInput:
    allowed = {
        "marketSymbol",
        "side",
        "orderType",
        "collateralUsd",
        "leverage",
        "limitPrice",
        "slippagePercent",
        "marginMode",
        "consentVersion",
    }
    _exact_keys(
        body,
        allowed,
        {"marketSymbol", "side", "orderType", "collateralUsd", "leverage", "consentVersion"},
    )
    _consent(body)
    symbol = _symbol(body["marketSymbol"])
    side = str(body["side"]).strip().upper()
    if side not in {"LONG", "SHORT"}:
        raise _fail("SIDE_INVALID", "side must be LONG or SHORT")
    order_type = str(body["orderType"]).strip().upper()
    if order_type not in {"MARKET", "LIMIT"}:
        raise _fail("ORDER_TYPE_INVALID", "Only MARKET and LIMIT orders are enabled")
    collateral = _decimal(body["collateralUsd"], "collateralUsd")
    if collateral < Decimal("1") or collateral > Decimal("100000"):
        raise _fail("COLLATERAL_INVALID", "collateralUsd must be between 1 and 100000")
    if isinstance(body["leverage"], bool):
        raise _fail("LEVERAGE_INVALID", "leverage must be an integer")
    try:
        leverage = int(body["leverage"])
    except (TypeError, ValueError) as exc:
        raise _fail("LEVERAGE_INVALID", "leverage must be an integer") from exc
    if str(leverage) != str(body["leverage"]).strip() and not isinstance(body["leverage"], int):
        raise _fail("LEVERAGE_INVALID", "leverage must be an integer")
    policy = market_policy(symbol)
    assert policy is not None
    if leverage < 1 or leverage > policy.max_leverage:
        raise _fail(
            "LEVERAGE_INVALID",
            f"{symbol} leverage must be between 1x and {policy.max_leverage}x",
        )
    notional = collateral * Decimal(leverage)
    if notional > Decimal(max_notional_usd):
        raise _fail("NOTIONAL_LIMIT", "Order notional exceeds the service risk limit")
    limit_price = None
    if order_type == "LIMIT":
        if body.get("limitPrice") is None:
            raise _fail("LIMIT_PRICE_REQUIRED", "limitPrice is required for LIMIT orders")
        limit_price = _decimal(body["limitPrice"], "limitPrice")
        if limit_price <= 0:
            raise _fail("LIMIT_PRICE_INVALID", "limitPrice must be positive")
    elif body.get("limitPrice") is not None:
        raise _fail("LIMIT_PRICE_INVALID", "limitPrice is only accepted for LIMIT orders")
    slippage = _decimal(body.get("slippagePercent", "0.5"), "slippagePercent")
    if slippage < Decimal("0.01") or slippage > Decimal("1"):
        raise _fail("SLIPPAGE_INVALID", "slippagePercent must be between 0.01 and 1")
    margin_mode = str(body.get("marginMode", "CROSS")).strip().upper()
    if margin_mode not in {"CROSS", "ISOLATED"}:
        raise _fail("MARGIN_MODE_INVALID", "marginMode must be CROSS or ISOLATED")
    return OrderInput(
        market_symbol=symbol,
        side=side,
        order_type=order_type,
        collateral_usd=collateral,
        leverage=leverage,
        limit_price=limit_price,
        slippage_percent=slippage,
        margin_mode=margin_mode,
    )


@dataclass(frozen=True)
class CancelInput:
    market_symbol: str
    order_id: int


def parse_cancel(body: dict[str, Any]) -> CancelInput:
    _exact_keys(body, {"marketSymbol", "orderId"}, {"marketSymbol", "orderId"})
    symbol = _symbol(body["marketSymbol"])
    if isinstance(body["orderId"], bool):
        raise _fail("ORDER_ID_INVALID", "orderId must be a positive integer")
    try:
        order_id = int(str(body["orderId"]))
    except ValueError as exc:
        raise _fail("ORDER_ID_INVALID", "orderId must be a positive integer") from exc
    if order_id <= 0 or order_id > (1 << 60) - 1:
        raise _fail("ORDER_ID_INVALID", "orderId must be a positive integer")
    return CancelInput(symbol, order_id)


def parse_cancel_all(body: dict[str, Any]) -> str | None:
    _exact_keys(body, {"marketSymbol"}, set())
    return _symbol(body["marketSymbol"]) if body.get("marketSymbol") else None


@dataclass(frozen=True)
class CloseInput:
    market_symbol: str
    close_percent: Decimal
    slippage_percent: Decimal


def parse_close(body: dict[str, Any]) -> CloseInput:
    _exact_keys(
        body,
        {"marketSymbol", "closePercent", "slippagePercent", "consentVersion"},
        {"marketSymbol", "consentVersion"},
    )
    _consent(body)
    symbol = _symbol(body["marketSymbol"])
    close_percent = _decimal(body.get("closePercent", "100"), "closePercent")
    if close_percent <= 0 or close_percent > 100:
        raise _fail("CLOSE_PERCENT_INVALID", "closePercent must be greater than 0 and at most 100")
    slippage = _decimal(body.get("slippagePercent", "0.5"), "slippagePercent")
    if slippage < Decimal("0.01") or slippage > Decimal("1"):
        raise _fail("SLIPPAGE_INVALID", "slippagePercent must be between 0.01 and 1")
    return CloseInput(symbol, close_percent, slippage)


@dataclass(frozen=True)
class CompletionInput:
    challenge_id: str
    signature: str


def parse_completion(body: dict[str, Any]) -> CompletionInput:
    _exact_keys(body, {"challengeId", "signature"}, {"challengeId", "signature"})
    challenge_id = str(body["challengeId"]).strip().lower()
    signature = str(body["signature"]).strip()
    if not CHALLENGE_ID_RE.fullmatch(challenge_id):
        raise _fail("CHALLENGE_INVALID", "challengeId is invalid")
    if not SIGNATURE_RE.fullmatch(signature):
        raise _fail("SIGNATURE_INVALID", "signature must be a 65-byte Ethereum signature")
    return CompletionInput(challenge_id, signature)


def parse_empty(body: dict[str, Any]) -> None:
    _exact_keys(body, set(), set())
