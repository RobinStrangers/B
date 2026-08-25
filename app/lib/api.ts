import { DatabaseUnavailableError } from '@/db';
import {
  AgentConflictError,
  AgentRateLimitError,
  AgentResourceNotFoundError,
} from '@/db/agent';
import {
  provisionUser,
  WalletOwnershipConflictError,
  WalletSynchronizationConflictError,
  type AppUser,
  type VerifiedIdentity,
} from '@/db/account';
import {
  PrivyAuthenticationError,
  verifyPrivyRequest,
  type VerifiedPrivyAuthentication,
} from './privy-server';
import { ExecutionServiceError } from './execution-client';

const USER_ID_HEADER = 'oai-authenticated-user-id';
const USER_EMAIL_HEADER = 'oai-authenticated-user-email';
const USER_FULL_NAME_HEADER = 'oai-authenticated-user-full-name';
const USER_FULL_NAME_ENCODING_HEADER = 'oai-authenticated-user-full-name-encoding';
const PERCENT_ENCODED_UTF8 = 'percent-encoded-utf-8';
const MAX_JSON_BYTES = 16_384;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function decodeDisplayName(headers: Headers) {
  const encoding = headers.get(USER_FULL_NAME_ENCODING_HEADER)?.trim().toLowerCase();
  const encodedName = headers.get(USER_FULL_NAME_HEADER)?.trim();
  if (encoding !== PERCENT_ENCODED_UTF8 || !encodedName) return null;

  try {
    const decodedName = decodeURIComponent(encodedName).trim();
    return decodedName || null;
  } catch {
    return null;
  }
}

function getSitesIdentity(request: Request): VerifiedIdentity | null {
  if (process.env.ALLOW_SITES_AUTH_FALLBACK !== 'true') return null;

  const subject = request.headers.get(USER_ID_HEADER)?.trim() ?? '';
  if (!subject) return null;

  return {
    issuer: 'openai-sites',
    subject,
    provider: 'sites-dispatch',
    email: request.headers.get(USER_EMAIL_HEADER)?.trim() || null,
    displayName: decodeDisplayName(request.headers),
  };
}

export type RequestAuthentication = {
  identity: VerifiedIdentity;
  privy: VerifiedPrivyAuthentication | null;
};

export async function getRequestAuthentication(request: Request): Promise<RequestAuthentication | null> {
  if (request.headers.has('authorization')) {
    const privy = await verifyPrivyRequest(request);
    if (!privy) return null;
    return {
      identity: {
        issuer: 'privy.io',
        subject: privy.userId,
        provider: 'privy',
        email: privy.email,
        displayName: privy.displayName,
      },
      privy,
    };
  }

  const identity = getSitesIdentity(request);
  return identity ? { identity, privy: null } : null;
}

export async function getVerifiedIdentity(request: Request): Promise<VerifiedIdentity | null> {
  return (await getRequestAuthentication(request))?.identity ?? null;
}

export async function requireProfileUser(request: Request): Promise<{
  identity: VerifiedIdentity;
  user: AppUser;
  privy: VerifiedPrivyAuthentication | null;
}>;
export async function requireProfileUser(
  request: Request,
  authentication: RequestAuthentication | null,
): Promise<{
  identity: VerifiedIdentity;
  user: AppUser;
  privy: VerifiedPrivyAuthentication | null;
}>;
export async function requireProfileUser(
  request: Request,
  authentication?: RequestAuthentication | null,
): Promise<{
  identity: VerifiedIdentity;
  user: AppUser;
  privy: VerifiedPrivyAuthentication | null;
}> {
  const verified = authentication === undefined
    ? await getRequestAuthentication(request)
    : authentication;
  if (!verified) {
    throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in is required for this account endpoint.');
  }

  const user = await provisionUser(verified.identity);
  if (user.status !== 'active') {
    throw new ApiError(403, 'ACCOUNT_UNAVAILABLE', 'This Aventa profile is not active.');
  }
  return { identity: verified.identity, user, privy: verified.privy };
}

export async function requirePrivyProfileUser(request: Request): Promise<{
  identity: VerifiedIdentity;
  user: AppUser;
  privy: VerifiedPrivyAuthentication;
}> {
  const authentication = await getRequestAuthentication(request);
  if (!authentication?.privy) {
    throw new ApiError(
      401,
      'PRIVY_AUTHENTICATION_REQUIRED',
      'Sign in with Privy to use your private Signal Desk.',
    );
  }

  const profile = await requireProfileUser(request, authentication);
  return {
    identity: profile.identity,
    user: profile.user,
    privy: authentication.privy,
  };
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) {
    throw new ApiError(403, 'ORIGIN_REQUIRED', 'A verified same-origin request is required for account changes.');
  }

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) {
    throw new ApiError(403, 'ORIGIN_MISMATCH', 'This write request did not originate from Aventa.');
  }
}

export async function readJsonObject(request: Request) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new ApiError(415, 'JSON_REQUIRED', 'This endpoint accepts application/json only.');
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new ApiError(400, 'INVALID_BODY', 'The request body could not be read.');
  }
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'OBJECT_REQUIRED', 'The request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

export function privateJson(payload: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(payload, { ...init, headers });
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return privateJson({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof PrivyAuthenticationError) {
    return privateJson({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  if (error instanceof WalletOwnershipConflictError) {
    return privateJson(
      { error: { code: 'WALLET_OWNERSHIP_CONFLICT', message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof WalletSynchronizationConflictError) {
    return privateJson(
      { error: { code: 'WALLET_SYNCHRONIZATION_CONFLICT', message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof DatabaseUnavailableError) {
    return privateJson(
      { error: { code: 'DATABASE_UNAVAILABLE', message: 'The Aventa profile database is unavailable.' } },
      { status: 503 },
    );
  }
  if (error instanceof AgentResourceNotFoundError) {
    return privateJson(
      { error: { code: 'AGENT_RESOURCE_NOT_FOUND', message: error.message } },
      { status: 404 },
    );
  }
  if (error instanceof AgentConflictError) {
    return privateJson(
      { error: { code: 'AGENT_STATE_CONFLICT', message: error.message } },
      { status: 409 },
    );
  }
  if (error instanceof AgentRateLimitError) {
    return privateJson(
      { error: { code: 'AGENT_RATE_LIMITED', message: error.message } },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  if (error instanceof ExecutionServiceError) {
    return privateJson(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  console.error('Unhandled Aventa API error', error);
  return privateJson(
    { error: { code: 'INTERNAL_ERROR', message: 'The account service could not complete this request.' } },
    { status: 500 },
  );
}
