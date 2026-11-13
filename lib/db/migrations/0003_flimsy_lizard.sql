ALTER TABLE `advertising_accounts` ADD `groups_sent_in_interval` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `advertising_accounts` ADD `last_forward_order` integer DEFAULT -1 NOT NULL;
--> statement-breakpoint
-- The removed setting repeated messages within one group. Never silently
-- continue those campaigns under the corrected groups-per-interval meaning.
UPDATE advertising_account_runs SET status='uncertain',
note='Previous repeated-copy campaign was stopped during upgrade. Check Telegram before a new start.'
WHERE status='sending' AND EXISTS (
  SELECT 1 FROM advertising_schedules s
  WHERE s.group_id=advertising_account_runs.group_id AND s.owner_id=advertising_account_runs.owner_id
  AND CASE WHEN json_valid(s.draft) THEN json_extract(s.draft,'$.forward.messagesPerGroup') ELSE 0 END > 1
);
--> statement-breakpoint
UPDATE advertising_schedules SET running=0,next_send_at=NULL,revision=revision+1,batch_sent_count=0,
last_status='stopped',note='Messages per group was replaced by Groups per interval. Review and confirm a new queue; each group receives one message.'
WHERE CASE WHEN json_valid(draft) THEN json_extract(draft,'$.forward.messagesPerGroup') ELSE 0 END > 1;