import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const createdAt = () => integer('created_at').notNull().default(sql`(unixepoch())`);
const updatedAt = () => integer('updated_at').notNull().default(sql`(unixepoch())`);
const canonicalUnsigned = (column: AnySQLiteColumn) => sql`
  length(${column}) > 0
  and ${column} not glob '*[^0-9]*'
  and (${column} = '0' or substr(${column}, 1, 1) between '1' and '9')
`;
const canonicalSigned = (column: AnySQLiteColumn) => sql`
  ${column} = '0'
  or (
    ${column} not glob '*[^0-9]*'
    and substr(${column}, 1, 1) between '1' and '9'
  )
  or (
    substr(${column}, 1, 1) = '-'
    and length(${column}) > 1
    and substr(${column}, 2) not glob '*[^0-9]*'
    and substr(${column}, 2, 1) between '1' and '9'
  )
`;
const evmAddress = (column: AnySQLiteColumn) => sql`
  length(${column}) = 42
  and substr(${column}, 1, 2) = '0x'
  and ${column} = lower(${column})
  and substr(${column}, 3) not glob '*[^0-9a-f]*'
`;
const bytes32Hex = (column: AnySQLiteColumn) => sql`
  length(${column}) = 66
  and substr(${column}, 1, 2) = '0x'
  and ${column} = lower(${column})
  and substr(${column}, 3) not glob '*[^0-9a-f]*'
`;

export const appUsers = sqliteTable('app_users', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('active'),
  displayName: text('display_name'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: integer('deleted_at'),
}, (table) => [
  check('app_users_status_check', sql`${table.status} in ('active', 'suspended', 'deleted')`),
]);

export const authIdentities = sqliteTable('auth_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull(),
  subject: text('subject').notNull(),
  provider: text('provider').notNull(),
  createdAt: createdAt(),
  lastSeenAt: integer('last_seen_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('uq_auth_identities_issuer_subject').on(table.issuer, table.subject),
  index('idx_auth_identities_user').on(table.userId),
]);

