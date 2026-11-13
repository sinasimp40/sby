import { CommerceError } from "./commerce-providers";
import { withAdvertisingLock } from "./advertising-store";
import { stopAccountSchedules } from "./advertising-account-auth";

export async function disableAdvertisingGroups(owner: string, groupIds: string[]) {
  if (!groupIds.length || groupIds.length > 1000 || new Set(groupIds).size !== groupIds.length)
    throw new CommerceError("Choose between 1 and 1,000 distinct groups.");
  await withAdvertisingLock(owner, async client => {
    await client.query("BEGIN");
    try {
      const groups = await client.query("SELECT id,status FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, groupIds]);
      if (groups.rowCount !== groupIds.length) throw new CommerceError("A group was not found. Refresh the list and review Disable all shown again.", 404);
      const ids = groups.rows.filter(group => group.status !== "removed").map(group => group.id as string);
      if (ids.length) {
        // Match the existing per-group switch: stop posting without removing
        // membership, changing permissions, or excluding future explicit re-enables.
        await stopAccountSchedules(owner, client, ids, "Disabled from the filtered group list.");
        await client.query("UPDATE advertising_groups SET enabled=false WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, ids]);
        await client.query(`UPDATE advertising_deliveries SET status='cancelled',note='Destination disabled by the merchant.'
          WHERE owner_id=$1 AND group_id=ANY($2::uuid[]) AND status='pending'`, [owner, ids]);
        await client.query(`UPDATE advertising_deliveries SET status='uncertain',note='Disabled during a send. Check Telegram before resending.'
          WHERE owner_id=$1 AND group_id=ANY($2::uuid[]) AND status='sending'`, [owner, ids]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
