import { pool } from "@workspace/db";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver } from "./advertising-account-auth";
import { AccountError, createAccountDriver, safeAccountError, type AccountFactory } from "./advertising-account-driver";
import { definiteDestinationFailure, queueGroupRemoval } from "./advertising-membership-store";

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
        const checked = await driver.inspect(group.chat_id || group.target);
        const duplicate = (await client.query("SELECT status FROM advertising_groups WHERE owner_id=$1 AND chat_id=$2 AND id<>$3", [owner, checked.chatId, group.id])).rows[0];
        if (duplicate?.status === "removed") await client.query(`UPDATE advertising_groups SET enabled=false,status='removed',account_generation=NULL,
          note='This is an alias of a removed destination. Restore through membership import.',checked_at=now() WHERE owner_id=$1 AND id=$2`, [owner, group.id]);
        else if (duplicate) await client.query("UPDATE advertising_groups SET chat_id=NULL,status='duplicate',account_generation=NULL,note='This group is already saved under another target.',checked_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id]);
        else await client.query(`UPDATE advertising_groups SET chat_id=$3,title=$4,status='ready',account_generation=$5,
          note='Account membership and posting permissions verified.',checked_at=now() WHERE owner_id=$1 AND id=$2`,
          [owner, group.id, checked.chatId, checked.title.slice(0, 200), account.generation]);
      } catch (error) {
        const safe = safeAccountError(error);
        await client.query("UPDATE advertising_groups SET status='error',account_generation=NULL,note=$3,checked_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id, safe.message]);
        if (["rate_limit", "auth", "restricted", "network"].includes(safe.kind)) throw safe;
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