export const wallets = sqliteTable('wallets', {
  id: text('id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  address: text('address').notNull(),
  checksumAddress: text('checksum_address'),
  walletKind: text('wallet_kind').notNull().default('external'),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('uq_wallets_chain_address').on(table.chainId, table.address),
  check('wallets_chain_id_check', sql`${table.chainId} > 0`),
  check('wallets_address_check', evmAddress(table.address)),
  check('wallets_kind_check', sql`${table.walletKind} in ('external', 'embedded', 'contract')`),
]);

export const userWalletLinks = sqliteTable('user_wallet_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  walletId: text('wallet_id').notNull().references(() => wallets.id, { onDelete: 'restrict' }),
  verificationMethod: text('verification_method').notNull(),
  proofHash: text('proof_hash'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  verifiedAt: integer('verified_at').notNull(),
  linkedAt: integer('linked_at').notNull().default(sql`(unixepoch())`),
  unlinkedAt: integer('unlinked_at'),
}, (table) => [
  check('wallet_links_verification_check', sql`${table.verificationMethod} in ('siwe_eoa', 'eip1271', 'privy_attestation')`),
  check('wallet_links_primary_check', sql`${table.isPrimary} in (0, 1)`),
  check('wallet_links_timestamps_check', sql`${table.unlinkedAt} is null or ${table.unlinkedAt} >= ${table.linkedAt}`),
  uniqueIndex('uq_active_wallet_owner').on(table.walletId).where(sql`${table.unlinkedAt} is null`),
  uniqueIndex('uq_active_primary_wallet').on(table.userId).where(sql`${table.isPrimary} = 1 and ${table.unlinkedAt} is null`),
  index('idx_wallet_links_user_active').on(table.userId, table.linkedAt).where(sql`${table.unlinkedAt} is null`),
]);

export const privyWalletSyncState = sqliteTable('privy_wallet_sync_state', {
  userId: text('user_id').primaryKey().references(() => appUsers.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull(),
  appliedRequestId: text('applied_request_id'),
  updatedAt: updatedAt(),
}, (table) => [
  check('privy_wallet_sync_request_check', sql`length(${table.requestId}) between 1 and 80`),
  check('privy_wallet_sync_applied_check', sql`${table.appliedRequestId} is null or length(${table.appliedRequestId}) between 1 and 80`),
]);

export const walletChallenges = sqliteTable('wallet_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  chainId: integer('chain_id').notNull(),
  address: text('address').notNull(),
  messageHash: text('message_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex('uq_wallet_challenges_message_hash').on(table.messageHash),
  index('idx_wallet_challenges_user_expiry').on(table.userId, table.expiresAt),
  check('wallet_challenges_chain_check', sql`${table.chainId} > 0`),
  check('wallet_challenges_address_check', evmAddress(table.address)),
  check('wallet_challenges_hash_check', bytes32Hex(table.messageHash)),
  check('wallet_challenges_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  check('wallet_challenges_consumed_check', sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`),
]);

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => appUsers.id, { onDelete: 'cascade' }),
  language: text('language').notNull().default('en'),
  defaultMarketId: text('default_market_id').notNull().default('btc-usdt'),
  chartInterval: text('chart_interval').notNull().default('15'),
  reduceMotion: integer('reduce_motion', { mode: 'boolean' }).notNull().default(false),
  uiPreferencesJson: text('ui_preferences_json').notNull().default('{}'),
  updatedAt: updatedAt(),
}, (table) => [
  check('user_preferences_language_check', sql`${table.language} = 'en'`),
  check('user_preferences_interval_check', sql`${table.chartInterval} in ('1', '5', '15', '30', '60', '240', 'D')`),
  check('user_preferences_reduce_motion_check', sql`${table.reduceMotion} in (0, 1)`),
  check('user_preferences_json_check', sql`json_valid(${table.uiPreferencesJson})`),
]);

export const userMarketFavorites = sqliteTable('user_market_favorites', {
  userId: text('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  marketId: text('market_id').notNull(),
  createdAt: createdAt(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.marketId], name: 'pk_user_market_favorites' }),
]);

export const chainEvents = sqliteTable('chain_events', {
  eventId: text('event_id').primaryKey(),
  chainId: integer('chain_id').notNull(),
  contractAddress: text('contract_address').notNull(),
  transactionHash: text('transaction_hash').notNull(),
  logIndex: integer('log_index').notNull(),
  blockNumber: integer('block_number').notNull(),
  blockHash: text('block_hash').notNull(),
  blockTimestamp: integer('block_timestamp').notNull(),
  topic0: text('topic0').notNull(),
  eventName: text('event_name').notNull(),
  decoderVersion: integer('decoder_version').notNull().default(1),
  topicsJson: text('topics_json').notNull().default('[]'),
  dataHex: text('data_hex').notNull().default('0x'),
  decodedJson: text('decoded_json').notNull().default('{}'),
  isCanonical: integer('is_canonical', { mode: 'boolean' }).notNull().default(true),
  isFinalized: integer('is_finalized', { mode: 'boolean' }).notNull().default(false),
  observedAt: integer('observed_at').notNull().default(sql`(unixepoch())`),
  finalizedAt: integer('finalized_at'),
  orphanedAt: integer('orphaned_at'),
}, (table) => [
  uniqueIndex('uq_chain_events_transaction_log').on(table.chainId, table.transactionHash, table.logIndex),
  index('idx_chain_events_contract_scan').on(table.chainId, table.contractAddress, table.blockNumber, table.logIndex),
  index('idx_chain_events_transaction').on(table.chainId, table.transactionHash),
  check('chain_events_chain_check', sql`${table.chainId} > 0`),
  check('chain_events_contract_check', evmAddress(table.contractAddress)),
  check('chain_events_transaction_check', bytes32Hex(table.transactionHash)),
  check('chain_events_block_hash_check', bytes32Hex(table.blockHash)),
  check('chain_events_topic0_check', bytes32Hex(table.topic0)),
  check('chain_events_position_check', sql`${table.logIndex} >= 0 and ${table.blockNumber} >= 0 and ${table.blockTimestamp} >= 0`),
  check('chain_events_decoder_check', sql`${table.decoderVersion} > 0`),
  check('chain_events_topics_json_check', sql`json_valid(${table.topicsJson})`),
  check('chain_events_data_hex_check', sql`length(${table.dataHex}) >= 2 and substr(${table.dataHex}, 1, 2) = '0x' and ${table.dataHex} = lower(${table.dataHex}) and substr(${table.dataHex}, 3) not glob '*[^0-9a-f]*' and (length(${table.dataHex}) - 2) % 2 = 0`),
  check('chain_events_decoded_json_check', sql`json_valid(${table.decodedJson})`),
  check('chain_events_canonical_check', sql`${table.isCanonical} in (0, 1)`),
  check('chain_events_finalized_check', sql`${table.isFinalized} in (0, 1)`),
  check('chain_events_finality_check', sql`${table.isFinalized} = 0 or ${table.isCanonical} = 1`),
]);

