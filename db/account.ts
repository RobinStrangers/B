import { getDatabase } from './index';

const ROBINHOOD_CHAIN_ID = 4663;
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;
const PRIVY_SYNC_REQUEST_PATTERN = /^pws_[a-f0-9]{32}$/;
const PRIVY_WALLET_SYNC_MAX_AGE_SECONDS = 10 * 60;

export type VerifiedIdentity = {
  issuer: 'openai-sites' | 'privy.io';
  subject: string;
  provider: 'sites-dispatch' | 'privy';
  email: string | null;
  displayName: string | null;
};

export type PrivyWalletAttestation = {
  address: string;
  walletKind: 'external' | 'embedded';
  verifiedAt: number;
};

export class WalletOwnershipConflictError extends Error {
  constructor() {
    super('A verified wallet is already linked to another Aventa profile.');
    this.name = 'WalletOwnershipConflictError';
  }
}

export class WalletSynchronizationConflictError extends Error {
  constructor() {
    super('The wallet list changed during synchronization. Please retry.');
    this.name = 'WalletSynchronizationConflictError';
  }
}

export type AppUser = {
  id: string;
  status: 'active' | 'suspended' | 'deleted';
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AccountPreferences = {
  defaultMarketId: string;
  chartInterval: string;
  reduceMotion: boolean;
  favoriteMarkets: string[];
};

export type VerifiedWallet = {
  id: string;
  address: string;
  checksumAddress: string | null;
  chainId: number;
  walletKind: 'external' | 'embedded' | 'contract';
  verificationMethod: 'siwe_eoa' | 'eip1271' | 'privy_attestation';
  isPrimary: boolean;
  verifiedAt: number;
};

type UserRow = {
  id: string;
  status: AppUser['status'];
  display_name: string | null;
  created_at: number;
  updated_at: number;
};

type PreferenceRow = {
  default_market_id: string;
  chart_interval: string;
  reduce_motion: number;
};

type FavoriteRow = { market_id: string };

type WalletRow = {
  id: string;
  address: string;
  checksum_address: string | null;
  chain_id: number;
  wallet_kind: VerifiedWallet['walletKind'];
  verification_method: VerifiedWallet['verificationMethod'];
  is_primary: number;
  verified_at: number;
};


export type WalletOwnershipChallenge = {
  id: string;
  userId: string;
  chainId: number;
  address: string;
  messageHash: string;
  expiresAt: number;
  consumedAt: number | null;
  createdAt: number;
};

type WalletChallengeRow = {
  id: string;
  user_id: string;
  chain_id: number;
  address: string;
  message_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

type VaultHistoryRow = {
  id: string;
  direction: 'deposit' | 'withdraw';
  asset: string;
  amount_raw: string;
  asset_decimals: number;
  block_timestamp: number;
  transaction_hash: string;
  is_finalized: number;
};

async function stableIdentifier(prefix: string, value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex.slice(0, 32)}`;
}

function normalizeDisplayName(value: string | null) {
  const normalized = value?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '';
  return normalized || null;
}

function mapUser(row: UserRow): AppUser {
  return {
    id: row.id,
    status: row.status,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function provisionUser(identity: VerifiedIdentity) {
  const database = getDatabase();
  const existingUser = await database.prepare(`
    SELECT app_users.id, app_users.status, app_users.display_name, app_users.created_at, app_users.updated_at
    FROM auth_identities
    INNER JOIN app_users ON app_users.id = auth_identities.user_id
    WHERE auth_identities.issuer = ?
      AND auth_identities.subject = ?
    LIMIT 1
  `).bind(identity.issuer, identity.subject).first<UserRow>();
  if (existingUser) return mapUser(existingUser);

  const now = Math.floor(Date.now() / 1000);
  const identityKey = `${identity.issuer}:${identity.subject}`;
  const [userId, identityId] = await Promise.all([
    stableIdentifier('usr', identityKey),
    stableIdentifier('idn', identityKey),
  ]);
  const displayName = normalizeDisplayName(identity.displayName);

  await database.batch([
    database.prepare(`
      INSERT INTO app_users (id, status, display_name, created_at, updated_at)
      VALUES (?, 'active', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, app_users.display_name),
        updated_at = excluded.updated_at
    `).bind(userId, displayName, now, now),
    database.prepare(`
      INSERT INTO auth_identities (id, user_id, issuer, subject, provider, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issuer, subject) DO UPDATE SET
        provider = excluded.provider,
        last_seen_at = excluded.last_seen_at
    `).bind(identityId, userId, identity.issuer, identity.subject, identity.provider, now, now),
    database.prepare(`
      INSERT INTO user_preferences (user_id, language, default_market_id, chart_interval, reduce_motion, ui_preferences_json, updated_at)
      VALUES (?, 'en', 'btc-usdt', '15', 0, '{}', ?)
      ON CONFLICT(user_id) DO NOTHING
    `).bind(userId, now),
  ]);

  const row = await database.prepare(`
    SELECT app_users.id, app_users.status, app_users.display_name, app_users.created_at, app_users.updated_at
    FROM auth_identities
    INNER JOIN app_users ON app_users.id = auth_identities.user_id
    WHERE auth_identities.issuer = ?
      AND auth_identities.subject = ?
    LIMIT 1
  `).bind(identity.issuer, identity.subject).first<UserRow>();

  if (!row) throw new Error('The persisted Aventa profile could not be loaded.');
  return mapUser(row);
}

export async function createWalletOwnershipChallenge(options: {
  id: string;
  userId: string;
  chainId: number;
  address: string;
  messageHash: string;
  expiresAt: number;
}) {
  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  await database.batch([
    database.prepare(`
      UPDATE wallet_challenges
      SET consumed_at = ?
      WHERE user_id = ?
        AND chain_id = ?
        AND address = ?
        AND consumed_at IS NULL
    `).bind(now, options.userId, options.chainId, options.address),
    database.prepare(`
      INSERT INTO wallet_challenges (
        id, user_id, chain_id, address, message_hash, expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).bind(
      options.id,
      options.userId,
      options.chainId,
      options.address,
      options.messageHash,
      options.expiresAt,
      now,
    ),
  ]);
}

