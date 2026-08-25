import {
  getAddress,
  hashMessage,
  isAddress,
  recoverMessageAddress,
  type Hex,
} from 'viem';

export const WALLET_OWNERSHIP_CHAIN_ID = 4663;
export const WALLET_OWNERSHIP_CHALLENGE_TTL_SECONDS = 5 * 60;
export const WALLET_CHALLENGE_ID_PATTERN = /^wch_[a-f0-9]{32}$/;
export const WALLET_SIGNATURE_PATTERN = /^0x[a-fA-F0-9]{130}$/;
const MAX_WALLET_MESSAGE_LENGTH = 4_096;

export function normalizeEvmAddress(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  try {
    const checksumAddress = getAddress(trimmed.toLowerCase());
    return {
      address: checksumAddress.toLowerCase(),
      checksumAddress,
    };
  } catch {
    return null;
  }
}

export function walletOwnershipMessage(options: {
  origin: string;
  checksumAddress: string;
  challengeId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}) {
  const url = new URL(options.origin);
  return [
    `${url.host} wants you to sign in with your Ethereum account:`,
    options.checksumAddress,
    '',
    'Verify this wallet for Aventa trading on Robinhood Chain. This does not submit a transaction or grant custody of your wallet.',
    '',
    `URI: ${url.origin}`,
    'Version: 1',
    `Chain ID: ${WALLET_OWNERSHIP_CHAIN_ID}`,
    `Nonce: ${options.nonce}`,
    `Issued At: ${options.issuedAt.toISOString()}`,
    `Expiration Time: ${options.expiresAt.toISOString()}`,
    `Request ID: ${options.challengeId}`,
  ].join('\n');
}

export function walletMessageHash(message: string) {
  if (!message || message.length > MAX_WALLET_MESSAGE_LENGTH) return null;
  return hashMessage(message).toLowerCase();
}

export async function recoverWalletMessageAddress(message: string, signature: string) {
  if (!message || message.length > MAX_WALLET_MESSAGE_LENGTH || !WALLET_SIGNATURE_PATTERN.test(signature)) {
    return null;
  }
  try {
    return (await recoverMessageAddress({
      message,
      signature: signature as Hex,
    })).toLowerCase();
  } catch {
    return null;
  }
}
