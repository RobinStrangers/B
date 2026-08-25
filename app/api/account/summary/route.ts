import { apiErrorResponse, privateJson, requireProfileUser } from '@/app/lib/api';
import {
  getAccountPreferences,
  getIndexerCheckpoint,
  getProjectionCounts,
  getVerifiedWallets,
} from '@/db/account';
import { getExecutionConfigurationStatus } from '@/app/lib/execution-client';

const EMPTY_PROJECTIONS = { positions: 0, openOrders: 0, trades: 0, fundingPayments: 0 };
const INDEXER_FRESHNESS_SECONDS = 180;

function checkpointIsHealthy(checkpoint: Awaited<ReturnType<typeof getIndexerCheckpoint>>) {
  if (!checkpoint || checkpoint.state !== 'healthy' || checkpoint.last_scanned_block < 0) return false;
  const age = Math.floor(Date.now() / 1000) - checkpoint.updated_at;
  return age >= -30 && age <= INDEXER_FRESHNESS_SECONDS;
}

export async function GET(request: Request) {
  try {
    const { identity, user } = await requireProfileUser(request);
    const vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS?.trim() ?? null;
    const venueAddress = process.env.NEXT_PUBLIC_VENUE_ADDRESS?.trim() ?? null;
    const [preferences, wallets, vaultCheckpoint, venueCheckpoint] = await Promise.all([
      getAccountPreferences(user.id),
      getVerifiedWallets(user.id),
      getIndexerCheckpoint('vault-events', vaultAddress),
      getIndexerCheckpoint('venue-events', venueAddress),
    ]);
    const projections = checkpointIsHealthy(venueCheckpoint)
      ? await getProjectionCounts(user.id, venueAddress)
      : EMPTY_PROJECTIONS;

    return privateJson({
      account: {
        status: user.status,
        displayName: user.displayName ?? identity.displayName ?? identity.email ?? 'Aventa user',
        email: identity.email,
        createdAt: new Date(user.createdAt * 1000).toISOString(),
      },
      preferences,
      verifiedWallets: wallets.map((wallet) => ({
        address: wallet.address,
        checksumAddress: wallet.checksumAddress,
        chainId: wallet.chainId,
        walletKind: wallet.walletKind,
        verificationMethod: wallet.verificationMethod,
        isPrimary: wallet.isPrimary,
        verifiedAt: wallet.verifiedAt,
      })),
      projections,
      indexers: {
        vault: vaultCheckpoint ?? null,
        venue: venueCheckpoint ?? null,
      },
      execution: getExecutionConfigurationStatus(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
