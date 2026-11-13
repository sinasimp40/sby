import type { AdvertisingClient } from "./advertising-store";
import { withAccountDriver, stopAccountSchedules } from "./advertising-account-auth";
import type { AccountFactory } from "./advertising-account-driver";
import { safeAccountError } from "./advertising-account-errors";
import { definiteDestinationFailure, queueGroupRemoval } from "./advertising-membership-store";

export const LEGACY_UNRESOLVED_GROUP = "Could not resolve this group for the connected Telegram account. Check the account shown in Advertising, or use the group's public @username.";

/** Never leave arbitrary historical errors or reinterpret transport failures. */
export async function disableFailedChecks(owner: string, client: AdvertisingClient) {
  const changed = (await client.query(`UPDATE advertising_groups SET enabled=false
    WHERE owner_id=$1 AND status='error' AND enabled=true RETURNING id`, [owner])).rows;
  if (changed.length) await stopAccountSchedules(owner, client, changed.map(group => group.id),
    "Disabled after a failed group check. Verify permissions before enabling again.", true);
}

/** Read-only recheck for the exact old resolver bug, with a verified account. */
export async function recoverUnresolvedChecks(owner: string, client: AdvertisingClient, factory: AccountFactory) {
  const groups = (await client.query(`SELECT * FROM advertising_groups WHERE owner_id=$1 AND status='error'
    AND note=$2 ORDER BY checked_at,id LIMIT 20`, [owner, LEGACY_UNRESOLVED_GROUP])).rows
    .filter(group => /^-[1-9]\d*$/.test(group.chat_id || group.target));
  if (!groups.length) return;
  await withAccountDriver(owner, client, async (driver, account) => {
    const me = await driver.me();
    if (me?.id !== account.account_id) return;
    for (const group of groups) {
      const pinned = group.chat_id || group.target;
      try {
        const checked = await driver.inspect(pinned);
        if (checked.chatId !== pinned) continue;
        await client.query(`UPDATE advertising_groups SET enabled=false,status='ready',chat_id=$3,title=$4,
          account_generation=$5,checked_at=now(),note='Posting permissions reverified after a resolution error. Remains disabled; enable explicitly.'
          WHERE owner_id=$1 AND id=$2 AND status='error'`,
        [owner, group.id, pinned, checked.title.slice(0, 200), account.generation]);
      } catch (error) {
        const safe = safeAccountError(error);
        if (definiteDestinationFailure(safe)) await queueGroupRemoval(owner, client, group, account, safe.message);
        else {
          await client.query(`UPDATE advertising_groups SET enabled=false,status=$4,note=$3,checked_at=now()
            WHERE owner_id=$1 AND id=$2 AND status='error'`,
          [owner, group.id, safe.message, ["network", "auth", "restricted", "rate_limit"].includes(safe.kind) ? "pending" : "error"]);
          if (["network", "auth", "restricted", "rate_limit"].includes(safe.kind)) throw safe;
        }
      }
    }
  }, factory, "check_groups");
}
