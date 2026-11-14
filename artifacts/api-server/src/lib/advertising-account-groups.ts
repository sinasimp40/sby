import { pool } from "@workspace/db";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver, stopAccountSchedules } from "./advertising-account-auth";
import { AccountError, createAccountDriver, safeAccountError, type AccountFactory } from "./advertising-account-driver";
import { definiteDestinationFailure, queueGroupRemoval } from "./advertising-membership-store";
import { purgeAdvertisingGroup } from "./advertising-group-purge";

export async function accountMode(owner: string) {
  return Boolean((await pool.query("SELECT 1 FROM advertising_accounts WHERE owner_id=$1", [owner])).rowCount);
}
export async function checkAccountGroups(owner: string, ids: string[], factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, client => withAccountDriver(owner, client, async (driver, account) => {
    const me = await driver.me();
    if (!me || me.id !== account.account_id) throw new AccountError("The saved account could not be verified. Review Telegram Devices before another login.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
    const groups = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, ids])).rows;
    if (groups.length !== ids.length) throw new AccountError("One or more selected groups were not found.");
    for (const group of groups) {
      if (group.status === "removed") throw new AccountError("This destination was removed. Restore it through the reviewed membership import.");
      if (group.kind === "private_invite" && !group.chat_id) {
        await client.query("UPDATE advertising_groups SET status='needs_setup',account_generation=NULL,note='Join this group manually in Telegram, then use Find groups or its negative chat ID.',checked_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id]);
        continue;
      }
      try {
        // Pin public/invite targets before checking posting rights. A denied
        // posting check must not discard the identity needed for a safe leave.
        if (!group.chat_id && !/^-\d+$/.test(group.target) && driver.membership) {
          const membership = await driver.membership(group.target);
          if (membership.chatId) {
            const duplicate = await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND chat_id=$2 AND id<>$3",
              [owner, membership.chatId, group.id]);
            if (!duplicate.rowCount) {
              await client.query("UPDATE advertising_groups SET chat_id=$3 WHERE owner_id=$1 AND id=$2",
                [owner, group.id, membership.chatId]);
              group.chat_id = membership.chatId;
            } else {
              await purgeAdvertisingGroup(owner, client, group.id, { duplicateChatId: membership.chatId });
              continue;
            }
          }
        }
        const checked = await driver.inspect(group.chat_id || group.target);
        const duplicate = (await client.query("SELECT status FROM advertising_groups WHERE owner_id=$1 AND chat_id=$2 AND id<>$3", [owner, checked.chatId, group.id])).rows[0];
        if (duplicate) await purgeAdvertisingGroup(owner, client, group.id, { duplicateChatId: checked.chatId });
        else await client.query(`UPDATE advertising_groups SET chat_id=$3,title=$4,status='ready',account_generation=$5,
          note='Account membership and posting permissions verified.',checked_at=now() WHERE owner_id=$1 AND id=$2`,
          [owner, group.id, checked.chatId, checked.title.slice(0, 200), account.generation]);
      } catch (error) {
        const safe = safeAccountError(error);
        const temporary = ["rate_limit", "auth", "restricted", "network"].includes(safe.kind);
        await client.query("UPDATE advertising_groups SET enabled=false,status=$4,account_generation=NULL,note=$3,checked_at=now() WHERE owner_id=$1 AND id=$2",
          [owner, group.id, safe.message, temporary ? "pending" : "error"]);
        await stopAccountSchedules(owner, client, [group.id], "Posting stopped after a failed permission check.", true);
        if (temporary) throw safe;
        if (definiteDestinationFailure(safe)) await queueGroupRemoval(owner, client, group, account, safe.message);
      }
    }
  }, factory, "check_groups"));
}
export async function discoverAccountGroups(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, client => withAccountDriver(owner, client, async (driver, account) => {
    const me = await driver.me();
    if (!me || me.id !== account.account_id) throw new AccountError("The saved account could not be verified. Review Telegram Devices before another login.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
    const groups = await driver.groups();
    let count = (await client.query("SELECT count(*)::integer AS n FROM advertising_groups WHERE owner_id=$1", [owner])).rows[0].n;
    for (const group of groups) {
      if (count >= 1000) break;
      const existing = await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND (chat_id=$2 OR target=$2)", [owner, group.chatId]);
      if (!existing.rowCount) {
        await client.query("INSERT INTO advertising_groups(owner_id,target,kind,title,note) VALUES($1,$2,'chat_id',$3,'Joined group discovered. Check permission before starting.') ON CONFLICT DO NOTHING", [owner, group.chatId, group.title.slice(0, 200)]);
        count++;
      }
    }
  }, factory, "discover_groups"));
}
