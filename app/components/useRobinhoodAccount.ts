'use client';

import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Eip1193Provider = {
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WalletAssetBalance = {
  symbol: 'ETH' | 'USDG';
  identity: string;
  balance?: string;
  contractAddress?: string;
  decimals?: number;
  configured: boolean;
  status: 'idle' | 'loading' | 'live' | 'error' | 'not-found';
};

type ProviderError = Error & { code?: number };

export const ROBINHOOD_CHAIN_ID = '0x1237';
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

export const ROBINHOOD_CHAIN = {
  chainId: ROBINHOOD_CHAIN_ID,
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [safeRobinhoodRpcUrl()],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};

const tokenConfiguration = [
  {
    symbol: 'USDG' as const,
    contractAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    identity: 'Robinhood Chain USDG',
  },
];

function isAddress(value?: string): value is string {
  return Boolean(value && /^0x[a-fA-F0-9]{40}$/.test(value));
}

function providerMessage(error: unknown) {
  const providerError = error as ProviderError;
  if (providerError?.code === 4001) return 'The wallet request was declined.';
  return providerError?.message || 'The wallet request could not be completed.';
}

async function switchToRobinhoodChain(provider: Eip1193Provider) {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN_ID }] });
  } catch (error) {
    const providerError = error as ProviderError;
    if (providerError?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [ROBINHOOD_CHAIN] });
  }
}

function initialAssets(): WalletAssetBalance[] {
  return [
    { symbol: 'ETH', identity: 'Robinhood Chain native asset', configured: true, status: 'idle' },
    ...tokenConfiguration.map((token) => ({
      symbol: token.symbol,
      identity: token.identity,
      contractAddress: isAddress(token.contractAddress) ? token.contractAddress : undefined,
      configured: isAddress(token.contractAddress),
      status: 'idle' as const,
    })),
  ];
}

function parseBalanceSnapshot(value: unknown): { assets: WalletAssetBalance[]; updatedAt: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.assets) || typeof root.updatedAt !== 'number') return undefined;
  const assets = root.assets.filter((asset): asset is WalletAssetBalance => {
    if (!asset || typeof asset !== 'object') return false;
    const row = asset as Record<string, unknown>;
    return (row.symbol === 'ETH' || row.symbol === 'USDG')
      && typeof row.identity === 'string'
      && typeof row.configured === 'boolean'
      && (row.status === 'live' || row.status === 'error' || row.status === 'not-found')
      && (row.balance === undefined || typeof row.balance === 'string')
      && (row.contractAddress === undefined || typeof row.contractAddress === 'string')
      && (row.decimals === undefined || typeof row.decimals === 'number');
  });
  return assets.length === root.assets.length ? { assets, updatedAt: root.updatedAt } : undefined;
}

