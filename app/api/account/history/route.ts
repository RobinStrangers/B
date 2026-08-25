import { apiErrorResponse, ApiError, privateJson, requireProfileUser } from '@/app/lib/api';
import { getIndexerCheckpoint, getVerifiedVaultHistory } from '@/db/account';

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const INDEXER_FRESHNESS_SECONDS = 180;

export async function GET(request: Request) {
  try {
    const { user } = await requireProfileUser(request);
    const address = new URL(request.url).searchParams.get('address')?.trim() ?? '';
    if (!ADDRESS_PATTERN.test(address)) {
      throw new ApiError(400, 'INVALID_WALLET_ADDRESS', 'A valid EVM wallet address is required.');
    }

    const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS?.trim() ?? '';
    const configured = ADDRESS_PATTERN.test(vaultAddress);
    const [history, checkpoint] = await Promise.all([
      getVerifiedVaultHistory(user.id, address, configured ? vaultAddress : null),
      getIndexerCheckpoint('vault-events', configured ? vaultAddress : null),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const checkpointAge = checkpoint ? now - checkpoint.updated_at : Number.POSITIVE_INFINITY;
    const indexed = configured && Boolean(
      checkpoint
      && checkpoint.state === 'healthy'
      && checkpoint.last_scanned_block >= 0
      && checkpointAge >= -30
      && checkpointAge <= INDEXER_FRESHNESS_SECONDS,
    );

    if (!history.ownershipVerified) {
      return privateJson({
        configured,
        indexed,
        ownershipVerified: false,
        items: [],
        message: 'Verify wallet ownership with Privy or a signed-wallet flow before private account history can be shown.',
      });
    }

    if (!configured) {
      return privateJson({
        configured: false,
        indexed: false,
        ownershipVerified: true,
        items: history.items,
        message: 'History activates after a verified vault and event indexer are configured.',
      });
    }

    return privateJson({
      configured: true,
      indexed,
      ownershipVerified: true,
      items: indexed ? history.items : [],
      message: indexed
        ? (history.items.length ? undefined : 'No verified vault events were found for this wallet.')
        : 'The vault address is configured, but verified event indexing is not connected.',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
