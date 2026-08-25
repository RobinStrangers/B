import { getVerifiedWallets } from '@/db/account';
import {
  ApiError,
  privateJson,
  readJsonObject,
  requirePrivyProfileUser,
  requireSameOrigin,
} from './api';
import { invokeExecution } from './execution-client';

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ExecutionProxyOptions = {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  request: Request;
  mutation?: boolean;
  responseStatus?: number;
  actor?: Awaited<ReturnType<typeof requirePrivyProfileUser>>;
};

export function requireIdempotencyKey(request: Request) {
  const value = request.headers.get('idempotency-key')?.trim() ?? '';
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new ApiError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'A UUID idempotency key is required for every execution change.',
    );
  }
  return value.toLowerCase();
}

export function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unsupported) {
    throw new ApiError(400, 'UNSUPPORTED_FIELD', `The field “${unsupported}” is not accepted.`);
  }
}

export function requiredString(body: Record<string, unknown>, key: string, pattern: RegExp, message: string) {
  const value = body[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ApiError(400, 'INVALID_EXECUTION_REQUEST', message);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string, pattern: RegExp, message: string) {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ApiError(400, 'INVALID_EXECUTION_REQUEST', message);
  }
  return value;
}

export function requiredInteger(body: Record<string, unknown>, key: string, minimum: number, maximum: number) {
  const value = body[key];
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ApiError(400, 'INVALID_EXECUTION_REQUEST', `${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

export function optionalInteger(body: Record<string, unknown>, key: string, minimum: number, maximum: number) {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  return requiredInteger(body, key, minimum, maximum);
}

export async function readExecutionBody(request: Request) {
  return readJsonObject(request);
}

export async function authorizeExecutionRequest(request: Request, mutation = false) {
  if (mutation) requireSameOrigin(request);
  return requirePrivyProfileUser(request);
}

export async function proxyExecution(options: ExecutionProxyOptions) {
  const { user, privy } = options.actor ?? await authorizeExecutionRequest(options.request, options.mutation);
  const wallets = await getVerifiedWallets(user.id);
  const primaryWallet = wallets.find((wallet) => wallet.isPrimary) ?? wallets[0];
  if (!primaryWallet) {
    throw new ApiError(
      409,
      'VERIFIED_WALLET_REQUIRED',
      'Connect and verify an EVM wallet before using execution services.',
    );
  }
  const idempotencyKey = options.mutation ? requireIdempotencyKey(options.request) : undefined;
  const payload = await invokeExecution({
    path: options.path,
    method: options.method ?? (options.mutation ? 'POST' : 'GET'),
    body: options.body,
    authentication: privy,
    walletAddress: primaryWallet.address,
    idempotencyKey,
  });
  return privateJson(payload, { status: options.responseStatus ?? (options.mutation ? 202 : 200) });
}
