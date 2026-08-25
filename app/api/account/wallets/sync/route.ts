import {
  apiErrorResponse,
  ApiError,
  privateJson,
  readJsonObject,
  requireProfileUser,
  requireSameOrigin,
} from '@/app/lib/api';
import { getAuthoritativePrivyWallets } from '@/app/lib/privy-server';
import { beginPrivyWalletSync, syncPrivyWallets } from '@/db/account';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await readJsonObject(request);
    const { identity, user, privy } = await requireProfileUser(request);

    if (identity.provider !== 'privy' || !privy) {
      throw new ApiError(400, 'PRIVY_SESSION_REQUIRED', 'A verified Privy session is required.');
    }
    const syncRequestId = await beginPrivyWalletSync(user.id);
    const authoritativeWallets = await getAuthoritativePrivyWallets(privy.userId);
    const result = await syncPrivyWallets(user.id, authoritativeWallets, syncRequestId);
    return privateJson({
      synchronized: result.synchronized,
      verifiedWallets: result.linkedWallets,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
