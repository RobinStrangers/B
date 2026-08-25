'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAventaAuth } from './useAventaAuth';
import { executionAuthorizationMessage } from '../lib/execution-authorization';

export type ExecutionGate = { id: string; label: string; ready: boolean; detail?: string };
export type ExecutionAccountChoice = { index: number; label: string; kind?: string };
export type ExecutionActivity = {
  positions: Array<Record<string, unknown>>;
  openOrders: Array<Record<string, unknown>>;
  orderHistory: Array<Record<string, unknown>>;
  tradeHistory: Array<Record<string, unknown>>;
};
export type ExecutionReadiness = {
  mode: 'off' | 'paper' | 'canary' | 'limited_live';
  serviceReady: boolean;
  keyReady: boolean;
  feeApproved: boolean;
  marketExecutable: boolean;
  canPrepare: boolean;
  canSubmit: boolean;
  canCancel: boolean;
  canClose: boolean;
  accountIndex?: number;
  message: string;
  gates: ExecutionGate[];
};

const EMPTY_ACTIVITY: ExecutionActivity = { positions: [], openOrders: [], orderHistory: [], tradeHistory: [] };
const INITIAL_READINESS: ExecutionReadiness = {
  mode: 'off',
  serviceReady: false,
  keyReady: false,
  feeApproved: false,
  marketExecutable: false,
  canPrepare: false,
  canSubmit: false,
  canCancel: false,
  canClose: false,
  message: 'Checking isolated signer readiness…',
  gates: [],
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeReadiness(payload: unknown): ExecutionReadiness {
  const root = record(payload);
  const keyStatus = typeof root?.keyStatus === 'string' ? root.keyStatus : 'NOT_ENROLLED';
  const nonceLane = record(root?.nonceLane);
  const rawGates = Array.isArray(root?.gates) ? root.gates : [];
  const suppliedGates = rawGates.flatMap((item) => {
    const gate = record(item);
    if (!gate || typeof gate.id !== 'string' || typeof gate.label !== 'string' || typeof gate.ready !== 'boolean') return [];
    return [{ id: gate.id, label: gate.label, ready: gate.ready, detail: typeof gate.detail === 'string' ? gate.detail : undefined }];
  });
  const mode = root?.mode === 'paper' || root?.mode === 'canary' || root?.mode === 'limited_live' ? root.mode : 'off';
  const keyReady = keyStatus === 'ACTIVE';
  const feeApproved = root?.integratorApproved === true;
  const marketExecutable = root?.marketExecutable !== false;
  const gates = suppliedGates.length ? suppliedGates : [
    { id: 'wallet', label: 'Verified wallet is bound to this profile', ready: root?.walletBound === true },
    { id: 'key', label: 'User-owned Lighter trading key is active', ready: keyReady },
    { id: 'fee', label: 'Exact 0.17% integrator cap is active', ready: feeApproved },
    { id: 'treasury', label: 'Aventa treasury ownership is verified', ready: root?.treasuryVerified === true },
    { id: 'nonce', label: 'Execution nonce lane is ready', ready: nonceLane?.state === 'READY', detail: typeof nonceLane?.state === 'string' ? nonceLane.state : undefined },
  ];
  const canSubmit = root?.canOpen === true && marketExecutable;
  const message = typeof root?.message === 'string'
    ? root.message
    : mode === 'off'
      ? 'Execution is safely locked until the isolated signer is deployed and canary mode is enabled.'
      : canSubmit
        ? 'All account and venue gates passed. Every action still requires a fresh wallet signature.'
        : keyReady
          ? 'Trading authority is connected, but one or more live safety gates are still closed.'
          : 'Activate a user-owned Lighter trading key before submitting orders.';
  return {
    mode,
    serviceReady: true,
    keyReady,
    feeApproved,
    marketExecutable,
    canPrepare: root?.canEnroll === true || (keyReady && !feeApproved),
    canSubmit,
    canCancel: root?.canCancel === true,
    canClose: root?.canClose === true,
    accountIndex: typeof root?.accountIndex === 'number' ? root.accountIndex : undefined,
    message,
    gates,
  };
}

function normalizeActivity(payload: unknown): ExecutionActivity {
  const root = record(payload);
  const rows = (key: keyof ExecutionActivity) => Array.isArray(root?.[key])
    ? (root?.[key] as unknown[]).flatMap((item) => {
      const row = record(item);
      return row ? [row] : [];
    })
    : [];
  const requests = Array.isArray(root?.items)
    ? (root.items as unknown[]).flatMap((item) => {
      const row = record(item);
      return row ? [row] : [];
    })
    : [];
  return {
    positions: rows('positions'),
    openOrders: rows('openOrders'),
    orderHistory: rows('orderHistory').length ? rows('orderHistory') : requests,
    tradeHistory: rows('tradeHistory'),
  };
}

async function responsePayload(response: Response) {
  const payload = await response.json().catch(() => undefined);
  if (response.ok) return payload;
  const root = record(payload);
  const error = record(root?.error);
  throw new Error(typeof error?.message === 'string' ? error.message : 'The execution request was rejected.');
}

export function useAventaExecution(marketId: string) {
  const { authenticated, authFetch } = useAventaAuth();
  const [readiness, setReadiness] = useState(INITIAL_READINESS);
  const [activity, setActivity] = useState(EMPTY_ACTIVITY);
  const [accountChoices, setAccountChoices] = useState<ExecutionAccountChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    if (!authenticated) {
      setReadiness({ ...INITIAL_READINESS, message: 'Sign in to check account execution readiness.' });
      setActivity(EMPTY_ACTIVITY);
      return;
    }
    const [readinessResult, activityResult] = await Promise.allSettled([
      authFetch(`/api/execution/readiness?market=${encodeURIComponent(marketId)}`, { cache: 'no-store' }),
      authFetch('/api/execution/activity', { cache: 'no-store' }),
    ]);
    if (readinessResult.status === 'fulfilled') {
      try {
        setReadiness(normalizeReadiness(await responsePayload(readinessResult.value)));
        setError('');
      } catch (requestError) {
        setReadiness({ ...INITIAL_READINESS, message: requestError instanceof Error ? requestError.message : INITIAL_READINESS.message });
      }
    } else {
      setReadiness({ ...INITIAL_READINESS, message: 'The isolated signer is unavailable.' });
    }
    if (activityResult.status === 'fulfilled' && activityResult.value.ok) {
      setActivity(normalizeActivity(await activityResult.value.json().catch(() => undefined)));
    }
  }, [authenticated, authFetch, marketId]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => { void refresh(); }, 0);
    if (!authenticated) return () => window.clearTimeout(initialRefresh);
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visibleRefresh);
    const interval = window.setInterval(visibleRefresh, 20_000);
    return () => {
      window.clearTimeout(initialRefresh);
      document.removeEventListener('visibilitychange', visibleRefresh);
      window.clearInterval(interval);
    };
  }, [authenticated, refresh]);

  const post = useCallback(async (path: string, body: unknown, idempotencyKey = crypto.randomUUID()) => {
    const response = await authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
    return responsePayload(response);
  }, [authFetch]);

  const activate = useCallback(async (
    signMessage: (message: string) => Promise<string>,
    accountIndex?: number,
  ) => {
    setBusy(true);
    setError('');
    setNotice(readiness.keyReady
      ? 'Preparing the exact 0.17% Aventa fee-cap approval…'
      : 'Preparing a wallet-owned Lighter trading key…');
    try {
      if (!readiness.keyReady) {
        const prepared = record(await post('/api/execution/enrollment/key/prepare', {
          ...(accountIndex === undefined ? {} : { accountIndex }),
        }));
        const rawAccounts = Array.isArray(prepared?.accounts) ? prepared.accounts : [];
        const choices = rawAccounts.flatMap((item) => {
          const row = record(item);
          return row && typeof row.index === 'number'
            ? [{ index: row.index, label: typeof row.label === 'string' ? row.label : `Lighter account #${row.index}`, kind: typeof row.kind === 'string' ? row.kind : undefined }]
            : [];
        });
        if (prepared?.selectionRequired === true || (!prepared?.messageToSign && choices.length)) {
          setAccountChoices(choices);
          setNotice('Choose the Lighter account this wallet should authorize.');
          return;
        }
        if (typeof prepared?.challengeId !== 'string' || typeof prepared.messageToSign !== 'string') {
          throw new Error('The signer did not return a valid enrollment challenge.');
        }
        setNotice('Approve the API-key registration in your wallet. Aventa never requests your wallet private key.');
        const signature = await signMessage(prepared.messageToSign);
        const completed = record(await post('/api/execution/enrollment/key/complete', {
          challengeId: prepared.challengeId,
          signature,
        }));
        if (completed?.keyStatus !== 'ACTIVE') {
          setAccountChoices([]);
          setNotice('The venue accepted the trading key. Aventa will unlock fee approval after settlement is confirmed.');
          await refresh();
          return;
        }
      }

      setNotice('Preparing the exact 0.17% Aventa fee-cap approval…');
      const feePrepared = record(await post('/api/execution/enrollment/integrator/prepare', {}));
      if (typeof feePrepared?.challengeId !== 'string' || typeof feePrepared.messageToSign !== 'string') {
        throw new Error('The signer did not return a valid fee approval challenge.');
      }
      const feeSignature = await signMessage(feePrepared.messageToSign);
      await post('/api/execution/enrollment/integrator/complete', {
        challengeId: feePrepared.challengeId,
        signature: feeSignature,
      });
      setAccountChoices([]);
      setNotice('Fee approval submitted. Aventa is confirming the authoritative venue state…');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Trading activation failed safely.');
      setNotice('');
    } finally {
      setBusy(false);
    }
  }, [post, readiness.keyReady, refresh]);

  const revoke = useCallback(async (signMessage: (message: string) => Promise<string>) => {
    setBusy(true);
    setError('');
    setNotice('Preparing a wallet-owned revocation challenge…');
    try {
      const prepared = record(await post('/api/execution/enrollment/revoke/prepare', {}));
      if (typeof prepared?.challengeId !== 'string' || typeof prepared.messageToSign !== 'string') {
        throw new Error('The signer did not return a valid revocation challenge.');
      }
      const signature = await signMessage(prepared.messageToSign);
      const completed = record(await post('/api/execution/enrollment/revoke/complete', {
        challengeId: prepared.challengeId,
        signature,
      }));
      setNotice(completed?.keyStatus === 'REVOKED'
        ? 'Trading authority was revoked and the encrypted signer key was deleted.'
        : 'Revocation was submitted. New execution remains locked while venue state settles.');
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Trading-authority revocation failed safely.');
      setNotice('');
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [post, refresh]);

  const authorizedMutation = useCallback(async (
    action: 'order' | 'cancel' | 'cancel-all' | 'close',
    path: string,
    payload: Record<string, unknown>,
    walletAddress: string,
    signMessage: (message: string) => Promise<string>,
    suppliedIdempotencyKey?: string,
  ) => {
    const idempotencyKey = suppliedIdempotencyKey ?? crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 30_000;
    const message = executionAuthorizationMessage({ action, idempotencyKey, issuedAt, expiresAt, payload });
    const signature = await signMessage(message);
    return post(path, {
      ...payload,
      authorization: { walletAddress, issuedAt, expiresAt, signature },
    }, idempotencyKey);
  }, [post]);

  const execute = useCallback(async (
    action: 'order' | 'cancel' | 'cancel-all' | 'close',
    path: string,
    payload: Record<string, unknown>,
    walletAddress: string,
    signMessage: (message: string) => Promise<string>,
    idempotencyKey?: string,
  ) => {
    setBusy(true);
    setError('');
    setNotice('Review and sign this exact execution intent in your wallet.');
    try {
      const result = await authorizedMutation(action, path, payload, walletAddress, signMessage, idempotencyKey);
      setNotice('Request submitted. Aventa is reconciling the authoritative venue result.');
      await refresh();
      return result;
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Execution failed safely.';
      setError(message);
      setNotice('');
      throw requestError;
    } finally {
      setBusy(false);
    }
  }, [authorizedMutation, refresh]);

  return { readiness, activity, accountChoices, busy, error, notice, refresh, activate, revoke, execute };
}
