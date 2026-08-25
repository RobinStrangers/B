'use client';

import { useIdentityToken, usePrivy } from '@privy-io/react-auth';
import { useCallback } from 'react';

export function useAventaAuth() {
  const privy = usePrivy();
  const { authenticated, getAccessToken } = privy;
  const { identityToken } = useIdentityToken();

  const authFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (authenticated) {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Your Privy session could not be verified. Please sign in again.');
      }
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (identityToken) headers.set('Privy-Id-Token', identityToken);
    }

    return fetch(input, {
      ...init,
      headers,
      credentials: init.credentials ?? 'same-origin',
    });
  }, [authenticated, getAccessToken, identityToken]);

  return {
    ...privy,
    authFetch,
    identityToken,
    requestReady: privy.ready || Boolean(privy.error),
  };
}
