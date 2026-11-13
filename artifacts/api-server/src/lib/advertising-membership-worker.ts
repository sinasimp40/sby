import { repairMissingLeaveIdentities, MISSING_LEAVE_IDENTITY } from "./advertising-leave-repair";
import { disableFailedChecks, recoverUnresolvedChecks } from "./advertising-failed-checks";
import { pool } from "@workspace/db";
import { withAdvertisingLock, type AdvertisingClient } from "./advertising-store";
import { withAccountDriver, stopAccountSchedules } from "./advertising-account-auth";
import { AccountError, createAccountDriver, safeAccountError, type AccountFactory, type AccountDriver } from "./advertising-account-driver";
import { assertTransferReviewed } from "./shop-transfer-safety";
import { definiteDestinationFailure, queueGroupRemoval } from "./advertising-membership-store";

export async function queueRecordedUncertain(owner: string, client: AdvertisingClient, account: Record<string, any>) {
  if (!account?.account_id) return;
  const rows = (await client.query(`SELECT g.*,r.id AS run_id,r.account_generation AS run_generation,r.draft
    FROM advertising_groups g JOIN advertising_account_runs r ON r.owner_id=g.owner_id AND r.group_id=g.id AND r.chat_id=g.chat_id
    WHERE g.owner_id=$1 AND g.status<>'removed' AND r.status='uncertain'
      AND (r.draft->'forward'->'source'->>'accountId'=$3 OR
        (r.draft->'forward'->'source'->>'accountId' IS NULL AND r.account_generation=$2))
      AND NOT EXISTS(SELECT 1 FROM advertising_account_runs newer WHERE newer.owner_id=r.owner_id AND newer.chat_id=r.chat_id
        AND newer.status IN ('sent','sending') AND newer.started_at>=r.started_at)
      AND NOT EXISTS(SELECT 1 FROM advertising_membership_jobs restored WHERE restored.owner_id=g.owner_id
        AND restored.action='join' AND restored.restore_allowed=true AND restored.status IN ('joined','already_joined')
        AND restored.updated_at>=r.started_at AND (restored.group_id=g.id OR restored.chat_id=g.chat_id))
    ORDER BY r.started_at DESC,r.id DESC LIMIT 100`, [owner, account.generation, account.account_id])).rows;
  const seen = new Set<string>();
  for (const group of rows) {
    if (seen.has(group.id)) continue;
    // A fresh authorization may have a new generation. Only the frozen,
    // previously verified source-account identity can bind older runs to it.
    const recordedAccount = group.draft?.forward?.source?.accountId;
    if (recordedAccount ? recordedAccount !== account.account_id : group.run_generation !== account.generation) continue;
    seen.add(group.id);
    await queueGroupRemoval(owner, client, group, account,
      "Telegram did not confirm the advertisement. The original activity record is retained.", "uncertain", group.run_id);
  }
}

async function recordedFailures(owner: string, client: AdvertisingClient, account: Record<string, any>) {
  const rows = (await client.query(`SELECT g.*,r.note AS failure_note FROM advertising_groups g
    JOIN advertising_account_runs r ON r.group_id=g.id AND r.owner_id=g.owner_id
    WHERE g.owner_id=$1 AND g.status='error' AND g.enabled=false
      AND r.account_generation=$2 AND r.chat_id=g.chat_id AND r.status='failed'
      AND NOT EXISTS(SELECT 1 FROM advertising_account_runs newer WHERE newer.owner_id=r.owner_id
        AND newer.group_id=r.group_id AND (newer.started_at>r.started_at OR
          (newer.started_at=r.started_at AND newer.status IN ('sent','uncertain','sending'))))
    LIMIT 100`, [owner, account.generation])).rows;
  for (const group of rows) {
    // Only trustworthy known permission diagnostics, never generic failures or
    // UNCERTAIN history. New failures are queued directly at their source.
    if (/^This account (lacks permission to send|is blocked, removed)|^The Telegram account connected in Advertising is not a member/.test(group.failure_note))
      await queueGroupRemoval(owner, client, group, account, group.failure_note);
  }
}

