CREATE TABLE `agent_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT 'New signal session' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`agent_version` text DEFAULT 'intent-policy-v1' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_conversations_title_check" CHECK(length("agent_conversations"."title") between 1 and 80),
	CONSTRAINT "agent_conversations_status_check" CHECK("agent_conversations"."status" in ('active', 'archived')),
	CONSTRAINT "agent_conversations_version_check" CHECK(length("agent_conversations"."agent_version") between 1 and 40),
	CONSTRAINT "agent_conversations_time_check" CHECK("agent_conversations"."updated_at" >= "agent_conversations"."created_at"),
	CONSTRAINT "agent_conversations_archive_check" CHECK(("agent_conversations"."status" = 'active' and "agent_conversations"."archived_at" is null) or ("agent_conversations"."status" = 'archived' and "agent_conversations"."archived_at" is not null and "agent_conversations"."archived_at" >= "agent_conversations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_conversations_id_user` ON `agent_conversations` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversations_user_status_updated` ON `agent_conversations` (`user_id`,`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE TABLE `agent_financial_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`intent_type` text NOT NULL,
	`summary_text` text NOT NULL,
	`status` text NOT NULL,
	`execution_mode` text DEFAULT 'record_only' NOT NULL,
	`payload_json` text NOT NULL,
	`payload_schema_version` integer DEFAULT 1 NOT NULL,
	`payload_hash` text NOT NULL,
	`risk_json` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_id` text NOT NULL,
	`policy_version` text DEFAULT 'intent-policy-v1' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`closed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`,`user_id`) REFERENCES `agent_conversations`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`,`conversation_id`,`user_id`) REFERENCES `agent_messages`(`id`,`conversation_id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_intents_type_check" CHECK("agent_financial_intents"."intent_type" in ('perp_order_preview', 'close_position_preview', 'cancel_order_preview', 'deposit_preview', 'withdrawal_preview', 'account_query', 'market_query', 'navigation')),
	CONSTRAINT "agent_intents_summary_check" CHECK(length("agent_financial_intents"."summary_text") between 1 and 240),
	CONSTRAINT "agent_intents_status_check" CHECK("agent_financial_intents"."status" in ('needs_input', 'proposed', 'acknowledged', 'rejected', 'expired', 'blocked', 'completed')),
	CONSTRAINT "agent_intents_type_status_check" CHECK(
    (
      "agent_financial_intents"."intent_type" in ('perp_order_preview', 'close_position_preview', 'cancel_order_preview', 'deposit_preview', 'withdrawal_preview')
      and "agent_financial_intents"."status" in ('needs_input', 'proposed', 'acknowledged', 'rejected', 'expired', 'blocked')
    )
    or (
      "agent_financial_intents"."intent_type" in ('account_query', 'market_query', 'navigation')
      and "agent_financial_intents"."status" in ('needs_input', 'completed', 'blocked')
    )
  ),
	CONSTRAINT "agent_intents_execution_check" CHECK("agent_financial_intents"."execution_mode" = 'record_only'),
	CONSTRAINT "agent_intents_payload_check" CHECK(json_valid("agent_financial_intents"."payload_json") and length("agent_financial_intents"."payload_json") between 2 and 65536),
	CONSTRAINT "agent_intents_payload_version_check" CHECK("agent_financial_intents"."payload_schema_version" = 1),
	CONSTRAINT "agent_intents_payload_hash_check" CHECK(
  length("agent_financial_intents"."payload_hash") = 66
  and substr("agent_financial_intents"."payload_hash", 1, 2) = '0x'
  and "agent_financial_intents"."payload_hash" = lower("agent_financial_intents"."payload_hash")
  and substr("agent_financial_intents"."payload_hash", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "agent_intents_risk_check" CHECK(json_valid("agent_financial_intents"."risk_json") and length("agent_financial_intents"."risk_json") between 2 and 32768),
	CONSTRAINT "agent_intents_idempotency_check" CHECK(
  length("agent_financial_intents"."idempotency_key_hash") = 66
  and substr("agent_financial_intents"."idempotency_key_hash", 1, 2) = '0x'
  and "agent_financial_intents"."idempotency_key_hash" = lower("agent_financial_intents"."idempotency_key_hash")
  and substr("agent_financial_intents"."idempotency_key_hash", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "agent_intents_request_id_check" CHECK(length("agent_financial_intents"."request_id") between 8 and 100),
	CONSTRAINT "agent_intents_policy_check" CHECK(length("agent_financial_intents"."policy_version") between 1 and 40),
	CONSTRAINT "agent_intents_version_check" CHECK("agent_financial_intents"."version" > 0),
	CONSTRAINT "agent_intents_expiry_state_check" CHECK(
    (
      "agent_financial_intents"."status" in ('proposed', 'acknowledged', 'expired')
      and "agent_financial_intents"."expires_at" is not null
    )
    or (
      "agent_financial_intents"."status" not in ('proposed', 'acknowledged', 'expired')
      and "agent_financial_intents"."expires_at" is null
    )
  ),
	CONSTRAINT "agent_intents_closed_state_check" CHECK(
    (
      "agent_financial_intents"."status" in ('rejected', 'expired', 'blocked', 'completed')
      and "agent_financial_intents"."closed_at" is not null
    )
    or (
      "agent_financial_intents"."status" in ('needs_input', 'proposed', 'acknowledged')
      and "agent_financial_intents"."closed_at" is null
    )
  ),
	CONSTRAINT "agent_intents_time_check" CHECK(
    "agent_financial_intents"."updated_at" >= "agent_financial_intents"."created_at"
    and (
      "agent_financial_intents"."expires_at" is null
      or ("agent_financial_intents"."expires_at" > "agent_financial_intents"."created_at" and "agent_financial_intents"."expires_at" <= "agent_financial_intents"."created_at" + 900)
    )
    and ("agent_financial_intents"."closed_at" is null or "agent_financial_intents"."closed_at" >= "agent_financial_intents"."created_at")
    and ("agent_financial_intents"."status" <> 'expired' or "agent_financial_intents"."closed_at" >= "agent_financial_intents"."expires_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_intents_user_idempotency` ON `agent_financial_intents` (`user_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_intents_id_user` ON `agent_financial_intents` (`id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_intents_user_status_created` ON `agent_financial_intents` (`user_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_intents_user_created` ON `agent_financial_intents` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_intents_conversation_created` ON `agent_financial_intents` (`conversation_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_intents_proposed_expiry` ON `agent_financial_intents` (`status`,`expires_at`) WHERE "agent_financial_intents"."status" = 'proposed';--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sequence_no` integer NOT NULL,
	`role` text NOT NULL,
	`visibility` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'complete' NOT NULL,
	`content_text` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text NOT NULL,
	`client_request_id_hash` text,
	`request_id` text NOT NULL,
	`model_id` text,
	`agent_version` text DEFAULT 'intent-policy-v1' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`,`user_id`) REFERENCES `agent_conversations`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_messages_sequence_check" CHECK("agent_messages"."sequence_no" > 0),
	CONSTRAINT "agent_messages_role_check" CHECK("agent_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "agent_messages_role_shape_check" CHECK(
    (
      "agent_messages"."role" = 'user'
      and "agent_messages"."status" = 'complete'
      and "agent_messages"."client_request_id_hash" is not null
      and "agent_messages"."model_id" is null
    )
    or (
      "agent_messages"."role" = 'assistant'
      and "agent_messages"."client_request_id_hash" is null
      and "agent_messages"."model_id" is not null
    )
  ),
	CONSTRAINT "agent_messages_visibility_check" CHECK("agent_messages"."visibility" = 'user'),
	CONSTRAINT "agent_messages_status_check" CHECK("agent_messages"."status" in ('complete', 'failed')),
	CONSTRAINT "agent_messages_content_check" CHECK(length("agent_messages"."content_text") between 1 and 8000),
	CONSTRAINT "agent_messages_metadata_check" CHECK(json_valid("agent_messages"."metadata_json")),
	CONSTRAINT "agent_messages_content_hash_check" CHECK(
  length("agent_messages"."content_hash") = 66
  and substr("agent_messages"."content_hash", 1, 2) = '0x'
  and "agent_messages"."content_hash" = lower("agent_messages"."content_hash")
  and substr("agent_messages"."content_hash", 3) not glob '*[^0-9a-f]*'
),
	CONSTRAINT "agent_messages_request_hash_check" CHECK("agent_messages"."client_request_id_hash" is null or (
  length("agent_messages"."client_request_id_hash") = 66
  and substr("agent_messages"."client_request_id_hash", 1, 2) = '0x'
  and "agent_messages"."client_request_id_hash" = lower("agent_messages"."client_request_id_hash")
  and substr("agent_messages"."client_request_id_hash", 3) not glob '*[^0-9a-f]*'
)),
	CONSTRAINT "agent_messages_request_id_check" CHECK(length("agent_messages"."request_id") between 8 and 100),
	CONSTRAINT "agent_messages_model_check" CHECK("agent_messages"."model_id" is null or length("agent_messages"."model_id") between 1 and 80),
	CONSTRAINT "agent_messages_version_check" CHECK(length("agent_messages"."agent_version") between 1 and 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_messages_conversation_sequence` ON `agent_messages` (`conversation_id`,`sequence_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_messages_user_client_request` ON `agent_messages` (`user_id`,`client_request_id_hash`) WHERE "agent_messages"."client_request_id_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_messages_id_conversation_user` ON `agent_messages` (`id`,`conversation_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_conversation_created` ON `agent_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_user_created` ON `agent_messages` (`user_id`,`created_at`);