import { CommerceError } from "./commerce-providers";
import { withAdvertisingLock } from "./advertising-store";
import { stopAccountSchedules } from "./advertising-account-auth";

/** Dashboard removal only: retain identities and evidence, never send a leave. */
export async function removeAdvertisingGroups(owner: string, groupIds: string[]) {
  if (!groupIds.length || groupIds.length > 1000 || new Set(groupIds).size !== groupIds.length)
    throw new CommerceError("Choose between 1 and 1,000 distinct groups.");
  await withAdvertisingLock(owner, async client => {
    await client.query("BEGIN");
    try {
      const existing = await client.query("SELECT id,status FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, groupIds]);
      if (existing.rowCount !== groupIds.length) throw new CommerceError("A selected group was not found. Refresh the list and review your selection.", 404);
      const activeIds = existing.rows.filter(group => group.status !== "removed").map(group => group.id as string);
      if (!activeIds.length) { await client.query("COMMIT"); return; }
      await stopAccountSchedules(owner, client, activeIds, "Removed from the advertising list by the merchant.", true);
      await client.query(`UPDATE advertising_groups SET enabled=false,status='removed',account_generation=NULL,
        note='Removed from advertising by the merchant. Telegram membership was not changed.'
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