async function saveJoined(owner: string, client: AdvertisingClient, driver: AccountDriver, account: Record<string, any>, job: Record<string, any>,
  result: { chatId: string | null; title: string; outcome: string }) {
  if (!result.chatId) throw new AccountError("Telegram did not confirm the joined group's identity.", "network", 0, "POST_NOT_CONFIRMED");
  const existing = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND (target=$2 OR chat_id=$3) ORDER BY CASE WHEN chat_id=$3 THEN 0 ELSE 1 END LIMIT 1",
    [owner, job.target, result.chatId])).rows[0];
  if (existing?.status === "removed" && !job.restore_allowed) throw new AccountError("This destination was removed. Explicit restoration is required.");
  if (existing && existing.status !== "removed" && result.outcome === "already_joined") {
    await client.query(`UPDATE advertising_membership_jobs SET status='already_joined',group_id=$3,chat_id=$4,title=$5,
      note='Already joined and saved. Existing successful destination was left unchanged.',updated_at=now() WHERE owner_id=$1 AND id=$2`,
    [owner, job.id, existing.id, result.chatId, result.title.slice(0, 200)]);
    return;
  }
  let group;
  if (existing) {
    await stopAccountSchedules(owner, client, [existing.id], "Membership changed. Enable and confirm Start separately.");
    group = (await client.query(`UPDATE advertising_groups SET chat_id=$3,title=$4,status='pending',enabled=false,account_generation=NULL,
      note='Membership confirmed. Check posting permissions; joining never starts advertising.' WHERE owner_id=$1 AND id=$2 RETURNING *`,
    [owner, existing.id, result.chatId, result.title.slice(0, 200)])).rows[0];
  } else {
    const parsedKind = job.target.startsWith("https:") ? "private_invite" : "public";
    group = (await client.query(`INSERT INTO advertising_groups(owner_id,target,kind,chat_id,title,status,enabled,note)
      VALUES($1,$2,$3,$4,$5,'pending',false,'Membership confirmed. Posting has not started.') RETURNING *`,
    [owner, job.target, parsedKind, result.chatId, result.title.slice(0, 200)])).rows[0];
  }
  let note = "Membership confirmed. Destination saved disabled; enable it and confirm a campaign to advertise.";
  try {
    const checked = await driver.inspect(result.chatId);
    if (checked.chatId !== result.chatId) throw new AccountError("Group identity changed. Check it again.");
    await client.query(`UPDATE advertising_groups SET status='ready',account_generation=$3,checked_at=now(),
      note='Joined; posting rights verified. Enable and confirm Start separately.' WHERE owner_id=$1 AND id=$2`, [owner, group.id, account.generation]);
  } catch (error) {
    const safe = safeAccountError(error);
    if (definiteDestinationFailure(safe)) {
      await queueGroupRemoval(owner, client, group, account, safe.message);
      note = "Membership confirmed, but posting was denied. Destination removed and leave queued.";
    } else {
      note = `Membership confirmed; posting permissions need review. ${safe.message}`;
      if (["network", "auth", "restricted", "rate_limit"].includes(safe.kind)) {
        // Persist joined outcome before propagating so no join RPC is replayed.
        await client.query("UPDATE advertising_membership_jobs SET status=$3,group_id=$4,note=$5,updated_at=now() WHERE owner_id=$1 AND id=$2",
          [owner, job.id, result.outcome, group.id, note]);
        throw safe;
      }
    }
  }
  await client.query("UPDATE advertising_membership_jobs SET status=$3,group_id=$4,chat_id=$5,title=$6,note=$7,updated_at=now() WHERE owner_id=$1 AND id=$2",
    [owner, job.id, result.outcome, group.id, result.chatId, result.title.slice(0, 200), note]);
}

