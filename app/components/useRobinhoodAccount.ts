'use client';

import { useWallets } from '@privy-io/react-auth';
import { encodeFunctionData, parseUnits, type Address } from 'viem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAventaAuth } from './useAventaAuth';
import {
  AVENTA_TREASURY_ADDRESS,
  ROBINHOOD_LIGHTER_PROXY,
  ROBINHOOD_LIGHTER_WITHDRAWAL_ABI,
  ROBINHOOD_USDG_ADDRESS,
  ROBINHOOD_USDG_ASSET_INDEX,
  ROBINHOOD_USDG_DECIMALS,
  USDG_ERC20_ABI,
} from '../lib/lighter-robinhood';

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

type ProviderError = Error & {
  code?: number;
  data?: unknown;
  cause?: unknown;
  error?: unknown;
  details?: string;
  shortMessage?: string;
};

export const ROBINHOOD_CHAIN_ID = '0x1237';
const ROBINHOOD_RPC_FALLBACK = 'https://rpc.mainnet.chain.robinhood.com';
const UINT128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

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

  const candidates: unknown[] = [
    providerError?.shortMessage,
    providerError?.details,
    providerError?.message,
    providerError?.data,
    providerError?.cause,
    providerError?.error,
  ];
  const visited = new Set<unknown>();

  const extract = (value: unknown): string | undefined => {
    if (!value || visited.has(value)) return undefined;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed.toLowerCase() === 'internal error') return undefined;
      return trimmed;
    }
    if (typeof value !== 'object') return undefined;
    visited.add(value);
    const row = value as Record<string, unknown>;
    for (const key of ['reason', 'message', 'shortMessage', 'details', 'data', 'cause', 'error']) {
      const nested = extract(row[key]);
      if (nested) return nested;
    }
    return undefined;
  };

  for (const candidate of candidates) {
    const message = extract(candidate);
    if (message) return message;
  }
  return providerError?.code ? `Wallet RPC error (${providerError.code}).` : 'The wallet request could not be completed.';
}

