import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { CommerceError, TelegramRequestError, telegramForOwner } from "./commerce-providers";
import { sendProductCard } from "./product-media";
import { customerPromotionCard, type PromotedProduct } from "./customer-promotion-card";
import { eligiblePromotionProducts, promotionGate, promotionTransaction } from "./customer-promotions-store";
import { configuredOwnerId } from "./admin-bootstrap";
import { logger } from "./logger";
import { prunePromotionHistory } from "./customer-promotions-retention";

type Send = (method: string, body: Record<string, unknown>) => Promise<{ message_id?: number }>;
interface Claim { token: string; roundId: string; deliveryId: string; customerId: string; chatId: string; product: PromotedProduct }
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
async function counts(client: PoolClient, owner: string, round: string) {
  await client.query(`UPDATE customer_promotion_rounds SET
    sent=(SELECT count(*) FROM customer_promotion_deliveries WHERE round_id=$1 AND status='sent'),
    failed=(SELECT count(*) FROM customer_promotion_deliveries WHERE round_id=$1 AND status='failed'),
    uncertain=(SELECT count(*) FROM customer_promotion_deliveries WHERE round_id=$1 AND status='unknown'),
    skipped=(SELECT count(*) FROM customer_promotion_deliveries WHERE round_id=$1 AND status='skipped')
    WHERE id=$1 AND owner_id=$2`, [round, owner]);
}
async function finish(client: PoolClient, owner: string, round: string, now: Date, status: "completed" | "stopped", info: string) {
  await client.query(`UPDATE customer_promotion_rounds SET status=$1,info=$2,completed_at=$3
    WHERE id=$4 AND owner_id=$5 AND status='running'`, [status, info, now, round, owner]);
  await client.query(`UPDATE customer_promotion_deliveries SET status='skipped',error=$1,updated_at=$2
    WHERE round_id=$3 AND owner_id=$4 AND status='retry'`, [info, now, round, owner]);
  await counts(client, owner, round);
  const settings = (await client.query("SELECT enabled,interval_minutes FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0];
  await client.query(`UPDATE customer_promotion_settings SET active_round_id=NULL,next_at=$1,info=$2
    WHERE owner_id=$3 AND active_round_id=$4`, [settings.enabled ? later(now, settings.interval_minutes * 60000) : null,
    settings.enabled ? info : "Customer promotions are disabled.", owner, round]);
  await prunePromotionHistory(client, owner);
}
async function claimDelivery(owner: string, now: Date, random: () => number): Promise<Claim | null> {
  return promotionTransaction(async client => {
    const token = randomUUID();
    const settings = (await client.query(`UPDATE customer_promotion_settings SET lease_token=$1,lease_until=$2
      WHERE owner_id=$3 AND enabled=1 AND (lease_until IS NULL OR lease_until<=$4)
      AND (next_dispatch_at IS NULL OR next_dispatch_at<=$4) RETURNING *`, [token, later(now, 60000), owner, now])).rows[0];
    if (!settings) return null;
    const release = async () => { await client.query("UPDATE customer_promotion_settings SET lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND lease_token=$2", [owner, token]); return null; };
    // An expired sender may have submitted its message. Never retry such rows.
    const interrupted = await client.query(`UPDATE customer_promotion_deliveries SET status='unknown',error='Sender interrupted; delivery outcome is uncertain. Not retried.',updated_at=$1
      WHERE owner_id=$2 AND status='sending' RETURNING round_id`, [now, owner]);
    for (const roundId of new Set(interrupted.rows.map(row => row.round_id as string))) await counts(client, owner, roundId);
    let round = settings.active_round_id ? (await client.query("SELECT * FROM customer_promotion_rounds WHERE id=$1 AND owner_id=$2 AND status='running'", [settings.active_round_id, owner])).rows[0] : null;
    const eligible = await eligiblePromotionProducts(client, owner);
    if (!round) {
      if (!settings.next_at || new Date(settings.next_at).getTime() > now.getTime()) return release();
      if (!eligible.length) {
        await client.query("UPDATE customer_promotion_settings SET active_round_id=NULL,next_at=$1,info=$2 WHERE owner_id=$3",
          [later(now, settings.interval_minutes * 60000), "No enabled, active products/options with available stock. No promotion sent.", owner]);
        return release();
      }
      const choices = eligible.length > 1 ? eligible.filter(item => item.id !== settings.last_product_id) : eligible;
      const product = choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))]!;
      const id = randomUUID();
      const highwater = (await client.query("SELECT max(id) AS highwater FROM bot_customers WHERE owner_id=$1", [owner])).rows[0].highwater ?? "";
      round = (await client.query(`INSERT INTO customer_promotion_rounds(id,owner_id,product_id,product_name,highwater,created_at)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [id, owner, product.id, product.name, highwater, now])).rows[0];
      await client.query(`UPDATE customer_promotion_settings SET active_round_id=$1,last_product_id=$2,next_at=NULL,
        info='Sending the current promotion round.' WHERE owner_id=$3`, [id, product.id, owner]);
    }
    const product = eligible.find(item => item.id === round.product_id);
    if (!product) {
      await finish(client, owner, round.id, now, "stopped", "Selected product was disabled, archived, removed or sold out. Remaining deliveries stopped.");
      return release();
    }
    const retry = (await client.query(`SELECT d.*,c.chat_id FROM customer_promotion_deliveries d JOIN bot_customers c ON c.id=d.customer_id AND c.owner_id=d.owner_id
      WHERE d.owner_id=$1 AND d.round_id=$2 AND d.status='retry' ORDER BY d.retry_at,d.id LIMIT 1`, [owner, round.id])).rows[0];
    if (retry && retry.retry_at && new Date(retry.retry_at).getTime() > now.getTime()) return release();
    let recipient = retry ? { id: retry.customer_id, chat_id: retry.chat_id } : (await client.query(`SELECT c.id,c.chat_id FROM bot_customers c
      WHERE c.owner_id=$1 AND c.id>$2 AND c.id<=$3 AND c.created_at<=$4
      AND NOT EXISTS(SELECT 1 FROM customer_promotion_preferences x WHERE x.owner_id=$1 AND x.customer_id=c.id AND (x.opted_out=1 OR x.blocked=1))
      AND NOT EXISTS(SELECT 1 FROM customer_promotion_deliveries d WHERE d.round_id=$5 AND d.customer_id=c.id)
      ORDER BY c.id LIMIT 1`, [owner, round.cursor, round.highwater, round.created_at, round.id])).rows[0];
    if (!recipient) { await finish(client, owner, round.id, now, "completed", "Round completed. Waiting one shared interval before the next round."); return release(); }
    let deliveryId: string;
    if (retry) {
      deliveryId = retry.id;
      await client.query("UPDATE customer_promotion_deliveries SET status='sending',attempts=attempts+1,retry_at=NULL,updated_at=$1 WHERE id=$2", [now, deliveryId]);
    } else {
      deliveryId = randomUUID();
      // Commit the attempt AND cursor before the external send. A crashed sender
      // can lose an outcome, but cannot silently submit the same delivery again.
      await client.query(`INSERT INTO customer_promotion_deliveries(id,owner_id,round_id,customer_id,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,'sending',$5,$5)`, [deliveryId, owner, round.id, recipient.id, now]);
      await client.query("UPDATE customer_promotion_rounds SET cursor=$1 WHERE id=$2 AND owner_id=$3", [recipient.id, round.id, owner]);
    }
    return { token, roundId: round.id, deliveryId, customerId: recipient.id, chatId: recipient.chat_id, product };
  });
}
async function ready(owner: string, claim: Claim, now: Date) {
  return promotionTransaction(async client => {
    const current = (await client.query(`SELECT * FROM customer_promotion_settings WHERE owner_id=$1 AND lease_token=$2
      AND enabled=1 AND active_round_id=$3`, [owner, claim.token, claim.roundId])).rows[0];
    const recipient = (await client.query(`SELECT c.chat_id FROM bot_customers c WHERE c.owner_id=$1 AND c.id=$2
      AND NOT EXISTS(SELECT 1 FROM customer_promotion_preferences x WHERE x.owner_id=$1 AND x.customer_id=c.id AND (x.opted_out=1 OR x.blocked=1))`, [owner, claim.customerId])).rows[0];
    const product = current ? (await eligiblePromotionProducts(client, owner)).find(item => item.id === claim.product.id) : null;
    if (!current || !recipient || !product) {
      await client.query("UPDATE customer_promotion_deliveries SET status='skipped',error='Stopped or no longer eligible before submission.',updated_at=$1 WHERE id=$2 AND status='sending'", [now, claim.deliveryId]);
      await counts(client, owner, claim.roundId);
      if (current && !product) await finish(client, owner, claim.roundId, now, "stopped", "Selected product is no longer eligible.");
      return null;
    }
    await client.query("UPDATE customer_promotion_settings SET lease_until=$1 WHERE owner_id=$2 AND lease_token=$3", [later(now, 60000), owner, claim.token]);
    return { product, chatId: recipient.chat_id as string };
  });
}
async function settle(owner: string, claim: Claim, now: Date, messageId: number | undefined, error?: unknown) {
  await promotionTransaction(async client => {
    const held = (await client.query("SELECT lease_token,enabled,active_round_id FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0];
    if (held?.lease_token !== claim.token) return; // Another sender already classified the expired attempt.
    const entry = (await client.query("SELECT attempts FROM customer_promotion_deliveries WHERE id=$1 AND status='sending'", [claim.deliveryId])).rows[0];
    if (!entry) return;
    let status = "sent", info = "", retryAt: Date | null = null, cooldown = 1000;
    if (error) {
      const telegramError = error instanceof TelegramRequestError ? error : null;
      const pausedBeforeSubmission = error instanceof CommerceError && !telegramError && error.status === 503;
      if (pausedBeforeSubmission) await client.query("UPDATE customer_promotion_deliveries SET attempts=MAX(0,attempts-1) WHERE id=$1", [claim.deliveryId]);
      if (telegramError?.providerStatus === 429 || pausedBeforeSubmission) {
        cooldown = Math.max(1000, (telegramError?.retryAfterSeconds || 60) * 1000);
        status = entry.attempts < 3 || pausedBeforeSubmission ? "retry" : "failed";
        retryAt = status === "retry" ? later(now, cooldown) : null;
        info = pausedBeforeSubmission ? "Paused before submission; waiting for shop-bot availability." : "Telegram rate limit. Waiting for the shared cooldown.";
      } else if (telegramError && telegramError.providerStatus >= 400 && telegramError.providerStatus < 500) {
        status = "failed"; info = `Telegram rejected this delivery (${telegramError.providerStatus}).`;
        if (telegramError.providerStatus === 403 || telegramError.reason === "chat_unavailable") {
          await client.query(`INSERT INTO customer_promotion_preferences(owner_id,customer_id,blocked) VALUES($1,$2,1)
            ON CONFLICT(owner_id,customer_id) DO UPDATE SET blocked=1,updated_at=$3`, [owner, claim.customerId, now]);
          info = "Customer blocked the bot or the chat is unreachable; excluded from future promotions.";
        }
        if (telegramError.providerStatus === 401) cooldown = 15 * 60000;
      } else {
        status = "unknown"; cooldown = 60000;
        info = "Telegram outcome is uncertain. This delivery will not be automatically retried.";
      }
    } else if (!Number.isSafeInteger(messageId) || messageId! < 1) {
      status = "unknown"; info = "Telegram returned no valid message reference. Not automatically retried."; cooldown = 60000;
    }
    if (status === "retry" && (!held.enabled || held.active_round_id !== claim.roundId)) {
      status = "skipped"; retryAt = null; info = "Stopped by the owner; the rejected or unsubmitted delivery was not retried.";
    }
    await client.query(`UPDATE customer_promotion_deliveries SET status=$1,message_id=$2,error=$3,retry_at=$4,updated_at=$5
      WHERE id=$6 AND owner_id=$7 AND status='sending'`, [status, messageId ?? null, info, retryAt, now, claim.deliveryId, owner]);
    await counts(client, owner, claim.roundId);
    await client.query("UPDATE customer_promotion_settings SET next_dispatch_at=$1,info=CASE WHEN enabled=1 THEN $2 ELSE info END WHERE owner_id=$3 AND lease_token=$4",
      [later(now, cooldown), info || "Sending the current promotion round.", owner, claim.token]);
    if (!held.enabled || held.active_round_id !== claim.roundId) await prunePromotionHistory(client, owner);
  });
}
/** One bounded delivery per tick. The DB lease also guards overlapping callers. */
export async function processCustomerPromotions(owner: string, options: { now?: () => Date; random?: () => number; send?: Send } = {}) {
  const now = options.now ?? (() => new Date());
  const enabled = (await pool.query("SELECT enabled FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0]?.enabled;
  if (!enabled) return;
  const gate = await promotionGate(owner);
  if (gate) { await pool.query("UPDATE customer_promotion_settings SET info=$1 WHERE owner_id=$2 AND enabled=1", [gate, owner]); return; }
  const claim = await claimDelivery(owner, now(), options.random ?? Math.random);
  if (!claim) return;
  try {
    const current = await ready(owner, claim, now());
    if (!current) return;
    const paused = await promotionGate(owner);
    if (paused) { await settle(owner, claim, now(), undefined, new CommerceError(paused, 503)); return; }
    try {
      const beforeSubmit = async () => {
        const gate = await promotionGate(owner);
        if (gate) throw new CommerceError(gate, 503);
        if (!await ready(owner, claim, now())) throw new CommerceError("Promotion stopped before submission.", 503);
      };
      const guardedSend: Send = options.send
        ? async (method, body) => { await beforeSubmit(); return options.send!(method, body); }
        : (method, body) => telegramForOwner(owner, method, body, beforeSubmit);
      const message = await sendProductCard(current.chatId, customerPromotionCard(current.product), guardedSend);
      await settle(owner, claim, now(), message.message_id);
    } catch (error) { await settle(owner, claim, now(), undefined, error); }
  } finally {
    await pool.query("UPDATE customer_promotion_settings SET lease_token=NULL,lease_until=NULL WHERE owner_id=$1 AND lease_token=$2", [owner, claim.token]);
  }
}
let stopping = false;
export function stopCustomerPromotionsWorker() { stopping = true; }
export async function runCustomerPromotionsWorker() {
  while (!stopping) {
    const owner = configuredOwnerId();
    try { if (owner) await processCustomerPromotions(owner); }
    catch { logger.error("Customer promotion step failed; persisted delivery references were retained."); }
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); });
  }
}
