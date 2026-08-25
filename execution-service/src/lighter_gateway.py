from __future__ import annotations

import asyncio
import ctypes
import json
import time
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
from typing import Any

from config import (
    INTEGRATOR_FEE_UNITS,
    LIGHTER_API_URL,
    LIGHTER_CHAIN_ID,
    TREASURY_ACCOUNT_INDEX,
)
from errors import ServiceError, VenueAmbiguous, VenueRejected
from policy import treasury_matches


def lighter_message_encoding(message: str) -> str:
    if not isinstance(message, str) or not message or "\x00" in message:
        raise VenueRejected(
            "Venue returned malformed signing material",
            code="SIGNER_RESPONSE_INVALID",
        )
    # Match lighter-sdk==1.1.2 exactly: messageToSign is EIP-191 UTF-8 text,
    # even when the text happens to begin with the characters "0x".
    return "utf8"


def _model_dict(value: Any) -> dict[str, Any]:
    if hasattr(value, "to_dict"):
        result = value.to_dict()
    elif hasattr(value, "model_dump"):
        result = value.model_dump(by_alias=True, exclude_none=True)
    elif isinstance(value, dict):
        result = value
    else:
        raise VenueRejected("Venue returned an unexpected response", code="VENUE_RESPONSE_INVALID")
    if not isinstance(result, dict):
        raise VenueRejected("Venue returned an unexpected response", code="VENUE_RESPONSE_INVALID")
    return result


def _first_list(data: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        candidate = data.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def _integer(value: Any, field: str) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError) as exc:
        raise VenueRejected(f"Venue {field} is invalid", code="VENUE_RESPONSE_INVALID") from exc


