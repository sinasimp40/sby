CREATE TABLE `customer_promotion_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`round_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`message_id` integer,
	`retry_at` text,
	`error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `customer_promotion_rounds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `bot_customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_promotion_delivery_once_idx` ON `customer_promotion_deliveries` (`round_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_promotion_delivery_round_idx` ON `customer_promotion_deliveries` (`round_id`,`status`);--> statement-breakpoint
CREATE TABLE `customer_promotion_preferences` (
	`owner_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`opted_out` integer DEFAULT false NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	PRIMARY KEY(`owner_id`, `customer_id`),
	FOREIGN KEY (`customer_id`) REFERENCES `bot_customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `customer_promotion_products` (
	`owner_id` text NOT NULL,
	`product_id` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`owner_id`, `product_id`),
	FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `customer_promotion_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`product_id` integer,
	`product_name` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`highwater` text DEFAULT '' NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`uncertain` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`info` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `customer_promotion_round_owner_idx` ON `customer_promotion_rounds` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `customer_promotion_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`interval_minutes` integer DEFAULT 60 NOT NULL,
	`next_at` text,
	`active_round_id` text,
	`last_product_id` integer,
	`lease_token` text,
	`lease_until` text,
	`next_dispatch_at` text,
	`info` text DEFAULT 'Customer promotions are disabled.' NOT NULL
);
