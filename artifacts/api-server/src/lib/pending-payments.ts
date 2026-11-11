import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, shopPayments } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { escapeHtml } from "./payment-message";

type PendingPayment = typeof shopPayments.$inferSelect;
const openStatuses = ["creating", "waiting", "confirming", "confirmed", "sending", "partially_paid"];

export class PendingPaymentsError extends CommerceError {
  constructor() {
    super("You have three pending crypto payments. View or cancel one below. Wallet purchases are still available.");
  }
}

export function isPendingCryptoPayment(p: Pick<PendingPayment, "kind" | "status" | "cancelledAt" | "fulfillment" | "expiresAt">, now = Date.now()) {
  if (p.kind === "wallet" || p.cancelledAt || ["credited", "delivered"].includes(p.fulfillment) || !openStatuses.includes(p.status)) return false;
  // An expired, unpaid quote must not block new deposits. Confirming/partial
  // payments remain visible even after quote expiry; their settlement is active.
  return !["creating", "waiting"].includes(p.status) || !p.expiresAt || p.expiresAt.getTime() > now;
}

export function assertPendingPaymentLimit(wallet: boolean, payments: Parameters<typeof isPendingCryptoPayment>[0][], now = Date.now()) {
  if (!wallet && payments.filter(p => isPendingCryptoPayment(p, now)).length >= 3) throw new PendingPaymentsError();
}

export async function customerPendingPayments(ownerId: string, customerId: string) {
  const rows = await db.select().from(shopPayments).where(and(
    eq(shopPayments.ownerId, ownerId), eq(shopPayments.customerId, customerId),
    isNull(shopPayments.cancelledAt), inArray(shopPayments.status, openStatuses),
  )).orderBy(desc(shopPayments.createdAt));
  return rows.filter(p => isPendingCryptoPayment(p));
}

export function pendingPaymentsMenu(payments: PendingPayment[]) {
  const visible = payments.slice(0, 10);
  const statusNames: Record<string, string> = {
    creating: "Preparing", waiting: "Awaiting payment", confirming: "Confirming",
    confirmed: "Processing", sending: "Settling", partially_paid: "Partial payment",
  };
  const text = [
    "⏳ <b>Pending payments</b>", "",
    payments.length ? `${payments.length} open crypto payment${payments.length === 1 ? "" : "s"}. Your wallet balance is still available for purchases.` : "You have no pending crypto payments.",
    ...visible.map((p, i) => `\n<b>${i + 1}. $${(p.amountCents / 100).toFixed(2)} · ${escapeHtml(p.coin.toUpperCase())}</b>\n${escapeHtml(statusNames[p.status] ?? "Processing")} · <code>${escapeHtml(p.id.slice(0, 8))}</code>`),
    "", "Cancel removes an invoice from this list. Funds already sent will still be verified automatically.",
    ...(payments.length > visible.length ? ["Showing the latest 10. Cancel an item and refresh to see more."] : []),
  ].join("\n");
  return { text, reply_markup: { inline_keyboard: [
    ...visible.map((p, i) => [
      { text: `📄 View ${i + 1}`, callback_data: `pending_view:${p.id}` },
      { text: `✖️ Cancel ${i + 1}`, callback_data: `pending_cancel:${p.id}` },
    ]),
    ...(payments.length < 3 ? [[{ text: "💳 New deposit", callback_data: "deposit_new" }]] : []),
    [{ text: "🔄 Refresh", callback_data: "pending" }, { text: "🏠 Home", callback_data: "cancel_home" }],
  ] } };
}
