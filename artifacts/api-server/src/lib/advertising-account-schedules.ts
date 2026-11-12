import { createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import type { AdvertisingAccountStartInput } from "@workspace/api-zod";
import { configuredOwnerId } from "./admin-bootstrap";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver, stopAccountSchedules } from "./advertising-account-auth";
import { accountMessage, AccountError, safeAccountError, createAccountDriver, type AccountFactory } from "./advertising-account-driver";
import { assertTransferReviewed } from "./shop-transfer-safety";
import { logger } from "./logger";
import { processAccountRecovery, recoveryState } from "./advertising-account-recovery";

export async function startAccountSchedules(owner: string, input: AdvertisingAccountStartInput) {
  if (!input.permissionConfirmed) throw new AccountError("Confirm permission to post this recurring advertisement in every selected group.");
  const draft = accountMessage(input.draft);
  // Store the original fields, not the already-appended shop link.
  const payloadHash = createHash("sha256").update(JSON.stringify({ account: input.accountId, groups: [...input.groupIds].sort(),
    expected: [...input.expectedGroups].sort((a, b) => a.id.localeCompare(b.id)), draft })).digest("hex");
  await assertTransferReviewed(owner);
  return withAdvertisingLock(owner, async client => {
    const prior = (await client.query("SELECT payload_hash FROM advertising_account_commands WHERE owner_id=$1 AND request_key=$2", [owner, input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new AccountError("This start request was used with a different message or selection. Review and start again.");
      return;
    }
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (!account?.session_encrypted || account.last_error || account.login_encrypted) throw new AccountError("Finish account sign-in and check the connection before starting.");
    if (account.account_id !== input.accountId) throw new AccountError("The connected account changed. Review this start request again.");
    const groups = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, input.groupIds])).rows;
    if (groups.length !== input.groupIds.length || groups.some(g => !g.enabled || g.status !== "ready" || !g.chat_id || g.account_generation !== account.generation))
      throw new AccountError("Select only enabled groups verified for this connected account.");
    const expected = new Map(input.expectedGroups.map(group => [group.id, group]));
    if (expected.size !== groups.length || input.expectedGroups.length !== groups.length) throw new AccountError("Review the selected groups again.");
    for (const group of groups) {
      const interval = (await client.query("SELECT interval_seconds FROM advertising_schedules WHERE owner_id=$1 AND group_id=$2", [owner, group.id])).rows[0]?.interval_seconds ?? 1800;
      const confirmed = expected.get(group.id);
      if (!confirmed || confirmed.chatId !== group.chat_id || confirmed.intervalSeconds !== interval)
        throw new AccountError("A selected group or its interval changed. Close this confirmation and review it again.");
    }
    await client.query("BEGIN");
    try {
      await stopAccountSchedules(owner, client, input.groupIds, "Replaced by a newly confirmed start.");
      for (const group of groups) await client.query(`INSERT INTO advertising_schedules(group_id,owner_id,running,account_generation,draft,next_send_at,last_status,note)
        VALUES($1,$2,true,$3,$4::jsonb,now(),'queued','Started by merchant. First post may send immediately.')
        ON CONFLICT(group_id) DO UPDATE SET running=true,account_generation=EXCLUDED.account_generation,draft=EXCLUDED.draft,
        next_send_at=now(),revision=advertising_schedules.revision+1,last_status='queued',note=EXCLUDED.note`,
        [group.id, owner, account.generation, JSON.stringify(input.draft)]);
      await client.query("INSERT INTO advertising_account_commands(owner_id,request_key,payload_hash) VALUES($1,$2,$3)", [owner, input.idempotencyKey, payloadHash]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}
export async function stopSelectedAccountSchedules(owner: string, ids?: string[]) {
  return withAdvertisingLock(owner, async client => {
    if (ids) {
      const found = await client.query("SELECT id FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, ids]);
      if (found.rowCount !== ids.length) throw new AccountError("One or more selected groups were not found.");
    }
    await stopAccountSchedules(owner, client, ids);
  });
}
export async function processAccountSchedules(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, async client => {
    // An interrupted send is never replayed on restart, including a later
    // scheduled repeat for that group, until the merchant reviews/restarts it.
    const interrupted = await client.query(`UPDATE advertising_account_runs SET status='uncertain',note='Sender restarted without confirmation. This group was stopped; check Telegram before restarting.'
      WHERE owner_id=$1 AND status='sending' AND started_at<now()-interval '60 seconds' RETURNING group_id`, [owner]);
    if (interrupted.rowCount) await stopAccountSchedules(owner, client, interrupted.rows.map(row => row.group_id), "Interrupted send needs review.");
    const schedule = (await client.query("SELECT * FROM advertising_schedules WHERE owner_id=$1 AND running=true AND next_send_at<=now() ORDER BY next_send_at,group_id LIMIT 1", [owner])).rows[0];
    if (!schedule) return;
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (recoveryState(account?.last_error)) return; // Keep enabled schedules waiting; never dispatch while recovering.
    if (!account?.session_encrypted || account.last_error || account.login_encrypted || account.generation !== schedule.account_generation) {
      await stopAccountSchedules(owner, client, undefined, "Posting stopped because the account connection changed."); return;
    }
    if (new Date(account.next_send_at).getTime() > Date.now()) return;
    await assertTransferReviewed(owner);
    const group = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner, schedule.group_id])).rows[0];
    if (!group?.enabled || group.status !== "ready" || !group.chat_id || group.account_generation !== account.generation) {
      await stopAccountSchedules(owner, client, [schedule.group_id], "Group is disabled, removed or needs permission verification."); return;
    }
    const run = (await client.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [owner, group.id, group.title || group.target, group.chat_id, account.generation, schedule.revision, schedule.next_send_at,
        JSON.stringify(schedule.draft), randomBytes(8).readBigInt64BE().toString()])).rows[0];
    if (!run) {
      const prior = (await client.query("SELECT status FROM advertising_account_runs WHERE owner_id=$1 AND group_id=$2 AND revision=$3 AND scheduled_for=$4", [owner, group.id, schedule.revision, schedule.next_send_at])).rows[0];
      if (prior?.status === "sent" || prior?.status === "rate_limited") await client.query("UPDATE advertising_schedules SET next_send_at=now()+interval_seconds*interval '1 second' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      else if (prior?.status !== "sending") await stopAccountSchedules(owner, client, [group.id], "Previous attempt needs review.");
      return;
    }
    const randomId = (await client.query("SELECT random_id FROM advertising_account_runs WHERE id=$1", [run.id])).rows[0].random_id;
    await client.query("UPDATE advertising_accounts SET next_send_at=now()+interval '3 seconds' WHERE owner_id=$1", [owner]);
    await client.query("UPDATE advertising_schedules SET last_status='sending',note='Waiting for Telegram confirmation.' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
    let dispatched = false;
    try {
      const receipt = await withAccountDriver(owner, client, async driver => {
        const me = await driver.me();
        if (!me || me.id !== account.account_id) throw new AccountError("The Telegram account identity could not be verified. Review Telegram Devices before another login.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
        const checked = await driver.inspect(group.target, schedule.draft);
        if (checked.chatId !== group.chat_id) throw new AccountError("Group identity changed. Check it again.");
        dispatched = true;
        const receipt = await driver.send(group.chat_id, schedule.draft, randomId);
        if (receipt?.chatId !== group.chat_id || !Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0)
          throw new AccountError("Telegram did not provide a verified message receipt. Check the group before restarting; no automatic retry.", "network", 0, "POST_NOT_CONFIRMED");
        return receipt;
      }, factory, "post_ad");
      await client.query("UPDATE advertising_account_runs SET status='sent',sent_at=now(),note=$2 WHERE id=$1",
        [run.id, `Verified in selected group: message #${receipt.messageId}. It was readable at send time; later removal is possible.`]);
      await client.query(`UPDATE advertising_schedules SET next_send_at=now()+interval_seconds*interval '1 second',
        last_status='sent',note='Posted. Next post follows this group interval.' WHERE owner_id=$1 AND group_id=$2`, [owner, group.id]);
      await client.query("UPDATE advertising_groups SET last_sent_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id]);
    } catch (error) {
      const safe = safeAccountError(error);
      if (safe.kind === "rate_limit") {
        await client.query("UPDATE advertising_account_runs SET status='rate_limited',note=$2 WHERE id=$1", [run.id, safe.message]);
        await client.query("UPDATE advertising_accounts SET next_send_at=now()+$2*interval '1 second' WHERE owner_id=$1", [owner, safe.waitSeconds]);
        await client.query("UPDATE advertising_schedules SET next_send_at=now()+$3*interval '1 second',last_status='rate_limited',note=$4 WHERE owner_id=$1 AND group_id=$2", [owner, group.id, safe.waitSeconds, safe.message]);
      } else {
        const uncertain = dispatched && safe.kind === "network";
        await client.query("UPDATE advertising_account_runs SET status=$2,note=$3 WHERE id=$1", [run.id, uncertain ? "uncertain" : "failed",
          uncertain ? "Telegram did not confirm the post. This group is stopped; check it before restarting." : safe.message]);
        await stopAccountSchedules(owner, client, ["auth", "restricted"].includes(safe.kind) ? undefined : [group.id], safe.message);
        if (["auth", "restricted"].includes(safe.kind))
          await client.query("UPDATE advertising_accounts SET last_error=$2,checked_at=now() WHERE owner_id=$1", [owner, safe.message]);
      }
    }
  });
}
export async function runAccountAdvertisingWorker() {
  for (;;) {
    try { const owner = configuredOwnerId(); if (owner) { await processAccountRecovery(owner); await processAccountSchedules(owner); } }
    catch { logger.warn("Account advertising sender could not complete a queue check."); }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
