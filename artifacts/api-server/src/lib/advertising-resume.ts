import { createHash } from "node:crypto";
import { ResumeAdvertisingCampaignBody, type AdvertisingResumeInput } from "@workspace/api-zod";
import { withAdvertisingLock } from "./advertising-store";
import { withAccountDriver } from "./advertising-account-auth";
import { AccountError, createAccountDriver, type AccountFactory } from "./advertising-account-driver";
import { readCheckpoint, captureCheckpoint } from "./advertising-checkpoint-store";
import { assertTransferReviewed } from "./shop-transfer-safety";

export async function resumeForwardCampaign(owner: string, input: AdvertisingResumeInput, factory: AccountFactory = createAccountDriver) {
  input = ResumeAdvertisingCampaignBody.parse(input);
  if (!input.confirmed) throw new AccountError("Confirm resuming the saved campaign.");
  await assertTransferReviewed(owner);
  const hash = createHash("sha256").update(JSON.stringify(["resume", input.planId, input.revision, input.accountId])).digest("hex");
  return withAdvertisingLock(owner, async client => {
    const prior = (await client.query("SELECT payload_hash FROM advertising_account_commands WHERE owner_id=$1 AND request_key=$2", [owner, input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.payload_hash !== hash) throw new AccountError("This confirmation was used for different campaign progress.");
      return;
    }
    const cp = await readCheckpoint(owner, client);
    if (!cp || cp.plan_id !== input.planId || cp.revision !== input.revision || cp.state !== "paused")
      throw new AccountError("Campaign progress changed. Close this confirmation and review Resume again.");
    const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
    const master = (await client.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0]?.draft;
    if (!account?.session_encrypted || account.last_error || account.login_encrypted ||
      account.account_id !== cp.account_id || input.accountId !== cp.account_id)
      throw new AccountError("Reconnect and verify the original Telegram account before resuming.");
    if (master?.forward?.planId !== cp.plan_id ||
      master.forward.source.fingerprint !== cp.data.forward.source.fingerprint)
      throw new AccountError("The campaign source changed. Start a new campaign instead.");
    if ((await client.query("SELECT 1 FROM advertising_schedules WHERE owner_id=$1 AND running=true", [owner])).rowCount)
      throw new AccountError("A campaign is already running. Stop it before reviewing Resume.");
    const groups = (await client.query(`SELECT g.*,s.draft FROM advertising_groups g JOIN advertising_schedules s
      ON s.group_id=g.id AND s.owner_id=g.owner_id WHERE g.owner_id=$1`, [owner])).rows;
    const eligible = cp.data.queue.filter(entry => entry.eligible && !entry.held && groups.some(group =>
      group.id === entry.groupId && group.chat_id === entry.chatId && group.enabled && ["ready", "pending"].includes(group.status) &&
      group.draft?.forward?.planId === cp.plan_id && group.draft.forward.source.fingerprint === cp.data.forward.source.fingerprint &&
      group.draft.forward.order === entry.order));
    if (!eligible.length) throw new AccountError("No eligible groups remain. UNCERTAIN, removed and disabled destinations will not resume.");
    const source = await withAccountDriver(owner, client, async driver => {
      if (!driver.savedMessage || !driver.forward) throw new AccountError("This client cannot verify the Saved Message.");
      if ((await driver.me())?.id !== cp.account_id)
        throw new AccountError("Telegram account identity changed.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
      return driver.savedMessage(cp.data.forward.source.id);
    }, factory, "saved_messages");
    if (source.accountId !== cp.account_id || source.id !== cp.data.forward.source.id ||
      source.fingerprint !== cp.data.forward.source.fingerprint || !source.canForward)
      throw new AccountError("The original Saved Message changed or cannot be forwarded. Start a new campaign.");
    await client.query("BEGIN");
    try {
      // Do not rebuild priorities, reorder groups, or reset interval progress.
      for (const entry of eligible) await client.query(`UPDATE advertising_schedules SET running=true,account_generation=$3,
        next_send_at=$4,revision=revision+1,last_status='queued',note='Resumed saved campaign. Posting rights are verified before sending.'
        WHERE owner_id=$1 AND group_id=$2`, [owner, entry.groupId, account.generation, new Date(entry.nextSendAt)]);
      await client.query(`UPDATE advertising_accounts SET groups_sent_in_interval=$2,last_forward_order=$3,
        next_send_at=GREATEST(next_send_at,telegram_wait_until,$4,now()+interval '3 seconds') WHERE owner_id=$1`,
      [owner, cp.data.groupsSentInInterval, cp.data.lastForwardOrder, new Date(cp.data.nextSendAt)]);
      await captureCheckpoint(owner, client);
      await client.query("INSERT INTO advertising_account_commands(owner_id,request_key,payload_hash) VALUES($1,$2,$3)", [owner, input.idempotencyKey, hash]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}
