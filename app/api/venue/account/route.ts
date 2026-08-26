const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const VENUE_API = 'https://api.rh.lighter.xyz';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : value === undefined || value === null ? undefined : String(value);
}

async function venueFetch(path: string) {
  const response = await fetch(`${VENUE_API}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw new Error(`Venue returned ${response.status}.`);
  return payload;
}

function marketRows(payload: unknown) {
  const root = record(payload);
  const candidates = root?.order_book_details ?? root?.order_books ?? root?.markets ?? root?.data;
  return Array.isArray(candidates) ? candidates.map(record).filter(Boolean) as Record<string, unknown>[] : [];
}

function accountRows(payload: unknown) {
  const root = record(payload);
  const candidates = root?.accounts ?? root?.sub_accounts ?? root?.data;
  if (Array.isArray(candidates)) return candidates.map(record).filter(Boolean) as Record<string, unknown>[];
  const single = record(root?.account);
  return single ? [single] : [];
}

function normalizeMarketSymbol(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(?:USDT|USDC|USDG|USD)$/, '');
}

function accountUsdgBalances(account: Record<string, unknown>) {
  const legacyAvailableRaw = stringValue(account.available_balance ?? account.availableBalance) ?? '0';
  const legacyCollateralRaw = stringValue(account.collateral ?? account.total_collateral) ?? '0';
  const legacyAvailable = numberValue(legacyAvailableRaw) ?? 0;
  const legacyCollateral = numberValue(legacyCollateralRaw) ?? 0;

  const rawAssets = Array.isArray(account.assets)
    ? account.assets
    : Array.isArray(account.account_assets)
      ? account.account_assets
      : Array.isArray(account.accountAssets)
        ? account.accountAssets
        : [];
  const usdgAsset = rawAssets
    .map(record)
    .filter(Boolean)
    .find((asset) => {
      const symbol = stringValue(asset?.symbol)?.trim().toUpperCase();
      const assetId = numberValue(asset?.asset_id ?? asset?.assetId);
      return symbol === 'USDG' || assetId === 3;
    });
  const assetTotal = numberValue(usdgAsset?.balance) ?? 0;
  const assetLocked = Math.max(0, numberValue(usdgAsset?.locked_balance ?? usdgAsset?.lockedBalance) ?? 0);
  const assetFree = Math.max(0, assetTotal - assetLocked);

  return {
    availableBalance: legacyAvailable > 0 ? legacyAvailableRaw : String(assetFree),
    collateral: legacyCollateral > 0 ? legacyCollateralRaw : String(Math.max(0, assetTotal)),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address')?.trim() ?? '';
  const requestedSymbol = url.searchParams.get('symbol')?.trim().toUpperCase() ?? '';
  if (address && !ADDRESS_PATTERN.test(address)) {
    return Response.json({ error: { code: 'INVALID_ADDRESS', message: 'A valid EVM wallet address is required.' } }, { status: 400 });
  }

  try {
    const [marketsResult, accountResult] = await Promise.allSettled([
      venueFetch('/api/v1/orderBookDetails'),
      address
        ? venueFetch(`/api/v1/account?by=l1_address&value=${encodeURIComponent(address)}&active_only=true`)
        : Promise.resolve(undefined),
    ]);
    if (marketsResult.status !== 'fulfilled') throw marketsResult.reason;
    const markets = marketRows(marketsResult.value);
    const market = requestedSymbol
      ? markets.find((item) => normalizeMarketSymbol(stringValue(item.symbol) ?? '') === normalizeMarketSymbol(requestedSymbol))
      : undefined;
    const accounts = accountResult.status === 'fulfilled' ? accountRows(accountResult.value) : [];
    const accountIndexParam = url.searchParams.get('accountIndex');
    const requestedAccountIndex = accountIndexParam ? numberValue(accountIndexParam) : undefined;
    const account = requestedAccountIndex === undefined
      ? accounts[0]
      : accounts.find((item) => numberValue(item.index ?? item.account_index) === requestedAccountIndex);
    const rawPositions = Array.isArray(account?.positions) ? account.positions : [];
    const positions = rawPositions.flatMap((value) => {
      const position = record(value);
      return position ? [position] : [];
    }).map((position) => ({
      marketId: numberValue(position.market_id),
      symbol: stringValue(position.symbol) ?? 'Market',
      side: numberValue(position.sign) === -1 ? 'short' : 'long',
      size: stringValue(position.position) ?? '0',
      entryPrice: stringValue(position.avg_entry_price) ?? '0',
      positionValue: stringValue(position.position_value) ?? '0',
      unrealizedPnl: stringValue(position.unrealized_pnl) ?? '0',
      realizedPnl: stringValue(position.realized_pnl) ?? '0',
      liquidationPrice: stringValue(position.liquidation_price) ?? '0',
      marginMode: numberValue(position.margin_mode) === 1 ? 'isolated' : 'cross',
      allocatedMargin: stringValue(position.allocated_margin) ?? '0',
      openOrderCount: numberValue(position.open_order_count) ?? 0,
    })).filter((position) => Number(position.size) !== 0);

    const usdgBalances = account ? accountUsdgBalances(account) : undefined;

    return Response.json({
      venue: {
        name: 'Lighter',
        network: 'Robinhood Chain',
        online: true,
        marketListed: Boolean(market),
        marketId: market ? numberValue(market.market_id) : undefined,
        marketStatus: market ? stringValue(market.status) ?? 'active' : 'not-listed',
        updatedAt: Date.now(),
      },
      account: account ? {
        index: numberValue(account.index ?? account.account_index),
        availableBalance: usdgBalances?.availableBalance ?? '0',
        collateral: usdgBalances?.collateral ?? '0',
        portfolioValue: stringValue(account.total_asset_value ?? account.collateral) ?? '0',
        pendingOrderCount: numberValue(account.pending_order_count) ?? 0,
        crossInitialMarginRequirement: stringValue(account.cross_initial_margin_requirement) ?? '0',
        crossMaintenanceMarginRequirement: stringValue(account.cross_maintenance_margin_requirement) ?? '0',
      } : null,
      positions,
      openOrders: [],
      orderHistory: [],
      tradeHistory: [],
      privateActivityRequiresTradingKey: Boolean(account),
    }, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch {
    return Response.json({
      error: { code: 'VENUE_RECONNECTING', message: 'The Robinhood Chain derivatives venue is reconnecting.' },
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