export const vaultActivity = sqliteTable('vault_activity', {
  eventId: text('event_id').primaryKey().references(() => chainEvents.eventId, { onDelete: 'restrict' }),
  chainId: integer('chain_id').notNull(),
  vaultAddress: text('vault_address').notNull(),
  direction: text('direction').notNull(),
  accountAddress: text('account_address').notNull(),
  recipientAddress: text('recipient_address'),
  assetKind: text('asset_kind').notNull(),
  assetAddress: text('asset_address'),
  assetSymbolSnapshot: text('asset_symbol_snapshot').notNull(),
  assetDecimals: integer('asset_decimals').notNull(),
  amountRaw: text('amount_raw').notNull(),
}, (table) => [
  index('idx_vault_activity_account').on(table.chainId, table.accountAddress),
  index('idx_vault_activity_vault').on(table.chainId, table.vaultAddress),
  check('vault_activity_direction_check', sql`${table.direction} in ('deposit', 'withdraw')`),
  check('vault_activity_asset_kind_check', sql`${table.assetKind} in ('native', 'erc20')`),
  check('vault_activity_decimals_check', sql`${table.assetDecimals} between 0 and 36`),
  check('vault_activity_chain_check', sql`${table.chainId} > 0`),
  check('vault_activity_vault_check', evmAddress(table.vaultAddress)),
  check('vault_activity_account_check', evmAddress(table.accountAddress)),
  check('vault_activity_recipient_check', sql`${table.recipientAddress} is null or (${evmAddress(table.recipientAddress)})`),
  check('vault_activity_asset_address_check', sql`(${table.assetKind} = 'native' and ${table.assetAddress} is null) or (${table.assetKind} = 'erc20' and ${table.assetAddress} is not null and (${evmAddress(table.assetAddress)}))`),
  check('vault_activity_amount_check', canonicalUnsigned(table.amountRaw)),
]);

export const indexerCheckpoints = sqliteTable('indexer_checkpoints', {
  streamKey: text('stream_key').primaryKey(),
  chainId: integer('chain_id').notNull(),
  contractAddress: text('contract_address').notNull(),
  lastScannedBlock: integer('last_scanned_block').notNull().default(-1),
  lastScannedBlockHash: text('last_scanned_block_hash'),
  lastFinalizedBlock: integer('last_finalized_block').notNull().default(-1),
  confirmationsRequired: integer('confirmations_required').notNull().default(0),
  state: text('state').notNull().default('idle'),
  updatedAt: updatedAt(),
}, (table) => [
  check('indexer_checkpoints_chain_check', sql`${table.chainId} > 0`),
  check('indexer_checkpoints_contract_check', evmAddress(table.contractAddress)),
  check('indexer_checkpoints_blocks_check', sql`${table.lastScannedBlock} >= -1 and ${table.lastFinalizedBlock} >= -1 and ${table.lastFinalizedBlock} <= ${table.lastScannedBlock}`),
  check('indexer_checkpoints_confirmations_check', sql`${table.confirmationsRequired} >= 0`),
  check('indexer_checkpoints_state_check', sql`${table.state} in ('idle', 'syncing', 'rebuilding', 'healthy', 'error')`),
]);

