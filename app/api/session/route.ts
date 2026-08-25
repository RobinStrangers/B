import { apiErrorResponse, getRequestAuthentication, privateJson, requireProfileUser } from '@/app/lib/api';

export async function GET(request: Request) {
  try {
    const authentication = await getRequestAuthentication(request);
    if (!authentication) {
      return privateJson({
        authenticated: false,
        authProvider: null,
        authorization: 'anonymous',
        tradingAuthorization: 'not-granted',
        persistence: { provider: 'd1', status: 'authentication-required' },
        user: null,
      });
    }

    const { identity, user, privy } = await requireProfileUser(request, authentication);
    return privateJson({
      authenticated: true,
      authProvider: identity.provider === 'privy' ? 'privy' : 'sites',
      authorization: 'profile-only',
      tradingAuthorization: 'not-granted',
      persistence: { provider: 'd1', status: 'ready' },
      walletAttestation: privy
        ? {
            identityTokenVerified: privy.identityTokenVerified,
            source: 'privy',
          }
        : null,
      user: {
        email: identity.email,
        fullName: identity.displayName,
        displayName: user.displayName ?? identity.displayName ?? identity.email ?? 'Aventa user',
        createdAt: new Date(user.createdAt * 1000).toISOString(),
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
