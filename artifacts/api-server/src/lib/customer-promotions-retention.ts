import type { PoolClient } from "@workspace/db";

export const PROMOTION_HISTORY_ROUNDS = 10;
export const PROMOTION_HISTORY_DELIVERIES = 2000;

// Closed round totals remain authoritative after their detailed audit is trimmed.
// Never trim a running round, pending retry, in-flight attempt or active cursor.
export async function prunePromotionHistory(client: PoolClient, owner: string) {
  const stable = `r.owner_id=$1 AND r.status<>'running'
    AND NOT EXISTS(SELECT 1 FROM customer_promotion_settings s WHERE s.owner_id=$1 AND s.active_round_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM customer_promotion_deliveries busy WHERE busy.round_id=r.id AND busy.status IN ('sending','retry'))`;
  await client.query(`DELETE FROM customer_promotion_rounds WHERE owner_id=$1
    AND id IN(SELECT r.id FROM customer_promotion_rounds r WHERE ${stable})
    AND id NOT IN(SELECT id FROM customer_promotion_rounds WHERE owner_id=$1
      ORDER BY created_at DESC,id DESC LIMIT ${PROMOTION_HISTORY_ROUNDS})`, [owner]);
  await client.query(`DELETE FROM customer_promotion_deliveries WHERE owner_id=$1
    AND round_id IN(SELECT r.id FROM customer_promotion_rounds r WHERE ${stable})
    AND id NOT IN(SELECT d.id FROM customer_promotion_deliveries d
      JOIN customer_promotion_rounds r ON r.id=d.round_id WHERE d.owner_id=$1 AND ${stable}
      ORDER BY d.updated_at DESC,d.id DESC LIMIT ${PROMOTION_HISTORY_DELIVERIES})`, [owner]);
}
