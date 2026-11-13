import type { AdvertisingForwardSnapshot } from "@workspace/api-zod";
import type { AdvertisingClient } from "./advertising-store";

export const COPY_PAUSE_SECONDS = 3;

// Each copy is a separate durable occurrence with its own Telegram random ID.
// Persist its receipt and batch progress together. A crash before commit leaves
// a "sending" record to stop/review, never an automatic replay.
export async function completeForwardCopy(
  owner: string, client: AdvertisingClient, groupId: string,
  forward: AdvertisingForwardSnapshot, sentCount: number,
  receipt?: { runId: string; messageId: number },
) {
  const count = forward.messagesPerGroup ?? 1;
  const completed = sentCount + 1;
  const finished = completed >= count;
  const gap = finished ? forward.intervalSeconds : COPY_PAUSE_SECONDS;
  await client.query("BEGIN");
  try {
    if (receipt) await client.query("UPDATE advertising_account_runs SET status='sent',sent_at=now(),note=$2 WHERE id=$1",
      [receipt.runId, `Verified in selected group: message #${receipt.messageId}. Copy ${completed}/${count}. It was readable at send time; later removal is possible.`]);
    await client.query(`UPDATE advertising_schedules SET batch_sent_count=$3,revision=revision+1,
      next_send_at=CASE WHEN $4 THEN now() ELSE next_send_at END,last_status='sent',note=$5
      WHERE owner_id=$1 AND group_id=$2`, [owner, groupId, finished ? 0 : completed, finished,
      finished ? `Forwarded ${count}/${count} copies. This group returns after the others in the shared queue.`
        : `Forwarded ${completed}/${count} copies. Next copy follows a short pause; Telegram waits still apply.`]);
    await client.query(`UPDATE advertising_accounts SET next_send_at=GREATEST(telegram_wait_until,now()+$2*interval '1 second')
      WHERE owner_id=$1`, [owner, gap]);
    await client.query("UPDATE advertising_groups SET last_sent_at=now() WHERE owner_id=$1 AND id=$2", [owner, groupId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
