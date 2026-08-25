import { getVerifiedWallets } from '@/db/account';
import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import {
  AVENTA_TREASURY_ADDRESS,
  ROBINHOOD_LIGHTER_API,
} from '@/app/lib/lighter-robinhood';

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ROBINHOOD_CHAIN_ID = 4663;

function upstreamMessage(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJsonObject(request);
    const { user } = await requirePrivyProfileUser(request);

    const address = typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
    if (!ADDRESS_PATTERN.test(address)) {
      throw new ApiError(400, 'INVALID_ADDRESS', 'A valid EVM wallet address is required.');
    }
    if (address === AVENTA_TREASURY_ADDRESS.toLowerCase()) {
      throw new ApiError(403, 'TREASURY_WALLET_FORBIDDEN', 'The Aventa treasury wallet cannot be used as a user trading account.');
    }

    const verifiedWallets = await getVerifiedWallets(user.id);
    const verified = verifiedWallets.some((wallet) => (
      wallet.chainId === ROBINHOOD_CHAIN_ID
      && wallet.address.toLowerCase() === address
    ));
    if (!verified) {
      throw new ApiError(409, 'VERIFIED_WALLET_REQUIRED', 'Verify this Robinhood Chain wallet before creating a deposit address.');
    }

    const form = new URLSearchParams({
      chain_id: String(ROBINHOOD_CHAIN_ID),
      from_addr: address,
      amount: '0',
      is_external_deposit: 'true',
    });
    const response = await fetch(`${ROBINHOOD_LIGHTER_API}/api/v1/createIntentAddress`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => undefined) as unknown;
    const intentAddress = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).intent_address
      : undefined;

    if (!response.ok || typeof intentAddress !== 'string' || !ADDRESS_PATTERN.test(intentAddress)) {
      throw new ApiError(
        502,
        'LIGHTER_INTENT_UNAVAILABLE',
        upstreamMessage(payload) || 'Robinhood Lighter could not create a deposit address for this wallet.',
      );
    }

    return privateJson({
      intentAddress,
      chainId: ROBINHOOD_CHAIN_ID,
      collateral: 'USDG',
      minimumDeposit: '1',
      persistent: true,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
