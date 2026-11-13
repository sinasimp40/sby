import type { AdvertisingForwardSnapshot } from "@workspace/api-zod";
import type { AdvertisingClient } from "./advertising-store";
import { captureCheckpoint } from "./advertising-checkpoint-store";

export const INTER_GROUP_PAUSE_SECONDS = 3;

// One send per group visit. Receipt, queue advancement and account-wide batch
// progress commit together. An interrupted send is reviewed, never replayed.
export async function completeForwardGroup(
  owner: string, client: AdvertisingClient, groupId: string,
  forward: AdvertisingForwardSnapshot, sentCount: number,
  receipt?: { runId: string; messageId: number },
) {
  const count = forward.groupsPerInterval ?? 1;
  const completed = sentCount + 1;
  await client.query("BEGIN");
  try {
    const active = (await client.query(`SELECT draft FROM advertising_schedules WHERE owner_id=$1 AND running=true
      AND draft->'forward'->>'planId'=$2`, [owner, forward.planId])).rows;
    const finalOrder = Math.max(forward.order, ...active.map(row => Number(row.draft.forward.order)));
    const finished = completed >= count || forward.order >= finalOrder;
    const gap = finished ? forward.intervalSeconds : INTER_GROUP_PAUSE_SECONDS;
    if (receipt) await client.query("UPDATE advertising_account_runs SET status='sent',sent_at=now(),note=$2 WHERE id=$1",
      [receipt.runId, `Verified in selected group: message #${receipt.messageId}. One message to this group. It was readable at send time; later removal is possible.`]);
    await client.query(`UPDATE advertising_schedules SET batch_sent_count=0,revision=revision+1,
      next_send_at=now(),last_status='sent',note=$3 WHERE owner_id=$1 AND group_id=$2`, [owner, groupId,
      finished ? "Forwarded once. The shared interval applies before the next batch."
        : `Forwarded once. ${completed}/${count} groups reached in this interval.`]);
    await client.query(`UPDATE advertising_accounts SET groups_sent_in_interval=$3,last_forward_order=$4,
      next_send_at=GREATEST(telegram_wait_until,now()+$2*interval '1 second')
      WHERE owner_id=$1`, [owner, gap, finished ? 0 : completed, forward.order]);
    await client.query("UPDATE advertising_groups SET last_sent_at=now() WHERE owner_id=$1 AND id=$2", [owner, groupId]);
    await captureCheckpoint(owner, client);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
