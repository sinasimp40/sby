import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import type { AdvertisingMembershipInput } from "@workspace/api-zod";
import { withAdvertisingLock, type AdvertisingClient } from "./advertising-store";
import { AccountError, type AccountFactory, createAccountDriver, safeAccountError } from "./advertising-account-driver";
import { withAccountDriver } from "./advertising-account-auth";
import { parseAdvertisingTarget, segregateAdvertisingTargets } from "./advertising-targets";
import { assertTransferReviewed } from "./shop-transfer-safety";

const sourceProblems = new Set(["SAVED_MESSAGE_MISSING", "SAVED_MESSAGE_CHANGED", "CHAT_FORWARDS_RESTRICTED",
  "MESSAGE_ID_INVALID", "PREMIUM_ACCOUNT_REQUIRED", "CUSTOM_EMOJI_INVALID", "STICKERSET_INVALID"]);
export const definiteDestinationFailure = (error: AccountError) =>
  !sourceProblems.has(error.telegramCode) && (error.kind === "permission" ||
    (error.kind === "destination" && ["DESTINATION_UNRESOLVED", "GROUP_MEMBERSHIP_UNVERIFIED"].includes(error.telegramCode)) ||
    (error.kind === "validation" && error.definite && ["CHANNEL_INVALID", "CHAT_ID_INVALID"].includes(error.telegramCode)));

