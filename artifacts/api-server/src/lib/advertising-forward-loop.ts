import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { StartAdvertisingForwardLoopBody, type AdvertisingDraft, type AdvertisingForwardLoop, type AdvertisingForwardStartInput, type AdvertisingSavedMessagesInput } from "@workspace/api-zod";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver, stopAccountSchedules } from "./advertising-account-auth";
import { createAccountDriver, type AccountFactory } from "./advertising-account-driver";
import { AccountError } from "./advertising-account-errors";
import { assertTransferReviewed } from "./shop-transfer-safety";
import { validateForwardSnapshot } from "./advertising-saved-messages";

export async function loadOwnerSavedMessages(owner: string, input: AdvertisingSavedMessagesInput, factory: AccountFactory = createAccountDriver) {
  return withAdvertisingLock(owner, client => withAccountDriver(owner, client, async driver => {
    if (!driver.savedMessages) throw new AccountError("This client cannot load Saved Messages.");
    return driver.savedMessages(input.offsetId ?? 0);
  }, factory, "saved_messages"));
}
export async function startForwardLoop(owner: string, input: AdvertisingForwardStartInput, factory: AccountFactory = createAccountDriver) {
  input = StartAdvertisingForwardLoopBody.parse(input);
  if (!input.permissionConfirmed) throw new AccountError("Confirm you have permission to advertise in every selected group.");
  const payloadHash = createHash("sha256").update(JSON.stringify({ accountId: input.accountId, messageId: input.messageId,
    fingerprint: input.sourceFingerprint, groupIds: input.groupIds, intervalSeconds: input.intervalSeconds,
    expected: [...input.expectedGroups].sort((a, b) => a.id.localeCompare(b.id)) })).digest("hex");
  await assertTransferReviewed(owner);
  return withAdvertisingLock(owner, async client => {
    const prior = (await client.query("SELECT payload_hash FROM advertising_account_commands WHERE owner_id=$1 AND request_key=$2", [owner, input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new AccountError("This confirmation was already used for a different selection. Review it again.");
      return;
    }
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    if (!account?.session_encrypted || account.last_error || account.login_encrypted || account.account_id !== input.accountId)
      throw new AccountError("The connected account changed or is not ready. Review the account and saved message again.");
    const groups = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, input.groupIds])).rows;
    const expected = new Map(input.expectedGroups.map(g => [g.id, g.chatId]));
    if (new Set(input.groupIds).size !== input.groupIds.length || groups.length !== input.groupIds.length ||
      expected.size !== groups.length || input.expectedGroups.length !== groups.length ||
      groups.some(g => !g.enabled || g.status !== "ready" || !g.chat_id || g.account_generation !== account.generation || expected.get(g.id) !== g.chat_id))
      throw new AccountError("The group selection changed. Select enabled groups verified for this account and review them again.");
    const source = await withAccountDriver(owner, client, async driver => {
      if (!driver.savedMessage || !driver.forward) throw new AccountError("This client cannot forward Saved Messages.");
      const me = await driver.me();
      if (me?.id !== input.accountId) throw new AccountError("The Telegram account identity changed.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
      return driver.savedMessage(input.messageId);
    }, factory, "saved_messages");
    if (source.id !== input.messageId || source.accountId !== input.accountId || source.fingerprint !== input.sourceFingerprint || !source.canForward)
      throw new AccountError("The saved message changed after you selected it. Refresh Saved Messages and confirm it again.", "validation", 0, "SAVED_MESSAGE_CHANGED");
    const snapshot: AdvertisingDraft = { text: source.text.trim() ? source.text : `Saved message #${source.id}`, imageUrl: null, buttonText: "", buttonUrl: null,
      forward: { source, intervalSeconds: input.intervalSeconds, planId: input.idempotencyKey, order: 0 } };
    validateForwardSnapshot(snapshot.forward);
    await client.query("BEGIN");
    try {
      // One owner has one loop. Starting replaces all previous group timers.
      await stopAccountSchedules(owner, client, undefined, "Replaced by a confirmed Saved Messages forwarding loop.");
      await client.query("INSERT INTO advertising_bots(owner_id,draft) VALUES($1,$2::jsonb) ON CONFLICT(owner_id) DO UPDATE SET draft=EXCLUDED.draft",
        [owner, JSON.stringify(snapshot)]);
      for (const [order, groupId] of input.groupIds.entries()) {
        const draft = { ...snapshot, forward: { ...snapshot.forward!, order } };
        // This timestamp is a durable queue priority, not an independent timer.
        // All initial entries are due; the account gate spaces actual forwards.
        await client.query(`INSERT INTO advertising_schedules(group_id,owner_id,running,account_generation,draft,interval_seconds,next_send_at,last_status,note)
          VALUES($1,$2,true,$3,$4::jsonb,$5,now()-interval '1 day'+$6*interval '1 millisecond','queued','Waiting in the shared forwarding queue.')
          ON CONFLICT(group_id) DO UPDATE SET running=true,account_generation=EXCLUDED.account_generation,draft=EXCLUDED.draft,
          interval_seconds=EXCLUDED.interval_seconds,next_send_at=EXCLUDED.next_send_at,revision=advertising_schedules.revision+1,
          last_status='queued',note=EXCLUDED.note`, [groupId, owner, account.generation, JSON.stringify(draft), input.intervalSeconds, order]);
      }
      // Preserve a prior wait/flood gate, including across Stop followed by Start.
      await client.query("UPDATE advertising_accounts SET next_send_at=GREATEST(next_send_at,now()) WHERE owner_id=$1", [owner]);
      await client.query("INSERT INTO advertising_account_commands(owner_id,request_key,payload_hash) VALUES($1,$2,$3)", [owner, input.idempotencyKey, payloadHash]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}
export async function ownerForwardLoop(owner: string, draft: AdvertisingDraft): Promise<AdvertisingForwardLoop> {
  const empty: AdvertisingForwardLoop = { source: null, intervalSeconds: 1800, running: false, groupIds: [], nextGroupId: null, nextSendAt: null };
  if (!draft.forward) return empty;
  const snapshot = validateForwardSnapshot(draft.forward);
  const rows = (await pool.query(`SELECT s.group_id,s.running,s.next_send_at,s.draft
    FROM advertising_schedules s JOIN advertising_groups g ON g.id=s.group_id AND g.owner_id=s.owner_id
    WHERE s.owner_id=$1 AND s.draft->'forward'->>'planId'=$2 ORDER BY s.next_send_at NULLS LAST,s.group_id`, [owner, snapshot.planId])).rows;
  const active = rows.filter(r => r.running);
  const account = (await pool.query("SELECT next_send_at FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
  return { source: snapshot.source, intervalSeconds: snapshot.intervalSeconds, running: active.length > 0,
    groupIds: [...(active.length ? active : rows)].sort((a, b) => a.draft.forward.order - b.draft.forward.order).map(r => r.group_id),
    nextGroupId: active[0]?.group_id ?? null, nextSendAt: active.length ? account?.next_send_at ?? null : null };
}
