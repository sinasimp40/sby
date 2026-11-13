CREATE TABLE `bot_runtime_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`transfer_review_required` integer DEFAULT false NOT NULL,
	`transport` text DEFAULT 'polling' NOT NULL,
	`public_url` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shop_inventory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`owner_id` text NOT NULL,
	`encrypted_credential` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_inventory_product_fingerprint_idx` ON `shop_inventory` (`product_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `shop_inventory_owner_idx` ON `shop_inventory` (`owner_id`);--> statement-breakpoint
CREATE TABLE `shop_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`image_url` text,
	`group_id` text,
	`group_name` text,
	`group_description` text,
	`option_name` text,
	`category` text NOT NULL,
	`price_cents` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`delivery_format` text NOT NULL,
	`button_emoji` text DEFAULT '🛍' NOT NULL,
	`button_custom_emoji_id` text,
	`stock_announced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	FOREIGN KEY (`owner_id`,`button_custom_emoji_id`) REFERENCES `shop_custom_emojis`(`owner_id`,`custom_emoji_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shop_products_owner_idx` ON `shop_products` (`owner_id`);--> statement-breakpoint
CREATE INDEX `shop_products_group_idx` ON `shop_products` (`owner_id`,`group_id`);--> statement-breakpoint
CREATE TABLE `emoji_import_sessions` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`chat_id` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emoji_import_sessions_token_hash_unique` ON `emoji_import_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `shop_custom_emojis` (
	`owner_id` text NOT NULL,
	`custom_emoji_id` text NOT NULL,
	`emoji` text NOT NULL,
	`set_name` text,
	`format` text NOT NULL,
	`thumbnail_file_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	PRIMARY KEY(`owner_id`, `custom_emoji_id`)
);
--> statement-breakpoint
CREATE TABLE `shop_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shop_activity_owner_idx` ON `shop_activity` (`owner_id`);--> statement-breakpoint
CREATE TABLE `shop_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`preferences` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shop_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shop_records_owner_kind_idx` ON `shop_records` (`owner_id`,`kind`);--> statement-breakpoint
CREATE TABLE `bot_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`bot_username` text NOT NULL,
	`public_url` text NOT NULL,
	`active` text DEFAULT 'yes' NOT NULL,
	`verified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`telegram_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`username` text NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	CONSTRAINT "bot_customer_nonnegative_balance" CHECK("bot_customers"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_customer_owner_telegram_idx` ON `bot_customers` (`owner_id`,`telegram_id`);--> statement-breakpoint
CREATE TABLE `bot_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shop_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`owner_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`kind` text NOT NULL,
	`product_id` integer,
	`inventory_id` integer,
	`quantity` integer DEFAULT 1 NOT NULL,
	`inventory_ids` text,
	`product_name` text DEFAULT 'Wallet deposit' NOT NULL,
	`amount_cents` integer NOT NULL,
	`coin` text NOT NULL,
	`rate_mode` text DEFAULT 'fixed' NOT NULL,
	`provider_payment_id` text,
	`address` text,
	`pay_amount` text,
	`received_amount` text,
	`last_checked_at` text,
	`invoice_message_id` integer,
	`invoice_caption_hash` text,
	`invoice_needs_update` integer DEFAULT false NOT NULL,
	`cancelled_at` text,
	`extra_id` text,
	`network` text,
	`expires_at` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`fulfillment` text DEFAULT 'pending' NOT NULL,
	`delivered_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `bot_customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`inventory_id`) REFERENCES `shop_inventory`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shop_payment_positive_amount" CHECK("shop_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_payments_request_key_unique` ON `shop_payments` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `shop_payments_provider_payment_id_unique` ON `shop_payments` (`provider_payment_id`);--> statement-breakpoint
CREATE INDEX `shop_payments_owner_idx` ON `shop_payments` (`owner_id`);--> statement-breakpoint
CREATE TABLE `wallet_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `bot_customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `shop_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_entries_payment_id_unique` ON `wallet_entries` (`payment_id`);--> statement-breakpoint
CREATE TABLE `admin_login_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`reset_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`credential_version` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`telegram_token_encrypted` text,
	`telegram_verified_at` text,
	`telegram_bot_username` text,
	`nowpayments_api_key_encrypted` text,
	`nowpayments_verified_at` text,
	`nowpayments_ipn_secret_encrypted` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE TABLE `advertising_bots` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`bot_id` text,
	`username` text DEFAULT '' NOT NULL,
	`token_encrypted` text,
	`checked_at` text,
	`last_error` text,
	`update_offset` integer DEFAULT 0 NOT NULL,
	`next_send_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`draft` text DEFAULT '{"text":"","imageUrl":null,"buttonText":"Visit shop","buttonUrl":null}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_bot_identity` ON `advertising_bots` (`bot_id`);--> statement-breakpoint
CREATE TABLE `advertising_campaigns` (
	`id` text PRIMARY KEY DEFAULT (telecart_uuid()) NOT NULL,
	`owner_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`draft` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_campaign_request` ON `advertising_campaigns` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `advertising_deliveries` (
	`id` text PRIMARY KEY DEFAULT (telecart_uuid()) NOT NULL,
	`owner_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`group_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`target` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text DEFAULT 'Waiting to send.' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`sent_at` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `advertising_campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_campaign_recipient` ON `advertising_deliveries` (`campaign_id`,`chat_id`);--> statement-breakpoint
CREATE TABLE `advertising_groups` (
	`id` text PRIMARY KEY DEFAULT (telecart_uuid()) NOT NULL,
	`owner_id` text NOT NULL,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`chat_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text DEFAULT 'Check posting permissions before sending.' NOT NULL,
	`checked_at` text,
	`last_sent_at` text,
	`account_generation` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_group_target` ON `advertising_groups` (`owner_id`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_group_chat` ON `advertising_groups` (`owner_id`,`chat_id`);--> statement-breakpoint
CREATE TABLE `advertising_account_commands` (
	`id` text PRIMARY KEY DEFAULT (telecart_uuid()) NOT NULL,
	`owner_id` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_account_start_request` ON `advertising_account_commands` (`owner_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `advertising_account_runs` (
	`id` text PRIMARY KEY DEFAULT (telecart_uuid()) NOT NULL,
	`owner_id` text NOT NULL,
	`group_id` text NOT NULL,
	`target` text NOT NULL,
	`chat_id` text NOT NULL,
	`account_generation` integer NOT NULL,
	`revision` integer NOT NULL,
	`scheduled_for` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`sent_at` text,
	`draft` text NOT NULL,
	`random_id` text NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`note` text DEFAULT 'Waiting for Telegram confirmation.' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_account_occurrence` ON `advertising_account_runs` (`owner_id`,`group_id`,`revision`,`scheduled_for`);--> statement-breakpoint
CREATE TABLE `advertising_accounts` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`api_id` integer,
	`api_hash_encrypted` text,
	`session_encrypted` text,
	`account_id` text,
	`username` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`checked_at` text,
	`last_error` text,
	`next_send_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`login_id` text,
	`login_encrypted` text,
	`login_expires_at` text
);
--> statement-breakpoint
CREATE TABLE `advertising_schedules` (
	`group_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`running` integer DEFAULT false NOT NULL,
	`interval_seconds` integer DEFAULT 1800 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`account_generation` integer DEFAULT 0 NOT NULL,
	`draft` text,
	`next_send_at` text,
	`last_status` text DEFAULT 'stopped' NOT NULL,
	`note` text DEFAULT 'Select this group and confirm Start to begin.' NOT NULL
);
