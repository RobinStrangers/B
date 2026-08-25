import {
  PrivyClient,
  verifyAccessToken,
  verifyIdentityToken,
  type User,
  type VerifyAccessTokenResponse,
} from '@privy-io/node';
import { DEFAULT_PRIVY_APP_ID } from './privy-config';

const MAX_ACCESS_TOKEN_LENGTH = 12_000;
const MAX_IDENTITY_TOKEN_LENGTH = 32_000;
const PRIVY_DID_PATTERN = /^did:privy:[A-Za-z0-9._:-]{1,180}$/;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export type PrivyWalletAttestation = {
  address: string;
  walletKind: 'external' | 'embedded';
  verifiedAt: number;
};

export type VerifiedPrivyAuthentication = {
  appId: string;
  userId: string;
  sessionId: string;
  email: string | null;
  displayName: string | null;
  identityTokenVerified: boolean;
};

export class PrivyAuthenticationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PrivyAuthenticationError';
  }
}

let cachedClient: { key: string; client: PrivyClient } | undefined;

function environmentValue(name: string) {
  return process.env[name]?.trim() || '';
}

function appId() {
  return environmentValue('NEXT_PUBLIC_PRIVY_APP_ID') || DEFAULT_PRIVY_APP_ID;
}

function verificationKey() {
  return environmentValue('PRIVY_JWT_VERIFICATION_KEY').replace(/\\n/g, '\n');
}

export function getPrivyConfigurationStatus() {
  const secret = environmentValue('PRIVY_APP_SECRET');
  const key = verificationKey();
  return {
    appId: appId() ? 'configured' as const : 'missing' as const,
    tokenVerification: key ? 'static-key' as const : 'privy-jwks' as const,
    authoritativeUserLookup: secret ? 'configured' as const : 'app-secret-required' as const,
  };
}

function getPrivyClient(currentAppId: string, secret: string, key: string) {
  const cacheKey = `${currentAppId}:${secret}:${key}`;
  if (cachedClient?.key === cacheKey) return cachedClient.client;

  const client = new PrivyClient({
    appId: currentAppId,
    appSecret: secret,
    ...(key ? { jwtVerificationKey: key } : {}),
  });
  cachedClient = { key: cacheKey, client };
  return client;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1] || match[1].length > MAX_ACCESS_TOKEN_LENGTH) {
    throw new PrivyAuthenticationError(401, 'INVALID_AUTH_TOKEN', 'The authentication token is invalid.');
  }
  return match[1];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringField(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function timestampField(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return Math.floor(Date.now() / 1000);
}

function summarizePrivyUser(user: User | undefined) {
  if (!user) {
    return { email: null, displayName: null, wallets: [] as PrivyWalletAttestation[] };
  }

  let email: string | null = null;
  let displayName: string | null = null;
  const wallets = new Map<string, PrivyWalletAttestation>();

  for (const linkedAccount of user.linked_accounts) {
    const account = record(linkedAccount);
    if (!account) continue;
    const type = stringField(account, 'type');

    if (type === 'email' && !email) {
      email = stringField(account, 'address');
    }

    if (!displayName) {
      displayName = stringField(account, 'name', 'display_name', 'username');
    }

    if (type !== 'wallet' || stringField(account, 'chain_type') !== 'ethereum') continue;
    // Only Privy's embedded Ethereum wallets are safe to auto-link across
    // chains. External and smart-contract wallets require chain-4663
    // SIWE/EIP-1271 verification before they can authorize account data.
    if (
      stringField(account, 'wallet_client_type') !== 'privy'
      || stringField(account, 'connector_type') !== 'embedded'
    ) continue;
    const address = stringField(account, 'address');
    if (!address || !EVM_ADDRESS_PATTERN.test(address)) continue;

    const normalizedAddress = address.toLowerCase();
    wallets.set(normalizedAddress, {
      address: normalizedAddress,
      walletKind: 'embedded',
      verifiedAt: timestampField(account, 'latest_verified_at', 'verified_at', 'first_verified_at'),
    });
  }

  return { email, displayName, wallets: [...wallets.values()] };
}

async function verifyAccessTokenForApp(
  accessToken: string,
  currentAppId: string,
  secret: string,
  key: string,
): Promise<VerifyAccessTokenResponse> {
  if (key) {
    return verifyAccessToken({
      access_token: accessToken,
      app_id: currentAppId,
      verification_key: key,
    });
  }
  // Privy's Node SDK retrieves this app's public JWKS when no static key is supplied.
  // The App Secret is not needed for signature verification and remains server-only.
  return getPrivyClient(currentAppId, secret, key).utils().auth().verifyAuthToken(accessToken);
}

async function verifyUserIdentity(
  request: Request,
  currentAppId: string,
  secret: string,
  key: string,
) {
  const identityToken = request.headers.get('privy-id-token')?.trim();
  if (!identityToken) return undefined;
  if (identityToken.length > MAX_IDENTITY_TOKEN_LENGTH) {
    throw new PrivyAuthenticationError(401, 'INVALID_IDENTITY_TOKEN', 'The identity token is invalid.');
  }

  if (key) {
    return verifyIdentityToken({
      identity_token: identityToken,
      app_id: currentAppId,
      verification_key: key,
    });
  }
  return getPrivyClient(currentAppId, secret, key).users().get({ id_token: identityToken });
}

export async function getAuthoritativePrivyWallets(userId: string) {
  const currentAppId = appId();
  const secret = environmentValue('PRIVY_APP_SECRET');
  if (!secret) {
    throw new PrivyAuthenticationError(
      503,
      'PRIVY_APP_SECRET_REQUIRED',
      'Authoritative Privy wallet synchronization requires a server credential.',
    );
  }

  try {
    const user = await getPrivyClient(currentAppId, secret, verificationKey()).users()._get(userId);
    if (user.id !== userId || !PRIVY_DID_PATTERN.test(user.id)) {
      throw new Error('Privy returned a different user.');
    }
    return summarizePrivyUser(user).wallets;
  } catch (error) {
    if (error instanceof PrivyAuthenticationError) throw error;
    throw new PrivyAuthenticationError(
      502,
      'PRIVY_USER_LOOKUP_FAILED',
      'The current Privy wallet list could not be verified.',
    );
  }
}

export async function verifyPrivyRequest(request: Request): Promise<VerifiedPrivyAuthentication | null> {
  const accessToken = bearerToken(request);
  if (!accessToken) return null;

  const currentAppId = appId();
  const secret = environmentValue('PRIVY_APP_SECRET');
  const key = verificationKey();

  try {
    const [claims, privyUser] = await Promise.all([
      verifyAccessTokenForApp(accessToken, currentAppId, secret, key),
      verifyUserIdentity(request, currentAppId, secret, key),
    ]);

    const now = Math.floor(Date.now() / 1000);
    if (
      claims.app_id !== currentAppId
      || claims.issuer !== 'privy.io'
      || claims.expiration <= now
      || !PRIVY_DID_PATTERN.test(claims.user_id)
      || (privyUser && privyUser.id !== claims.user_id)
    ) {
      throw new Error('Privy claims did not match this application.');
    }

    const summary = summarizePrivyUser(privyUser);
    return {
      appId: currentAppId,
      userId: claims.user_id,
      sessionId: claims.session_id,
      email: summary.email,
      displayName: summary.displayName,
      identityTokenVerified: Boolean(privyUser),
    };
  } catch (error) {
    if (error instanceof PrivyAuthenticationError) throw error;
    throw new PrivyAuthenticationError(401, 'INVALID_AUTH_TOKEN', 'The authentication token is invalid.');
  }
}