export const orderProjections = sqliteTable('order_projections', {
  projectionKey: text('projection_key').primaryKey(),
  chainId: integer('chain_id').notNull(),
  venueAddress: text('venue_address').notNull(),
  onchainOrderId: text('onchain_order_id').notNull(),
  accountAddress: text('account_address').notNull(),
  marketId: text('market_id').notNull(),
  side: text('side').notNull(),
  orderType: text('order_type').notNull(),
  status: text('status').notNull(),
  sizeRaw: text('size_raw').notNull(),
  filledSizeRaw: text('filled_size_raw').notNull(),
  limitPriceRaw: text('limit_price_raw'),
  triggerPriceRaw: text('trigger_price_raw'),
  averageFillPriceRaw: text('average_fill_price_raw'),
  sizeDecimals: integer('size_decimals').notNull(),
  priceDecimals: integer('price_decimals').notNull(),
  reduceOnly: integer('reduce_only', { mode: 'boolean' }).notNull().default(false),
  createdBlockNumber: integer('created_block_number').notNull(),
  updatedBlockNumber: integer('updated_block_number').notNull(),
  createdEventId: text('created_event_id').notNull().references(() => chainEvents.eventId),
  updatedEventId: text('updated_event_id').notNull().references(() => chainEvents.eventId),
}, (table) => [
  uniqueIndex('uq_order_projections_venue_order').on(table.chainId, table.venueAddress, table.onchainOrderId),
  index('idx_order_projections_account_status').on(table.chainId, table.accountAddress, table.status, table.updatedBlockNumber),
  index('idx_order_projections_market_status').on(table.chainId, table.venueAddress, table.marketId, table.status),
  check('order_projections_chain_check', sql`${table.chainId} > 0`),
  check('order_projections_venue_check', evmAddress(table.venueAddress)),
  check('order_projections_account_check', evmAddress(table.accountAddress)),
  check('order_projections_side_check', sql`${table.side} in ('long', 'short')`),
  check('order_projections_type_check', sql`${table.orderType} in ('market', 'limit', 'stop', 'stop_limit')`),
  check('order_projections_status_check', sql`${table.status} in ('open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected')`),
  check('order_projections_size_check', canonicalUnsigned(table.sizeRaw)),
  check('order_projections_filled_size_check', canonicalUnsigned(table.filledSizeRaw)),
  check('order_projections_limit_price_check', sql`${table.limitPriceRaw} is null or (${canonicalUnsigned(table.limitPriceRaw)})`),
  check('order_projections_trigger_price_check', sql`${table.triggerPriceRaw} is null or (${canonicalUnsigned(table.triggerPriceRaw)})`),
  check('order_projections_average_price_check', sql`${table.averageFillPriceRaw} is null or (${canonicalUnsigned(table.averageFillPriceRaw)})`),
  check('order_projections_decimals_check', sql`${table.sizeDecimals} between 0 and 36 and ${table.priceDecimals} between 0 and 36`),
  check('order_projections_reduce_only_check', sql`${table.reduceOnly} in (0, 1)`),
  check('order_projections_blocks_check', sql`${table.createdBlockNumber} >= 0 and ${table.updatedBlockNumber} >= ${table.createdBlockNumber}`),
]);

