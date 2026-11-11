import { and, asc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, pool, shopPayments, botRuntimeSettings } from "@workspace/db";
import { configuredOwnerId } from "./admin-bootstrap";
import { checkPayment } from "./commerce-payments";
import { logger } from "./logger";

// Both webhook and polling deployments reconcile through the same authoritative,
// idempotent settlement path. No synthetic paid states or new invoices.
export async function reconcilePaymentBatch() {
  const owner = configuredOwnerId();
  if (!owner) return;
  const [transfer] = await db.select({ pending: botRuntimeSettings.transferReviewRequired }).from(botRuntimeSettings).where(eq(botRuntimeSettings.ownerId, owner));
  if (transfer?.pending) return;
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('telecart-payment-reconciliation', 4)) AS locked");
    locked = lock.rows[0]?.locked === true;
    if (!locked) return;
    const rows = await db.select({ id: shopPayments.id }).from(shopPayments).where(and(
      eq(shopPayments.ownerId, owner),
      isNotNull(shopPayments.providerPaymentId),
      or(isNull(shopPayments.deliveredAt), eq(shopPayments.invoiceNeedsUpdate, true)),
      // Keep late terminal payments observable, without polling historical orders forever.
      or(lt(shopPayments.lastCheckedAt, new Date(Date.now() - 5 * 60000)), isNull(shopPayments.lastCheckedAt),
        and(eq(shopPayments.fulfillment, "pending"), lt(shopPayments.lastCheckedAt, new Date(Date.now() - 30000))),
        and(eq(shopPayments.invoiceNeedsUpdate, true), lt(shopPayments.updatedAt, new Date(Date.now() - 30000)))),
      // Seven-day window plus allocated delivery retries regardless of age.
      or(gt(shopPayments.createdAt, new Date(Date.now() - 7 * 86400000)), eq(shopPayments.fulfillment, "allocated"), eq(shopPayments.fulfillment, "credited")),
    )).orderBy(asc(shopPayments.updatedAt)).limit(20);
    for (const row of rows) {
      try { await checkPayment(row.id); }
      catch {
        // Bound failure retries; never log provider bodies or customer details.
        await db.update(shopPayments).set({ lastCheckedAt: new Date(), updatedAt: new Date() }).where(eq(shopPayments.id, row.id));
        logger.warn("A payment status check failed; automatic reconciliation will retry.");
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('telecart-payment-reconciliation', 4))").catch(() => undefined);
    client.release();
  }
}

export async function runPaymentReconciliation() {
  for (;;) {
    try { await reconcilePaymentBatch(); }
    catch { logger.warn("Payment reconciliation interrupted; retrying shortly."); }
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}