function walletClientType(wallet: unknown) {
  if (!wallet || typeof wallet !== 'object') return '';
  const value = (wallet as Record<string, unknown>).walletClientType;
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isUnsupportedRobinhoodSmartWallet(wallet: unknown) {
  const clientType = walletClientType(wallet);
  return clientType === 'base_account'
    || clientType === 'coinbase_smart_wallet'
    || clientType === 'privy_smart_account';
}

type TransactionReceipt = { status?: string; transactionHash?: string };

type VenueOnboardingSnapshot = {
  accountExists: boolean;
  accountIndexes: number[];
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function rpcResponseMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback;
  const root = payload as Record<string, unknown>;
  const error = root.error;
  if (!error || typeof error !== 'object') return fallback;
  const row = error as Record<string, unknown>;
  const message = typeof row.message === 'string' && row.message.trim() ? row.message.trim() : fallback;
  const rpcCode = typeof row.rpcCode === 'number' ? ` (RPC ${row.rpcCode})` : '';
  return `${message}${rpcCode}`;
}

async function robinhoodReadRpc(method: 'eth_call' | 'eth_estimateGas' | 'eth_getTransactionReceipt', params: unknown[]) {
  const response = await fetch('/api/chain/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw new Error(rpcResponseMessage(payload, 'Robinhood Chain RPC request failed.'));
  if (!payload || typeof payload !== 'object' || !('result' in payload)) {
    throw new Error('Robinhood Chain RPC returned an invalid response.');
  }
  return (payload as Record<string, unknown>).result;
}

function bufferedGas(gasHex: string) {
  const estimate = BigInt(gasHex);
  const padded = (estimate * BigInt(125) + BigInt(99)) / BigInt(100);
  return `0x${padded.toString(16)}`;
}

async function waitForReceipt(txHash: string, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await robinhoodReadRpc('eth_getTransactionReceipt', [txHash]) as TransactionReceipt | null;
    if (receipt) {
      if (receipt.status?.toLowerCase() === '0x0') throw new Error('The Robinhood Chain transaction reverted.');
      return receipt;
    }
    await sleep(1_250);
  }
  throw new Error('The transaction was submitted, but confirmation is taking longer than expected. Check Robinhood Chain before retrying.');
}

async function onboardingSnapshot(address: string): Promise<VenueOnboardingSnapshot> {
  const response = await fetch(`/api/venue/onboarding?address=${encodeURIComponent(address)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    throw new Error(verificationResponseMessage(payload, 'Robinhood Lighter onboarding is temporarily unavailable.'));
  }
  if (!payload || typeof payload !== 'object') throw new Error('Robinhood Lighter onboarding returned an invalid response.');
  const root = payload as Record<string, unknown>;
  const indexes = Array.isArray(root.accountIndexes)
    ? root.accountIndexes.filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    : [];
  return { accountExists: root.accountExists === true, accountIndexes: indexes };
}

async function switchToRobinhoodChain(provider: Eip1193Provider) {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN_ID }] });
  } catch (error) {
    const providerError = error as ProviderError;
    if (providerError?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [ROBINHOOD_CHAIN] });
    const chainAfterAdd = await provider.request({ method: 'eth_chainId' });
    if (typeof chainAfterAdd !== 'string' || chainAfterAdd.toLowerCase() !== ROBINHOOD_CHAIN_ID) {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN_ID }] });
    }
  }
}

async function ensureRobinhoodChain(
  provider: Eip1193Provider,
  wallet?: {
    type?: string;
    switchChain?: (chainId: number) => Promise<unknown>;
    getEthereumProvider?: () => Promise<unknown>;
  },
) {
  let activeProvider = provider;
  const initialChain = await activeProvider.request({ method: 'eth_chainId' });
  if (typeof initialChain === 'string' && initialChain.toLowerCase() === ROBINHOOD_CHAIN_ID) {
    return activeProvider;
  }

  if (wallet?.type === 'ethereum' && wallet.switchChain) {
    try {
      await wallet.switchChain(4663);
    } catch (error) {
      const providerError = error as ProviderError;
      if (providerError?.code === 4001) throw error;
    }
    if (wallet.getEthereumProvider) {
      activeProvider = await wallet.getEthereumProvider() as unknown as Eip1193Provider;
    }
  }

  let chainId = await activeProvider.request({ method: 'eth_chainId' });
  if (typeof chainId !== 'string' || chainId.toLowerCase() !== ROBINHOOD_CHAIN_ID) {
    await switchToRobinhoodChain(activeProvider);
    if (wallet?.type === 'ethereum' && wallet.getEthereumProvider) {
      activeProvider = await wallet.getEthereumProvider() as unknown as Eip1193Provider;
    }
    chainId = await activeProvider.request({ method: 'eth_chainId' });
  }

  if (typeof chainId !== 'string' || chainId.toLowerCase() !== ROBINHOOD_CHAIN_ID) {
    throw new Error('Robinhood Chain switch did not complete. Switch the wallet to chain 4663 and try again.');
  }
  return activeProvider;
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


function verifiedWalletFromSummary(value: unknown, address: string) {
  if (!value || typeof value !== 'object') return false;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.verifiedWallets)) return false;
  const normalizedAddress = address.toLowerCase();
  return root.verifiedWallets.some((wallet) => {
    if (!wallet || typeof wallet !== 'object') return false;
    const row = wallet as Record<string, unknown>;
    return row.chainId === 4663
      && typeof row.address === 'string'
      && row.address.toLowerCase() === normalizedAddress
      && (row.verificationMethod === 'siwe_eoa'
        || row.verificationMethod === 'eip1271'
        || row.verificationMethod === 'privy_attestation');
  });
}

function verificationResponseMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback;
  const root = payload as Record<string, unknown>;
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : null;
  return typeof error?.message === 'string' && error.message.trim() ? error.message : fallback;
}

export function useRobinhoodAccount() {
  const privy = useAventaAuth();
  const { authFetch } = privy;
  const { wallets, ready: walletsReady } = useWallets();
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState('');
  const [assets, setAssets] = useState<WalletAssetBalance[]>(initialAssets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [walletDisabled, setWalletDisabled] = useState(false);
  const [verifiedAddress, setVerifiedAddress] = useState('');
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [withdrawalClaimReady, setWithdrawalClaimReady] = useState(false);
  const [withdrawalClaimBusy, setWithdrawalClaimBusy] = useState(false);
  const [withdrawalClaimError, setWithdrawalClaimError] = useState('');
  const withdrawalClaimGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const ownershipRequestGeneration = useRef(0);
  const providerRef = useRef<Eip1193Provider | undefined>(undefined);
  const walletCandidate = useMemo(() => {
    const evmWallets = wallets.filter((wallet) => wallet.type === 'ethereum');
    const supportedExternal = evmWallets.filter((wallet) => (
      walletClientType(wallet) !== 'privy' && !isUnsupportedRobinhoodSmartWallet(wallet)
    ));
    return supportedExternal.find((wallet) => wallet.linked)
      ?? supportedExternal[0]
      ?? evmWallets.find((wallet) => wallet.linked && !isUnsupportedRobinhoodSmartWallet(wallet))
      ?? evmWallets.find((wallet) => !isUnsupportedRobinhoodSmartWallet(wallet))
      ?? evmWallets[0];
  }, [wallets]);
  const connectedWallet = privy.authenticated && !walletDisabled ? walletCandidate : undefined;

  const isRobinhoodChain = chainId.toLowerCase() === ROBINHOOD_CHAIN_ID;
  const ownershipVerified = Boolean(
    privy.authenticated
    && isRobinhoodChain
    && address
    && verifiedAddress === address.toLowerCase()
  );

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
    if (generation !== requestGeneration.current) return undefined;
    setAssets((current) => current.map((asset) => asset.configured ? { ...asset, status: 'loading' } : asset));
    try {
      const response = await fetch(`/api/chain/balances?address=${encodeURIComponent(account)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Chain read failed.');
      const snapshot = parseBalanceSnapshot(await response.json());
      if (!snapshot) throw new Error('Chain read was malformed.');
      if (generation !== requestGeneration.current) return undefined;
      setError('');
      setAssets(snapshot.assets);
      setUpdatedAt(snapshot.updatedAt);
      return snapshot;
    } catch {
      if (generation !== requestGeneration.current) return undefined;
      setAssets((current) => current.map((asset) => asset.configured ? { ...asset, status: 'error' } : asset));
      setUpdatedAt(undefined);
      setError('Robinhood Chain did not return a balance snapshot. Retry in a moment.');
      return undefined;
    }
  }, []);

  const refreshWithdrawalClaim = useCallback(async (account = address) => {
    const generation = ++withdrawalClaimGeneration.current;
    if (!account || !isRobinhoodChain || !isAddress(account)) {
      setWithdrawalClaimReady(false);
      setWithdrawalClaimError('');
      return false;
    }

    const claimData = encodeFunctionData({
      abi: ROBINHOOD_LIGHTER_WITHDRAWAL_ABI,
      functionName: 'withdrawPendingBalance',
      args: [account as Address, ROBINHOOD_USDG_ASSET_INDEX, UINT128_MAX],
    });
    try {
      const gas = await robinhoodReadRpc('eth_estimateGas', [{
        from: account,
        to: ROBINHOOD_LIGHTER_PROXY,
        data: claimData,
        value: '0x0',
      }]);
      const ready = typeof gas === 'string' && /^0x[a-fA-F0-9]+$/.test(gas) && BigInt(gas) > BigInt(0);
      if (generation === withdrawalClaimGeneration.current) {
        setWithdrawalClaimReady(ready);
        if (ready) setWithdrawalClaimError('');
      }
      return ready;
    } catch {
      if (generation === withdrawalClaimGeneration.current) setWithdrawalClaimReady(false);
      return false;
    }
  }, [address, isRobinhoodChain]);

  const refreshOwnershipVerification = useCallback(async (account: string) => {
    const generation = ++ownershipRequestGeneration.current;
    if (!privy.authenticated || !account) {
      setVerifiedAddress('');
      return false;
    }
    const normalizedAccount = account.toLowerCase();
    try {
      const response = await authFetch('/api/account/summary', { cache: 'no-store' });
      if (generation !== ownershipRequestGeneration.current) return false;
      if (!response.ok) {
        setVerifiedAddress('');
        return false;
      }
      const payload = await response.json();
      if (generation !== ownershipRequestGeneration.current) return false;
      const verified = verifiedWalletFromSummary(payload, account);
      setVerifiedAddress(verified ? normalizedAccount : '');
      return verified;
    } catch {
      if (generation === ownershipRequestGeneration.current) setVerifiedAddress('');
      return false;
    }
  }, [authFetch, privy.authenticated]);

  const verifyOwnershipWithProvider = useCallback(async (
    provider: Eip1193Provider,
    account: string,
  ) => {
    const normalizedAccount = account.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalizedAccount)) {
      throw new Error('The connected wallet address is invalid.');
    }
    const currentChain = await provider.request({ method: 'eth_chainId' });
    if (typeof currentChain !== 'string' || currentChain.toLowerCase() !== ROBINHOOD_CHAIN_ID) {
      throw new Error('Switch to Robinhood Chain before verifying this wallet.');
    }

    const alreadyVerified = await refreshOwnershipVerification(normalizedAccount);
    if (alreadyVerified) return true;

    setVerificationBusy(true);
    try {
      const challengeResponse = await authFetch('/api/account/wallets/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: normalizedAccount, chainId: 4663 }),
      });
      const challengePayload = await challengeResponse.json().catch(() => undefined);
      if (!challengeResponse.ok) {
        throw new Error(verificationResponseMessage(challengePayload, 'Wallet verification could not start.'));
      }
      if (!challengePayload || typeof challengePayload !== 'object') {
        throw new Error('Wallet verification returned an invalid challenge.');
      }
      const challenge = challengePayload as Record<string, unknown>;
      if (
        typeof challenge.challengeId !== 'string'
        || typeof challenge.message !== 'string'
        || typeof challenge.address !== 'string'
        || challenge.address.toLowerCase() !== normalizedAccount
        || challenge.chainId !== 4663
      ) {
        throw new Error('Wallet verification returned an invalid challenge.');
      }

      const signature = await provider.request({
        method: 'personal_sign',
        params: [challenge.message, account],
      });
      if (typeof signature !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(signature)) {
        throw new Error('The wallet did not return a valid ownership signature.');
      }

      const verifyResponse = await authFetch('/api/account/wallets/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          message: challenge.message,
          signature,
        }),
      });
      const verifyPayload = await verifyResponse.json().catch(() => undefined);
      if (!verifyResponse.ok) {
        throw new Error(verificationResponseMessage(verifyPayload, 'Wallet ownership verification failed.'));
      }
      if (!verifyPayload || typeof verifyPayload !== 'object' || (verifyPayload as Record<string, unknown>).verified !== true) {
        throw new Error('Wallet ownership verification returned an invalid response.');
      }
      ownershipRequestGeneration.current += 1;
      setVerifiedAddress(normalizedAccount);
      return true;
    } finally {
      setVerificationBusy(false);
    }
  }, [authFetch, refreshOwnershipVerification]);

  const synchronize = useCallback(async (provider: Eip1193Provider, providedAccounts?: unknown) => {
    const generation = ++requestGeneration.current;
    const accounts = Array.isArray(providedAccounts) ? providedAccounts : await provider.request({ method: 'eth_accounts' });
    const nextAddress = privy.authenticated && Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
    const nextChain = await provider.request({ method: 'eth_chainId' });
    const normalizedChain = typeof nextChain === 'string' ? nextChain.toLowerCase() : '';

    if (generation !== requestGeneration.current) return;
    setAddress(nextAddress);
    setChainId(normalizedChain);
    ownershipRequestGeneration.current += 1;
    setVerifiedAddress('');
    // Do not read the connected wallet's token balances during normal Aventa
    // navigation. Those balances are only needed when the user explicitly
    // opens the Deposit flow. The Wallet screen itself is venue-account state.
    setAssets(initialAssets());
    setUpdatedAt(undefined);
  }, [privy.authenticated]);

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
        ownershipRequestGeneration.current += 1;
        setVerifiedAddress('');
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
          ownershipRequestGeneration.current += 1;
          setVerifiedAddress('');
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
          ownershipRequestGeneration.current += 1;
          setVerifiedAddress('');
        }
        return;
      }

      try {
        provider = await ensureRobinhoodChain(provider, connectedWallet);
      } catch (switchError) {
        if (!disposed) setError(providerMessage(switchError));
      }
      if (disposed) return;

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
    if (!address || !isRobinhoodChain) {
      withdrawalClaimGeneration.current += 1;
      const resetTimer = window.setTimeout(() => {
        setWithdrawalClaimReady(false);
        setWithdrawalClaimError('');
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }

    const refreshClaim = () => {
      if (document.visibilityState === 'visible') void refreshWithdrawalClaim(address);
    };
    const refreshTimer = window.setTimeout(refreshClaim, 0);
    const interval = window.setInterval(refreshClaim, 8_000);
    const handleWithdrawalSubmitted = () => {
      window.setTimeout(refreshClaim, 1_500);
      window.setTimeout(refreshClaim, 4_000);
    };
    window.addEventListener('aventa:withdrawal-submitted', handleWithdrawalSubmitted);
    document.addEventListener('visibilitychange', refreshClaim);
    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
      window.removeEventListener('aventa:withdrawal-submitted', handleWithdrawalSubmitted);
      document.removeEventListener('visibilitychange', refreshClaim);
    };
  }, [address, isRobinhoodChain, refreshWithdrawalClaim]);

  useEffect(() => {
    if (!privy.authenticated || !address || !isRobinhoodChain) return;
    const refreshTimer = window.setTimeout(() => {
      void refreshOwnershipVerification(address).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [address, isRobinhoodChain, privy.authenticated, refreshOwnershipVerification]);

  const verifyOwnership = useCallback(async () => {
    if (!address) throw new Error('Connect an EVM wallet before verifying ownership.');
    const provider = await resolveProvider();
    if (!provider) throw new Error('No EVM wallet was detected in this browser.');
    setError('');
    setBusy(true);
    try {
      const switchedProvider = !isRobinhoodChain
        ? await ensureRobinhoodChain(provider, connectedWallet)
        : provider;
      const accounts = await switchedProvider.request({ method: 'eth_accounts' });
      const activeAccount = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
      if (!activeAccount || activeAccount.toLowerCase() !== address.toLowerCase()) {
        throw new Error('The active wallet account changed. Reconnect the wallet and try again.');
      }
      await synchronize(switchedProvider, accounts);
      return await verifyOwnershipWithProvider(switchedProvider, activeAccount);
    } catch (requestError) {
      setError(providerMessage(requestError));
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [address, connectedWallet, isRobinhoodChain, resolveProvider, synchronize, verifyOwnershipWithProvider]);

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
      const switchedProvider = await ensureRobinhoodChain(provider, walletCandidate);
      providerRef.current = switchedProvider;
      await synchronize(switchedProvider);
      const activeAccounts = await switchedProvider.request({ method: 'eth_accounts' });
      const activeAccount = Array.isArray(activeAccounts) && typeof activeAccounts[0] === 'string' ? activeAccounts[0] : '';
      if (activeAccount) {
        try {
          await verifyOwnershipWithProvider(switchedProvider, activeAccount);
        } catch (verificationError) {
          setError(providerMessage(verificationError));
        }
      }
    } catch (requestError) {
      setError(providerMessage(requestError));
      await synchronize(provider).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [privy, synchronize, verifyOwnershipWithProvider, walletCandidate]);

  const switchNetwork = useCallback(async () => {
    const provider = await resolveProvider();
    if (!provider) {
      setError('No EVM wallet was detected in this browser.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const switchedProvider = await ensureRobinhoodChain(provider, connectedWallet);
      providerRef.current = switchedProvider;
      await synchronize(switchedProvider);
      const accounts = await switchedProvider.request({ method: 'eth_accounts' });
      const activeAccount = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
      if (activeAccount) {
        try {
          await verifyOwnershipWithProvider(switchedProvider, activeAccount);
        } catch (verificationError) {
          setError(providerMessage(verificationError));
        }
      }
    } catch (requestError) {
      setError(providerMessage(requestError));
    } finally {
      setBusy(false);
    }
  }, [connectedWallet, resolveProvider, synchronize, verifyOwnershipWithProvider]);



  const claimPendingWithdrawalUsdg = useCallback(async () => {
    if (!address) throw new Error('Connect the wallet that owns this Lighter account before claiming USDG.');
    if (!ownershipVerified) throw new Error('Verify wallet ownership before claiming a withdrawal.');

    const ethBalance = assets.find((asset) => asset.symbol === 'ETH');
    if (ethBalance?.status === 'live' && ethBalance.balance && Number(ethBalance.balance) <= 0) {
      throw new Error('This wallet needs a small amount of ETH on Robinhood Chain for the claim transaction gas.');
    }

    setWithdrawalClaimBusy(true);
    setWithdrawalClaimError('');
    try {
      let provider = await resolveProvider();
      if (!provider) throw new Error('No EVM wallet was detected in this browser.');
      if (isUnsupportedRobinhoodSmartWallet(connectedWallet)) {
        throw new Error('This smart wallet does not support Robinhood Chain. Connect an EOA wallet such as Bitget, MetaMask, or Rabby.');
      }

      provider = await ensureRobinhoodChain(provider, connectedWallet);
      providerRef.current = provider;
      const accounts = await provider.request({ method: 'eth_accounts' });
      const activeAccount = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
      if (!activeAccount || activeAccount.toLowerCase() !== address.toLowerCase()) {
        throw new Error('The active wallet account changed. Reconnect the verified wallet and try again.');
      }

      const claimData = encodeFunctionData({
        abi: ROBINHOOD_LIGHTER_WITHDRAWAL_ABI,
        functionName: 'withdrawPendingBalance',
        args: [activeAccount as Address, ROBINHOOD_USDG_ASSET_INDEX, UINT128_MAX],
      });
      const request = {
        from: activeAccount,
        to: ROBINHOOD_LIGHTER_PROXY,
        data: claimData,
        value: '0x0',
      };

      let gas: unknown;
      try {
        gas = await robinhoodReadRpc('eth_estimateGas', [request]);
      } catch {
        await refreshBalances(activeAccount).catch(() => undefined);
        setWithdrawalClaimReady(false);
        throw new Error('This withdrawal is not claimable yet, or Lighter already settled it automatically. Refresh your wallet balance and try again if the USDG has not arrived.');
      }
      if (typeof gas !== 'string' || !/^0x[a-fA-F0-9]+$/.test(gas)) {
        throw new Error('Robinhood Chain did not return a valid gas estimate for the withdrawal claim.');
      }

      let txHash: unknown;
      try {
        txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ ...request, gas: bufferedGas(gas) }],
        });
      } catch (claimError) {
        throw new Error(`USDG withdrawal claim failed: ${providerMessage(claimError)}`);
      }
      if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
        throw new Error('The wallet did not return a valid withdrawal claim transaction hash.');
      }

      await waitForReceipt(txHash);
      setWithdrawalClaimReady(false);
      await refreshBalances(activeAccount);
      window.dispatchEvent(new CustomEvent('aventa:withdrawal-claimed', {
        detail: { address: activeAccount, txHash, asset: 'USDG', assetIndex: ROBINHOOD_USDG_ASSET_INDEX },
      }));
      return { txHash };
    } catch (claimError) {
      const message = providerMessage(claimError);
      setWithdrawalClaimError(message);
      throw new Error(message);
    } finally {
      setWithdrawalClaimBusy(false);
    }
  }, [address, assets, connectedWallet, ownershipVerified, refreshBalances, resolveProvider]);

  const refreshWalletBalances = useCallback(async () => {
    if (!address) return undefined;
    return refreshBalances(address);
  }, [address, refreshBalances]);

  const refresh = useCallback(async () => {
    if (address) await refreshWithdrawalClaim(address);
  }, [address, refreshWithdrawalClaim]);

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

  const depositUsdg = useCallback(async (amount: string) => {
    if (!address) throw new Error('Connect an EVM wallet before depositing USDG.');
    if (address.toLowerCase() === AVENTA_TREASURY_ADDRESS.toLowerCase()) {
      throw new Error('The Aventa treasury wallet cannot be used as a user trading account.');
    }

    const normalizedAmount = amount.trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(normalizedAmount)) {
      throw new Error('Enter a valid USDG amount with no more than 6 decimal places.');
    }
    const rawAmount = parseUnits(normalizedAmount, ROBINHOOD_USDG_DECIMALS);
    const minimumAmount = parseUnits('1', ROBINHOOD_USDG_DECIMALS);
    if (rawAmount < minimumAmount) {
      throw new Error('Robinhood Lighter requires a minimum deposit of 1 USDG.');
    }

    setBusy(true);
    const walletSnapshot = await refreshBalances(address);
    if (!walletSnapshot) {
      setBusy(false);
      throw new Error("Aventa could not read this wallet\'s Robinhood Chain balances for the deposit. Retry in a moment.");
    }
    const usdgBalance = walletSnapshot.assets.find((asset) => asset.symbol === 'USDG');
    if (!usdgBalance?.balance || usdgBalance.status !== 'live' || !/^\d+(?:\.\d+)?$/.test(usdgBalance.balance)) {
      setBusy(false);
      throw new Error('Aventa could not verify the USDG available in this wallet.');
    }
    const walletBalance = parseUnits(usdgBalance.balance, ROBINHOOD_USDG_DECIMALS);
    if (rawAmount > walletBalance) {
      setBusy(false);
      throw new Error('Deposit amount exceeds the USDG available in this wallet.');
    }

    const ethBalance = walletSnapshot.assets.find((asset) => asset.symbol === 'ETH');
    if (ethBalance?.status === 'live' && ethBalance.balance && Number(ethBalance.balance) <= 0) {
      setBusy(false);
      throw new Error('This wallet needs a small amount of ETH on Robinhood Chain for gas.');
    }

    setError('');
    try {
      let provider = await resolveProvider();
      if (!provider) throw new Error('No EVM wallet was detected in this browser.');
      if (isUnsupportedRobinhoodSmartWallet(connectedWallet)) {
        throw new Error('This smart wallet does not support Robinhood Chain. Connect an EOA wallet such as Bitget, MetaMask, or Rabby.');
      }

      provider = await ensureRobinhoodChain(provider, connectedWallet);
      providerRef.current = provider;

      const accounts = await provider.request({ method: 'eth_accounts' });
      const activeAccount = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : '';
      if (!activeAccount || activeAccount.toLowerCase() !== address.toLowerCase()) {
        throw new Error('The active wallet account changed. Reconnect the wallet and try again.');
      }
      if (activeAccount.toLowerCase() === AVENTA_TREASURY_ADDRESS.toLowerCase()) {
        throw new Error('The Aventa treasury wallet cannot be used as a user trading account.');
      }

      const verified = ownershipVerified || await verifyOwnershipWithProvider(provider, activeAccount);
      if (!verified) throw new Error('Verify wallet ownership before depositing trading collateral.');

      await onboardingSnapshot(activeAccount);

      const intentResponse = await authFetch('/api/venue/deposit-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: activeAccount }),
      });
      const intentPayload = await intentResponse.json().catch(() => undefined) as unknown;
      if (!intentResponse.ok) {
        throw new Error(verificationResponseMessage(intentPayload, 'Robinhood Lighter deposit address could not be created.'));
      }
      const intentAddress = intentPayload && typeof intentPayload === 'object'
        ? (intentPayload as Record<string, unknown>).intentAddress
        : undefined;
      if (typeof intentAddress !== 'string' || !isAddress(intentAddress)) {
        throw new Error('Robinhood Lighter returned an invalid deposit address.');
      }

      const transferData = encodeFunctionData({
        abi: USDG_ERC20_ABI,
        functionName: 'transfer',
        args: [intentAddress as Address, rawAmount],
      });
      const transferRequest = {
        from: activeAccount,
        to: ROBINHOOD_USDG_ADDRESS,
        data: transferData,
        value: '0x0',
      };

      let transferGas: unknown;
      try {
        transferGas = await robinhoodReadRpc('eth_estimateGas', [transferRequest]);
      } catch (transferSimulationError) {
        throw new Error(`USDG deposit transfer simulation failed: ${providerMessage(transferSimulationError)}`);
      }
      if (typeof transferGas !== 'string' || !/^0x[a-fA-F0-9]+$/.test(transferGas)) {
        throw new Error('USDG deposit transfer simulation did not return a valid gas estimate.');
      }

      let depositHash: unknown;
      try {
        depositHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ ...transferRequest, gas: bufferedGas(transferGas) }],
        });
      } catch (transferError) {
        throw new Error(`USDG deposit transfer failed: ${providerMessage(transferError)}`);
      }
      if (typeof depositHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(depositHash)) {
        throw new Error('The wallet did not return a valid USDG deposit transaction hash.');
      }

      await waitForReceipt(depositHash);
      await refreshBalances(activeAccount);
      window.dispatchEvent(new CustomEvent('aventa:deposit-confirmed', {
        detail: { address: activeAccount, txHash: depositHash, intentAddress },
      }));

      const immediateSnapshot = await onboardingSnapshot(activeAccount).catch(() => undefined);
      if (immediateSnapshot?.accountExists && immediateSnapshot.accountIndexes.length) {
        const accountIndex = immediateSnapshot.accountIndexes[0];
        window.dispatchEvent(new CustomEvent('aventa:venue-account-ready', { detail: { address: activeAccount, accountIndex } }));
        return { txHash: depositHash, accountReady: true as const, accountIndex };
      }

      void (async () => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          await sleep(2_500);
          const snapshot = await onboardingSnapshot(activeAccount).catch(() => undefined);
          if (snapshot?.accountExists && snapshot.accountIndexes.length) {
            window.dispatchEvent(new CustomEvent('aventa:venue-account-ready', {
              detail: { address: activeAccount, accountIndex: snapshot.accountIndexes[0] },
            }));
            return;
          }
        }
      })();

      return { txHash: depositHash, accountReady: false as const, accountIndex: undefined };
    } catch (requestError) {
      const message = providerMessage(requestError);
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }, [address, authFetch, connectedWallet, ownershipVerified, refreshBalances, resolveProvider, verifyOwnershipWithProvider]);

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
    withdrawalClaimGeneration.current += 1;
    setWithdrawalClaimReady(false);
    setWithdrawalClaimError('');
    ownershipRequestGeneration.current += 1;
    setVerifiedAddress('');
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
    depositUsdg,
    claimPendingWithdrawalUsdg,
    error,
    isRobinhoodChain,
    ownershipVerified,
    verificationBusy,
    refresh,
    refreshWalletBalances,
    refreshOwnershipVerification,
    refreshWithdrawalClaim,
    signMessage,
    verifyOwnership,
    switchNetwork,
    updatedAt,
    withdrawalClaimBusy,
    withdrawalClaimError,
    withdrawalClaimReady,
  }), [address, assets, busy, claimPendingWithdrawalUsdg, connect, depositUsdg, disconnect, error, isRobinhoodChain, ownershipVerified, refresh, refreshWalletBalances, refreshOwnershipVerification, refreshWithdrawalClaim, signMessage, switchNetwork, updatedAt, verificationBusy, verifyOwnership, withdrawalClaimBusy, withdrawalClaimError, withdrawalClaimReady]);
}

export type RobinhoodAccountState = ReturnType<typeof useRobinhoodAccount>;

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
