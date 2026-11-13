CREATE TABLE `advertising_checkpoints` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`account_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`state` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z') NOT NULL
);