export const tradeProjections = sqliteTable('trade_projections', {
  tradeKey: text('trade_key').primaryKey(),
  chainId: integer('chain_id').notNull(),
  venueAddress: text('venue_address').notNull(),
  onchainTradeId: text('onchain_trade_id').notNull(),
  onchainOrderId: text('onchain_order_id'),
  accountAddress: text('account_address').notNull(),
  marketId: text('market_id').notNull(),
  side: text('side').notNull(),
  liquidityRole: text('liquidity_role'),
  sizeRaw: text('size_raw').notNull(),
  priceRaw: text('price_raw').notNull(),
  feeRaw: text('fee_raw').notNull(),
  realizedPnlRaw: text('realized_pnl_raw'),
  sizeDecimals: integer('size_decimals').notNull(),
  priceDecimals: integer('price_decimals').notNull(),
  collateralDecimals: integer('collateral_decimals').notNull(),
  blockNumber: integer('block_number').notNull(),
  blockTimestamp: integer('block_timestamp').notNull(),
  sourceEventId: text('source_event_id').notNull().unique().references(() => chainEvents.eventId),
}, (table) => [
  uniqueIndex('uq_trade_projections_venue_trade').on(table.chainId, table.venueAddress, table.onchainTradeId),
  index('idx_trade_projections_account_block').on(table.chainId, table.accountAddress, table.blockNumber),
  index('idx_trade_projections_market_block').on(table.chainId, table.venueAddress, table.marketId, table.blockNumber),
  check('trade_projections_chain_check', sql`${table.chainId} > 0`),
  check('trade_projections_venue_check', evmAddress(table.venueAddress)),
  check('trade_projections_account_check', evmAddress(table.accountAddress)),
  check('trade_projections_side_check', sql`${table.side} in ('long', 'short')`),
  check('trade_projections_liquidity_check', sql`${table.liquidityRole} is null or ${table.liquidityRole} in ('maker', 'taker')`),
  check('trade_projections_size_check', canonicalUnsigned(table.sizeRaw)),
  check('trade_projections_price_check', canonicalUnsigned(table.priceRaw)),
  check('trade_projections_fee_check', canonicalUnsigned(table.feeRaw)),
  check('trade_projections_realized_pnl_check', sql`${table.realizedPnlRaw} is null or (${canonicalSigned(table.realizedPnlRaw)})`),
  check('trade_projections_decimals_check', sql`${table.sizeDecimals} between 0 and 36 and ${table.priceDecimals} between 0 and 36 and ${table.collateralDecimals} between 0 and 36`),
  check('trade_projections_block_check', sql`${table.blockNumber} >= 0 and ${table.blockTimestamp} >= 0`),
]);