export async function getWalletOwnershipChallenge(
  userId: string,
  challengeId: string,
): Promise<WalletOwnershipChallenge | null> {
  const row = await getDatabase().prepare(`
    SELECT id, user_id, chain_id, address, message_hash, expires_at, consumed_at, created_at
    FROM wallet_challenges
    WHERE id = ?
      AND user_id = ?
    LIMIT 1
  `).bind(challengeId, userId).first<WalletChallengeRow>();

  return row ? {
    id: row.id,
    userId: row.user_id,
    chainId: row.chain_id,
    address: row.address,
    messageHash: row.message_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  } : null;
}

export async function completeWalletOwnershipVerification(options: {
  userId: string;
  challengeId: string;
  chainId: number;
  address: string;
  checksumAddress: string;
  proofHash: string;
}): Promise<VerifiedWallet | null> {
  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const consumeMarker = Date.now();

  const existingWallet = await database.prepare(`
    SELECT
      wallets.id AS wallet_id,
      wallets.wallet_kind,
      user_wallet_links.id AS link_id,
      user_wallet_links.user_id,
      user_wallet_links.is_primary
    FROM wallets
    LEFT JOIN user_wallet_links
      ON user_wallet_links.wallet_id = wallets.id
      AND user_wallet_links.unlinked_at IS NULL
    WHERE wallets.chain_id = ?
      AND wallets.address = ?
    LIMIT 1
  `).bind(options.chainId, options.address).first<{
    wallet_id: string;
    wallet_kind: VerifiedWallet['walletKind'];
    link_id: string | null;
    user_id: string | null;
    is_primary: number | null;
  }>();

  if (existingWallet?.user_id && existingWallet.user_id !== options.userId) {
    throw new WalletOwnershipConflictError();
  }

  let linkId = existingWallet?.link_id ?? null;
  if (!linkId && existingWallet?.wallet_id) {
    const priorLink = await database.prepare(`
      SELECT id
      FROM user_wallet_links
      WHERE user_id = ?
        AND wallet_id = ?
      ORDER BY linked_at DESC
      LIMIT 1
    `).bind(options.userId, existingWallet.wallet_id).first<{ id: string }>();
    linkId = priorLink?.id ?? null;
  }

  const [walletId, verifiedLinkId] = await Promise.all([
    existingWallet?.wallet_id
      ? Promise.resolve(existingWallet.wallet_id)
      : stableIdentifier('wal', `${options.chainId}:${options.address}`),
    linkId
      ? Promise.resolve(linkId)
      : stableIdentifier('pwl', `${options.userId}:${options.chainId}:${options.address}`),
  ]);

  const walletKind = existingWallet?.wallet_kind === 'embedded' ? 'embedded' : 'external';
  const isPrimary = true;
  const challengeExists = `
    EXISTS (
      SELECT 1
      FROM wallet_challenges
      WHERE id = ?
        AND user_id = ?
        AND chain_id = ?
        AND address = ?
        AND message_hash = ?
        AND consumed_at IS NULL
        AND expires_at >= ?
    )
  `;

  await database.batch([
    database.prepare(`
      UPDATE user_wallet_links
      SET is_primary = 0
      WHERE user_id = ?
        AND unlinked_at IS NULL
        AND wallet_id <> ?
        AND ${challengeExists}
    `).bind(
      options.userId,
      walletId,
      options.challengeId,
      options.userId,
      options.chainId,
      options.address,
      options.proofHash,
      now,
    ),
    database.prepare(`
      INSERT INTO wallets (id, chain_id, address, checksum_address, wallet_kind, created_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE ${challengeExists}
      ON CONFLICT(chain_id, address) DO UPDATE SET
        checksum_address = excluded.checksum_address,
        wallet_kind = CASE
          WHEN wallets.wallet_kind = 'contract' THEN wallets.wallet_kind
          WHEN wallets.wallet_kind = 'embedded' THEN wallets.wallet_kind
          ELSE excluded.wallet_kind
        END
    `).bind(
      walletId,
      options.chainId,
      options.address,
      options.checksumAddress,
      walletKind,
      now,
      options.challengeId,
      options.userId,
      options.chainId,
      options.address,
      options.proofHash,
      now,
    ),
    database.prepare(`
      INSERT INTO user_wallet_links (
        id, user_id, wallet_id, verification_method, proof_hash,
        is_primary, verified_at, linked_at, unlinked_at
      )
      SELECT ?, ?, ?, 'siwe_eoa', ?, ?, ?, ?, NULL
      WHERE ${challengeExists}
      ON CONFLICT(id) DO UPDATE SET
        verification_method = 'siwe_eoa',
        proof_hash = excluded.proof_hash,
        is_primary = excluded.is_primary,
        verified_at = excluded.verified_at,
        unlinked_at = NULL
      WHERE user_wallet_links.user_id = excluded.user_id
        AND user_wallet_links.wallet_id = excluded.wallet_id
    `).bind(
      verifiedLinkId,
      options.userId,
      walletId,
      options.proofHash,
      isPrimary ? 1 : 0,
      now,
      now,
      options.challengeId,
      options.userId,
      options.chainId,
      options.address,
      options.proofHash,
      now,
    ),
    database.prepare(`
      UPDATE wallet_challenges
      SET consumed_at = ?
      WHERE id = ?
        AND user_id = ?
        AND chain_id = ?
        AND address = ?
        AND message_hash = ?
        AND consumed_at IS NULL
        AND expires_at >= ?
    `).bind(
      consumeMarker,
      options.challengeId,
      options.userId,
      options.chainId,
      options.address,
      options.proofHash,
      now,
    ),
    database.prepare(`
      INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
      SELECT ?, ?, 'wallet.ownership.verified', ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM wallet_challenges
        WHERE id = ?
          AND user_id = ?
          AND consumed_at = ?
      )
    `).bind(
      `aud_${crypto.randomUUID().replace(/-/g, '')}`,
      options.userId,
      JSON.stringify({
        chainId: options.chainId,
        address: options.address,
        verificationMethod: 'siwe_eoa',
      }),
      now,
      options.challengeId,
      options.userId,
      consumeMarker,
    ),
  ]);

  const [consumed, wallet] = await Promise.all([
    database.prepare(`
      SELECT id
      FROM wallet_challenges
      WHERE id = ?
        AND user_id = ?
        AND consumed_at = ?
      LIMIT 1
    `).bind(options.challengeId, options.userId, consumeMarker).first<{ id: string }>(),
    database.prepare(`
      SELECT
        wallets.id,
        wallets.address,
        wallets.checksum_address,
        wallets.chain_id,
        wallets.wallet_kind,
        user_wallet_links.verification_method,
        user_wallet_links.is_primary,
        user_wallet_links.verified_at
      FROM user_wallet_links
      INNER JOIN wallets ON wallets.id = user_wallet_links.wallet_id
      WHERE user_wallet_links.user_id = ?
        AND wallets.chain_id = ?
        AND wallets.address = ?
        AND user_wallet_links.unlinked_at IS NULL
      LIMIT 1
    `).bind(options.userId, options.chainId, options.address).first<WalletRow>(),
  ]);

  if (!consumed || !wallet || wallet.verification_method !== 'siwe_eoa') return null;
  return {
    id: wallet.id,
    address: wallet.address,
    checksumAddress: wallet.checksum_address,
    chainId: wallet.chain_id,
    walletKind: wallet.wallet_kind,
    verificationMethod: wallet.verification_method,
    isPrimary: Boolean(wallet.is_primary),
    verifiedAt: wallet.verified_at,
  };
}

