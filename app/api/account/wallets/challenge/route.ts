import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import {
  normalizeEvmAddress,
  WALLET_OWNERSHIP_CHAIN_ID,
  WALLET_OWNERSHIP_CHALLENGE_TTL_SECONDS,
  walletMessageHash,
  walletOwnershipMessage,
} from '@/app/lib/wallet-ownership';
import { createWalletOwnershipChallenge } from '@/db/account';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJsonObject(request);
    const { user } = await requirePrivyProfileUser(request);

    if (body.chainId !== WALLET_OWNERSHIP_CHAIN_ID) {
      throw new ApiError(
        400,
        'ROBINHOOD_CHAIN_REQUIRED',
        'Switch the wallet to Robinhood Chain before verifying ownership.',
      );
    }

    const normalized = normalizeEvmAddress(body.address);
    if (!normalized) {
      throw new ApiError(400, 'INVALID_WALLET_ADDRESS', 'A valid EVM wallet address is required.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + WALLET_OWNERSHIP_CHALLENGE_TTL_SECONDS * 1000);
    const challengeId = `wch_${crypto.randomUUID().replace(/-/g, '')}`;
    const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const message = walletOwnershipMessage({
      origin: new URL(request.url).origin,
      checksumAddress: normalized.checksumAddress,
      challengeId,
      nonce,
      issuedAt: now,
      expiresAt,
    });
    const messageHash = walletMessageHash(message);
    if (!messageHash) {
      throw new ApiError(500, 'WALLET_CHALLENGE_FAILED', 'The wallet verification challenge could not be created.');
    }

    await createWalletOwnershipChallenge({
      id: challengeId,
      userId: user.id,
      chainId: WALLET_OWNERSHIP_CHAIN_ID,
      address: normalized.address,
      messageHash,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    });

    return privateJson({
      challengeId,
      address: normalized.checksumAddress,
      chainId: WALLET_OWNERSHIP_CHAIN_ID,
      message,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