export const positionProjections = sqliteTable('position_projections', {
  projectionKey: text('projection_key').primaryKey(),
  chainId: integer('chain_id').notNull(),
  venueAddress: text('venue_address').notNull(),
  accountAddress: text('account_address').notNull(),
  marketId: text('market_id').notNull(),
  side: text('side').notNull(),
  sizeRaw: text('size_raw').notNull(),
  collateralRaw: text('collateral_raw').notNull(),
  entryPriceRaw: text('entry_price_raw'),
  realizedPnlRaw: text('realized_pnl_raw').notNull(),
  fundingAccruedRaw: text('funding_accrued_raw').notNull(),
  sizeDecimals: integer('size_decimals').notNull(),
  priceDecimals: integer('price_decimals').notNull(),
  collateralDecimals: integer('collateral_decimals').notNull(),
  updatedBlockNumber: integer('updated_block_number').notNull(),
  updatedEventId: text('updated_event_id').notNull().references(() => chainEvents.eventId),
}, (table) => [
  uniqueIndex('uq_position_projections_account_market').on(table.chainId, table.venueAddress, table.accountAddress, table.marketId),
  index('idx_position_projections_account').on(table.chainId, table.accountAddress),
  index('idx_position_projections_market').on(table.chainId, table.venueAddress, table.marketId),
  check('position_projections_chain_check', sql`${table.chainId} > 0`),
  check('position_projections_venue_check', evmAddress(table.venueAddress)),
  check('position_projections_account_check', evmAddress(table.accountAddress)),
  check('position_projections_side_check', sql`${table.side} in ('long', 'short', 'flat')`),
  check('position_projections_size_check', canonicalUnsigned(table.sizeRaw)),
  check('position_projections_open_size_check', sql`(${table.side} = 'flat' and ${table.sizeRaw} = '0') or (${table.side} in ('long', 'short') and ${table.sizeRaw} <> '0')`),
  check('position_projections_collateral_check', canonicalUnsigned(table.collateralRaw)),
  check('position_projections_entry_price_check', sql`${table.entryPriceRaw} is null or (${canonicalUnsigned(table.entryPriceRaw)})`),
  check('position_projections_realized_pnl_check', canonicalSigned(table.realizedPnlRaw)),
  check('position_projections_funding_check', canonicalSigned(table.fundingAccruedRaw)),
  check('position_projections_decimals_check', sql`${table.sizeDecimals} between 0 and 36 and ${table.priceDecimals} between 0 and 36 and ${table.collateralDecimals} between 0 and 36`),
  check('position_projections_block_check', sql`${table.updatedBlockNumber} >= 0`),
]);

export const fundingPaymentProjections = sqliteTable('funding_payment_projections', {
  paymentKey: text('payment_key').primaryKey(),
  chainId: integer('chain_id').notNull(),
  venueAddress: text('venue_address').notNull(),
  accountAddress: text('account_address').notNull(),
  marketId: text('market_id').notNull(),
  rateRaw: text('rate_raw').notNull(),
  paymentRaw: text('payment_raw').notNull(),
  collateralDecimals: integer('collateral_decimals').notNull(),
  blockNumber: integer('block_number').notNull(),
  blockTimestamp: integer('block_timestamp').notNull(),
  sourceEventId: text('source_event_id').notNull().unique().references(() => chainEvents.eventId),
}, (table) => [
  index('idx_funding_payments_account_block').on(table.chainId, table.accountAddress, table.blockNumber),
  check('funding_payments_chain_check', sql`${table.chainId} > 0`),
  check('funding_payments_venue_check', evmAddress(table.venueAddress)),
  check('funding_payments_account_check', evmAddress(table.accountAddress)),
  check('funding_payments_rate_check', canonicalSigned(table.rateRaw)),
  check('funding_payments_payment_check', canonicalSigned(table.paymentRaw)),
  check('funding_payments_decimals_check', sql`${table.collateralDecimals} between 0 and 36`),
  check('funding_payments_block_check', sql`${table.blockNumber} >= 0 and ${table.blockTimestamp} >= 0`),
]);

