'use client';

import { useWallets } from '@privy-io/react-auth';
import { decodeFunctionResult, encodeFunctionData, parseUnits, type Address, type Hex } from 'viem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAventaAuth } from './useAventaAuth';
import {
  AVENTA_TREASURY_ADDRESS,
  ROBINHOOD_LIGHTER_DEPOSIT_ABI,
  ROBINHOOD_LIGHTER_PERPS_ROUTE,
  ROBINHOOD_LIGHTER_PROXY,
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

type TransactionReceipt = { status?: string; transactionHash?: string };

type VenueOnboardingSnapshot = {
  accountExists: boolean;
  accountIndexes: number[];
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForReceipt(provider: Eip1193Provider, txHash: string, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] }) as TransactionReceipt | null;
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
  const [ownershipVerified, setOwnershipVerified] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
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

  const refreshOwnershipVerification = useCallback(async (account: string) => {
    if (!privy.authenticated || !account) {
      setOwnershipVerified(false);
      return false;
    }
    try {
      const response = await authFetch('/api/account/summary', { cache: 'no-store' });
      if (!response.ok) return false;
      const verified = verifiedWalletFromSummary(await response.json(), account);
      setOwnershipVerified(verified);
      return verified;
    } catch {
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
      setOwnershipVerified(true);
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
    setOwnershipVerified(false);
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
        setOwnershipVerified(false);
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

  useEffect(() => {
    if (!privy.authenticated || !address || !isRobinhoodChain) {
      setOwnershipVerified(false);
      return;
    }
    void refreshOwnershipVerification(address).catch(() => undefined);
  }, [address, isRobinhoodChain, privy.authenticated, refreshOwnershipVerification]);

  const verifyOwnership = useCallback(async () => {
    if (!address) throw new Error('Connect an EVM wallet before verifying ownership.');
    const provider = await resolveProvider();
    if (!provider) throw new Error('No EVM wallet was detected in this browser.');
    setError('');
    setBusy(true);
    try {
      if (!isRobinhoodChain) {
        if (connectedWallet?.type === 'ethereum') await connectedWallet.switchChain(4663);
        else await switchToRobinhoodChain(provider);
      }
      const switchedProvider = await resolveProvider();
      if (!switchedProvider) throw new Error('The connected wallet provider did not respond.');
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
      if (walletCandidate?.type === 'ethereum') await walletCandidate.switchChain(4663);
      else await switchToRobinhoodChain(provider);
      const switchedProvider = walletCandidate?.type === 'ethereum'
        ? await walletCandidate.getEthereumProvider() as unknown as Eip1193Provider
        : provider;
      if (!switchedProvider) throw new Error('The connected wallet provider did not respond.');
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
      if (connectedWallet?.type === 'ethereum') await connectedWallet.switchChain(4663);
      else await switchToRobinhoodChain(provider);
      const switchedProvider = await resolveProvider();
      if (!switchedProvider) throw new Error('The connected wallet provider did not respond.');
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
    if (rawAmount <= BigInt(0)) throw new Error('Deposit amount must be greater than zero.');

    const usdgBalance = assets.find((asset) => asset.symbol === 'USDG');
    if (usdgBalance?.status === 'live' && usdgBalance.balance && /^\d+(?:\.\d+)?$/.test(usdgBalance.balance)) {
      const walletBalance = parseUnits(usdgBalance.balance, ROBINHOOD_USDG_DECIMALS);
      if (rawAmount > walletBalance) throw new Error('Deposit amount exceeds the USDG available in this wallet.');
    }

    const ethBalance = assets.find((asset) => asset.symbol === 'ETH');
    if (ethBalance?.status === 'live' && ethBalance.balance && Number(ethBalance.balance) <= 0) {
      throw new Error('This wallet needs a small amount of ETH on Robinhood Chain for gas.');
    }

    setBusy(true);
    setError('');
    try {
      let provider = await resolveProvider();
      if (!provider) throw new Error('No EVM wallet was detected in this browser.');

      const currentChain = await provider.request({ method: 'eth_chainId' });
      if (typeof currentChain !== 'string' || currentChain.toLowerCase() !== ROBINHOOD_CHAIN_ID) {
        if (connectedWallet?.type === 'ethereum') await connectedWallet.switchChain(4663);
        else await switchToRobinhoodChain(provider);
        provider = await resolveProvider();
        if (!provider) throw new Error('The connected wallet provider did not respond after switching network.');
      }

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

      // This preflight rejects the treasury wallet/account and records whether
      // Lighter already has an account for this L1 address. A missing account is
      // expected for first-time users; the deposit itself is addressed to the wallet.
      await onboardingSnapshot(activeAccount);

      const allowanceData = encodeFunctionData({
        abi: USDG_ERC20_ABI,
        functionName: 'allowance',
        args: [activeAccount as Address, ROBINHOOD_LIGHTER_PROXY],
      });
      const allowanceResult = await provider.request({
        method: 'eth_call',
        params: [{ to: ROBINHOOD_USDG_ADDRESS, data: allowanceData }, 'latest'],
      });
      if (typeof allowanceResult !== 'string') throw new Error('USDG allowance could not be read from Robinhood Chain.');
      const allowance = decodeFunctionResult({
        abi: USDG_ERC20_ABI,
        functionName: 'allowance',
        data: allowanceResult as Hex,
      });

      if (allowance < rawAmount) {
        const approvalData = encodeFunctionData({
          abi: USDG_ERC20_ABI,
          functionName: 'approve',
          args: [ROBINHOOD_LIGHTER_PROXY, rawAmount],
        });
        const approvalHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from: activeAccount, to: ROBINHOOD_USDG_ADDRESS, data: approvalData, value: '0x0' }],
        });
        if (typeof approvalHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(approvalHash)) {
          throw new Error('The wallet did not return a valid USDG approval transaction hash.');
        }
        await waitForReceipt(provider, approvalHash);
      }

      const depositData = encodeFunctionData({
        abi: ROBINHOOD_LIGHTER_DEPOSIT_ABI,
        functionName: 'deposit',
        args: [
          activeAccount as Address,
          ROBINHOOD_USDG_ASSET_INDEX,
          ROBINHOOD_LIGHTER_PERPS_ROUTE,
          rawAmount,
        ],
      });
      const depositHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: activeAccount, to: ROBINHOOD_LIGHTER_PROXY, data: depositData, value: '0x0' }],
      });
      if (typeof depositHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(depositHash)) {
        throw new Error('The wallet did not return a valid Lighter deposit transaction hash.');
      }
      await waitForReceipt(provider, depositHash);
      await refreshBalances(activeAccount);
      window.dispatchEvent(new CustomEvent('aventa:deposit-confirmed', { detail: { address: activeAccount, txHash: depositHash } }));

      const immediateSnapshot = await onboardingSnapshot(activeAccount).catch(() => undefined);
      if (immediateSnapshot?.accountExists && immediateSnapshot.accountIndexes.length) {
        const accountIndex = immediateSnapshot.accountIndexes[0];
        window.dispatchEvent(new CustomEvent('aventa:venue-account-ready', { detail: { address: activeAccount, accountIndex } }));
        return { txHash: depositHash, accountReady: true as const, accountIndex };
      }

      // Venue indexing can lag the L1 receipt. Do not keep the wallet UI blocked
      // while that happens; continue bounded discovery in the background.
      void (async () => {
        const deadline = Date.now() + 90_000;
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
      setError(providerMessage(requestError));
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [address, assets, connectedWallet, ownershipVerified, refreshBalances, resolveProvider, verifyOwnershipWithProvider]);

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
    setOwnershipVerified(false);
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
    error,
    isRobinhoodChain,
    ownershipVerified,
    verificationBusy,
    refresh,
    refreshOwnershipVerification,
    signMessage,
    verifyOwnership,
    switchNetwork,
    updatedAt,
  }), [address, assets, busy, connect, depositUsdg, disconnect, error, isRobinhoodChain, ownershipVerified, refresh, refreshOwnershipVerification, signMessage, switchNetwork, updatedAt, verificationBusy, verifyOwnership]);
}

export type RobinhoodAccountState = ReturnType<typeof useRobinhoodAccount>;

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
