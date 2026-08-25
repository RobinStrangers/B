CREATE TABLE `app_users` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`display_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "app_users_status_check" CHECK("app_users"."status" in ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_metadata_json_check" CHECK(json_valid("audit_events"."metadata_json"))
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_user_created` ON `audit_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`provider` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auth_identities_issuer_subject` ON `auth_identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `idx_auth_identities_user` ON `auth_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `chain_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`contract_address` text NOT NULL,
	`transaction_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`block_number` integer NOT NULL,
	`block_hash` text NOT NULL,
	`block_timestamp` integer NOT NULL,
	`topic0` text NOT NULL,
	`event_name` text NOT NULL,
	`decoder_version` integer DEFAULT 1 NOT NULL,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`data_hex` text DEFAULT '0x' NOT NULL,
	`decoded_json` text DEFAULT '{}' NOT NULL,
	`is_canonical` integer DEFAULT true NOT NULL,
	`is_finalized` integer DEFAULT false NOT NULL,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finalized_at` integer,
	`orphaned_at` integer,
	CONSTRAINT "chain_events_chain_check" CHECK("chain_events"."chain_id" > 0),
	CONSTRAINT "chain_events_contract_check" CHECK(
  length("chain_events"."contract_address") = 42
  and substr("chain_events"."contract_address", 1, 2) = '0x'
  and "chain_events"."contract_address" = lower("chain_events"."contract_address")
  and substr("chain_events"."contract_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "chain_events_transaction_check" CHECK(
  length("chain_events"."transaction_hash") = 66
  and substr("chain_events"."transaction_hash", 1, 2) = '0x'
  and "chain_events"."transaction_hash" = lower("chain_events"."transaction_hash")
  and substr("chain_events"."transaction_hash", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "chain_events_block_hash_check" CHECK(
  length("chain_events"."block_hash") = 66
  and substr("chain_events"."block_hash", 1, 2) = '0x'
  and "chain_events"."block_hash" = lower("chain_events"."block_hash")
  and substr("chain_events"."block_hash", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "chain_events_topic0_check" CHECK(
  length("chain_events"."topic0") = 66
  and substr("chain_events"."topic0", 1, 2) = '0x'
  and "chain_events"."topic0" = lower("chain_events"."topic0")
  and substr("chain_events"."topic0", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "chain_events_position_check" CHECK("chain_events"."log_index" >= 0 and "chain_events"."block_number" >= 0 and "chain_events"."block_timestamp" >= 0),
	CONSTRAINT "chain_events_decoder_check" CHECK("chain_events"."decoder_version" > 0),
	CONSTRAINT "chain_events_topics_json_check" CHECK(json_valid("chain_events"."topics_json")),
	CONSTRAINT "chain_events_data_hex_check" CHECK(length("chain_events"."data_hex") >= 2 and substr("chain_events"."data_hex", 1, 2) = '0x' and "chain_events"."data_hex" = lower("chain_events"."data_hex") and substr("chain_events"."data_hex", 3) not glob '*[^0-9a-f]*' and (length("chain_events"."data_hex") - 2) % 2 = 0),
	CONSTRAINT "chain_events_decoded_json_check" CHECK(json_valid("chain_events"."decoded_json")),
	CONSTRAINT "chain_events_canonical_check" CHECK("chain_events"."is_canonical" in (0, 1)),
	CONSTRAINT "chain_events_finalized_check" CHECK("chain_events"."is_finalized" in (0, 1)),
	CONSTRAINT "chain_events_finality_check" CHECK("chain_events"."is_finalized" = 0 or "chain_events"."is_canonical" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_chain_events_transaction_log` ON `chain_events` (`chain_id`,`transaction_hash`,`log_index`);--> statement-breakpoint