export const agentConversations = sqliteTable('agent_conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('New signal session'),
  status: text('status').notNull().default('active'),
  agentVersion: text('agent_version').notNull().default('intent-policy-v1'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: integer('archived_at'),
}, (table) => [
  uniqueIndex('uq_agent_conversations_id_user').on(table.id, table.userId),
  index('idx_agent_conversations_user_status_updated').on(table.userId, table.status, table.updatedAt, table.id),
  check('agent_conversations_title_check', sql`length(${table.title}) between 1 and 80`),
  check('agent_conversations_status_check', sql`${table.status} in ('active', 'archived')`),
  check('agent_conversations_version_check', sql`length(${table.agentVersion}) between 1 and 40`),
  check('agent_conversations_time_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  check('agent_conversations_archive_check', sql`(${table.status} = 'active' and ${table.archivedAt} is null) or (${table.status} = 'archived' and ${table.archivedAt} is not null and ${table.archivedAt} >= ${table.createdAt})`),
]);

export const agentMessages = sqliteTable('agent_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  userId: text('user_id').notNull(),
  sequenceNo: integer('sequence_no').notNull(),
  role: text('role').notNull(),
  visibility: text('visibility').notNull().default('user'),
  status: text('status').notNull().default('complete'),
  contentText: text('content_text').notNull(),
  metadataJson: text('metadata_json').notNull().default('{}'),
  contentHash: text('content_hash').notNull(),
  clientRequestIdHash: text('client_request_id_hash'),
  requestId: text('request_id').notNull(),
  modelId: text('model_id'),
  agentVersion: text('agent_version').notNull().default('intent-policy-v1'),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({
    columns: [table.conversationId, table.userId],
    foreignColumns: [agentConversations.id, agentConversations.userId],
    name: 'fk_agent_messages_conversation_owner',
  }).onDelete('cascade'),
  uniqueIndex('uq_agent_messages_conversation_sequence').on(table.conversationId, table.sequenceNo),
  uniqueIndex('uq_agent_messages_user_client_request').on(table.userId, table.clientRequestIdHash).where(sql`${table.clientRequestIdHash} is not null`),
  uniqueIndex('uq_agent_messages_id_conversation_user').on(table.id, table.conversationId, table.userId),
  index('idx_agent_messages_conversation_created').on(table.conversationId, table.createdAt),
  index('idx_agent_messages_user_created').on(table.userId, table.createdAt),
  check('agent_messages_sequence_check', sql`${table.sequenceNo} > 0`),
  check('agent_messages_role_check', sql`${table.role} in ('user', 'assistant')`),
  check('agent_messages_role_shape_check', sql`
    (
      ${table.role} = 'user'
      and ${table.status} = 'complete'
      and ${table.clientRequestIdHash} is not null
      and ${table.modelId} is null
    )
    or (
      ${table.role} = 'assistant'
      and ${table.clientRequestIdHash} is null
      and ${table.modelId} is not null
    )
  `),
  check('agent_messages_visibility_check', sql`${table.visibility} = 'user'`),
  check('agent_messages_status_check', sql`${table.status} in ('complete', 'failed')`),
  check('agent_messages_content_check', sql`length(${table.contentText}) between 1 and 8000`),
  check('agent_messages_metadata_check', sql`json_valid(${table.metadataJson})`),
  check('agent_messages_content_hash_check', bytes32Hex(table.contentHash)),
  check('agent_messages_request_hash_check', sql`${table.clientRequestIdHash} is null or (${bytes32Hex(table.clientRequestIdHash)})`),
  check('agent_messages_request_id_check', sql`length(${table.requestId}) between 8 and 100`),
  check('agent_messages_model_check', sql`${table.modelId} is null or length(${table.modelId}) between 1 and 80`),
  check('agent_messages_version_check', sql`length(${table.agentVersion}) between 1 and 40`),
]);

