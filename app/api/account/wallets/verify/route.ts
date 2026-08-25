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
  recoverWalletMessageAddress,
  WALLET_CHALLENGE_ID_PATTERN,
  walletMessageHash,
} from '@/app/lib/wallet-ownership';
import {
  completeWalletOwnershipVerification,
  getWalletOwnershipChallenge,
} from '@/db/account';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readJsonObject(request);
    const { user } = await requirePrivyProfileUser(request);

    const challengeId = typeof body.challengeId === 'string' ? body.challengeId.trim().toLowerCase() : '';
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';

    if (!WALLET_CHALLENGE_ID_PATTERN.test(challengeId)) {
      throw new ApiError(400, 'INVALID_WALLET_CHALLENGE', 'The wallet verification challenge is invalid.');
    }

    const challenge = await getWalletOwnershipChallenge(user.id, challengeId);
    if (!challenge) {
      throw new ApiError(404, 'WALLET_CHALLENGE_NOT_FOUND', 'The wallet verification challenge was not found.');
    }
    if (challenge.consumedAt !== null) {
      throw new ApiError(409, 'WALLET_CHALLENGE_USED', 'This wallet verification challenge has already been used.');
    }

    const now = Math.floor(Date.now() / 1000);
    if (challenge.expiresAt < now) {
      throw new ApiError(409, 'WALLET_CHALLENGE_EXPIRED', 'This wallet verification challenge has expired.');
    }

    const messageHash = walletMessageHash(message);
    if (!messageHash || messageHash !== challenge.messageHash) {
      throw new ApiError(400, 'WALLET_CHALLENGE_MISMATCH', 'The signed wallet challenge does not match the issued challenge.');
    }

    const recoveredAddress = await recoverWalletMessageAddress(message, signature);
    if (!recoveredAddress || recoveredAddress !== challenge.address) {
      throw new ApiError(403, 'WALLET_SIGNATURE_INVALID', 'The wallet signature could not verify ownership of this address.');
    }

    const normalizedAddress = normalizeEvmAddress(challenge.address);
    if (!normalizedAddress) {
      throw new ApiError(500, 'WALLET_CHALLENGE_INVALID', 'The stored wallet verification challenge is invalid.');
    }

    const wallet = await completeWalletOwnershipVerification({
      userId: user.id,
      challengeId,
      chainId: challenge.chainId,
      address: challenge.address,
      checksumAddress: normalizedAddress.checksumAddress,
      proofHash: messageHash,
    });
    if (!wallet) {
      throw new ApiError(409, 'WALLET_CHALLENGE_CONFLICT', 'The wallet verification challenge changed before it could be applied. Retry verification.');
    }

    return privateJson({
      verified: true,
      wallet: {
        address: wallet.address,
        checksumAddress: wallet.checksumAddress,
        chainId: wallet.chainId,
        walletKind: wallet.walletKind,
        verificationMethod: wallet.verificationMethod,
        isPrimary: wallet.isPrimary,
        verifiedAt: wallet.verifiedAt,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
