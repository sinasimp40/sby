CREATE TABLE `manual_wallet_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`request_key` text NOT NULL,
	`actor_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`balance_before_cents` integer NOT NULL,
	`balance_after_cents` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `bot_customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "manual_wallet_credit_values" CHECK("manual_wallet_credits"."amount_cents" > 0 AND "manual_wallet_credits"."amount_cents" <= 2000000000
    AND "manual_wallet_credits"."balance_before_cents" >= 0 AND "manual_wallet_credits"."balance_after_cents" <= 2000000000
    AND "manual_wallet_credits"."balance_after_cents" = "manual_wallet_credits"."balance_before_cents" + "manual_wallet_credits"."amount_cents")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_wallet_credit_request_idx` ON `manual_wallet_credits` (`owner_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `manual_wallet_credit_customer_idx` ON `manual_wallet_credits` (`owner_id`,`customer_id`,`created_at`,`id`);