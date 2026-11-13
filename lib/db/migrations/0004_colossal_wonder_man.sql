CREATE TABLE `advertising_membership_jobs` (
	`id` text PRIMARY KEY DEFAULT (telecart_uuid()) NOT NULL,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`generation` integer NOT NULL,
	`group_id` text,
	`target` text NOT NULL,
	`chat_id` text,
	`title` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text DEFAULT 'Waiting' NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`restore_allowed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advertising_membership_request` ON `advertising_membership_jobs` (`owner_id`,`request_key`,`target`,`action`);