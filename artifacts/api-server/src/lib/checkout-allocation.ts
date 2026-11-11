import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, botCustomers, shopPayments, shopInventory, shopProducts, walletEntries } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { assertPendingPaymentLimit } from "./pending-payments";
import { assertTransferReviewed } from "./shop-transfer-safety";
import type { settingsForOwner } from "./shop-store";

export interface CheckoutInput {
  ownerId: string; customerId: string; token: string; coin: string;
  productId?: number; depositCents?: number; expectedAmountCents?: number;
  wallet?: boolean; quantity?: number;
}
export const MAX_PURCHASE_QUANTITY = 100;
export function checkoutQuantity(input: CheckoutInput) {
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY ||
    (!input.productId && quantity !== 1)) throw new CommerceError("Choose a whole-number quantity between 1 and 100, within available stock.");
  return quantity;
}

// One transaction assigns ALL units and debits the total once, or changes nothing.
// Connection/maintenance/provider checks remain in createCheckout before this step.
export async function allocateCheckout(input: CheckoutInput, settings: Pick<Awaited<ReturnType<typeof settingsForOwner>>, "minDeposit" | "rateMode">) {
  const quantity = checkoutQuantity(input);
  await assertTransferReviewed(input.ownerId);
  if (input.productId !== undefined && !input.wallet) throw new CommerceError("Products can only be purchased with wallet balance.");
  const requestKey = `${input.customerId}:${input.token}`;
  return db.transaction(async tx => {
    const [customer] = await tx.select().from(botCustomers).where(and(
      eq(botCustomers.id, input.customerId), eq(botCustomers.ownerId, input.ownerId),
    )).for("update");
    if (!customer) throw new CommerceError("Customer not found.");
    const [existing] = await tx.select().from(shopPayments).where(eq(shopPayments.requestKey, requestKey));
    if (existing) {
      if (existing.cancelledAt) throw new CommerceError("This invoice was cancelled. Open Wallet → Deposit for a new selection.");
      return { payment: existing, created: false };
    }
    if (!input.wallet) {
      const pending = await tx.select().from(shopPayments).where(and(
        eq(shopPayments.ownerId, input.ownerId), eq(shopPayments.customerId, customer.id),
        inArray(shopPayments.status, ["creating", "waiting", "confirming", "confirmed", "sending", "partially_paid"]),
      ));
      assertPendingPaymentLimit(false, pending);
    }
    let product: typeof shopProducts.$inferSelect | undefined;
    let stocks: Array<typeof shopInventory.$inferSelect> = [];
    if (input.productId) {
      [product] = await tx.select().from(shopProducts).where(and(
        eq(shopProducts.id, input.productId), eq(shopProducts.ownerId, input.ownerId), eq(shopProducts.status, "active"),
      )).for("update");
      if (!product) throw new CommerceError("This product is no longer available.");
      if (input.expectedAmountCents !== undefined && product.priceCents !== input.expectedAmountCents) throw new CommerceError("The price changed. Select this product again.");
      stocks = await tx.select().from(shopInventory).where(and(
        eq(shopInventory.productId, product.id), eq(shopInventory.ownerId, input.ownerId), eq(shopInventory.status, "available"),
      )).orderBy(shopInventory.id).limit(quantity).for("update", { skipLocked: true });
      if (stocks.length < quantity) throw new CommerceError(`📦 Only ${stocks.length} account${stocks.length === 1 ? " is" : "s are"} available right now. Choose a lower quantity or refresh the product.`);
    }
    const cents = product ? product.priceCents * quantity : input.depositCents ?? 0;
    if (cents <= 0 || !Number.isSafeInteger(cents) || cents > 10000000) throw new CommerceError("Invalid payment amount.");
    if (!product && cents < Math.round(settings.minDeposit * 100)) throw new CommerceError(`Minimum deposit is $${settings.minDeposit.toFixed(2)}.`);
    if (input.wallet && (!product || customer.balanceCents < cents)) throw new CommerceError(`👛 Insufficient wallet balance. You need $${(cents / 100).toFixed(2)} for this purchase. Add funds first.`);
    const [payment] = await tx.insert(shopPayments).values({
      id: randomUUID(), requestKey, ownerId: input.ownerId, customerId: customer.id,
      kind: input.wallet ? "wallet" : product ? "purchase" : "deposit",
      productId: product?.id, inventoryId: stocks[0]?.id,
      inventoryIds: stocks.length ? stocks.map(s => s.id) : null, quantity,
      productName: product ? `${product.name}${quantity > 1 ? ` × ${quantity}` : ""}` : "Wallet deposit",
      amountCents: cents, coin: input.wallet ? "usd" : input.coin, rateMode: settings.rateMode,
      status: input.wallet ? "finished" : "creating", fulfillment: input.wallet ? "allocated" : "pending",
    }).returning();
    if (stocks.length) await tx.update(shopInventory).set({ status: input.wallet ? "delivered" : "reserved" }).where(inArray(shopInventory.id, stocks.map(s => s.id)));
    if (input.wallet) {
      await tx.insert(walletEntries).values({ id: randomUUID(), customerId: customer.id, paymentId: payment!.id, amountCents: -cents });
      await tx.update(botCustomers).set({ balanceCents: sql`${botCustomers.balanceCents} - ${cents}` }).where(eq(botCustomers.id, customer.id));
    }
    return { payment: payment!, created: true };
  });
}