export async function processAccountMembership(owner: string, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, async client => {
    // A crash after a membership RPC may have changed Telegram. Never replay.
    await client.query(`UPDATE advertising_membership_jobs SET status='uncertain',note='Interrupted membership action. Preview/check membership before any new action.',updated_at=now()
      WHERE owner_id=$1 AND status='working' AND updated_at<now()-interval '60 seconds'`, [owner]);
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (!account) return;
    await disableFailedChecks(owner, client);
    if (!account.account_id) return;
    await repairMissingLeaveIdentities(owner, client, account);
    await recordedFailures(owner, client, account);
    await queueRecordedUncertain(owner, client, account);
    // Automatic leaves remain authorized for this same account after sign-in.
    // Never revive joins, manually stopped jobs, or a restored destination.
    // An uncertain leave remains read-only reconciliation, not an RPC replay.
    await client.query(`UPDATE advertising_membership_jobs SET generation=$3,
      note='Original account reconnected. Destination is still removed; account verification and Telegram waits still apply.'
      WHERE owner_id=$1 AND account_id=$2 AND generation<>$3 AND action='leave' AND payload_hash='automatic'
        AND (status IN ('pending','uncertain') OR (status='stopped' AND note='Account authorization changed. Review before creating new work.'))
        AND EXISTS(SELECT 1 FROM advertising_groups g WHERE g.owner_id=$1 AND g.id=advertising_membership_jobs.group_id
          AND g.status='removed' AND g.chat_id=advertising_membership_jobs.chat_id)`, [owner, account.account_id, account.generation]);
    await client.query(`UPDATE advertising_membership_jobs SET status='stopped',note='Account authorization changed. Review before creating new work.',updated_at=now()
      WHERE owner_id=$1 AND status IN ('pending','awaiting_approval') AND (account_id<>$2 OR generation<>$3)`, [owner, account.account_id, account.generation]);
    if (!account.session_encrypted || account.last_error || account.login_encrypted || new Date(account.telegram_wait_until).getTime() > Date.now()) return;
    await recoverUnresolvedChecks(owner, client, factory);
    const job = (await client.query(`SELECT * FROM advertising_membership_jobs WHERE owner_id=$1
      AND account_id=$2 AND generation=$3 AND (status='pending' OR (status IN ('awaiting_approval','uncertain') AND updated_at<now()-interval '30 seconds'))
      ORDER BY CASE WHEN action='leave' THEN 0 ELSE 1 END,created_at,id LIMIT 1`, [owner, account.account_id, account.generation])).rows[0];
    if (!job) return;
    // Only installation-local authorized work can execute after transfer review.
    await assertTransferReviewed(owner);
    const approvalCheck = job.status === "awaiting_approval";
    const reconcileOnly = job.status === "uncertain";
    let actionAttempted = false;
    await client.query("UPDATE advertising_membership_jobs SET status='working',updated_at=now(),note='Checking membership and performing the confirmed action.' WHERE owner_id=$1 AND id=$2", [owner, job.id]);
    try {
      await withAccountDriver(owner, client, async driver => {
        const me = await driver.me();
        if (me?.id !== job.account_id) throw new AccountError("Account identity mismatch. No membership changes sent.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
        if (reconcileOnly) {
          if (!driver.membership) throw new AccountError("Check membership manually in Telegram.");
          const probe = await driver.membership(job.action === "leave" ? job.chat_id : job.target);
          if (job.chat_id && probe.chatId !== job.chat_id) throw new AccountError("Group identity changed. Check membership manually.");
          if (job.action === "join" && probe.joined) {
            await saveJoined(owner, client, driver, account, job, { ...probe, outcome: "already_joined" });
          } else {
            await client.query("UPDATE advertising_membership_jobs SET status=$3,note=$4,updated_at=now() WHERE owner_id=$1 AND id=$2", [owner, job.id,
              job.action === "leave" ? probe.joined ? "pending" : "already_absent" : "failed",
              job.action === "leave" ? probe.joined ? "Read-only check confirmed membership remains. Safe leave retry queued." : "Read-only check confirmed the account is absent." :
                "Read-only check did not confirm membership. Preview and explicitly confirm any new join."]);
          }
          return;
        }
        if (job.action === "leave") {
          const group = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner, job.group_id])).rows[0];
          if (!group || group.status !== "removed") {
            await client.query("UPDATE advertising_membership_jobs SET status='stopped',note='Destination is no longer marked removed.',updated_at=now() WHERE id=$1", [job.id]); return;
          }
          if (!job.chat_id || group.chat_id !== job.chat_id) throw new AccountError(MISSING_LEAVE_IDENTITY);
          if (!driver.leave) throw new AccountError("This account client does not support leaving groups.");
          actionAttempted = true;
          const outcome = await driver.leave(job.target, job.chat_id);
          if (!["left", "already_absent"].includes(outcome)) throw new AccountError("Telegram did not confirm leaving.", "network", 0, "POST_NOT_CONFIRMED");
          await client.query("UPDATE advertising_membership_jobs SET status=$3,note=$4,updated_at=now() WHERE owner_id=$1 AND id=$2",
            [owner, job.id, outcome, outcome === "left" ? "Telegram confirmed leaving this group." : "The account is already absent from this group."]);
          await client.query("UPDATE advertising_groups SET note=$3 WHERE owner_id=$1 AND id=$2", [owner, group.id, `Removed. ${outcome === "left" ? "Account left the group." : "Account already absent."}`]);
          return;
        }
        if (!driver.membership || !driver.join) throw new AccountError("This account client does not support joining.");
        const probe = await driver.membership(job.target);
        if (job.chat_id && probe.chatId !== job.chat_id) throw new AccountError("Group identity changed since preview. No group was joined.");
        const blocked = (await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND status='removed' AND (target=$2 OR chat_id=$3)",
          [owner, job.target, probe.chatId])).rowCount;
        if (blocked && !job.restore_allowed) throw new AccountError("This destination was removed; explicit restoration is required.");
        let result;
        if (probe.joined) result = { ...probe, outcome: "already_joined" };
        else if (approvalCheck) result = { ...probe, outcome: "awaiting_approval" };
        else { actionAttempted = true; result = await driver.join(job.target, job.chat_id); }
        if (["joined", "already_joined"].includes(result.outcome)) await saveJoined(owner, client, driver, account, job, result);
        else {
          const pending = result.outcome === "awaiting_approval";
          await client.query("UPDATE advertising_membership_jobs SET status=$3,title=$4,note=$5,updated_at=now() WHERE owner_id=$1 AND id=$2",
            [owner, job.id, pending ? "awaiting_approval" : "uncertain", result.title.slice(0, 200),
              pending ? "Join request submitted. Waiting for administrator approval; no posts will be sent." : "Telegram did not confirm membership. Preview again to check; no automatic join retry."]);
        }
      }, factory, job.action === "leave" ? "leave_group" : "join_group");
    } catch (error) {
      const safe = safeAccountError(error);
      const current = (await client.query("SELECT status FROM advertising_membership_jobs WHERE owner_id=$1 AND id=$2", [owner, job.id])).rows[0];
      if (current?.status !== "working") return; // A completed join with a failed permission check stays completed.
      const status = safe.kind === "rate_limit" ? approvalCheck ? "awaiting_approval" : "pending" :
        ["auth", "restricted"].includes(safe.kind) ? reconcileOnly ? "uncertain" : "pending" :
          safe.kind === "uncertain" ? "uncertain" :
            safe.kind === "network" ? reconcileOnly || actionAttempted ? "uncertain" : "pending" : "failed";
      await client.query("UPDATE advertising_membership_jobs SET status=$3,note=$4,updated_at=now() WHERE owner_id=$1 AND id=$2",
        [owner, job.id, status, safe.message]);
      if (safe.kind === "membership_limit") await client.query(`UPDATE advertising_membership_jobs SET status='stopped',note=$2,updated_at=now()
        WHERE owner_id=$1 AND action='join' AND status='pending'`, [owner, safe.message]);
    }
  });
}
