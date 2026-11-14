import { CommerceError } from "./commerce-providers";
import { withAdvertisingLock } from "./advertising-store";
import { stopAccountSchedules } from "./advertising-account-auth";
import { randomUUID } from "node:crypto";
import { purgeAdvertisingGroup } from "./advertising-group-purge";

/** Stop now, then erase only after the verified account confirms departure. */
export async function removeAdvertisingGroups(owner: string, groupIds: string[]) {
  if (!groupIds.length || groupIds.length > 1000 || new Set(groupIds).size !== groupIds.length)
    throw new CommerceError("Choose between 1 and 1,000 distinct groups.");
  await withAdvertisingLock(owner, async client => {
    await client.query("BEGIN");
    try {
      const existing = await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, groupIds]);
      if (existing.rowCount !== groupIds.length) throw new CommerceError("A selected group was not found. Refresh the list and review your selection.", 404);
      const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      if (existing.rows.some(group => group.status !== "duplicate") && !account?.account_id)
        throw new CommerceError("Connect and verify the Telegram account before requesting leave and permanent deletion.", 409);
      const activeIds = existing.rows.filter(group => group.status !== "removed").map(group => group.id as string);
      await stopAccountSchedules(owner, client, activeIds, "Removed from the advertising list by the merchant.", true);
      await client.query(`UPDATE advertising_groups SET enabled=false,status='removed',account_generation=NULL,
        note='Removal requested. Telegram leave is queued; permanent erasure waits for confirmed departure.'
        WHERE owner_id=$1 AND id=ANY($2::uuid[])`, [owner, activeIds]);
      await client.query(`UPDATE advertising_deliveries SET status='cancelled',note='Destination removed from advertising.'
        WHERE owner_id=$1 AND group_id=ANY($2::uuid[]) AND status='pending'`, [owner, activeIds]);
      await client.query(`UPDATE advertising_deliveries SET status='uncertain',note='Destination removed during a send. Check Telegram before resending.'
        WHERE owner_id=$1 AND group_id=ANY($2::uuid[]) AND status='sending'`, [owner, activeIds]);
      // Do not let a previously queued join reintroduce a removed destination.
      await client.query(`UPDATE advertising_membership_jobs SET status='stopped',updated_at=now(),
        note='Destination removed from advertising. Any previous join may have completed; check membership in Telegram.'
        WHERE owner_id=$1 AND group_id=ANY($2::uuid[]) AND action='join'
        AND status IN ('pending','working','awaiting_approval','uncertain')`, [owner, activeIds]);
      for (const group of existing.rows) {
        const chatId = group.chat_id || (/^-[1-9]\d*$/.test(group.target) ? group.target : null);
        const alias = chatId && (await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND id<>$2 AND chat_id=$3",
          [owner, group.id, chatId])).rowCount;
        if (group.status === "duplicate" || alias) {
          // Restore the proven alias status overwritten above for the purge guard.
          await client.query("UPDATE advertising_groups SET status='duplicate' WHERE owner_id=$1 AND id=$2", [owner, group.id]);
          await purgeAdvertisingGroup(owner, client, group.id, { transaction: false });
          continue;
        }
        if ((await client.query(`SELECT 1 FROM advertising_membership_jobs WHERE owner_id=$1 AND group_id=$2 AND action='leave'
          AND account_id=$3 AND status IN ('pending','working','uncertain','left','already_absent')`,
        [owner, group.id, account.account_id])).rowCount) continue;
        await client.query("UPDATE advertising_groups SET chat_id=$3 WHERE owner_id=$1 AND id=$2", [owner, group.id, chatId]);
        await client.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,chat_id,title,action,request_key,payload_hash,note)
          VALUES($1,$2,$3,$4,$5,$6,$7,'leave',$8,'automatic','Owner requested leaving and permanent erasure after confirmed departure.')`,
        [owner, account.account_id, account.generation, group.id, group.target, chatId, group.title, `manual-leave:${randomUUID()}`]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
