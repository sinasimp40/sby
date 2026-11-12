import { pool } from "@workspace/db";
import type { AdvertisingCampaignInput, AdvertisingDraft } from "@workspace/api-zod";
import { CommerceError } from "./commerce-providers";
import { assertTransferReviewed } from "./shop-transfer-safety";
import { advertisingBotForOwner, advertisingCampaigns, withAdvertisingLock, type AdvertisingClient } from "./advertising-store";
import { advertisingTelegram, AdvertisingTelegramError, inspectAdvertisingGroup, sendAdvertisingMessage, validateAdvertisingDraft, type AdvertisingCaller } from "./advertising-telegram";
import { logger } from "./logger";
import { configuredOwnerId } from "./admin-bootstrap";

export async function createAdvertisingCampaign(owner: string, input: AdvertisingCampaignInput) {
  if (!input.permissionConfirmed) throw new CommerceError("Confirm permission to advertise in the selected groups.");
  await assertTransferReviewed(owner);
  const id = await withAdvertisingLock(owner, async client => {
    const existing = (await client.query("SELECT id FROM advertising_campaigns WHERE owner_id=$1 AND idempotency_key=$2", [owner, input.idempotencyKey])).rows[0];
    if (existing) return existing.id as string;
    const { row } = await advertisingBotForOwner(owner, client);
    if (row.last_error) throw new CommerceError("Check or reconnect the advertising bot before sending.", 409);
    // Freeze the exact confirmed payload, not a draft another tab may edit
    // between saving and pressing Send.
    const draft = validateAdvertisingDraft(input.draft as AdvertisingDraft, true);
    const groups = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, input.groupIds])).rows;
    if (groups.length !== input.groupIds.length || groups.some(group => !group.enabled || group.status !== "ready" || !group.chat_id))
      throw new CommerceError("Only your enabled, verified groups may receive this advertisement.");
    if ((await client.query("SELECT 1 FROM advertising_campaigns WHERE owner_id=$1 AND status IN ('queued','sending')", [owner])).rowCount)
      throw new CommerceError("An advertising campaign is still running. Wait or stop it first.", 409);
    await client.query("BEGIN");
    try {
      const campaign = (await client.query("INSERT INTO advertising_campaigns(owner_id,bot_id,idempotency_key,draft) VALUES($1,$2,$3,$4::jsonb) RETURNING id", [owner, row.bot_id, input.idempotencyKey, JSON.stringify(draft)])).rows[0];
      for (const group of groups) await client.query("INSERT INTO advertising_deliveries(owner_id,campaign_id,group_id,chat_id,target) VALUES($1,$2,$3,$4,$5)", [owner, campaign.id, group.id, group.chat_id, group.title || group.target]);
      await client.query("COMMIT");
      return campaign.id as string;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
  return (await advertisingCampaigns(owner, id))[0]!;
}
async function finishCampaign(client: AdvertisingClient, id: string) {
  await client.query(`UPDATE advertising_campaigns SET status=CASE WHEN EXISTS(
    SELECT 1 FROM advertising_deliveries WHERE campaign_id=$1 AND status IN ('failed','uncertain','cancelled')) THEN 'partial' ELSE 'completed' END
    WHERE id=$1 AND status IN ('queued','sending') AND NOT EXISTS(
    SELECT 1 FROM advertising_deliveries WHERE campaign_id=$1 AND status IN ('pending','sending'))`, [id]);
}
export async function processAdvertisingOwner(owner: string, call: AdvertisingCaller = advertisingTelegram) {
  // Session lock survives commits: persist 'sending' before network I/O so a
  // crash cannot put an already-sent message back on an automatic retry queue.
  return withAdvertisingLock(owner, async client => {
    await client.query(`UPDATE advertising_deliveries SET status='uncertain',note='Sender restarted or lost confirmation. Check Telegram; this message will not be resent automatically.'
      WHERE owner_id=$1 AND status='sending' AND started_at < now()-interval '60 seconds'`, [owner]);
    const campaign = (await client.query("SELECT * FROM advertising_campaigns WHERE owner_id=$1 AND status IN ('queued','sending') ORDER BY created_at LIMIT 1", [owner])).rows[0];
    if (!campaign) return;
    await finishCampaign(client, campaign.id);
    const next = (await client.query("SELECT * FROM advertising_deliveries WHERE campaign_id=$1 AND status='pending' ORDER BY id LIMIT 1", [campaign.id])).rows[0];
    if (!next) return;
    const { row, token } = await advertisingBotForOwner(owner, client);
    if (row.bot_id !== campaign.bot_id || row.last_error) return;
    if (new Date(row.next_send_at).getTime() > Date.now()) return;
    await assertTransferReviewed(owner);
    const group = (await client.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND id=$2", [owner, next.group_id])).rows[0];
    if (!group || !group.enabled || group.status !== "ready" || group.chat_id !== next.chat_id) {
      await client.query("UPDATE advertising_deliveries SET status='cancelled',note='Group was removed, disabled or changed.' WHERE id=$1", [next.id]);
      await finishCampaign(client, campaign.id);
      return;
    }
    if (group.last_sent_at && Date.now() - new Date(group.last_sent_at).getTime() < 65000) return;
    try {
      const checked = await inspectAdvertisingGroup(token, row.bot_id, next.chat_id, call);
      if (checked.chatId !== next.chat_id) throw new CommerceError("Group identity changed. Check it again.");
    } catch (error) {
      if (error instanceof AdvertisingTelegramError && error.providerCode === 429) {
        await client.query("UPDATE advertising_bots SET next_send_at=now()+$2*interval '1 second' WHERE owner_id=$1", [owner, error.retryAfter]);
        return;
      }
      const note = error instanceof CommerceError ? error.message : "Could not verify posting permission.";
      await client.query("UPDATE advertising_deliveries SET status='failed',note=$2 WHERE id=$1", [next.id, note]);
      await client.query("UPDATE advertising_groups SET status='error',note=$3,checked_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id, note]);
      await finishCampaign(client, campaign.id);
      return;
    }
    await client.query("UPDATE advertising_campaigns SET status='sending' WHERE id=$1", [campaign.id]);
    await client.query("UPDATE advertising_deliveries SET status='sending',started_at=now(),attempts=attempts+1,note='Sending; awaiting Telegram confirmation.' WHERE id=$1", [next.id]);
    await client.query("UPDATE advertising_bots SET next_send_at=now()+interval '2 seconds' WHERE owner_id=$1", [owner]);
    try {
      await sendAdvertisingMessage(token, next.chat_id, campaign.draft, call);
      await client.query("UPDATE advertising_deliveries SET status='sent',note='Telegram confirmed delivery.',sent_at=now() WHERE id=$1", [next.id]);
      await client.query("UPDATE advertising_groups SET last_sent_at=now() WHERE owner_id=$1 AND id=$2", [owner, group.id]);
    } catch (error) {
      if (error instanceof AdvertisingTelegramError && error.providerCode === 429 && next.attempts < 4) {
        await client.query("UPDATE advertising_deliveries SET status='pending',note='Waiting for Telegram rate limit.' WHERE id=$1", [next.id]);
        await client.query("UPDATE advertising_bots SET next_send_at=now()+$2*interval '1 second' WHERE owner_id=$1", [owner, error.retryAfter]);
      } else {
        const definitive = error instanceof AdvertisingTelegramError && [400, 401, 403, 429].includes(error.providerCode);
        await client.query("UPDATE advertising_deliveries SET status=$2,note=$3 WHERE id=$1", [next.id, definitive ? "failed" : "uncertain",
          definitive ? error.message : "Telegram did not confirm the send. Check the group; no automatic resend."]);
        if (error instanceof AdvertisingTelegramError && error.providerCode === 401)
          await client.query("UPDATE advertising_bots SET last_error=$2,checked_at=now() WHERE owner_id=$1", [owner, error.message]);
      }
    }
    await finishCampaign(client, campaign.id);
  });
}
export async function runAdvertisingWorker() {
  for (;;) {
    try {
      const owners = (await pool.query("SELECT DISTINCT owner_id FROM advertising_campaigns WHERE owner_id=$1 AND status IN ('queued','sending')", [configuredOwnerId()])).rows;
      await Promise.all(owners.map(({ owner_id }) => processAdvertisingOwner(owner_id).catch(() => {
        // Never log provider exceptions, credentials or group message contents.
        logger.warn("Advertising sender paused an owner after an internal error.");
      })));
    } catch { logger.warn("Advertising queue could not be checked."); }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