CREATE INDEX `idx_chain_events_contract_scan` ON `chain_events` (`chain_id`,`contract_address`,`block_number`,`log_index`);--> statement-breakpoint
CREATE INDEX `idx_chain_events_transaction` ON `chain_events` (`chain_id`,`transaction_hash`);--> statement-breakpoint
CREATE TABLE `funding_payment_projections` (
	`payment_key` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`venue_address` text NOT NULL,
	`account_address` text NOT NULL,
	`market_id` text NOT NULL,
	`rate_raw` text NOT NULL,
	`payment_raw` text NOT NULL,
	`collateral_decimals` integer NOT NULL,
	`block_number` integer NOT NULL,
	`block_timestamp` integer NOT NULL,
	`source_event_id` text NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `chain_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "funding_payments_chain_check" CHECK("funding_payment_projections"."chain_id" > 0),
	CONSTRAINT "funding_payments_venue_check" CHECK(
  length("funding_payment_projections"."venue_address") = 42
  and substr("funding_payment_projections"."venue_address", 1, 2) = '0x'
  and "funding_payment_projections"."venue_address" = lower("funding_payment_projections"."venue_address")
  and substr("funding_payment_projections"."venue_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "funding_payments_account_check" CHECK(
  length("funding_payment_projections"."account_address") = 42
  and substr("funding_payment_projections"."account_address", 1, 2) = '0x'
  and "funding_payment_projections"."account_address" = lower("funding_payment_projections"."account_address")
  and substr("funding_payment_projections"."account_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "funding_payments_rate_check" CHECK(
  "funding_payment_projections"."rate_raw" = '0'
  or (
    "funding_payment_projections"."rate_raw" not glob '*[^0-9]*'
    and substr("funding_payment_projections"."rate_raw", 1, 1) between '1' and '9'
  )
  or (
    substr("funding_payment_projections"."rate_raw", 1, 1) = '-'
    and length("funding_payment_projections"."rate_raw") > 1
    and substr("funding_payment_projections"."rate_raw", 2) not glob '*[^0-9]*'
    and substr("funding_payment_projections"."rate_raw", 2, 1) between '1' and '9'
  )
),
	CONSTRAINT "funding_payments_payment_check" CHECK(
  "funding_payment_projections"."payment_raw" = '0'
  or (
    "funding_payment_projections"."payment_raw" not glob '*[^0-9]*'
    and substr("funding_payment_projections"."payment_raw", 1, 1) between '1' and '9'
  )
  or (
    substr("funding_payment_projections"."payment_raw", 1, 1) = '-'
    and length("funding_payment_projections"."payment_raw") > 1
    and substr("funding_payment_projections"."payment_raw", 2) not glob '*[^0-9]*'
    and substr("funding_payment_projections"."payment_raw", 2, 1) between '1' and '9'
  )
),
	CONSTRAINT "funding_payments_decimals_check" CHECK("funding_payment_projections"."collateral_decimals" between 0 and 36),
	CONSTRAINT "funding_payments_block_check" CHECK("funding_payment_projections"."block_number" >= 0 and "funding_payment_projections"."block_timestamp" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `funding_payment_projections_source_event_id_unique` ON `funding_payment_projections` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `idx_funding_payments_account_block` ON `funding_payment_projections` (`chain_id`,`account_address`,`block_number`);--> statement-breakpoint
CREATE TABLE `indexer_checkpoints` (
	`stream_key` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`contract_address` text NOT NULL,
	`last_scanned_block` integer DEFAULT -1 NOT NULL,
	`last_scanned_block_hash` text,
	`last_finalized_block` integer DEFAULT -1 NOT NULL,
	`confirmations_required` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "indexer_checkpoints_chain_check" CHECK("indexer_checkpoints"."chain_id" > 0),
	CONSTRAINT "indexer_checkpoints_contract_check" CHECK(
  length("indexer_checkpoints"."contract_address") = 42
  and substr("indexer_checkpoints"."contract_address", 1, 2) = '0x'
  and "indexer_checkpoints"."contract_address" = lower("indexer_checkpoints"."contract_address")
  and substr("indexer_checkpoints"."contract_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "indexer_checkpoints_blocks_check" CHECK("indexer_checkpoints"."last_scanned_block" >= -1 and "indexer_checkpoints"."last_finalized_block" >= -1 and "indexer_checkpoints"."last_finalized_block" <= "indexer_checkpoints"."last_scanned_block"),
	CONSTRAINT "indexer_checkpoints_confirmations_check" CHECK("indexer_checkpoints"."confirmations_required" >= 0),
	CONSTRAINT "indexer_checkpoints_state_check" CHECK("indexer_checkpoints"."state" in ('idle', 'syncing', 'rebuilding', 'healthy', 'error'))
);
--> statement-breakpoint
CREATE TABLE `order_projections` (
	`projection_key` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`venue_address` text NOT NULL,
	`onchain_order_id` text NOT NULL,
	`account_address` text NOT NULL,
	`market_id` text NOT NULL,
	`side` text NOT NULL,
	`order_type` text NOT NULL,
	`status` text NOT NULL,
	`size_raw` text NOT NULL,
	`filled_size_raw` text NOT NULL,
	`limit_price_raw` text,
	`trigger_price_raw` text,
	`average_fill_price_raw` text,
	`size_decimals` integer NOT NULL,
	`price_decimals` integer NOT NULL,
	`reduce_only` integer DEFAULT false NOT NULL,
	`created_block_number` integer NOT NULL,
	`updated_block_number` integer NOT NULL,
	`created_event_id` text NOT NULL,
	`updated_event_id` text NOT NULL,
	FOREIGN KEY (`created_event_id`) REFERENCES `chain_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_event_id`) REFERENCES `chain_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_projections_chain_check" CHECK("order_projections"."chain_id" > 0),
	CONSTRAINT "order_projections_venue_check" CHECK(
  length("order_projections"."venue_address") = 42
  and substr("order_projections"."venue_address", 1, 2) = '0x'
  and "order_projections"."venue_address" = lower("order_projections"."venue_address")
  and substr("order_projections"."venue_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "order_projections_account_check" CHECK(
  length("order_projections"."account_address") = 42
  and substr("order_projections"."account_address", 1, 2) = '0x'
  and "order_projections"."account_address" = lower("order_projections"."account_address")
  and substr("order_projections"."account_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "order_projections_side_check" CHECK("order_projections"."side" in ('long', 'short')),
	CONSTRAINT "order_projections_type_check" CHECK("order_projections"."order_type" in ('market', 'limit', 'stop', 'stop_limit')),
	CONSTRAINT "order_projections_status_check" CHECK("order_projections"."status" in ('open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected')),
	CONSTRAINT "order_projections_size_check" CHECK(
  length("order_projections"."size_raw") > 0
  and "order_projections"."size_raw" not glob '*[^0-9]*'
  and ("order_projections"."size_raw" = '0' or substr("order_projections"."size_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "order_projections_filled_size_check" CHECK(
  length("order_projections"."filled_size_raw") > 0
  and "order_projections"."filled_size_raw" not glob '*[^0-9]*'
  and ("order_projections"."filled_size_raw" = '0' or substr("order_projections"."filled_size_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "order_projections_limit_price_check" CHECK("order_projections"."limit_price_raw" is null or (
  length("order_projections"."limit_price_raw") > 0
  and "order_projections"."limit_price_raw" not glob '*[^0-9]*'
  and ("order_projections"."limit_price_raw" = '0' or substr("order_projections"."limit_price_raw", 1, 1) between '1' and '9')
)),
	CONSTRAINT "order_projections_trigger_price_check" CHECK("order_projections"."trigger_price_raw" is null or (
  length("order_projections"."trigger_price_raw") > 0
  and "order_projections"."trigger_price_raw" not glob '*[^0-9]*'
  and ("order_projections"."trigger_price_raw" = '0' or substr("order_projections"."trigger_price_raw", 1, 1) between '1' and '9')
)),
	CONSTRAINT "order_projections_average_price_check" CHECK("order_projections"."average_fill_price_raw" is null or (
  length("order_projections"."average_fill_price_raw") > 0
  and "order_projections"."average_fill_price_raw" not glob '*[^0-9]*'
  and ("order_projections"."average_fill_price_raw" = '0' or substr("order_projections"."average_fill_price_raw", 1, 1) between '1' and '9')
)),
	CONSTRAINT "order_projections_decimals_check" CHECK("order_projections"."size_decimals" between 0 and 36 and "order_projections"."price_decimals" between 0 and 36),
	CONSTRAINT "order_projections_reduce_only_check" CHECK("order_projections"."reduce_only" in (0, 1)),
	CONSTRAINT "order_projections_blocks_check" CHECK("order_projections"."created_block_number" >= 0 and "order_projections"."updated_block_number" >= "order_projections"."created_block_number")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_order_projections_venue_order` ON `order_projections` (`chain_id`,`venue_address`,`onchain_order_id`);--> statement-breakpoint
CREATE INDEX `idx_order_projections_account_status` ON `order_projections` (`chain_id`,`account_address`,`status`,`updated_block_number`);--> statement-breakpoint
CREATE INDEX `idx_order_projections_market_status` ON `order_projections` (`chain_id`,`venue_address`,`market_id`,`status`);--> statement-breakpoint
CREATE TABLE `position_projections` (
	`projection_key` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`venue_address` text NOT NULL,
	`account_address` text NOT NULL,
	`market_id` text NOT NULL,
	`side` text NOT NULL,
	`size_raw` text NOT NULL,
	`collateral_raw` text NOT NULL,
	`entry_price_raw` text,
	`realized_pnl_raw` text NOT NULL,
	`funding_accrued_raw` text NOT NULL,
	`size_decimals` integer NOT NULL,
	`price_decimals` integer NOT NULL,
	`collateral_decimals` integer NOT NULL,
	`updated_block_number` integer NOT NULL,
	`updated_event_id` text NOT NULL,
	FOREIGN KEY (`updated_event_id`) REFERENCES `chain_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "position_projections_chain_check" CHECK("position_projections"."chain_id" > 0),
	CONSTRAINT "position_projections_venue_check" CHECK(
  length("position_projections"."venue_address") = 42
  and substr("position_projections"."venue_address", 1, 2) = '0x'
  and "position_projections"."venue_address" = lower("position_projections"."venue_address")
  and substr("position_projections"."venue_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "position_projections_account_check" CHECK(
  length("position_projections"."account_address") = 42
  and substr("position_projections"."account_address", 1, 2) = '0x'
  and "position_projections"."account_address" = lower("position_projections"."account_address")
  and substr("position_projections"."account_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "position_projections_side_check" CHECK("position_projections"."side" in ('long', 'short', 'flat')),
	CONSTRAINT "position_projections_size_check" CHECK(
  length("position_projections"."size_raw") > 0
  and "position_projections"."size_raw" not glob '*[^0-9]*'
  and ("position_projections"."size_raw" = '0' or substr("position_projections"."size_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "position_projections_open_size_check" CHECK(("position_projections"."side" = 'flat' and "position_projections"."size_raw" = '0') or ("position_projections"."side" in ('long', 'short') and "position_projections"."size_raw" <> '0')),
	CONSTRAINT "position_projections_collateral_check" CHECK(
  length("position_projections"."collateral_raw") > 0
  and "position_projections"."collateral_raw" not glob '*[^0-9]*'
  and ("position_projections"."collateral_raw" = '0' or substr("position_projections"."collateral_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "position_projections_entry_price_check" CHECK("position_projections"."entry_price_raw" is null or (
  length("position_projections"."entry_price_raw") > 0
  and "position_projections"."entry_price_raw" not glob '*[^0-9]*'
  and ("position_projections"."entry_price_raw" = '0' or substr("position_projections"."entry_price_raw", 1, 1) between '1' and '9')
)),
	CONSTRAINT "position_projections_realized_pnl_check" CHECK(
  "position_projections"."realized_pnl_raw" = '0'
  or (
    "position_projections"."realized_pnl_raw" not glob '*[^0-9]*'
    and substr("position_projections"."realized_pnl_raw", 1, 1) between '1' and '9'
  )
  or (
    substr("position_projections"."realized_pnl_raw", 1, 1) = '-'
    and length("position_projections"."realized_pnl_raw") > 1
    and substr("position_projections"."realized_pnl_raw", 2) not glob '*[^0-9]*'
    and substr("position_projections"."realized_pnl_raw", 2, 1) between '1' and '9'
  )
),
	CONSTRAINT "position_projections_funding_check" CHECK(
  "position_projections"."funding_accrued_raw" = '0'
  or (
    "position_projections"."funding_accrued_raw" not glob '*[^0-9]*'
    and substr("position_projections"."funding_accrued_raw", 1, 1) between '1' and '9'
  )
  or (
    substr("position_projections"."funding_accrued_raw", 1, 1) = '-'
    and length("position_projections"."funding_accrued_raw") > 1
    and substr("position_projections"."funding_accrued_raw", 2) not glob '*[^0-9]*'
    and substr("position_projections"."funding_accrued_raw", 2, 1) between '1' and '9'
  )
),
	CONSTRAINT "position_projections_decimals_check" CHECK("position_projections"."size_decimals" between 0 and 36 and "position_projections"."price_decimals" between 0 and 36 and "position_projections"."collateral_decimals" between 0 and 36),
	CONSTRAINT "position_projections_block_check" CHECK("position_projections"."updated_block_number" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_position_projections_account_market` ON `position_projections` (`chain_id`,`venue_address`,`account_address`,`market_id`);--> statement-breakpoint
CREATE INDEX `idx_position_projections_account` ON `position_projections` (`chain_id`,`account_address`);--> statement-breakpoint
CREATE INDEX `idx_position_projections_market` ON `position_projections` (`chain_id`,`venue_address`,`market_id`);--> statement-breakpoint
CREATE TABLE `trade_projections` (
	`trade_key` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`venue_address` text NOT NULL,
	`onchain_trade_id` text NOT NULL,
	`onchain_order_id` text,
	`account_address` text NOT NULL,
	`market_id` text NOT NULL,
	`side` text NOT NULL,
	`liquidity_role` text,
	`size_raw` text NOT NULL,
	`price_raw` text NOT NULL,
	`fee_raw` text NOT NULL,
	`realized_pnl_raw` text,
	`size_decimals` integer NOT NULL,
	`price_decimals` integer NOT NULL,
	`collateral_decimals` integer NOT NULL,
	`block_number` integer NOT NULL,
	`block_timestamp` integer NOT NULL,
	`source_event_id` text NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `chain_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trade_projections_chain_check" CHECK("trade_projections"."chain_id" > 0),
	CONSTRAINT "trade_projections_venue_check" CHECK(
  length("trade_projections"."venue_address") = 42
  and substr("trade_projections"."venue_address", 1, 2) = '0x'
  and "trade_projections"."venue_address" = lower("trade_projections"."venue_address")
  and substr("trade_projections"."venue_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "trade_projections_account_check" CHECK(
  length("trade_projections"."account_address") = 42
  and substr("trade_projections"."account_address", 1, 2) = '0x'
  and "trade_projections"."account_address" = lower("trade_projections"."account_address")
  and substr("trade_projections"."account_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "trade_projections_side_check" CHECK("trade_projections"."side" in ('long', 'short')),
	CONSTRAINT "trade_projections_liquidity_check" CHECK("trade_projections"."liquidity_role" is null or "trade_projections"."liquidity_role" in ('maker', 'taker')),
	CONSTRAINT "trade_projections_size_check" CHECK(
  length("trade_projections"."size_raw") > 0
  and "trade_projections"."size_raw" not glob '*[^0-9]*'
  and ("trade_projections"."size_raw" = '0' or substr("trade_projections"."size_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "trade_projections_price_check" CHECK(
  length("trade_projections"."price_raw") > 0
  and "trade_projections"."price_raw" not glob '*[^0-9]*'
  and ("trade_projections"."price_raw" = '0' or substr("trade_projections"."price_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "trade_projections_fee_check" CHECK(
  length("trade_projections"."fee_raw") > 0
  and "trade_projections"."fee_raw" not glob '*[^0-9]*'
  and ("trade_projections"."fee_raw" = '0' or substr("trade_projections"."fee_raw", 1, 1) between '1' and '9')
),
	CONSTRAINT "trade_projections_realized_pnl_check" CHECK("trade_projections"."realized_pnl_raw" is null or (
  "trade_projections"."realized_pnl_raw" = '0'
  or (
    "trade_projections"."realized_pnl_raw" not glob '*[^0-9]*'
    and substr("trade_projections"."realized_pnl_raw", 1, 1) between '1' and '9'
  )
  or (
    substr("trade_projections"."realized_pnl_raw", 1, 1) = '-'
    and length("trade_projections"."realized_pnl_raw") > 1
    and substr("trade_projections"."realized_pnl_raw", 2) not glob '*[^0-9]*'
    and substr("trade_projections"."realized_pnl_raw", 2, 1) between '1' and '9'
  )
)),
	CONSTRAINT "trade_projections_decimals_check" CHECK("trade_projections"."size_decimals" between 0 and 36 and "trade_projections"."price_decimals" between 0 and 36 and "trade_projections"."collateral_decimals" between 0 and 36),
	CONSTRAINT "trade_projections_block_check" CHECK("trade_projections"."block_number" >= 0 and "trade_projections"."block_timestamp" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trade_projections_source_event_id_unique` ON `trade_projections` (`source_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_trade_projections_venue_trade` ON `trade_projections` (`chain_id`,`venue_address`,`onchain_trade_id`);--> statement-breakpoint
CREATE INDEX `idx_trade_projections_account_block` ON `trade_projections` (`chain_id`,`account_address`,`block_number`);--> statement-breakpoint
CREATE INDEX `idx_trade_projections_market_block` ON `trade_projections` (`chain_id`,`venue_address`,`market_id`,`block_number`);--> statement-breakpoint
CREATE TABLE `user_market_favorites` (
	`user_id` text NOT NULL,
	`market_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`user_id`, `market_id`),
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`default_market_id` text DEFAULT 'btc-usdt' NOT NULL,
	`chart_interval` text DEFAULT '15' NOT NULL,
	`reduce_motion` integer DEFAULT false NOT NULL,
	`ui_preferences_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_preferences_language_check" CHECK("user_preferences"."language" = 'en'),
	CONSTRAINT "user_preferences_interval_check" CHECK("user_preferences"."chart_interval" in ('1', '5', '15', '30', '60', '240', 'D')),
	CONSTRAINT "user_preferences_reduce_motion_check" CHECK("user_preferences"."reduce_motion" in (0, 1)),
	CONSTRAINT "user_preferences_json_check" CHECK(json_valid("user_preferences"."ui_preferences_json"))
);
--> statement-breakpoint
CREATE TABLE `user_wallet_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`wallet_id` text NOT NULL,
	`verification_method` text NOT NULL,
	`proof_hash` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`verified_at` integer NOT NULL,
	`linked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`unlinked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "wallet_links_verification_check" CHECK("user_wallet_links"."verification_method" in ('siwe_eoa', 'eip1271', 'privy_attestation')),
	CONSTRAINT "wallet_links_primary_check" CHECK("user_wallet_links"."is_primary" in (0, 1)),
	CONSTRAINT "wallet_links_timestamps_check" CHECK("user_wallet_links"."unlinked_at" is null or "user_wallet_links"."unlinked_at" >= "user_wallet_links"."linked_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_active_wallet_owner` ON `user_wallet_links` (`wallet_id`) WHERE "user_wallet_links"."unlinked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_active_primary_wallet` ON `user_wallet_links` (`user_id`) WHERE "user_wallet_links"."is_primary" = 1 and "user_wallet_links"."unlinked_at" is null;--> statement-breakpoint
CREATE INDEX `idx_wallet_links_user_active` ON `user_wallet_links` (`user_id`,`linked_at`) WHERE "user_wallet_links"."unlinked_at" is null;--> statement-breakpoint
CREATE TABLE `vault_activity` (
	`event_id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`vault_address` text NOT NULL,
	`direction` text NOT NULL,
	`account_address` text NOT NULL,
	`recipient_address` text,
	`asset_kind` text NOT NULL,
	`asset_address` text,
	`asset_symbol_snapshot` text NOT NULL,
	`asset_decimals` integer NOT NULL,
	`amount_raw` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `chain_events`(`event_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "vault_activity_direction_check" CHECK("vault_activity"."direction" in ('deposit', 'withdraw')),
	CONSTRAINT "vault_activity_asset_kind_check" CHECK("vault_activity"."asset_kind" in ('native', 'erc20')),
	CONSTRAINT "vault_activity_decimals_check" CHECK("vault_activity"."asset_decimals" between 0 and 36),
	CONSTRAINT "vault_activity_chain_check" CHECK("vault_activity"."chain_id" > 0),
	CONSTRAINT "vault_activity_vault_check" CHECK(
  length("vault_activity"."vault_address") = 42
  and substr("vault_activity"."vault_address", 1, 2) = '0x'
  and "vault_activity"."vault_address" = lower("vault_activity"."vault_address")
  and substr("vault_activity"."vault_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "vault_activity_account_check" CHECK(
  length("vault_activity"."account_address") = 42
  and substr("vault_activity"."account_address", 1, 2) = '0x'
  and "vault_activity"."account_address" = lower("vault_activity"."account_address")
  and substr("vault_activity"."account_address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "vault_activity_recipient_check" CHECK("vault_activity"."recipient_address" is null or (
  length("vault_activity"."recipient_address") = 42
  and substr("vault_activity"."recipient_address", 1, 2) = '0x'
  and "vault_activity"."recipient_address" = lower("vault_activity"."recipient_address")
  and substr("vault_activity"."recipient_address", 3) not glob '*[^0-9a-f]*'
)),
	CONSTRAINT "vault_activity_asset_address_check" CHECK(("vault_activity"."asset_kind" = 'native' and "vault_activity"."asset_address" is null) or ("vault_activity"."asset_kind" = 'erc20' and "vault_activity"."asset_address" is not null and (
  length("vault_activity"."asset_address") = 42
  and substr("vault_activity"."asset_address", 1, 2) = '0x'
  and "vault_activity"."asset_address" = lower("vault_activity"."asset_address")
  and substr("vault_activity"."asset_address", 3) not glob '*[^0-9a-f]*'
))),
	CONSTRAINT "vault_activity_amount_check" CHECK(
  length("vault_activity"."amount_raw") > 0
  and "vault_activity"."amount_raw" not glob '*[^0-9]*'
  and ("vault_activity"."amount_raw" = '0' or substr("vault_activity"."amount_raw", 1, 1) between '1' and '9')
)
);
--> statement-breakpoint
CREATE INDEX `idx_vault_activity_account` ON `vault_activity` (`chain_id`,`account_address`);--> statement-breakpoint
CREATE INDEX `idx_vault_activity_vault` ON `vault_activity` (`chain_id`,`vault_address`);--> statement-breakpoint
CREATE TABLE `wallet_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`message_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wallet_challenges_chain_check" CHECK("wallet_challenges"."chain_id" > 0),
	CONSTRAINT "wallet_challenges_address_check" CHECK(
  length("wallet_challenges"."address") = 42
  and substr("wallet_challenges"."address", 1, 2) = '0x'
  and "wallet_challenges"."address" = lower("wallet_challenges"."address")
  and substr("wallet_challenges"."address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "wallet_challenges_hash_check" CHECK(
  length("wallet_challenges"."message_hash") = 66
  and substr("wallet_challenges"."message_hash", 1, 2) = '0x'
  and "wallet_challenges"."message_hash" = lower("wallet_challenges"."message_hash")
  and substr("wallet_challenges"."message_hash", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "wallet_challenges_expiry_check" CHECK("wallet_challenges"."expires_at" > "wallet_challenges"."created_at"),
	CONSTRAINT "wallet_challenges_consumed_check" CHECK("wallet_challenges"."consumed_at" is null or "wallet_challenges"."consumed_at" >= "wallet_challenges"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_wallet_challenges_message_hash` ON `wallet_challenges` (`message_hash`);--> statement-breakpoint
CREATE INDEX `idx_wallet_challenges_user_expiry` ON `wallet_challenges` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`checksum_address` text,
	`wallet_kind` text DEFAULT 'external' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "wallets_chain_id_check" CHECK("wallets"."chain_id" > 0),
	CONSTRAINT "wallets_address_check" CHECK(
  length("wallets"."address") = 42
  and substr("wallets"."address", 1, 2) = '0x'
  and "wallets"."address" = lower("wallets"."address")
  and substr("wallets"."address", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "wallets_kind_check" CHECK("wallets"."wallet_kind" in ('external', 'embedded', 'contract'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_wallets_chain_address` ON `wallets` (`chain_id`,`address`);