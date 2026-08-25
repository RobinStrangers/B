import type { VerifiedPrivyAuthentication } from './privy-server';
import { signAwsRequest } from './aws-sigv4';

const MAX_REMOTE_RESPONSE_BYTES = 512_000;
const DEFAULT_TIMEOUT_MS = 12_000;

export type ExecutionMode = 'off' | 'paper' | 'canary' | 'limited_live';

export type ExecutionConfigurationStatus = {
  configured: boolean;
  mode: ExecutionMode;
  missing: string[];
};

type InvokeExecutionOptions = {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  authentication: VerifiedPrivyAuthentication;
  walletAddress?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

function environmentValue(name: string) {
  return process.env[name]?.trim() || '';
}

function executionMode(): ExecutionMode {
  const value = environmentValue('EXECUTION_MODE');
  return value === 'paper' || value === 'canary' || value === 'limited_live' ? value : 'off';
}

export function getExecutionConfigurationStatus(): ExecutionConfigurationStatus {
  const required = [
    'EXECUTION_FUNCTION_URL',
    'AWS_EXECUTION_REGION',
    'AWS_EXECUTION_ACCESS_KEY_ID',
    'AWS_EXECUTION_SECRET_ACCESS_KEY',
  ];
  const missing = required.filter((name) => !environmentValue(name));
  return {
    configured: missing.length === 0,
    mode: executionMode(),
    missing,
  };
}

function executionUrl(path: string) {
  const base = environmentValue('EXECUTION_FUNCTION_URL');
  if (!base) throw new ExecutionServiceError(503, 'EXECUTION_NOT_CONFIGURED', 'The execution service is not configured.');
  const root = base.endsWith('/') ? base : `${base}/`;
  return new URL(path.replace(/^\//, ''), root).toString();
}

export class ExecutionServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionServiceError';
  }
}

function safeError(payload: unknown, fallbackStatus: number) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const nested = root.error;
  const row = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : root;
  const rawCode = row.code ?? row.errorCode;
  const code = typeof rawCode === 'string' && /^[A-Z0-9_]{2,80}$/.test(rawCode)
    ? rawCode
    : 'EXECUTION_SERVICE_ERROR';
  const message = typeof row.message === 'string' && row.message.length <= 500
    ? row.message
    : `The execution service returned ${fallbackStatus}.`;
  return { code, message };
}

export async function invokeExecution(options: InvokeExecutionOptions) {
  const configuration = getExecutionConfigurationStatus();
  if (!configuration.configured) {
    throw new ExecutionServiceError(503, 'EXECUTION_NOT_CONFIGURED', 'The execution service is not configured.');
  }

  const method = options.method ?? 'GET';
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'x-aventa-user-id': options.authentication.userId,
    'x-aventa-session-id': options.authentication.sessionId,
    'x-aventa-privy-app-id': options.authentication.appId,
    'x-aventa-request-id': crypto.randomUUID(),
    'x-aventa-requested-mode': configuration.mode,
  });
  if (options.walletAddress) headers.set('x-aventa-wallet-address', options.walletAddress.toLowerCase());
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);

  const signedHeaders = await signAwsRequest({
    url: executionUrl(options.path),
    method,
    region: environmentValue('AWS_EXECUTION_REGION'),
    service: 'lambda',
    credentials: {
      accessKeyId: environmentValue('AWS_EXECUTION_ACCESS_KEY_ID'),
      secretAccessKey: environmentValue('AWS_EXECUTION_SECRET_ACCESS_KEY'),
      sessionToken: environmentValue('AWS_EXECUTION_SESSION_TOKEN') || undefined,
    },
    headers,
    body,
  });

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(executionUrl(options.path), {
      method,
      headers: signedHeaders,
      body: method === 'GET' ? undefined : body,
      signal,
      cache: 'no-store',
    });
  } catch {
    throw new ExecutionServiceError(
      503,
      'EXECUTION_SERVICE_UNAVAILABLE',
      'The execution service could not be reached. No retry was submitted automatically.',
    );
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_RESPONSE_BYTES) {
    throw new ExecutionServiceError(502, 'EXECUTION_RESPONSE_INVALID', 'The execution service returned an invalid response.');
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_RESPONSE_BYTES) {
    throw new ExecutionServiceError(502, 'EXECUTION_RESPONSE_INVALID', 'The execution service returned an invalid response.');
  }

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ExecutionServiceError(502, 'EXECUTION_RESPONSE_INVALID', 'The execution service returned an invalid response.');
  }
  if (!response.ok) {
    const error = safeError(payload, response.status);
    throw new ExecutionServiceError(
      response.status >= 400 && response.status < 600 ? response.status : 502,
      error?.code ?? 'EXECUTION_SERVICE_ERROR',
      error?.message ?? 'The execution service rejected this request.',
    );
  }
  return payload;
}