export function useRobinhoodAccount() {
  const privy = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState('');
  const [assets, setAssets] = useState<WalletAssetBalance[]>(initialAssets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [walletDisabled, setWalletDisabled] = useState(false);
  const requestGeneration = useRef(0);
  const providerRef = useRef<Eip1193Provider | undefined>(undefined);
  const walletCandidate = useMemo(
    () => wallets.find((wallet) => wallet.type === 'ethereum' && wallet.linked)
      ?? wallets.find((wallet) => wallet.type === 'ethereum'),
    [wallets],
  );
  const connectedWallet = privy.authenticated && !walletDisabled ? walletCandidate : undefined;

  const isRobinhoodChain = chainId.toLowerCase() === ROBINHOOD_CHAIN_ID;

  const resolveProvider = useCallback(async () => {
    if (connectedWallet?.type === 'ethereum') {
      return connectedWallet.getEthereumProvider() as unknown as Eip1193Provider;
    }
    return undefined;
  }, [connectedWallet]);

  const refreshBalances = useCallback(async (
    account: string,
    generation = ++requestGeneration.current,
  ) => {
    if (generation !== requestGeneration.current) return;
    setAssets((current) => current.map((asset) => asset.configured ? { ...asset, status: 'loading' } : asset));
    try {
      const response = await fetch(`/api/chain/balances?address=${encodeURIComponent(account)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Chain read failed.');
      const snapshot = parseBalanceSnapshot(await response.json());
      if (!snapshot) throw new Error('Chain read was malformed.');
      if (generation !== requestGeneration.current) return;
      setError('');
      setAssets(snapshot.assets);
      setUpdatedAt(snapshot.updatedAt);
    } catch {
      if (generation !== requestGeneration.current) return;
      setAssets((current) => current.map((asset) => asset.configured ? { ...asset, status: 'error' } : asset));
      setUpdatedAt(undefined);
      setError('Robinhood Chain did not return a balance snapshot. Retry in a moment.');
    }
  }, []);

  const synchronize = useCallback(async (provider: Eip1193Provider, providedAccounts?: unknown) => {
    const generation = ++requestGeneration.current;
    const accounts = Array.isArray(providedAccounts) ? providedAccounts : await provider.request({ method: 'eth_accounts' });
    const nextAddress = privy.authenticated && Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
    const nextChain = await provider.request({ method: 'eth_chainId' });
    const normalizedChain = typeof nextChain === 'string' ? nextChain.toLowerCase() : '';

    if (generation !== requestGeneration.current) return;
    setAddress(nextAddress);
    setChainId(normalizedChain);
    setAssets(initialAssets());
    setUpdatedAt(undefined);
    if (nextAddress) await refreshBalances(nextAddress, generation);
  }, [privy.authenticated, refreshBalances]);

  useEffect(() => {
    if ((!walletsReady || !privy.ready) && !privy.error) return;
    if (!privy.authenticated || walletDisabled || !connectedWallet) {
      requestGeneration.current += 1;
      providerRef.current = undefined;
      const resetTimer = window.setTimeout(() => {
        setAddress('');
        setChainId('');
        setAssets(initialAssets());
        setUpdatedAt(undefined);
        setError('');
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    let disposed = false;
    let provider: Eip1193Provider | undefined;
    let handleAccounts: ((...args: unknown[]) => void) | undefined;
    let handleChain: ((...args: unknown[]) => void) | undefined;

    const initialize = async () => {
      const walletConnected = await connectedWallet.isConnected().catch(() => false);
      if (!walletConnected || disposed) {
        if (!disposed) {
          providerRef.current = undefined;
          setAddress('');
          setChainId('');
          setAssets(initialAssets());
          setUpdatedAt(undefined);
        }
        return;
      }
      provider = await resolveProvider();
      if (!provider || disposed) {
        if (!disposed) {
          providerRef.current = undefined;
          setAddress('');
          setChainId('');
          setAssets(initialAssets());
        }
        return;
      }

      providerRef.current = provider;
      const runSynchronize = (providedAccounts?: unknown) => {
        setError('');
        void synchronize(provider as Eip1193Provider, providedAccounts)
          .catch((syncError) => setError(providerMessage(syncError)));
      };
      handleAccounts = (...args: unknown[]) => runSynchronize(args[0]);
      handleChain = () => runSynchronize();
      provider.on?.('accountsChanged', handleAccounts);
      provider.on?.('chainChanged', handleChain);
      runSynchronize();
    };

    void initialize().catch((syncError) => {
      if (!disposed) setError(providerMessage(syncError));
    });
    return () => {
      disposed = true;
      if (provider && handleAccounts) provider.removeListener?.('accountsChanged', handleAccounts);
      if (provider && handleChain) provider.removeListener?.('chainChanged', handleChain);
      if (providerRef.current === provider) providerRef.current = undefined;
    };
  }, [connectedWallet, privy.authenticated, privy.error, privy.ready, resolveProvider, synchronize, walletDisabled, walletsReady]);

  useEffect(() => {
    if (!address) return;
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refreshBalances(address); };
    document.addEventListener('visibilitychange', refreshVisible);
    const interval = window.setInterval(refreshVisible, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(interval);
    };
  }, [address, refreshBalances]);

  const connect = useCallback(async () => {
    if (!privy.ready && !privy.error) return;
    if (!privy.authenticated && !privy.error) {
      setWalletDisabled(false);
      setError('');
      privy.login({ loginMethods: ['wallet'], walletChainType: 'ethereum-only' });
      return;
    }
    if (!walletCandidate && !privy.error) {
      setError('');
      privy.linkWallet({ walletChainType: 'ethereum-only' });
      return;
    }

    setWalletDisabled(false);
    const provider = walletCandidate?.type === 'ethereum'
      ? await walletCandidate.getEthereumProvider() as unknown as Eip1193Provider
      : undefined;
    if (!provider) {
      setError('No EVM wallet was detected in this browser.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      if (walletCandidate && !walletCandidate.linked) await walletCandidate.loginOrLink();
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
        throw new Error('The wallet did not return an account.');
      }
      if (walletCandidate?.type === 'ethereum') await walletCandidate.switchChain(4663);
      else await switchToRobinhoodChain(provider);
      const switchedProvider = walletCandidate?.type === 'ethereum'
        ? await walletCandidate.getEthereumProvider() as unknown as Eip1193Provider
        : provider;
      if (!switchedProvider) throw new Error('The connected wallet provider did not respond.');
      providerRef.current = switchedProvider;
      await synchronize(switchedProvider);
    } catch (requestError) {
      setError(providerMessage(requestError));
      await synchronize(provider).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [privy, synchronize, walletCandidate]);

  const switchNetwork = useCallback(async () => {
    const provider = await resolveProvider();
    if (!provider) {
      setError('No EVM wallet was detected in this browser.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (connectedWallet?.type === 'ethereum') await connectedWallet.switchChain(4663);
      else await switchToRobinhoodChain(provider);
      const switchedProvider = await resolveProvider();
      if (!switchedProvider) throw new Error('The connected wallet provider did not respond.');
      providerRef.current = switchedProvider;
      await synchronize(switchedProvider);
    } catch (requestError) {
      setError(providerMessage(requestError));
    } finally {
      setBusy(false);
    }
  }, [connectedWallet, resolveProvider, synchronize]);

  const refresh = useCallback(async () => {
    if (address) await refreshBalances(address);
  }, [address, refreshBalances]);

  const signMessage = useCallback(async (message: string) => {
    const provider = await resolveProvider();
    if (!provider || !address) throw new Error('Connect the wallet that owns this venue account first.');
    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, address],
    });
    if (typeof signature !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(signature)) {
      throw new Error('The wallet did not return a valid signature.');
    }
    return signature;
  }, [address, resolveProvider]);

  const disconnect = useCallback(async () => {
    requestGeneration.current += 1;
    setBusy(true);
    setError('');
    setWalletDisabled(true);
    providerRef.current = undefined;
    setAddress('');
    setChainId('');
    setAssets(initialAssets());
    setUpdatedAt(undefined);
    try {
      await walletCandidate?.disconnect();
    } finally {
      setBusy(false);
    }
  }, [walletCandidate]);

  return useMemo(() => ({
    address,
    assets,
    busy,
    connect,
    disconnect,
    error,
    isRobinhoodChain,
    refresh,
    signMessage,
    switchNetwork,
    updatedAt,
  }), [address, assets, busy, connect, disconnect, error, isRobinhoodChain, refresh, signMessage, switchNetwork, updatedAt]);
}

export type RobinhoodAccountState = ReturnType<typeof useRobinhoodAccount>;

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
