import { CommerceError } from "./commerce-providers";
import { withAdvertisingLock } from "./advertising-store";

/** One dashboard action and one transaction, not one HTTP write per group. */
export async function enableAdvertisingGroups(owner: string, groupIds: string[]) {
  if (!groupIds.length || groupIds.length > 1000 || new Set(groupIds).size !== groupIds.length)
    throw new CommerceError("Choose between 1 and 1,000 distinct groups.");
  await withAdvertisingLock(owner, async client => {
    await client.query("BEGIN");
    try {
      const groups = await client.query("SELECT id,status FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, groupIds]);
      if (groups.rowCount !== groupIds.length)
        throw new CommerceError("A group was not found. Refresh the list and review Enable all shown again.", 404);
      if (groups.rows.some(group => group.status === "removed"))
        throw new CommerceError("A destination was removed. Refresh the list and review Enable all shown again.", 409);
      if (groups.rows.some(group => group.status === "error"))
        throw new CommerceError("Check groups with errors successfully before enabling them again. Refresh the list and review Enable all shown again.", 409);
      // Preserve permission status, selections, schedules, checkpoint and membership.
      await client.query("UPDATE advertising_groups SET enabled=true WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, groupIds]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
