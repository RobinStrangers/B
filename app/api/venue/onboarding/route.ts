import {
  AVENTA_TREASURY_ACCOUNT_INDEX,
  AVENTA_TREASURY_ADDRESS,
  ROBINHOOD_LIGHTER_API,
  ROBINHOOD_LIGHTER_PROXY,
  ROBINHOOD_USDG_ADDRESS,
} from '@/app/lib/lighter-robinhood';

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

type VenueRow = Record<string, unknown>;

function record(value: unknown): VenueRow | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as VenueRow : undefined;
}

function accountRows(payload: unknown) {
  const root = record(payload);
  const candidates = root?.sub_accounts ?? root?.accounts ?? root?.data;
  if (!Array.isArray(candidates)) return [];
  return candidates.map(record).filter(Boolean) as VenueRow[];
}

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function accountNotFound(payload: unknown) {
  const root = record(payload);
  const code = Number(root?.code);
  const message = typeof root?.message === 'string' ? root.message.toLowerCase() : '';
  return code === 21100 || message.includes('account not found');
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address')?.trim() ?? '';
  if (!ADDRESS_PATTERN.test(address)) {
    return Response.json(
      { error: { code: 'INVALID_ADDRESS', message: 'A valid EVM wallet address is required.' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (address.toLowerCase() === AVENTA_TREASURY_ADDRESS.toLowerCase()) {
    return Response.json(
      {
        error: {
          code: 'TREASURY_WALLET_FORBIDDEN',
          message: 'The Aventa treasury wallet cannot be used as a user trading account.',
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const response = await fetch(
      `${ROBINHOOD_LIGHTER_API}/api/v1/accountsByL1Address?l1_address=${encodeURIComponent(address)}`,
      {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      },
    );
    const payload = await response.json().catch(() => undefined) as unknown;

    if (accountNotFound(payload)) {
      return Response.json({
        accountExists: false,
        accountIndexes: [],
        canDeposit: true,
        venue: 'Robinhood Lighter',
        network: 'Robinhood Chain',
        collateral: 'USDG',
        depositContract: ROBINHOOD_LIGHTER_PROXY,
        collateralContract: ROBINHOOD_USDG_ADDRESS,
      }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
    }

    if (!response.ok) {
      return Response.json(
        { error: { code: 'VENUE_RECONNECTING', message: 'Robinhood Lighter account discovery is temporarily unavailable.' } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    let treasuryMatch = false;
    const indexes = accountRows(payload).flatMap((row) => {
      const l1Address = typeof row.l1_address === 'string'
        ? row.l1_address
        : typeof row.l1Address === 'string'
          ? row.l1Address
          : address;
      if (l1Address.toLowerCase() !== address.toLowerCase()) return [];
      const index = numberValue(row.index ?? row.account_index ?? row.accountIndex);
      if (index === undefined) return [];
      if (index === AVENTA_TREASURY_ACCOUNT_INDEX) {
        treasuryMatch = true;
        return [];
      }
      return [index];
    });
    const accountIndexes = [...new Set(indexes)].sort((a, b) => a - b);

    if (!accountIndexes.length && treasuryMatch) {
      return Response.json(
        {
          error: {
            code: 'TREASURY_ACCOUNT_FORBIDDEN',
            message: 'The Aventa treasury Lighter account cannot be used as a user trading account.',
          },
        },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return Response.json({
      accountExists: accountIndexes.length > 0,
      accountIndexes,
      canDeposit: true,
      venue: 'Robinhood Lighter',
      network: 'Robinhood Chain',
      collateral: 'USDG',
      depositContract: ROBINHOOD_LIGHTER_PROXY,
      collateralContract: ROBINHOOD_USDG_ADDRESS,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0' } });
  } catch {
    return Response.json(
      { error: { code: 'VENUE_RECONNECTING', message: 'Robinhood Lighter account discovery is temporarily unavailable.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
