import { createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import type { AdvertisingAccountStartInput } from "@workspace/api-zod";
import { configuredOwnerId } from "./admin-bootstrap";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver, stopAccountSchedules } from "./advertising-account-auth";
import { UNKNOWN_REQUEST_SKIPPED_NOTE } from "./advertising-account-errors";
import { accountMessage, AccountError, safeAccountError, createAccountDriver, type AccountFactory } from "./advertising-account-driver";
import { assertTransferReviewed } from "./shop-transfer-safety";
import { logger } from "./logger";
import { processAccountRecovery, recoveryState } from "./advertising-account-recovery";
import { validateForwardSnapshot } from "./advertising-saved-messages";
import { maintainAdvertisingActivity } from "./advertising-activity";
import { resetCampaignInterval } from "./advertising-campaign-timing";
import { completeForwardGroup, INTER_GROUP_PAUSE_SECONDS } from "./advertising-forward-progress";
import { definiteDestinationFailure, queueGroupRemoval } from "./advertising-membership-store";
import { processAccountMembership, queueRecordedUncertain } from "./advertising-membership-worker";
import { captureCheckpoint, readCheckpoint, checkpointAllowsVerification } from "./advertising-checkpoint-store";

export async function startAccountSchedules(owner: string, input: AdvertisingAccountStartInput) {
  if (input.draft.forward) throw new AccountError("Use the Saved Messages forwarding confirmation instead.");
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
    const current = (await client.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0];
    if (current?.draft?.forward) throw new AccountError("Advertising now uses Saved Messages and one shared interval. Confirm a forwarding loop instead.");
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
      await resetCampaignInterval(owner, client);
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
    await stopAccountSchedules(owner, client, ids, "Stopped by the merchant.", Boolean(ids));
  });
}
export async function processAccountSchedules(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, async client => {
    const savedCheckpoint = await readCheckpoint(owner, client);
    if (!savedCheckpoint || (savedCheckpoint.state === "active" &&
      !(await client.query("SELECT 1 FROM advertising_schedules WHERE owner_id=$1 AND running=true", [owner])).rowCount))
      await captureCheckpoint(owner, client);
    // An interrupted send is never replayed. Queue removal/leaving only after
    // binding its recorded chat and original account to the current identity.
    const interrupted = await client.query(`UPDATE advertising_account_runs SET status='uncertain',note='Sender restarted without confirmation. Destination removed and account leave queued when its identity is verified; no post retry.'
      WHERE owner_id=$1 AND status='sending' AND started_at<now()-interval '60 seconds' RETURNING group_id`, [owner]);
    if (interrupted.rowCount) {
      await stopAccountSchedules(owner, client, interrupted.rows.map(row => row.group_id), "Interrupted send; destination cleanup pending.");
      const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      await queueRecordedUncertain(owner, client, account);
    }
    const schedule = (await client.query("SELECT * FROM advertising_schedules WHERE owner_id=$1 AND running=true AND next_send_at<=now() ORDER BY next_send_at,group_id LIMIT 1", [owner])).rows[0];
    if (!schedule) return;
    let forward;
    try { forward = schedule.draft?.forward ? validateForwardSnapshot(schedule.draft.forward) : null; }
    catch {
      await stopAccountSchedules(owner, client, undefined, "The Saved Messages selection is invalid. Choose a message and confirm a new loop."); return;
    }
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (recoveryState(account?.last_error)) return; // Keep enabled schedules waiting; never dispatch while recovering.
    if (!account?.session_encrypted || account.last_error || account.login_encrypted || account.generation !== schedule.account_generation) {
      await stopAccountSchedules(owner, client, undefined, "Posting stopped because the account connection changed."); return;
    }
    if (Math.max(new Date(account.next_send_at).getTime(), new Date(account.telegram_wait_until).getTime()) > Date.now()) return;
    await assertTransferReviewed(owner);
    const group = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner, schedule.group_id])).rows[0];
    const verifyOnResume = Boolean(forward && group?.status === "pending" && group.chat_id &&
      await checkpointAllowsVerification(owner, client, forward.planId, group.id, group.chat_id, account.account_id));
    if (!group?.enabled || !group.chat_id || (!verifyOnResume && (group.status !== "ready" || group.account_generation !== account.generation))) {
      await stopAccountSchedules(owner, client, [schedule.group_id], "Group is disabled, removed or needs permission verification."); return;
    }
    const sentCount = Number(account.groups_sent_in_interval ?? 0);
    const batchSize = forward?.groupsPerInterval ?? 1;
    if (forward && (!Number.isInteger(sentCount) || sentCount < 0 || sentCount >= batchSize)) {
      await stopAccountSchedules(owner, client, undefined, "Invalid batch progress. Review and confirm a new campaign."); return;
    }
    // If the last destination was disabled/removed, still finish the partial
    // batch before wrapping around. Never refill it with a second visit to A.
    if (forward && sentCount > 0 && forward.order <= Number(account.last_forward_order)) {
      await client.query(`UPDATE advertising_accounts SET groups_sent_in_interval=0,last_forward_order=-1,
        next_send_at=GREATEST(next_send_at,telegram_wait_until,now()+$2*interval '1 second')
        WHERE owner_id=$1`, [owner, forward.intervalSeconds]);
      return;
    }
    const gap = INTER_GROUP_PAUSE_SECONDS;
    const run = (await client.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [owner, group.id, group.title || group.target, group.chat_id, account.generation, schedule.revision, schedule.next_send_at,
        JSON.stringify(schedule.draft), randomBytes(8).readBigInt64BE().toString()])).rows[0];
    if (!run) {
      const prior = (await client.query("SELECT status FROM advertising_account_runs WHERE owner_id=$1 AND group_id=$2 AND revision=$3 AND scheduled_for=$4", [owner, group.id, schedule.revision, schedule.next_send_at])).rows[0];
      if (prior?.status === "sent" || prior?.status === "rate_limited") {
        if (forward) {
          if (prior.status === "rate_limited") {
            await client.query("UPDATE advertising_schedules SET revision=revision+1 WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
            await client.query("UPDATE advertising_accounts SET next_send_at=GREATEST(next_send_at,telegram_wait_until,now()+$2*interval '1 second') WHERE owner_id=$1", [owner, gap]);
          } else await completeForwardGroup(owner, client, group.id, forward, sentCount);
        } else await client.query("UPDATE advertising_schedules SET next_send_at=now()+interval_seconds*interval '1 second' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      }
      else if (prior?.status !== "sending") await stopAccountSchedules(owner, client, [group.id], "Previous attempt needs review.");
      return;
    }
    const randomId = (await client.query("SELECT random_id FROM advertising_account_runs WHERE id=$1", [run.id])).rows[0].random_id;
    await client.query("UPDATE advertising_accounts SET next_send_at=now()+$2*interval '1 second' WHERE owner_id=$1", [owner, gap]);
    await client.query("UPDATE advertising_schedules SET last_status='sending',note='Waiting for Telegram confirmation.' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
    let dispatched = false;
    try {
      const receipt = await withAccountDriver(owner, client, async driver => {
        const me = await driver.me();
        if (!me || me.id !== account.account_id) throw new AccountError("The Telegram account identity could not be verified. Review Telegram Devices before another login.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
        const checked = await driver.inspect(group.target, schedule.draft);
        if (checked.chatId !== group.chat_id) throw new AccountError("Group identity changed. Check it again.");
        if (verifyOnResume) await client.query(`UPDATE advertising_groups SET status='ready',account_generation=$3,
          checked_at=now(),note='Same-account resume: posting rights verified before sending.' WHERE owner_id=$1 AND id=$2`, [owner, group.id, account.generation]);
        // Cover the bounded forwarding RPC even if the process dies before its
        // receipt is persisted. Confirmed completion resets this to the normal gap.
        if (forward) await client.query("UPDATE advertising_accounts SET next_send_at=now()+$2*interval '1 second' WHERE owner_id=$1", [owner, gap + 20]);
        dispatched = true;
        if (forward && !driver.forward) throw new AccountError("The connected client does not support forwarding Saved Messages.");
        const receipt = forward ? await driver.forward!(group.chat_id, forward, randomId)
          : await driver.send(group.chat_id, schedule.draft, randomId);
        if (receipt?.chatId !== group.chat_id || !Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0)
          throw new AccountError("Telegram did not provide a verified message receipt. Check the group before restarting; no automatic retry.", "network", 0, "POST_NOT_CONFIRMED");
        return receipt;
      }, factory, "post_ad");
      if (forward) {
        await completeForwardGroup(owner, client, group.id, forward, sentCount, { runId: run.id, messageId: receipt.messageId });
      } else {
        await client.query("UPDATE advertising_account_runs SET status='sent',sent_at=now(),note=$2 WHERE id=$1",
          [run.id, `Verified in selected group: message #${receipt.messageId}. It was readable at send time; later removal is possible.`]);
        await client.query(`UPDATE advertising_schedules SET next_send_at=now()+interval_seconds*interval '1 second',
          last_status='sent',note='Posted. Next post follows this group interval.' WHERE owner_id=$1 AND group_id=$2`, [owner, group.id]);
        await client.query("UPDATE advertising_groups SET last_sent_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id]);
      }
    } catch (error) {
      const safe = safeAccountError(error);
      if (safe.kind === "rate_limit") {
        await client.query("UPDATE advertising_account_runs SET status='rate_limited',note=$2 WHERE id=$1", [run.id, safe.message]);
        const wait = Math.max(safe.waitSeconds, forward ? gap : 0);
        await client.query(`UPDATE advertising_accounts SET
          next_send_at=GREATEST(telegram_wait_until,now()+$2*interval '1 second'),
          telegram_wait_until=GREATEST(telegram_wait_until,now()+$3*interval '1 second')
          WHERE owner_id=$1`, [owner, wait, safe.waitSeconds]);
        if (forward) await client.query(`UPDATE advertising_schedules SET revision=revision+1,last_status='rate_limited',note=$3
          WHERE owner_id=$1 AND group_id=$2`, [owner, group.id, safe.message]);
        else await client.query("UPDATE advertising_schedules SET next_send_at=now()+$3*interval '1 second',last_status='rate_limited',note=$4 WHERE owner_id=$1 AND group_id=$2",
          [owner, group.id, wait, safe.message]);
      } else {
        if (forward) await client.query("UPDATE advertising_accounts SET next_send_at=GREATEST(next_send_at,now()+$2*interval '1 second') WHERE owner_id=$1", [owner, gap]);
        const uncertain = dispatched && ["network", "uncertain"].includes(safe.kind);
        const unknownRequest = safe.kind === "network" && safe.telegramCode === "UNKNOWN";
        await client.query("UPDATE advertising_account_runs SET status=$2,note=$3 WHERE id=$1", [run.id, uncertain ? "uncertain" : "failed",
          unknownRequest ? UNKNOWN_REQUEST_SKIPPED_NOTE : uncertain ? "Telegram did not confirm the post. Destination removed; account leave queued. No post retry." : safe.message]);
        const invalidSource = forward && ["SAVED_MESSAGE_MISSING", "SAVED_MESSAGE_CHANGED", "CHAT_FORWARDS_RESTRICTED",
          "MESSAGE_ID_INVALID", "PREMIUM_ACCOUNT_REQUIRED"].includes(safe.telegramCode);
        await stopAccountSchedules(owner, client, ["auth", "restricted"].includes(safe.kind) || invalidSource ? undefined : [group.id],
          unknownRequest ? UNKNOWN_REQUEST_SKIPPED_NOTE : safe.message, unknownRequest);
        if (safe.kind === "permission") {
          await client.query(`UPDATE advertising_groups SET enabled=false,status='error',account_generation=NULL,
            checked_at=now(),note=$3 WHERE owner_id=$1 AND id=$2`,
            [owner, group.id, `Automatically disabled: ${safe.message} Recheck permissions and explicitly enable this group before restarting it.`]);
          await client.query(`UPDATE advertising_schedules SET note=$3 WHERE owner_id=$1 AND group_id=$2`,
            [owner, group.id, "Group automatically disabled because membership or posting permission was denied."]);
        }
        if (uncertain && !unknownRequest || (!invalidSource && definiteDestinationFailure(safe)))
          await queueGroupRemoval(owner, client, group, account, safe.message, uncertain ? "uncertain" : "definite", uncertain ? run.id : undefined);
        if (["auth", "restricted"].includes(safe.kind))
          await client.query("UPDATE advertising_accounts SET last_error=$2,checked_at=now() WHERE owner_id=$1", [owner, safe.message]);
      }
    }
  });
}
export async function runAccountAdvertisingWorker() {
  for (;;) {
    try {
      const owner = configuredOwnerId();
      if (owner) {
        await maintainAdvertisingActivity(owner);
        await processAccountRecovery(owner);
        await processAccountMembership(owner);
        await processAccountSchedules(owner);
      }
    }
    catch { logger.warn("Account advertising sender could not complete a queue check."); }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
