from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP

from config import TRADE_FEE_BPS, TREASURY_ACCOUNT_INDEX, TREASURY_ADDRESS


@dataclass(frozen=True)
class MarketPolicy:
    symbol: str
    category: str
    max_leverage: int


MARKET_POLICIES = {
    "BTC": MarketPolicy("BTC", "crypto", 15),
    "ETH": MarketPolicy("ETH", "crypto", 15),
    "XRP": MarketPolicy("XRP", "crypto", 15),
    "SOL": MarketPolicy("SOL", "crypto", 15),
    "SUI": MarketPolicy("SUI", "crypto", 15),
    "AAPL": MarketPolicy("AAPL", "shares", 5),
    "MSFT": MarketPolicy("MSFT", "shares", 5),
    "NVDA": MarketPolicy("NVDA", "shares", 5),
    "AMZN": MarketPolicy("AMZN", "shares", 5),
    "GOOGL": MarketPolicy("GOOGL", "shares", 5),
    "META": MarketPolicy("META", "shares", 5),
    "TSLA": MarketPolicy("TSLA", "shares", 3),
    "AMD": MarketPolicy("AMD", "shares", 3),
    "COIN": MarketPolicy("COIN", "shares", 3),
}


def market_policy(symbol: str) -> MarketPolicy | None:
    return MARKET_POLICIES.get(symbol.upper())


def open_allowed(
    mode: str,
    user_hash: str,
    *,
    opens_enabled: bool,
    canary_user_hashes: frozenset[str],
    enrolled_users: int,
    max_enrolled_users: int,
) -> bool:
    if not opens_enabled or enrolled_users >= max_enrolled_users:
        return False
    if mode == "limited_live":
        return True
    if mode == "canary":
        return user_hash.lower() in canary_user_hashes
    return False


def enrollment_allowed(
    mode: str,
    user_hash: str,
    *,
    canary_user_hashes: frozenset[str],
    enrolled_users: int,
    max_enrolled_users: int,
) -> bool:
    if enrolled_users >= max_enrolled_users:
        return False
    if mode == "limited_live":
        return True
    if mode == "canary":
        return user_hash.lower() in canary_user_hashes
    return False


def exits_allowed(*, exit_only_enabled: bool) -> bool:
    # Exit safety is intentionally independent of the open-position kill switch.
    return exit_only_enabled


def fee_usd(notional_usd: Decimal) -> Decimal:
    return (notional_usd * Decimal(TRADE_FEE_BPS) / Decimal(10_000)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def treasury_matches(account_index: int, l1_address: str) -> bool:
    return account_index == TREASURY_ACCOUNT_INDEX and l1_address.lower() == TREASURY_ADDRESS.lower()

