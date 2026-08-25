CREATE TABLE `privy_wallet_sync_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`applied_request_id` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "privy_wallet_sync_request_check" CHECK(length("privy_wallet_sync_state"."request_id") between 1 and 80),
	CONSTRAINT "privy_wallet_sync_applied_check" CHECK("privy_wallet_sync_state"."applied_request_id" is null or length("privy_wallet_sync_state"."applied_request_id") between 1 and 80)
);