export const agentFinancialIntents = sqliteTable('agent_financial_intents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  intentType: text('intent_type').notNull(),
  summaryText: text('summary_text').notNull(),
  status: text('status').notNull(),
  executionMode: text('execution_mode').notNull().default('record_only'),
  payloadJson: text('payload_json').notNull(),
  payloadSchemaVersion: integer('payload_schema_version').notNull().default(1),
  payloadHash: text('payload_hash').notNull(),
  riskJson: text('risk_json').notNull(),
  idempotencyKeyHash: text('idempotency_key_hash').notNull(),
  requestId: text('request_id').notNull(),
  policyVersion: text('policy_version').notNull().default('intent-policy-v1'),
  version: integer('version').notNull().default(1),
  expiresAt: integer('expires_at'),
  closedAt: integer('closed_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  foreignKey({
    columns: [table.conversationId, table.userId],
    foreignColumns: [agentConversations.id, agentConversations.userId],
    name: 'fk_agent_intents_conversation_owner',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.sourceMessageId, table.conversationId, table.userId],
    foreignColumns: [agentMessages.id, agentMessages.conversationId, agentMessages.userId],
    name: 'fk_agent_intents_source_owner',
  }),
  uniqueIndex('uq_agent_intents_user_idempotency').on(table.userId, table.idempotencyKeyHash),
  uniqueIndex('uq_agent_intents_id_user').on(table.id, table.userId),
  index('idx_agent_intents_user_status_created').on(table.userId, table.status, table.createdAt, table.id),
  index('idx_agent_intents_user_created').on(table.userId, table.createdAt, table.id),
  index('idx_agent_intents_conversation_created').on(table.conversationId, table.createdAt, table.id),
  index('idx_agent_intents_proposed_expiry').on(table.status, table.expiresAt).where(sql`${table.status} = 'proposed'`),
  check('agent_intents_type_check', sql`${table.intentType} in ('perp_order_preview', 'close_position_preview', 'cancel_order_preview', 'deposit_preview', 'withdrawal_preview', 'account_query', 'market_query', 'navigation')`),
  check('agent_intents_summary_check', sql`length(${table.summaryText}) between 1 and 240`),
  check('agent_intents_status_check', sql`${table.status} in ('needs_input', 'proposed', 'acknowledged', 'rejected', 'expired', 'blocked', 'completed')`),
  check('agent_intents_type_status_check', sql`
    (
      ${table.intentType} in ('perp_order_preview', 'close_position_preview', 'cancel_order_preview', 'deposit_preview', 'withdrawal_preview')
      and ${table.status} in ('needs_input', 'proposed', 'acknowledged', 'rejected', 'expired', 'blocked')
    )
    or (
      ${table.intentType} in ('account_query', 'market_query', 'navigation')
      and ${table.status} in ('needs_input', 'completed', 'blocked')
    )
  `),
  check('agent_intents_execution_check', sql`${table.executionMode} = 'record_only'`),
  check('agent_intents_payload_check', sql`json_valid(${table.payloadJson}) and length(${table.payloadJson}) between 2 and 65536`),
  check('agent_intents_payload_version_check', sql`${table.payloadSchemaVersion} = 1`),
  check('agent_intents_payload_hash_check', bytes32Hex(table.payloadHash)),
  check('agent_intents_risk_check', sql`json_valid(${table.riskJson}) and length(${table.riskJson}) between 2 and 32768`),
  check('agent_intents_idempotency_check', bytes32Hex(table.idempotencyKeyHash)),
  check('agent_intents_request_id_check', sql`length(${table.requestId}) between 8 and 100`),
  check('agent_intents_policy_check', sql`length(${table.policyVersion}) between 1 and 40`),
  check('agent_intents_version_check', sql`${table.version} > 0`),
  check('agent_intents_expiry_state_check', sql`
    (
      ${table.status} in ('proposed', 'acknowledged', 'expired')
      and ${table.expiresAt} is not null
    )
    or (
      ${table.status} not in ('proposed', 'acknowledged', 'expired')
      and ${table.expiresAt} is null
    )
  `),
  check('agent_intents_closed_state_check', sql`
    (
      ${table.status} in ('rejected', 'expired', 'blocked', 'completed')
      and ${table.closedAt} is not null
    )
    or (
      ${table.status} in ('needs_input', 'proposed', 'acknowledged')
      and ${table.closedAt} is null
    )
  `),
  check('agent_intents_time_check', sql`
    ${table.updatedAt} >= ${table.createdAt}
    and (
      ${table.expiresAt} is null
      or (${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + 900)
    )
    and (${table.closedAt} is null or ${table.closedAt} >= ${table.createdAt})
    and (${table.status} <> 'expired' or ${table.closedAt} >= ${table.expiresAt})
  `),
]);

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => appUsers.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: createdAt(),
}, (table) => [
  index('idx_audit_events_user_created').on(table.userId, table.createdAt),
  check('audit_events_metadata_json_check', sql`json_valid(${table.metadataJson})`),
]);
