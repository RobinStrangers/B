'use client';

import { PrivyProvider, useIdentityToken, usePrivy } from '@privy-io/react-auth';
import { useEffect, useRef, type ReactNode } from 'react';
import { DEFAULT_PRIVY_APP_ID, PRIVY_LOGIN_METHODS } from './lib/privy-config';

const WALLET_SYNC_INTERVAL_MS = 4 * 60 * 1000;

const ROBINHOOD_RPC_FALLBACK = 'https://rpc.mainnet.chain.robinhood.com';

function safeRobinhoodRpcUrl() {
  const value = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL?.trim();
  if (!value) return ROBINHOOD_RPC_FALLBACK;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : ROBINHOOD_RPC_FALLBACK;
  } catch {
    return ROBINHOOD_RPC_FALLBACK;
  }
}

const robinhoodRpcUrl = safeRobinhoodRpcUrl();

const robinhoodChain = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [robinhoodRpcUrl] },
    public: { http: [robinhoodRpcUrl] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Chain Explorer', url: 'https://robinhoodchain.blockscout.com' },
  },
} as const;

function VerifiedWalletSync() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const synchronizationInFlightRef = useRef(false);
  const linkedAccountFingerprint = user?.linkedAccounts
    .map((account) => {
      const address = 'address' in account && typeof account.address === 'string'
        ? account.address.toLowerCase()
        : '';
      return `${account.type}:${address}`;
    })
    .sort()
    .join('|') ?? '';

  useEffect(() => {
    if (!ready || !authenticated || !user?.id) return;

    const controller = new AbortController();

    const synchronize = async () => {
      if (synchronizationInFlightRef.current || controller.signal.aborted) return;
      synchronizationInFlightRef.current = true;
      try {
        const accessToken = await getAccessToken();
        if (!accessToken || controller.signal.aborted) return;

        const headers = new Headers({
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        });
        if (identityToken) headers.set('Privy-Id-Token', identityToken);

        await fetch('/api/account/wallets/sync', {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers,
          body: '{}',
          signal: controller.signal,
        }).catch(() => undefined);
      } finally {
        synchronizationInFlightRef.current = false;
      }
    };

    void synchronize();
    const interval = window.setInterval(() => void synchronize(), WALLET_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      controller.abort();
      synchronizationInFlightRef.current = false;
    };
  }, [authenticated, getAccessToken, identityToken, linkedAccountFingerprint, ready, user?.id]);

  return null;
}

export default function Providers({
  children,
  privyAppId,
}: {
  children: ReactNode;
  privyAppId?: string;
}) {
  const appId = privyAppId?.trim() || DEFAULT_PRIVY_APP_ID;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: [...PRIVY_LOGIN_METHODS],
        appearance: {
          theme: '#2B3740',
          accentColor: '#FC6224',
          logo: '/aventa-mark.png',
          landingHeader: 'Enter Aventa',
          loginMessage: 'Choose how you want to access your trading profile.',
          showWalletLoginFirst: false,
          walletChainType: 'ethereum-only',
        },
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
        supportedChains: [robinhoodChain],
        defaultChain: robinhoodChain,
      }}
    >
      <VerifiedWalletSync />
      {children}
    </PrivyProvider>
  );
}
