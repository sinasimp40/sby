ALTER TABLE `advertising_accounts` ADD `telegram_wait_until` text DEFAULT '1970-01-01T00:00:00.000000Z' NOT NULL;
--> statement-breakpoint
-- Older versions used one timer for merchant intervals, flood waits and
-- uncertain sends. Its origin cannot always be reconstructed: retain any
-- outstanding old deadline once rather than bypass a possible Telegram wait.
UPDATE advertising_accounts SET telegram_wait_until=next_send_at
WHERE next_send_at > (strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z');