export async function beginPrivyWalletSync(userId: string) {
  const database = getDatabase();
  const requestId = `pws_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);
  await database.prepare(`
    INSERT INTO privy_wallet_sync_state (user_id, request_id, applied_request_id, updated_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      request_id = excluded.request_id,
      updated_at = excluded.updated_at
  `).bind(userId, requestId, now).run();
  return requestId;
}

async function syncPrivyWalletsOnce(
  userId: string,
  attestations: PrivyWalletAttestation[],
  requestId: string,
) {
  const database = getDatabase();
  const normalized = new Map<string, PrivyWalletAttestation>();
  const now = Math.floor(Date.now() / 1000);

  for (const attestation of attestations) {
    if (attestation.walletKind !== 'embedded') continue;
    const address = attestation.address.toLowerCase();
    if (!ADDRESS_PATTERN.test(address)) continue;
    normalized.set(address, {
      address,
      walletKind: 'embedded',
      verifiedAt: Number.isInteger(attestation.verifiedAt) && attestation.verifiedAt > 0
        ? Math.min(attestation.verifiedAt, now)
        : now,
    });
  }

  const verifiedWallets = [...normalized.values()].sort((left, right) => {
    if (left.walletKind !== right.walletKind) return left.walletKind === 'embedded' ? -1 : 1;
    return left.address.localeCompare(right.address);
  });

  const existingWalletIds = new Map<string, string>();
  const existingLinkIds = new Map<string, string>();
  const eligibleWallets: PrivyWalletAttestation[] = [];
  for (const wallet of verifiedWallets) {
    const existingWallet = await database.prepare(`
      SELECT
        wallets.id AS wallet_id,
        wallets.wallet_kind,
        user_wallet_links.id AS link_id,
        user_wallet_links.user_id,
        user_wallet_links.verification_method
      FROM wallets
      LEFT JOIN user_wallet_links
        ON user_wallet_links.wallet_id = wallets.id
        AND user_wallet_links.unlinked_at IS NULL
      WHERE wallets.chain_id = ?
        AND wallets.address = ?
      LIMIT 1
    `).bind(ROBINHOOD_CHAIN_ID, wallet.address).first<{
      wallet_id: string;
      wallet_kind: VerifiedWallet['walletKind'];
      link_id: string | null;
      user_id: string | null;
      verification_method: VerifiedWallet['verificationMethod'] | null;
    }>();

    if (existingWallet?.user_id && existingWallet.user_id !== userId) {
      throw new WalletOwnershipConflictError();
    }
    // A Privy linked-account attestation must never downgrade or reopen a
    // chain-specific SIWE/EIP-1271 ownership link.
    if (
      existingWallet?.wallet_kind === 'contract'
      || (existingWallet?.user_id === userId && existingWallet.verification_method !== 'privy_attestation')
    ) {
      continue;
    }

    if (existingWallet?.wallet_id) existingWalletIds.set(wallet.address, existingWallet.wallet_id);
    if (existingWallet?.link_id) existingLinkIds.set(wallet.address, existingWallet.link_id);
    if (existingWallet?.wallet_id && !existingWallet.link_id) {
      const priorPrivyLink = await database.prepare(`
        SELECT id
        FROM user_wallet_links
        WHERE user_id = ?
          AND wallet_id = ?
          AND verification_method = 'privy_attestation'
        ORDER BY linked_at DESC
        LIMIT 1
      `).bind(userId, existingWallet.wallet_id).first<{ id: string }>();
      if (priorPrivyLink?.id) existingLinkIds.set(wallet.address, priorPrivyLink.id);
    }
    eligibleWallets.push(wallet);
  }

  const existingPrimary = await database.prepare(`
    SELECT user_wallet_links.id, user_wallet_links.verification_method, wallets.address
    FROM user_wallet_links
    INNER JOIN wallets ON wallets.id = user_wallet_links.wallet_id
    WHERE user_id = ?
      AND is_primary = 1
      AND unlinked_at IS NULL
    LIMIT 1
  `).bind(userId).first<{
    id: string;
    verification_method: VerifiedWallet['verificationMethod'];
    address: string;
  }>();

  let primaryAddress: string | null = null;
  if (!existingPrimary) {
    primaryAddress = eligibleWallets[0]?.address ?? null;
  } else if (existingPrimary.verification_method === 'privy_attestation') {
    primaryAddress = eligibleWallets.some((wallet) => wallet.address === existingPrimary.address)
      ? existingPrimary.address
      : eligibleWallets[0]?.address ?? null;
  }

  const walletKeys = await Promise.all(eligibleWallets.map(async (wallet) => {
    const [generatedWalletId, generatedLinkId, proofHash] = await Promise.all([
      existingWalletIds.has(wallet.address)
        ? Promise.resolve(existingWalletIds.get(wallet.address) as string)
        : stableIdentifier('wal', `${ROBINHOOD_CHAIN_ID}:${wallet.address}`),
      existingLinkIds.has(wallet.address)
        ? Promise.resolve(existingLinkIds.get(wallet.address) as string)
        : stableIdentifier('pwl', `${userId}:${ROBINHOOD_CHAIN_ID}:${wallet.address}`),
      stableIdentifier('pva', `${userId}:${wallet.address}:${wallet.verifiedAt}`),
    ]);
    return { wallet, walletId: generatedWalletId, linkId: generatedLinkId, proofHash };
  }));

  const statements: D1PreparedStatement[] = [
    database.prepare(`
      UPDATE user_wallet_links
      SET is_primary = 0
      WHERE user_id = ?
        AND verification_method = 'privy_attestation'
        AND unlinked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM privy_wallet_sync_state
          WHERE user_id = ? AND request_id = ?
        )
    `).bind(userId, userId, requestId),
  ];

  if (eligibleWallets.length) {
    const placeholders = eligibleWallets.map(() => '?').join(', ');
    statements.push(database.prepare(`
      UPDATE user_wallet_links
      SET is_primary = 0, unlinked_at = ?
      WHERE user_id = ?
        AND verification_method = 'privy_attestation'
        AND unlinked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM privy_wallet_sync_state
          WHERE user_id = ? AND request_id = ?
        )
        AND wallet_id NOT IN (
          SELECT id
          FROM wallets
          WHERE chain_id = ?
            AND address IN (${placeholders})
        )
    `).bind(
      now,
      userId,
      userId,
      requestId,
      ROBINHOOD_CHAIN_ID,
      ...eligibleWallets.map((wallet) => wallet.address),
    ));
  } else {
    statements.push(database.prepare(`
      UPDATE user_wallet_links
      SET is_primary = 0, unlinked_at = ?
      WHERE user_id = ?
        AND verification_method = 'privy_attestation'
        AND unlinked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM privy_wallet_sync_state
          WHERE user_id = ? AND request_id = ?
        )
    `).bind(now, userId, userId, requestId));
  }

  walletKeys.forEach(({ wallet, walletId, linkId, proofHash }) => {
    statements.push(
      database.prepare(`
        INSERT INTO wallets (id, chain_id, address, checksum_address, wallet_kind, created_at)
        SELECT ?, ?, ?, NULL, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM privy_wallet_sync_state
          WHERE user_id = ? AND request_id = ?
        )
        ON CONFLICT(chain_id, address) DO UPDATE SET
          wallet_kind = CASE
            WHEN wallets.wallet_kind = 'contract' THEN wallets.wallet_kind
            WHEN excluded.wallet_kind = 'embedded' THEN excluded.wallet_kind
            ELSE wallets.wallet_kind
          END
      `).bind(walletId, ROBINHOOD_CHAIN_ID, wallet.address, wallet.walletKind, now, userId, requestId),
      database.prepare(`
        INSERT INTO user_wallet_links (
          id, user_id, wallet_id, verification_method, proof_hash,
          is_primary, verified_at, linked_at, unlinked_at
        )
        SELECT ?, ?, ?, 'privy_attestation', ?, ?, ?, ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM privy_wallet_sync_state
          WHERE user_id = ? AND request_id = ?
        )
        ON CONFLICT(id) DO UPDATE SET
          proof_hash = excluded.proof_hash,
          is_primary = excluded.is_primary,
          verified_at = MAX(user_wallet_links.verified_at, excluded.verified_at),
          unlinked_at = NULL
        WHERE user_wallet_links.user_id = excluded.user_id
          AND user_wallet_links.wallet_id = excluded.wallet_id
          AND user_wallet_links.verification_method = 'privy_attestation'
      `).bind(
        linkId,
        userId,
        walletId,
        proofHash,
        wallet.address === primaryAddress ? 1 : 0,
        wallet.verifiedAt,
        now,
        userId,
        requestId,
      ),
    );
  });

  statements.push(database.prepare(`
    INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
    SELECT ?, ?, 'privy.wallets.synchronized', ?, ?
    WHERE EXISTS (
      SELECT 1 FROM privy_wallet_sync_state
      WHERE user_id = ? AND request_id = ?
    )
  `).bind(
    `aud_${crypto.randomUUID().replace(/-/g, '')}`,
    userId,
    JSON.stringify({ source: 'authoritative_privy_user', linkedWallets: eligibleWallets.length }),
    now,
    userId,
    requestId,
  ));

  statements.push(database.prepare(`
    UPDATE privy_wallet_sync_state
    SET applied_request_id = ?, updated_at = ?
    WHERE user_id = ?
      AND request_id = ?
  `).bind(requestId, now, userId, requestId));

  await database.batch(statements);
  const applied = await database.prepare(`
    SELECT user_id
    FROM privy_wallet_sync_state
    WHERE user_id = ?
      AND request_id = ?
      AND applied_request_id = ?
    LIMIT 1
  `).bind(userId, requestId, requestId).first<{ user_id: string }>();
  return {
    linkedWallets: applied ? eligibleWallets.length : 0,
    synchronized: Boolean(applied),
  };
}

function isWalletConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unique constraint failed|uq_active_wallet_owner|uq_active_primary_wallet).*user_wallet_links|user_wallet_links.*(?:unique constraint failed|uq_active_wallet_owner|uq_active_primary_wallet)/i.test(message);
}

export async function syncPrivyWallets(
  userId: string,
  attestations: PrivyWalletAttestation[],
  requestId: string,
) {
  if (!PRIVY_SYNC_REQUEST_PATTERN.test(requestId)) {
    throw new Error('The Privy wallet synchronization request is invalid.');
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await syncPrivyWalletsOnce(userId, attestations, requestId);
    } catch (error) {
      if (error instanceof WalletOwnershipConflictError) throw error;
      if (!isWalletConstraintError(error)) throw error;
      if (attempt === 1) throw new WalletSynchronizationConflictError();
    }
  }
  throw new WalletSynchronizationConflictError();
}

export async function getAccountPreferences(userId: string): Promise<AccountPreferences> {
  const database = getDatabase();
  const [preferenceRow, favoriteResult] = await Promise.all([
    database.prepare(`
      SELECT default_market_id, chart_interval, reduce_motion
      FROM user_preferences
      WHERE user_id = ?
      LIMIT 1
    `).bind(userId).first<PreferenceRow>(),
    database.prepare(`
      SELECT market_id
      FROM user_market_favorites
      WHERE user_id = ?
      ORDER BY created_at ASC, market_id ASC
    `).bind(userId).all<FavoriteRow>(),
  ]);

  return {
    defaultMarketId: preferenceRow?.default_market_id ?? 'btc-usdt',
    chartInterval: preferenceRow?.chart_interval ?? '15',
    reduceMotion: Boolean(preferenceRow?.reduce_motion),
    favoriteMarkets: favoriteResult.results.map((row) => row.market_id),
  };
}

export async function updateAccountPreferences(userId: string, preferences: AccountPreferences) {
  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    database.prepare(`
      INSERT INTO user_preferences (user_id, language, default_market_id, chart_interval, reduce_motion, ui_preferences_json, updated_at)
      VALUES (?, 'en', ?, ?, ?, '{}', ?)
      ON CONFLICT(user_id) DO UPDATE SET
        default_market_id = excluded.default_market_id,
        chart_interval = excluded.chart_interval,
        reduce_motion = excluded.reduce_motion,
        updated_at = excluded.updated_at
    `).bind(userId, preferences.defaultMarketId, preferences.chartInterval, preferences.reduceMotion ? 1 : 0, now),
    database.prepare('DELETE FROM user_market_favorites WHERE user_id = ?').bind(userId),
  ];

  for (const marketId of preferences.favoriteMarkets) {
    statements.push(database.prepare(`
      INSERT INTO user_market_favorites (user_id, market_id, created_at)
      VALUES (?, ?, ?)
    `).bind(userId, marketId, now));
  }

  await database.batch(statements);
  return getAccountPreferences(userId);
}

export async function getVerifiedWallets(userId: string): Promise<VerifiedWallet[]> {
  const result = await getDatabase().prepare(`
    SELECT
      wallets.id,
      wallets.address,
      wallets.checksum_address,
      wallets.chain_id,
      wallets.wallet_kind,
      user_wallet_links.verification_method,
      user_wallet_links.is_primary,
      user_wallet_links.verified_at
    FROM user_wallet_links
    INNER JOIN wallets ON wallets.id = user_wallet_links.wallet_id
    WHERE user_wallet_links.user_id = ?
      AND user_wallet_links.unlinked_at IS NULL
      AND (
        user_wallet_links.verification_method <> 'privy_attestation'
        OR EXISTS (
          SELECT 1
          FROM privy_wallet_sync_state
          WHERE privy_wallet_sync_state.user_id = user_wallet_links.user_id
            AND privy_wallet_sync_state.request_id = privy_wallet_sync_state.applied_request_id
            AND privy_wallet_sync_state.updated_at >= unixepoch() - ${PRIVY_WALLET_SYNC_MAX_AGE_SECONDS}
        )
      )
    ORDER BY user_wallet_links.is_primary DESC, user_wallet_links.linked_at ASC
  `).bind(userId).all<WalletRow>();

  return result.results.map((row) => ({
    id: row.id,
    address: row.address,
    checksumAddress: row.checksum_address,
    chainId: row.chain_id,
    walletKind: row.wallet_kind,
    verificationMethod: row.verification_method,
    isPrimary: Boolean(row.is_primary),
    verifiedAt: row.verified_at,
  }));
}

export async function getProjectionCounts(userId: string, venueAddress: string | null) {
  const normalizedVenueAddress = venueAddress?.toLowerCase() ?? '';
  if (!ADDRESS_PATTERN.test(normalizedVenueAddress)) {
    return { positions: 0, openOrders: 0, trades: 0, fundingPayments: 0 };
  }

  const database = getDatabase();
  const [positions, orders, trades, funding] = await Promise.all([
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM position_projections
      INNER JOIN chain_events ON chain_events.event_id = position_projections.updated_event_id
        AND chain_events.chain_id = position_projections.chain_id
        AND chain_events.contract_address = position_projections.venue_address
      INNER JOIN wallets ON wallets.chain_id = position_projections.chain_id
        AND wallets.address = position_projections.account_address
      INNER JOIN user_wallet_links ON user_wallet_links.wallet_id = wallets.id
      WHERE position_projections.chain_id = ?
        AND position_projections.venue_address = ?
        AND position_projections.side <> 'flat'
        AND position_projections.size_raw <> '0'
        AND chain_events.is_canonical = 1
        AND user_wallet_links.user_id = ?
        AND user_wallet_links.unlinked_at IS NULL
        AND (
          user_wallet_links.verification_method <> 'privy_attestation'
          OR EXISTS (
            SELECT 1 FROM privy_wallet_sync_state
            WHERE privy_wallet_sync_state.user_id = user_wallet_links.user_id
              AND privy_wallet_sync_state.request_id = privy_wallet_sync_state.applied_request_id
              AND privy_wallet_sync_state.updated_at >= unixepoch() - ${PRIVY_WALLET_SYNC_MAX_AGE_SECONDS}
          )
        )
    `).bind(ROBINHOOD_CHAIN_ID, normalizedVenueAddress, userId).first<{ count: number }>(),
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM order_projections
      INNER JOIN chain_events ON chain_events.event_id = order_projections.updated_event_id
        AND chain_events.chain_id = order_projections.chain_id
        AND chain_events.contract_address = order_projections.venue_address
      INNER JOIN wallets ON wallets.chain_id = order_projections.chain_id
        AND wallets.address = order_projections.account_address
      INNER JOIN user_wallet_links ON user_wallet_links.wallet_id = wallets.id
      WHERE order_projections.chain_id = ?
        AND order_projections.venue_address = ?
        AND order_projections.status IN ('open', 'partially_filled')
        AND chain_events.is_canonical = 1
        AND user_wallet_links.user_id = ?
        AND user_wallet_links.unlinked_at IS NULL
        AND (
          user_wallet_links.verification_method <> 'privy_attestation'
          OR EXISTS (
            SELECT 1 FROM privy_wallet_sync_state
            WHERE privy_wallet_sync_state.user_id = user_wallet_links.user_id
              AND privy_wallet_sync_state.request_id = privy_wallet_sync_state.applied_request_id
              AND privy_wallet_sync_state.updated_at >= unixepoch() - ${PRIVY_WALLET_SYNC_MAX_AGE_SECONDS}
          )
        )
    `).bind(ROBINHOOD_CHAIN_ID, normalizedVenueAddress, userId).first<{ count: number }>(),
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM trade_projections
      INNER JOIN chain_events ON chain_events.event_id = trade_projections.source_event_id
        AND chain_events.chain_id = trade_projections.chain_id
        AND chain_events.contract_address = trade_projections.venue_address
      INNER JOIN wallets ON wallets.chain_id = trade_projections.chain_id
        AND wallets.address = trade_projections.account_address
      INNER JOIN user_wallet_links ON user_wallet_links.wallet_id = wallets.id
      WHERE trade_projections.chain_id = ?
        AND trade_projections.venue_address = ?
        AND chain_events.is_canonical = 1
        AND user_wallet_links.user_id = ?
        AND user_wallet_links.unlinked_at IS NULL
        AND (
          user_wallet_links.verification_method <> 'privy_attestation'
          OR EXISTS (
            SELECT 1 FROM privy_wallet_sync_state
            WHERE privy_wallet_sync_state.user_id = user_wallet_links.user_id
              AND privy_wallet_sync_state.request_id = privy_wallet_sync_state.applied_request_id
              AND privy_wallet_sync_state.updated_at >= unixepoch() - ${PRIVY_WALLET_SYNC_MAX_AGE_SECONDS}
          )
        )
    `).bind(ROBINHOOD_CHAIN_ID, normalizedVenueAddress, userId).first<{ count: number }>(),
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM funding_payment_projections
      INNER JOIN chain_events ON chain_events.event_id = funding_payment_projections.source_event_id
        AND chain_events.chain_id = funding_payment_projections.chain_id
        AND chain_events.contract_address = funding_payment_projections.venue_address
      INNER JOIN wallets ON wallets.chain_id = funding_payment_projections.chain_id
        AND wallets.address = funding_payment_projections.account_address
      INNER JOIN user_wallet_links ON user_wallet_links.wallet_id = wallets.id
      WHERE funding_payment_projections.chain_id = ?
        AND funding_payment_projections.venue_address = ?
        AND chain_events.is_canonical = 1
        AND user_wallet_links.user_id = ?
        AND user_wallet_links.unlinked_at IS NULL
        AND (
          user_wallet_links.verification_method <> 'privy_attestation'
          OR EXISTS (
            SELECT 1 FROM privy_wallet_sync_state
            WHERE privy_wallet_sync_state.user_id = user_wallet_links.user_id
              AND privy_wallet_sync_state.request_id = privy_wallet_sync_state.applied_request_id
              AND privy_wallet_sync_state.updated_at >= unixepoch() - ${PRIVY_WALLET_SYNC_MAX_AGE_SECONDS}
          )
        )
    `).bind(ROBINHOOD_CHAIN_ID, normalizedVenueAddress, userId).first<{ count: number }>(),
  ]);

  return {
    positions: Number(positions?.count ?? 0),
    openOrders: Number(orders?.count ?? 0),
    trades: Number(trades?.count ?? 0),
    fundingPayments: Number(funding?.count ?? 0),
  };
}

function formatRawUnits(rawValue: string, decimals: number, precision = 8) {
  if (!/^\d+$/.test(rawValue) || decimals < 0 || decimals > 36) return rawValue;
  const padded = rawValue.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals || undefined);
  const fraction = decimals ? padded.slice(-decimals).slice(0, precision).replace(/0+$/, '') : '';
  return fraction ? `${whole}.${fraction}` : whole;
}

export async function getVerifiedVaultHistory(userId: string, address: string, vaultAddress: string | null) {
  const normalizedAddress = address.toLowerCase();
  if (!ADDRESS_PATTERN.test(normalizedAddress)) return { ownershipVerified: false, items: [] as const };

  const database = getDatabase();
  const ownership = await database.prepare(`
    SELECT user_wallet_links.id
    FROM user_wallet_links
    INNER JOIN wallets ON wallets.id = user_wallet_links.wallet_id
    WHERE user_wallet_links.user_id = ?
      AND wallets.chain_id = ?
      AND wallets.address = ?
      AND user_wallet_links.unlinked_at IS NULL
      AND (
        user_wallet_links.verification_method <> 'privy_attestation'
        OR EXISTS (
          SELECT 1 FROM privy_wallet_sync_state
          WHERE privy_wallet_sync_state.user_id = user_wallet_links.user_id
            AND privy_wallet_sync_state.request_id = privy_wallet_sync_state.applied_request_id
            AND privy_wallet_sync_state.updated_at >= unixepoch() - ${PRIVY_WALLET_SYNC_MAX_AGE_SECONDS}
        )
      )
    LIMIT 1
  `).bind(userId, ROBINHOOD_CHAIN_ID, normalizedAddress).first<{ id: string }>();

  if (!ownership) return { ownershipVerified: false, items: [] as const };

  const normalizedVaultAddress = vaultAddress?.toLowerCase() ?? '';
  if (!ADDRESS_PATTERN.test(normalizedVaultAddress)) {
    return { ownershipVerified: true, items: [] as const };
  }

  const result = await database.prepare(`
    SELECT
      vault_activity.event_id AS id,
      vault_activity.direction,
      vault_activity.asset_symbol_snapshot AS asset,
      vault_activity.amount_raw,
      vault_activity.asset_decimals,
      chain_events.block_timestamp,
      chain_events.transaction_hash,
      chain_events.is_finalized
    FROM vault_activity
    INNER JOIN chain_events ON chain_events.event_id = vault_activity.event_id
      AND chain_events.chain_id = vault_activity.chain_id
      AND chain_events.contract_address = vault_activity.vault_address
    WHERE vault_activity.chain_id = ?
      AND vault_activity.account_address = ?
      AND vault_activity.vault_address = ?
      AND chain_events.is_canonical = 1
    ORDER BY chain_events.block_number DESC, chain_events.log_index DESC
    LIMIT 100
  `).bind(ROBINHOOD_CHAIN_ID, normalizedAddress, normalizedVaultAddress).all<VaultHistoryRow>();

  return {
    ownershipVerified: true,
    items: result.results.map((row) => ({
      id: row.id,
      type: row.direction,
      asset: row.asset,
      amount: formatRawUnits(row.amount_raw, row.asset_decimals),
      status: row.is_finalized ? 'confirmed' as const : 'pending' as const,
      timestamp: new Date(row.block_timestamp * 1000).toISOString(),
      transactionHash: row.transaction_hash,
    })),
  };
}

export async function getIndexerCheckpoint(streamKey: string, contractAddress: string | null) {
  const normalizedContractAddress = contractAddress?.toLowerCase() ?? '';
  if (!ADDRESS_PATTERN.test(normalizedContractAddress)) return null;

  return getDatabase().prepare(`
    SELECT chain_id, contract_address, last_scanned_block, last_finalized_block, confirmations_required, state, updated_at
    FROM indexer_checkpoints
    WHERE stream_key = ?
      AND chain_id = ?
      AND contract_address = ?
    LIMIT 1
  `).bind(streamKey, ROBINHOOD_CHAIN_ID, normalizedContractAddress).first<{
    chain_id: number;
    contract_address: string;
    last_scanned_block: number;
    last_finalized_block: number;
    confirmations_required: number;
    state: 'idle' | 'syncing' | 'rebuilding' | 'healthy' | 'error';
    updated_at: number;
  }>();
}

export async function checkDatabaseHealth() {
  const row = await getDatabase().prepare(`
    SELECT COUNT(*) AS table_count
    FROM sqlite_schema
    WHERE type = 'table'
      AND name IN (
        'app_users',
        'auth_identities',
        'wallets',
        'user_wallet_links',
        'privy_wallet_sync_state',
        'wallet_challenges',
        'user_preferences',
        'user_market_favorites',
        'chain_events',
        'vault_activity',
        'indexer_checkpoints',
        'order_projections',
        'trade_projections',
        'position_projections',
        'funding_payment_projections',
        'agent_conversations',
        'agent_messages',
        'agent_financial_intents',
        'audit_events'
      )
  `).first<{ table_count: number }>();
  return Number(row?.table_count ?? 0) === 19;
}