export async function queueGroupRemoval(owner: string, client: AdvertisingClient, group: Record<string, any>, account: Record<string, any>, reason: string,
  cause: "definite" | "uncertain" = "definite", evidenceId?: string) {
  if (!account.account_id || group.status === "removed") return;
  if ((await client.query("SELECT 1 FROM advertising_groups WHERE owner_id=$1 AND id=$2 AND status='removed'", [owner, group.id])).rowCount) return;
  const requestKey = evidenceId ? `uncertain-run:${evidenceId}` : `auto-leave:${randomUUID()}`;
  if ((await client.query("SELECT 1 FROM advertising_membership_jobs WHERE owner_id=$1 AND request_key=$2", [owner, requestKey])).rowCount) return;
  const label = cause === "uncertain" ? "uncertain post" : "definite failure";
  await client.query("BEGIN");
  try {
    // Discovery can fail its first permission check before chat_id is saved.
    // Its numeric target is already an immutable identity, unlike a username.
    const chatId = group.chat_id || (/^-[1-9]\d*$/.test(group.target) ? group.target : null);
    await client.query(`UPDATE advertising_groups SET status='removed',enabled=false,chat_id=$4,note=$3 WHERE owner_id=$1 AND id=$2`,
      [owner, group.id, `Removed after ${label}. ${reason} Leaving is queued; see membership activity.`, chatId]);
    // Never rewrite posting evidence; only prevent subsequent scheduled sends.
    await client.query(`UPDATE advertising_schedules SET running=false,next_send_at=NULL,revision=revision+1,
      note=$3 WHERE owner_id=$1 AND group_id=$2`, [owner, group.id, `Destination removed after ${label}. Account leave queued; no post retry.`]);
    await client.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,chat_id,title,action,request_key,payload_hash,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,'leave',$8,'automatic',$9) ON CONFLICT DO NOTHING`,
    [owner, account.account_id, account.generation, group.id, group.target, chatId, group.title,
      requestKey, `Queued after ${label}. ${cause === "uncertain" ? "Telegram may already have posted. No post retry." : "Destination sending or permission failure."}`]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function membershipJobs(owner: string) {
  const rows = (await pool.query(`SELECT id,target,title,action,status,note,account_id AS "accountId",created_at AS "createdAt"
    FROM advertising_membership_jobs WHERE owner_id=$1
    ORDER BY CASE WHEN status IN ('pending','working') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 500`, [owner])).rows;
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function previewMembership(owner: string, text: string, factory: AccountFactory = createAccountDriver) {
  const parsed = segregateAdvertisingTargets(text).rows;
  if (parsed.length > 50) throw new AccountError("Preview up to 50 group links per join batch. Split larger files.");
  return withAdvertisingLock(owner, client => withAccountDriver(owner, client, async (driver, account) => {
    const me = await driver.me();
    if (me?.id !== account.account_id) throw new AccountError("Account identity changed. No groups were joined.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
    if (!driver.membership) throw new AccountError("This account client does not support membership previews.");
    if (new Date(account.telegram_wait_until).getTime() > Date.now()) throw new AccountError("Telegram requested a wait. Try again after the displayed account wait.", "rate_limit", Math.ceil((new Date(account.telegram_wait_until).getTime() - Date.now()) / 1000));
    const saved = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1", [owner])).rows;
    const rows = [];
    const seenChats = new Set<string>();
    for (const row of parsed) {
      const entry = { target: row.target ?? row.input, title: "", chatId: null as string | null, state: row.status as string, note: row.reason, canJoin: false };
      if (!row.target || row.status === "duplicate") { rows.push(entry); continue; }
      if (row.kind === "chat_id") {
        entry.state = "not_joinable"; entry.note = "A numeric ID alone cannot join a group. Use a public username or invite link."; rows.push(entry); continue;
      }
      try {
        const probe = await driver.membership(row.target);
        const existing = saved.find(g => g.target === row.target || (probe.chatId && g.chat_id === probe.chatId));
        Object.assign(entry, { title: probe.title, chatId: probe.chatId, canJoin: true,
          state: existing?.status === "removed" ? "removed" : probe.joined ? "already_joined" : probe.approval ? "approval_required" : "ready",
          note: existing?.status === "removed" ? "Previously removed. Explicitly select Restore before joining." :
            probe.joined ? "Already joined; confirmation only saves/checks this destination." :
              probe.approval ? "Joining submits a request; an administrator must approve." : "Will join only after confirmation." });
        if (probe.chatId && seenChats.has(probe.chatId)) Object.assign(entry, {
          state: "duplicate", canJoin: false, note: "Another link in this preview points to the same group.",
        });
        if (probe.chatId) seenChats.add(probe.chatId);
      } catch (error) {
        const safe = safeAccountError(error);
        if (["network", "auth", "restricted", "rate_limit"].includes(safe.kind)) throw safe;
        entry.state = "invalid"; entry.note = safe.message;
      }
      rows.push(entry);
    }
    return { accountId: me!.id, rows };
  }, factory, "membership"));
}

export async function startMembership(owner: string, input: AdvertisingMembershipInput) {
  if (!input.confirmed) throw new AccountError("Confirm the selected membership changes.");
  await assertTransferReviewed(owner);
  const normalized = input.targets.map(row => ({ ...row, target: parseAdvertisingTarget(row.target).target }));
  if (normalized.some(row => !row.target || /^-\d+$/.test(row.target)) || new Set(normalized.map(row => row.target)).size !== normalized.length)
    throw new AccountError("Choose unique public group or invitation links from the preview.");
  const hash = createHash("sha256").update(JSON.stringify({ ...input, idempotencyKey: undefined })).digest("hex");
  return withAdvertisingLock(owner, async client => {
    const prior = (await client.query("SELECT payload_hash FROM advertising_membership_jobs WHERE owner_id=$1 AND request_key=$2", [owner, input.idempotencyKey])).rows[0];
    if (prior) { if (prior.payload_hash !== hash) throw new AccountError("This confirmation was used for a different selection. Preview again."); return; }
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (!account?.session_encrypted || account.login_encrypted || account.last_error || input.accountId !== account.account_id)
      throw new AccountError("Connect and verify the same account before confirming joins.");
    const saved = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1", [owner])).rows;
    if (saved.filter(g => g.status !== "removed").length + normalized.length > 1000) throw new AccountError("Group limit reached. Remove unused destinations first.");
    await client.query("BEGIN");
    try {
      for (const row of normalized) {
        const existing = saved.find(g => g.target === row.target || (row.chatId && g.chat_id === row.chatId));
        const restore = input.restoreTargets.includes(row.target!);
        if (existing?.status === "removed" && !restore) throw new AccountError("Explicitly select Restore for previously removed destinations.");
        if (restore && existing) await client.query(`UPDATE advertising_membership_jobs SET status='restored',
          note='Explicit restoration selected. Pending leave cancelled.',updated_at=now()
          WHERE owner_id=$1 AND group_id=$2 AND action='leave' AND status='pending'`, [owner, existing.id]);
        const active = (await client.query(`SELECT 1 FROM advertising_membership_jobs WHERE owner_id=$1 AND account_id=$2 AND target=$3 AND action='join' AND status IN ('pending','working')`,
          [owner, account.account_id, row.target])).rowCount;
        if (active) throw new AccountError("A join for this target is already queued. Stop it before starting another.");
        await client.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,chat_id,action,request_key,payload_hash,restore_allowed,note)
          VALUES($1,$2,$3,$4,$5,$6,'join',$7,$8,$9,'Confirmed by the dashboard owner. Waiting for membership check.')`,
        [owner, account.account_id, account.generation, existing?.id ?? null, row.target, row.chatId,
          input.idempotencyKey, hash, restore]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

export async function stopMembership(owner: string) {
  return withAdvertisingLock(owner, async client => {
    await client.query(`UPDATE advertising_membership_jobs SET status='stopped',note='Stopped by owner before joining.',updated_at=now()
      WHERE owner_id=$1 AND action='join' AND status='pending'`, [owner]);
  });
}

