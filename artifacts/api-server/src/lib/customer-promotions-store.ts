import { pool, type PoolClient } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { getBotRuntime } from "./bot-runtime";
import { settingsForOwner } from "./shop-store";
import type { CustomerPromotionInput, PromotionProductsInput } from "@workspace/api-zod";
import type { PromotedProduct } from "./customer-promotion-card";
import { prunePromotionHistory } from "./customer-promotions-retention";

export const promotionDate = (value: unknown) => value == null ? null : new Date(value as string | Date).toISOString();
export async function promotionTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function promotionGate(owner: string) {
  const connection = await pool.query("SELECT owner_id,active FROM bot_connections WHERE id='primary'");
  if (connection.rows[0]?.owner_id !== owner || connection.rows[0]?.active !== "yes") return "Connect and enable this shop's bot before sending promotions.";
  if (!(await getBotRuntime(owner)).enabled) return "Paused: shop-bot processing is disabled or an imported shop awaits review.";
  if ((await settingsForOwner(owner)).maintenanceMode) return "Paused: the shop is in maintenance mode.";
  return "";
}
export async function eligiblePromotionProducts(client: Pick<PoolClient, "query">, owner: string): Promise<PromotedProduct[]> {
  const result = await client.query(`SELECT p.*,
    (SELECT count(*) FROM shop_inventory i WHERE i.owner_id=p.owner_id AND i.product_id=p.id AND i.status='available') AS stock
    FROM shop_products p JOIN customer_promotion_products f ON f.owner_id=p.owner_id AND f.product_id=p.id
    WHERE p.owner_id=$1 AND p.status='active' AND f.enabled=1
    AND EXISTS(SELECT 1 FROM shop_inventory i WHERE i.owner_id=p.owner_id AND i.product_id=p.id AND i.status='available')
    ORDER BY p.id`, [owner]);
  return result.rows.map(row => ({
    id: row.id, name: row.name, description: row.description, groupDescription: row.group_description,
    priceCents: row.price_cents, stock: row.stock, imageUrl: row.image_url,
    buttonEmoji: row.button_emoji, buttonCustomEmojiId: row.button_custom_emoji_id,
  }));
}
export async function customerPromotionStatus(owner: string) {
  const settings = (await pool.query("SELECT * FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0];
  const products = await pool.query("SELECT product_id,enabled FROM customer_promotion_products WHERE owner_id=$1 ORDER BY product_id", [owner]);
  const rounds = await pool.query("SELECT * FROM customer_promotion_rounds WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 10", [owner]);
  const deliveries = await pool.query(`SELECT id,round_id,status,attempts,error,updated_at FROM customer_promotion_deliveries
    WHERE owner_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 20`, [owner]);
  const recipientCount = (await pool.query(`SELECT count(*) AS count FROM bot_customers c WHERE c.owner_id=$1
    AND NOT EXISTS(SELECT 1 FROM customer_promotion_preferences x WHERE x.owner_id=$1 AND x.customer_id=c.id AND (x.opted_out=1 OR x.blocked=1))`, [owner])).rows[0].count as number;
  const eligibleCount = (await eligiblePromotionProducts(pool, owner)).length;
  const gate = settings?.enabled ? await promotionGate(owner) : "";
  const info = !settings?.enabled ? "Customer promotions are disabled." : gate ||
    (!eligibleCount ? "No eligible products: enable promotion for an active product or option with available stock." :
      !recipientCount ? "No eligible customers: customers must have contacted this shop bot and not opted out or blocked it." :
        settings.info);
  return {
    enabled: !!settings?.enabled, intervalMinutes: settings?.interval_minutes ?? 60,
    nextAt: promotionDate(settings?.next_at), info, eligibleCount, recipientCount,
    products: products.rows.map(row => ({ productId: row.product_id as number, enabled: !!row.enabled })),
    rounds: rounds.rows.map(row => ({ id: row.id, productId: row.product_id, productName: row.product_name,
      status: row.status, sent: row.sent, failed: row.failed, uncertain: row.uncertain, skipped: row.skipped,
      info: row.info, createdAt: promotionDate(row.created_at)!, completedAt: promotionDate(row.completed_at) })),
    deliveries: deliveries.rows.map(row => ({ id: row.id, roundId: row.round_id, status: row.status,
      attempts: row.attempts, error: row.error, updatedAt: promotionDate(row.updated_at)! })),
  };
}
export async function saveCustomerPromotionSettings(owner: string, input: CustomerPromotionInput, now = new Date()) {
  if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 43200)
    throw new CommerceError("Choose an interval from 1 to 43,200 whole minutes.");
  await promotionTransaction(async client => {
    await client.query("INSERT INTO customer_promotion_settings(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING", [owner]);
    const old = (await client.query("SELECT * FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0];
    if (!input.enabled && old.active_round_id) {
      await client.query(`UPDATE customer_promotion_rounds SET status='stopped',info='Stopped by the owner. A submitted message may finish.',completed_at=$1
        WHERE id=$2 AND owner_id=$3 AND status='running'`, [now, old.active_round_id, owner]);
      await client.query(`UPDATE customer_promotion_deliveries SET status='skipped',error='Stopped by the owner.',updated_at=$1
        WHERE owner_id=$2 AND round_id=$3 AND status='retry'`, [now, owner, old.active_round_id]);
      await client.query(`UPDATE customer_promotion_rounds SET skipped=(SELECT count(*) FROM customer_promotion_deliveries
        WHERE round_id=$1 AND status='skipped') WHERE id=$1 AND owner_id=$2`, [old.active_round_id, owner]);
    }
    const next = input.enabled
      ? !old.enabled || old.interval_minutes !== input.intervalMinutes
        ? new Date(now.getTime() + input.intervalMinutes * 60000) : old.next_at
      : null;
    await client.query(`UPDATE customer_promotion_settings SET enabled=$1,interval_minutes=$2,next_at=$3,
      active_round_id=$4,info=$5 WHERE owner_id=$6`, [input.enabled, input.intervalMinutes, next,
      input.enabled ? old.active_round_id : null, input.enabled ? "Waiting for the next shared promotion round." : "Customer promotions are disabled.", owner]);
    await prunePromotionHistory(client, owner);
  });
}
export async function setPromotedProductFlags(owner: string, input: PromotionProductsInput) {
  const ids = [...new Set(input.productIds)];
  if (!ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1) || typeof input.enabled !== "boolean") throw new CommerceError("Choose valid products.");
  await promotionTransaction(async client => {
    const owned = await client.query("SELECT id FROM shop_products WHERE owner_id=$1 AND id=ANY($2::int[])", [owner, ids]);
    if (owned.rowCount !== ids.length) throw new CommerceError("A selected product was not found in your shop.", 404);
    for (const id of ids) await client.query(`INSERT INTO customer_promotion_products(owner_id,product_id,enabled)
      VALUES($1,$2,$3) ON CONFLICT(owner_id,product_id) DO UPDATE SET enabled=excluded.enabled`, [owner, id, input.enabled]);
  });
}
export async function setCustomerPromotionPreference(owner: string, customer: string, optedOut: boolean) {
  await promotionTransaction(async client => {
    if (!(await client.query("SELECT id FROM bot_customers WHERE id=$1 AND owner_id=$2", [customer, owner])).rowCount) throw new CommerceError("Customer not found.", 404);
    await client.query(`INSERT INTO customer_promotion_preferences(owner_id,customer_id,opted_out,blocked) VALUES($1,$2,$3,0)
      ON CONFLICT(owner_id,customer_id) DO UPDATE SET opted_out=excluded.opted_out,blocked=0,updated_at=$4`,
    [owner, customer, optedOut, new Date()]);
  });
}
