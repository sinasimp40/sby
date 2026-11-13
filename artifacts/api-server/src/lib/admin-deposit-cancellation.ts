import { and, eq } from "drizzle-orm";
import { db, shopPayments, shopActivity } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { refreshPaymentMessage } from "./commerce-payments";
import { canCancelDeposit } from "./deposit-cancellation-policy";

export async function cancelAdminDeposit(ownerId: string | null, id: string) {
  if (!ownerId) throw new CommerceError("Sign in to cancel a top-up.", 401);
  const payment = await db.transaction(async tx => {
    const [p] = await tx.select().from(shopPayments).where(and(
      eq(shopPayments.id, id), eq(shopPayments.ownerId, ownerId), eq(shopPayments.kind, "deposit"),
    ));
    if (!p) throw new CommerceError("Deposit not found.", 404);
    if (p.cancelledAt) return p;
    if (!canCancelDeposit(p)) {
      throw new CommerceError("This deposit is already settled or closed. Refresh its status.", 409);
    }
    const [cancelled] = await tx.update(shopPayments).set({
      cancelledAt: new Date(), updatedAt: new Date(), invoiceNeedsUpdate: p.invoiceMessageId !== null,
    }).where(eq(shopPayments.id, p.id)).returning();
    await tx.insert(shopActivity).values({
      ownerId, title: "Top-up cancelled by admin", type: "payment",
      description: `Deposit ${p.id}. Payment verification and late-payment crediting continue.`,
    });
    return cancelled!;
  });
  // Cancellation is committed even if Telegram is unavailable. The persisted
  // notification flag lets reconciliation retry without another cancellation.
  let telegramUpdatePending = false;
  if (payment.invoiceMessageId) {
    try { await refreshPaymentMessage(payment.id); }
    catch { telegramUpdatePending = true; }
    const [latest] = await db.select({ pending: shopPayments.invoiceNeedsUpdate }).from(shopPayments).where(eq(shopPayments.id, id));
    telegramUpdatePending = latest?.pending ?? telegramUpdatePending;
  }
  return { id: payment.id, cancelledAt: payment.cancelledAt!.toISOString(), telegramUpdatePending };
}