def _decimal(value: Any, field: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except Exception as exc:
        raise VenueRejected(f"Venue {field} is invalid", code="VENUE_RESPONSE_INVALID") from exc
    if not result.is_finite():
        raise VenueRejected(f"Venue {field} is invalid", code="VENUE_RESPONSE_INVALID")
    return result


@dataclass(frozen=True)
class VenueMarket:
    symbol: str
    market_index: int
    mark_price: Decimal
    size_decimals: int
    price_decimals: int
    min_base_amount: Decimal
    min_quote_amount: Decimal
    force_reduce_only: bool
    venue_max_leverage: int

    def base_ticks(self, base_amount: Decimal) -> int:
        ticks = (base_amount * (Decimal(10) ** self.size_decimals)).to_integral_value(
            rounding=ROUND_FLOOR
        )
        return int(ticks)

    def price_ticks(self, price: Decimal, *, is_ask: bool, market_protection: bool = True) -> int:
        if market_protection:
            # A market sell must not execute below the floor; a market buy must
            # not execute above the ceiling.
            rounding = ROUND_CEILING if is_ask else ROUND_FLOOR
        else:
            # A limit sell rounds upward and a limit buy rounds downward so the
            # user limit is never made more aggressive by tick conversion.
            rounding = ROUND_CEILING if is_ask else ROUND_FLOOR
        ticks = (price * (Decimal(10) ** self.price_decimals)).to_integral_value(rounding=rounding)
        return int(ticks)


@dataclass(frozen=True)
class VenuePosition:
    base_amount: Decimal
    is_short: bool


@dataclass(frozen=True)
class Submission:
    tx_hash: str | None
    code: int
    message: str | None
    predicted_execution_time_ms: int | None = None

    def public(self) -> dict[str, Any]:
        return {
            "venueCode": self.code,
            "venueTxHash": self.tx_hash,
            "venueMessage": self.message,
            "predictedExecutionTimeMs": self.predicted_execution_time_ms,
        }


class LighterGateway:
    def __init__(self, api_url: str = LIGHTER_API_URL) -> None:
        # The endpoint and signing chain are intentionally fixed to Robinhood Lighter.
        if api_url.rstrip("/") != LIGHTER_API_URL:
            raise ServiceError("CONFIG_INVALID", "Only the Robinhood Lighter endpoint is allowed", http_status=503)
        self.api_url = LIGHTER_API_URL

    @staticmethod
    def _lighter() -> Any:
        try:
            import lighter
        except ImportError as exc:
            raise ServiceError("SIGNER_UNAVAILABLE", "Pinned Lighter signer is unavailable", http_status=503) from exc
        return lighter

    async def _api_client(self) -> tuple[Any, Any]:
        lighter = self._lighter()
        client = lighter.ApiClient(configuration=lighter.Configuration(host=self.api_url))
        return lighter, client

    async def accounts_for_wallet(self, wallet_address: str) -> list[dict[str, Any]]:
        lighter, client = await self._api_client()
        try:
            response = await lighter.AccountApi(client).accounts_by_l1_address(
                l1_address=wallet_address,
                _request_timeout=8.0,
            )
            data = _model_dict(response)
            accounts = _first_list(data, "sub_accounts", "accounts")
            if not accounts:
                raise ServiceError(
                    "LIGHTER_ACCOUNT_NOT_FOUND",
                    "No Robinhood Lighter account is linked to this wallet",
                    http_status=409,
                )
            candidates: list[dict[str, Any]] = []
            for raw in accounts:
                account = _model_dict(raw)
                address = str(account.get("l1_address") or account.get("l1Address") or wallet_address)
                if address.lower() != wallet_address.lower():
                    continue
                index = _integer(account.get("index"), "account index")
                raw_kind = account.get("account_type", account.get("accountType", account.get("type")))
                kind = str(raw_kind).strip().lower() if raw_kind not in {None, ""} else "trading"
                raw_label = account.get("name", account.get("label", account.get("description")))
                label = str(raw_label).strip() if raw_label not in {None, ""} else f"Lighter account #{index}"
                candidates.append({"index": index, "label": label[:80], "kind": kind[:40]})
            if not candidates:
                raise ServiceError(
                    "LIGHTER_ACCOUNT_MISMATCH",
                    "Lighter account ownership could not be verified",
                    http_status=409,
                )
            return sorted({item["index"]: item for item in candidates}.values(), key=lambda item: item["index"])
        finally:
            await client.close()

    async def verify_treasury(self) -> bool:
        lighter, client = await self._api_client()
        try:
            response = await lighter.AccountApi(client).account(
                by="index",
                value=str(TREASURY_ACCOUNT_INDEX),
                _request_timeout=8.0,
            )
            data = _model_dict(response)
            accounts = _first_list(data, "accounts", "sub_accounts")
            if len(accounts) != 1:
                return False
            account = _model_dict(accounts[0])
            return treasury_matches(
                _integer(account.get("index"), "account index"),
                str(account.get("l1_address") or account.get("l1Address") or ""),
            )
        except ServiceError:
            raise
        except Exception as exc:
            raise VenueAmbiguous("Treasury ownership could not be verified") from exc
        finally:
            await client.close()

    async def integrator_approval_active(self, account_index: int) -> bool:
        """Verify the exact fee cap from authoritative account state."""
        lighter, client = await self._api_client()
        try:
            response = await lighter.AccountApi(client).account(
                by="index",
                value=str(account_index),
                _request_timeout=8.0,
            )
            data = _model_dict(response)
            accounts = _first_list(data, "accounts", "sub_accounts")
            if len(accounts) != 1:
                return False
            account = _model_dict(accounts[0])
            approvals = _first_list(account, "approved_integrators", "approvedIntegrators")
            now_ms = int(time.time() * 1000)
            for raw in approvals:
                approval = _model_dict(raw)
                index = approval.get(
                    "integrator_account_index",
                    approval.get("integratorAccountIndex", approval.get("account_index")),
                )
                if index is None or _integer(index, "integrator account") != TREASURY_ACCOUNT_INDEX:
                    continue
                taker = approval.get(
                    "max_perps_taker_fee",
                    approval.get("maxPerpsTakerFee", approval.get("perps_taker_fee", 0)),
                )
                maker = approval.get(
                    "max_perps_maker_fee",
                    approval.get("maxPerpsMakerFee", approval.get("perps_maker_fee", 0)),
                )
                expiry = approval.get(
                    "approval_expiry",
                    approval.get("approvalExpiry", approval.get("expiry", 0)),
                )
                return (
                    _integer(taker, "integrator taker fee") >= INTEGRATOR_FEE_UNITS
                    and _integer(maker, "integrator maker fee") >= INTEGRATOR_FEE_UNITS
                    and _integer(expiry, "integrator expiry") > now_ms + 60_000
                )
            return False
        finally:
            await client.close()

    async def first_available_api_key_index(self, account_index: int) -> int:
        lighter, client = await self._api_client()
        try:
            response = await lighter.AccountApi(client).apikeys(
                account_index=account_index,
                api_key_index=255,
                _request_timeout=8.0,
            )
            data = _model_dict(response)
            entries = _first_list(data, "api_keys", "apikeys", "keys")
            occupied: set[int] = set()
            for raw in entries:
                entry = _model_dict(raw)
                public_key = entry.get("public_key") or entry.get("publicKey")
                if public_key in {None, "", "0", "0x0"}:
                    continue
                index = entry.get("api_key_index", entry.get("apiKeyIndex", entry.get("index")))
                if index is not None:
                    occupied.add(_integer(index, "API key index"))
            for index in range(4, 255):
                if index not in occupied:
                    return index
            raise ServiceError(
                "API_KEY_SLOTS_FULL",
                "No safe Lighter API key slot is available",
                http_status=409,
            )
        finally:
            await client.close()

    async def market(
        self,
        symbol: str,
        *,
        allow_force_reduce: bool = False,
    ) -> VenueMarket:
        lighter, client = await self._api_client()
        try:
            response = await lighter.OrderApi(client).order_book_details(filter="perp", _request_timeout=8.0)
            data = _model_dict(response)
            details = _first_list(data, "order_book_details", "orderBookDetails", "markets")
            exact = None
            for raw in details:
                candidate = _model_dict(raw)
                if str(candidate.get("symbol", "")).upper() == symbol.upper():
                    exact = candidate
                    break
            if exact is None:
                raise ServiceError(
                    "VENUE_MARKET_UNAVAILABLE",
                    "The exact allowlisted instrument is not listed by the venue",
                    http_status=409,
                )
            status = str(exact.get("status", "")).lower()
            if status not in {"active", "open", "trading"}:
                raise ServiceError("VENUE_MARKET_CLOSED", "The venue market is not active", http_status=423)
            config = exact.get("market_config") or exact.get("marketConfig") or {}
            if not isinstance(config, dict):
                config = _model_dict(config)
            force_reduce = bool(config.get("force_reduce_only", config.get("forceReduceOnly", False)))
            if force_reduce and not allow_force_reduce:
                raise ServiceError(
                    "VENUE_REDUCE_ONLY",
                    "The venue currently permits reductions only",
                    http_status=423,
                )
            min_initial_margin_fraction = _integer(
                exact.get("min_initial_margin_fraction"),
                "minimum initial margin fraction",
            )
            if min_initial_margin_fraction <= 0:
                raise VenueRejected(
                    "Venue leverage metadata is invalid",
                    code="VENUE_RESPONSE_INVALID",
                )
            return VenueMarket(
                symbol=symbol.upper(),
                market_index=_integer(exact.get("market_id", exact.get("market_index")), "market id"),
                mark_price=_decimal(exact.get("mark_price"), "mark price"),
                size_decimals=_integer(exact.get("supported_size_decimals"), "size decimals"),
                price_decimals=_integer(exact.get("supported_price_decimals"), "price decimals"),
                min_base_amount=_decimal(exact.get("min_base_amount", "0"), "minimum base amount"),
                min_quote_amount=_decimal(exact.get("min_quote_amount", "0"), "minimum quote amount"),
                force_reduce_only=force_reduce,
                venue_max_leverage=max(1, 10_000 // min_initial_margin_fraction),
            )
        finally:
            await client.close()

    async def market_index(self, symbol: str) -> int:
        """Resolve an exact allowlisted symbol even while its market is paused."""
        lighter, client = await self._api_client()
        try:
            response = await lighter.OrderApi(client).order_book_details(
                filter="perp",
                _request_timeout=8.0,
            )
            data = _model_dict(response)
            details = _first_list(data, "order_book_details", "orderBookDetails", "markets")
            for raw in details:
                candidate = _model_dict(raw)
                if str(candidate.get("symbol", "")).upper() == symbol.upper():
                    return _integer(
                        candidate.get("market_id", candidate.get("market_index")),
                        "market id",
                    )
            raise ServiceError(
                "VENUE_MARKET_UNAVAILABLE",
                "The exact allowlisted instrument is not listed by the venue",
                http_status=409,
            )
        finally:
            await client.close()

    async def position(self, account_index: int, market: VenueMarket) -> VenuePosition:
        lighter, client = await self._api_client()
        try:
            response = await lighter.AccountApi(client).account(
                by="index", value=str(account_index), active_only=True, _request_timeout=8.0
            )
            data = _model_dict(response)
            accounts = _first_list(data, "accounts", "sub_accounts")
            if len(accounts) != 1:
                raise VenueRejected("Venue position account is unavailable", code="POSITION_UNAVAILABLE")
            account = _model_dict(accounts[0])
            positions = _first_list(account, "positions")
            for raw in positions:
                position = _model_dict(raw)
                market_id = position.get("market_id", position.get("market_index"))
                if market_id is None or _integer(market_id, "position market") != market.market_index:
                    continue
                amount = _decimal(
                    position.get("position", position.get("size", position.get("base_amount", "0"))),
                    "position size",
                )
                sign = position.get("sign")
                is_short = amount < 0 or str(sign).lower() in {"-1", "short", "ask"}
                amount = abs(amount)
                if amount <= 0:
                    break
                return VenuePosition(amount, is_short)
            raise ServiceError("NO_POSITION", "No open position exists for this market", http_status=409)
        finally:
            await client.close()

    @staticmethod
    def _activity_row(raw: Any, symbols: dict[int, str]) -> dict[str, Any]:
        row = _model_dict(raw).copy()
        market_value = row.get("market_id", row.get("market_index", row.get("marketId")))
        market_index = None
        if market_value is not None:
            try:
                market_index = int(str(market_value))
            except (TypeError, ValueError):
                market_index = None
        symbol = symbols.get(market_index) if market_index is not None else None
        if symbol:
            row.setdefault("marketSymbol", symbol)
            row.setdefault("symbol", symbol)
        order_id = row.get(
            "order_index",
            row.get("orderIndex", row.get("client_order_index", row.get("clientOrderIndex"))),
        )
        if order_id is not None:
            row.setdefault("orderId", str(order_id))
        if "side" not in row and "is_ask" in row:
            row["side"] = "SHORT" if bool(row["is_ask"]) else "LONG"
        if "size" not in row:
            size = row.get("base_amount", row.get("baseAmount", row.get("position")))
            if size is not None:
                row["size"] = str(size)
        return row

    async def private_activity(
        self,
        account_index: int,
        api_key_index: int,
        private_key: str,
        *,
        limit: int,
    ) -> dict[str, list[dict[str, Any]]]:
        """Read the account's authoritative private orders and fills."""
        lighter = self._lighter()
        client = self.signer(account_index, api_key_index, private_key)
        try:
            authorization, error = client.create_auth_token_with_expiry(
                deadline=300,
                api_key_index=api_key_index,
            )
            if error or not authorization:
                raise ServiceError(
                    "ACTIVITY_AUTH_FAILED",
                    "Private venue activity authorization failed",
                    http_status=503,
                )
            account_result, active_result, inactive_result, trades_result, markets_result = await asyncio.gather(
                lighter.AccountApi(client.api_client).account(
                    by="index",
                    value=str(account_index),
                    active_only=True,
                    _request_timeout=8.0,
                ),
                client.order_api.account_active_orders(
                    authorization=authorization,
                    account_index=account_index,
                    _request_timeout=8.0,
                ),
                client.order_api.account_inactive_orders(
                    authorization=authorization,
                    account_index=account_index,
                    limit=limit,
                    _request_timeout=8.0,
                ),
                client.order_api.trades(
                    sort_by="timestamp",
                    sort_dir="desc",
                    limit=limit,
                    authorization=authorization,
                    account_index=account_index,
                    _request_timeout=8.0,
                ),
                client.order_api.order_book_details(filter="perp", _request_timeout=8.0),
            )
            market_data = _model_dict(markets_result)
            symbols: dict[int, str] = {}
            for raw in _first_list(market_data, "order_book_details", "orderBookDetails", "markets"):
                market = _model_dict(raw)
                index = market.get("market_id", market.get("market_index"))
                symbol = str(market.get("symbol", "")).strip().upper()
                if index is not None and symbol:
                    symbols[_integer(index, "market id")] = symbol

            account_data = _model_dict(account_result)
            accounts = _first_list(account_data, "accounts", "sub_accounts")
            positions = _first_list(_model_dict(accounts[0]), "positions") if len(accounts) == 1 else []
            active = _first_list(_model_dict(active_result), "orders", "data")
            inactive = _first_list(_model_dict(inactive_result), "orders", "data")
            trades = _first_list(_model_dict(trades_result), "trades", "data")
            return {
                "positions": [self._activity_row(row, symbols) for row in positions],
                "openOrders": [self._activity_row(row, symbols) for row in active],
                "orderHistory": [self._activity_row(row, symbols) for row in inactive],
                "tradeHistory": [self._activity_row(row, symbols) for row in trades],
            }
        except ServiceError:
            raise
        except Exception as exc:
            raise ServiceError(
                "ACTIVITY_UNAVAILABLE",
                "Private venue activity is temporarily unavailable",
                http_status=503,
                retryable=True,
            ) from exc
        finally:
            await client.close()

    async def next_nonce(self, account_index: int, api_key_index: int) -> int:
        lighter, client = await self._api_client()
        try:
            response = await lighter.TransactionApi(client).next_nonce(
                account_index=account_index,
                api_key_index=api_key_index,
                _request_timeout=8.0,
            )
            return _integer(getattr(response, "nonce", None), "nonce")
        except ServiceError:
            raise
        except Exception as exc:
            raise VenueAmbiguous("The next venue nonce could not be established") from exc
        finally:
            await client.close()

    def generate_api_key(self) -> tuple[str, str]:
        lighter = self._lighter()
        private_key, public_key, error = lighter.create_api_key()
        if error or not private_key or not public_key:
            raise ServiceError("API_KEY_GENERATION_FAILED", "Lighter API key generation failed", http_status=503)
        return private_key, public_key

    def signer(self, account_index: int, api_key_index: int, private_key: str) -> Any:
        lighter = self._lighter()
        return lighter.SignerClient(
            url=self.api_url,
            account_index=account_index,
            api_private_keys={api_key_index: private_key},
            chain_id=LIGHTER_CHAIN_ID,
        )

    @staticmethod
    def _decode_l1_result(result: Any) -> tuple[int, str, str | None, str]:
        from lighter.signer_client import decode_and_free

        error = decode_and_free(result.err)
        tx_info = decode_and_free(result.txInfo)
        tx_hash = decode_and_free(result.txHash)
        message = decode_and_free(result.messageToSign)
        if error:
            raise VenueRejected(error)
        if not tx_info or not message:
            raise VenueRejected("Venue signer omitted L1 authorization material", code="SIGNER_RESPONSE_INVALID")
        return int(result.txType), tx_info, tx_hash, message

    async def prepare_change_key(
        self,
        account_index: int,
        api_key_index: int,
        private_key: str,
        public_key: str,
    ) -> tuple[int, str, str | None, str]:
        client = self.signer(account_index, api_key_index, private_key)
        try:
            result = client.signer.SignChangePubKey(
                ctypes.c_char_p(public_key.encode("utf-8")),
                0,
                -1,
                api_key_index,
                account_index,
            )
            return self._decode_l1_result(result)
        finally:
            await client.close()

    async def prepare_integrator_approval(
        self,
        account_index: int,
        api_key_index: int,
        private_key: str,
        nonce: int,
        approval_expiry_ms: int,
    ) -> tuple[int, str, str | None, str]:
        client = self.signer(account_index, api_key_index, private_key)
        try:
            result = client.signer.SignApproveIntegrator(
                TREASURY_ACCOUNT_INDEX,
                INTEGRATOR_FEE_UNITS,
                INTEGRATOR_FEE_UNITS,
                0,
                0,
                approval_expiry_ms,
                0,
                nonce,
                api_key_index,
                account_index,
            )
            return self._decode_l1_result(result)
        finally:
            await client.close()

    async def submit_l1_signed_tx(
        self,
        account_index: int,
        api_key_index: int,
        private_key: str,
        *,
        tx_type: int,
        tx_info: str,
        message: str,
        message_encoding: str,
        signature: str,
        expected_wallet: str,
    ) -> Submission:
        try:
            from eth_account import Account
            from eth_account.messages import encode_defunct

            if message_encoding != "utf8":
                raise ValueError("invalid message encoding")
            encoded_message = encode_defunct(text=message)
            recovered = Account.recover_message(encoded_message, signature=signature)
        except Exception as exc:
            raise ServiceError("SIGNATURE_INVALID", "Wallet signature is invalid", http_status=401) from exc
        if recovered.lower() != expected_wallet.lower():
            raise ServiceError(
                "SIGNATURE_WALLET_MISMATCH",
                "Wallet signature does not match the verified wallet",
                http_status=403,
            )
        try:
            parsed = json.loads(tx_info)
            if not isinstance(parsed, dict):
                raise ValueError("invalid tx info")
            # Match the official Lighter Python SDK: the signer may include an
            # L1Sig field in txInfo already. Replace it with the signature we
            # just verified against the wallet instead of rejecting the challenge.
            parsed["L1Sig"] = signature
            signed_tx_info = json.dumps(parsed, separators=(",", ":"))
        except (ValueError, json.JSONDecodeError) as exc:
            raise ServiceError("CHALLENGE_INVALID", "Stored signing challenge is invalid", http_status=503) from exc
        client = self.signer(account_index, api_key_index, private_key)
        try:
            return self._submission(await client.send_tx(tx_type=tx_type, tx_info=signed_tx_info))
        except ServiceError:
            raise
        except Exception as exc:
            raise VenueAmbiguous() from exc
        finally:
            await client.close()

    async def check_signer(self, account_index: int, api_key_index: int, private_key: str) -> bool:
        client = self.signer(account_index, api_key_index, private_key)
        try:
            return client.check_client() is None
        finally:
            await client.close()

    @staticmethod
    def _submission(response: Any) -> Submission:
        data = _model_dict(response)
        code = _integer(data.get("code", getattr(response, "code", None)), "response code")
        message = data.get("message")
        tx_hash = data.get("tx_hash", data.get("txHash"))
        predicted = data.get(
            "predicted_execution_time_ms",
            data.get("predictedExecutionTimeMs"),
        )
        if code != 200:
            raise VenueRejected(str(message or "Venue rejected the transaction"))
        if not tx_hash:
            raise VenueAmbiguous("Venue acknowledged submission without a transaction hash")
        return Submission(
            str(tx_hash),
            code,
            str(message) if message else None,
            _integer(predicted, "predicted execution time") if predicted is not None else None,
        )

    async def update_leverage(
        self,
        client: Any,
        market: VenueMarket,
        leverage: int,
        margin_mode: str,
        nonce: int,
        api_key_index: int,
    ) -> Submission:
        try:
            _, response, error = await client.update_leverage(
                market.market_index,
                client.CROSS_MARGIN_MODE if margin_mode == "CROSS" else client.ISOLATED_MARGIN_MODE,
                leverage,
                nonce=nonce,
                api_key_index=api_key_index,
            )
            if error:
                raise VenueRejected(error)
            return self._submission(response)
        except VenueRejected:
            raise
        except Exception as exc:
            raise VenueAmbiguous("Leverage update outcome is unknown") from exc

    async def submit_order(
        self,
        client: Any,
        market: VenueMarket,
        *,
        client_order_index: int,
        base_ticks: int,
        price_ticks: int,
        is_ask: bool,
        order_type: str,
        reduce_only: bool,
        collect_integrator_fee: bool = True,
        nonce: int,
        api_key_index: int,
    ) -> Submission:
        venue_type = client.ORDER_TYPE_MARKET if order_type == "MARKET" else client.ORDER_TYPE_LIMIT
        tif = (
            client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
            if order_type == "MARKET"
            else client.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME
        )
        expiry = client.DEFAULT_IOC_EXPIRY if order_type == "MARKET" else client.DEFAULT_28_DAY_ORDER_EXPIRY
        try:
            _, response, error = await client.create_order(
                market.market_index,
                client_order_index,
                base_ticks,
                price_ticks,
                is_ask,
                venue_type,
                tif,
                reduce_only=reduce_only,
                order_expiry=expiry,
                integrator_account_index=TREASURY_ACCOUNT_INDEX if collect_integrator_fee else 0,
                integrator_taker_fee=INTEGRATOR_FEE_UNITS if collect_integrator_fee else 0,
                integrator_maker_fee=INTEGRATOR_FEE_UNITS if collect_integrator_fee else 0,
                nonce=nonce,
                api_key_index=api_key_index,
            )
            if error:
                raise VenueRejected(error)
            return self._submission(response)
        except VenueRejected:
            raise
        except Exception as exc:
            raise VenueAmbiguous() from exc

    async def cancel_order(
        self,
        client: Any,
        market_index: int,
        order_id: int,
        nonce: int,
        api_key_index: int,
    ) -> Submission:
        try:
            _, response, error = await client.cancel_order(
                market_index,
                order_id,
                nonce=nonce,
                api_key_index=api_key_index,
            )
            if error:
                raise VenueRejected(error)
            return self._submission(response)
        except VenueRejected:
            raise
        except Exception as exc:
            raise VenueAmbiguous("Cancel outcome is unknown") from exc

    async def cancel_all(
        self,
        client: Any,
        market_index: int,
        nonce: int,
        api_key_index: int,
    ) -> Submission:
        try:
            _, response, error = await client.cancel_all_orders(
                client.CANCEL_ALL_TIF_IMMEDIATE,
                int(time.time() * 1000),
                cancel_all_market_index=market_index,
                nonce=nonce,
                api_key_index=api_key_index,
            )
            if error:
                raise VenueRejected(error)
            return self._submission(response)
        except VenueRejected:
            raise
        except Exception as exc:
            raise VenueAmbiguous("Cancel-all outcome is unknown") from exc

    @staticmethod
    def order_amounts(
        market: VenueMarket,
        *,
        notional_usd: Decimal,
        is_ask: bool,
        order_type: str,
        limit_price: Decimal | None,
        slippage_percent: Decimal,
    ) -> tuple[int, int, Decimal]:
        if market.mark_price <= 0:
            raise VenueRejected("Venue mark price is invalid", code="VENUE_RESPONSE_INVALID")
        base_amount = notional_usd / market.mark_price
        base_ticks = market.base_ticks(base_amount)
        actual_base = Decimal(base_ticks) / (Decimal(10) ** market.size_decimals)
        if base_ticks <= 0 or base_ticks > (1 << 48) - 1 or actual_base < market.min_base_amount:
            raise ServiceError("ORDER_BELOW_MINIMUM", "Order is below the venue base minimum", http_status=409)
        if order_type == "LIMIT":
            assert limit_price is not None
            execution_price = limit_price
        else:
            slippage = slippage_percent / Decimal(100)
            execution_price = market.mark_price * (Decimal(1) - slippage if is_ask else Decimal(1) + slippage)
        if actual_base * execution_price < market.min_quote_amount:
            raise ServiceError("ORDER_BELOW_MINIMUM", "Order is below the venue quote minimum", http_status=409)
        price_ticks = market.price_ticks(
            execution_price,
            is_ask=is_ask,
            market_protection=order_type == "MARKET",
        )
        if price_ticks <= 0 or price_ticks > (1 << 32) - 1:
            raise ServiceError("ORDER_PRICE_INVALID", "Order price is invalid", http_status=409)
        return base_ticks, price_ticks, actual_base


async def brief_settlement_delay(submission: Submission | None = None) -> None:
    # Lighter documents a short same-key spacing requirement. The nonce lane
    # stays exclusively held while the service waits.
    delay_seconds = 0.35
    if submission and submission.predicted_execution_time_ms:
        predicted_delta = (submission.predicted_execution_time_ms - int(time.time() * 1000)) / 1000
        if 0 < predicted_delta <= 2:
            delay_seconds = max(delay_seconds, predicted_delta)
    await asyncio.sleep(delay_seconds)
