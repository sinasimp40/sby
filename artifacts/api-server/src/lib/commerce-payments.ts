import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool, botCustomers, shopPayments, shopInventory, shopProducts, walletEntries, shopActivity } from "@workspace/db";
import { CommerceError, decimalAtLeast, nowpayments, type ProviderPayment, sendPaymentQr, telegram } from "./commerce-providers";
import { decryptCredential } from "./inventory-encryption";
import { settingsForOwner } from "./shop-store";
import { activeConnection } from "./commerce-connection";

export type Payment = typeof shopPayments.$inferSelect;
const terminal = ["failed", "expired", "refunded"];

export async function getPayment(id: string) {
  const [payment] = await db.select().from(shopPayments).where(eq(shopPayments.id, id));
  return payment;
}

export async function createCheckout(input: {
  ownerId: string; customerId: string; token: string; coin: string;
  productId?: number; depositCents?: number; expectedAmountCents?: number; wallet?: boolean;
}) {
  const settings = await settingsForOwner(input.ownerId);
  const connection = await activeConnection();
  if (!connection || connection.active !== "yes" || connection.ownerId !== input.ownerId) throw new CommerceError("This shop is not connected.");
  if (settings.maintenanceMode) throw new CommerceError("The shop is under maintenance. Please try later.");
  if (!input.wallet && !settings.acceptedCoins.some(c => c.toLowerCase() === input.coin)) throw new CommerceError("That coin is not accepted.");
  const requestKey = `${input.customerId}:${input.token}`;
  const result = await db.transaction(async tx => {
    // Serialize ALL balance changes/invoice creation for this customer.
    const [customer] = await tx.select().from(botCustomers).where(and(
      eq(botCustomers.id, input.customerId), eq(botCustomers.ownerId, input.ownerId),
    )).for("update");
    if (!customer) throw new CommerceError("Customer not found.");
    const [existing] = await tx.select().from(shopPayments).where(eq(shopPayments.requestKey, requestKey));
    if (existing) return { payment: existing, created: false };
    const pending = await tx.select({ id: shopPayments.id }).from(shopPayments).where(and(
      eq(shopPayments.customerId, customer.id), inArray(shopPayments.status, ["creating", "waiting", "confirming", "confirmed", "sending", "partially_paid"]),
    ));
    if (pending.length >= 3) throw new CommerceError("You already have three pending payments. Complete or check one first.");
    let product: typeof shopProducts.$inferSelect | undefined;
    let stock: typeof shopInventory.$inferSelect | undefined;
    if (input.productId) {
      [product] = await tx.select().from(shopProducts).where(and(
        eq(shopProducts.id, input.productId), eq(shopProducts.ownerId, input.ownerId), eq(shopProducts.status, "active"),
      )).for("update");
      if (!product) throw new CommerceError("This product is no longer available.");
      if (input.expectedAmountCents !== undefined && product.priceCents !== input.expectedAmountCents) throw new CommerceError("The price changed. Select this product again.");
      [stock] = await tx.select().from(shopInventory).where(and(
        eq(shopInventory.productId, product.id), eq(shopInventory.ownerId, input.ownerId), eq(shopInventory.status, "available"),
      )).limit(1).for("update", { skipLocked: true });
      if (!stock) throw new CommerceError("This product is out of stock.");
    }
    const cents = product?.priceCents ?? input.depositCents ?? 0;
    if (cents <= 0 || !Number.isSafeInteger(cents) || cents > 10000000) throw new CommerceError("Invalid payment amount.");
    if (!product && cents < Math.round(settings.minDeposit * 100)) throw new CommerceError(`Minimum deposit is $${settings.minDeposit.toFixed(2)}.`);
    if (input.wallet && (!product || customer.balanceCents < cents)) throw new CommerceError("Insufficient wallet balance. Deposit first.");
    const [payment] = await tx.insert(shopPayments).values({
      id: randomUUID(), requestKey, ownerId: input.ownerId, customerId: customer.id,
      kind: input.wallet ? "wallet" : product ? "purchase" : "deposit",
      productId: product?.id, inventoryId: stock?.id, productName: product?.name ?? "Wallet deposit",
      amountCents: cents, coin: input.wallet ? "usd" : input.coin,
      status: input.wallet ? "finished" : "creating", fulfillment: input.wallet ? "allocated" : "pending",
    }).returning();
    if (stock) await tx.update(shopInventory).set({ status: input.wallet ? "delivered" : "reserved" }).where(eq(shopInventory.id, stock.id));
    if (input.wallet) {
      await tx.insert(walletEntries).values({ id: randomUUID(), customerId: customer.id, paymentId: payment!.id, amountCents: -cents });
      await tx.update(botCustomers).set({ balanceCents: sql`${botCustomers.balanceCents} - ${cents}` }).where(eq(botCustomers.id, customer.id));
    }
    return { payment: payment!, created: true };
  });
  if (!result.created || input.wallet) return result.payment;
  try {
    const p = await nowpayments("/payment", {
      price_amount: result.payment.amountCents / 100, price_currency: "usd", pay_currency: input.coin,
      order_id: result.payment.id, order_description: result.payment.productName,
      ipn_callback_url: `${connection.publicUrl}/api/nowpayments/ipn`,
      is_fixed_rate: true, is_fee_paid_by_user: false,
    });
    if (!p.payment_id || !/^\d+$/.test(String(p.payment_id)) || !p.pay_address ||
      p.order_id !== result.payment.id || p.pay_currency?.toLowerCase() !== input.coin ||
      !decimalAtLeast(p.pay_amount, "0.000000000000000001") ||
      !Number.isFinite(Number(p.price_amount)) || Math.abs(Number(p.price_amount) * 100 - result.payment.amountCents) > 0.00001 ||
      p.price_currency?.toLowerCase() !== "usd") throw new CommerceError("Provider returned an inconsistent invoice.", 502);
    const quoteExpiry = p.expiration_estimate_date ? new Date(p.expiration_estimate_date) : null;
    if (!quoteExpiry || !Number.isFinite(quoteExpiry.getTime()) || quoteExpiry.getTime() <= Date.now()) {
      throw new CommerceError("Provider returned no usable quote expiry.", 502);
    }
    const expiresAt = new Date(Math.min(quoteExpiry.getTime(), Date.now() + settings.invoiceExpiryMinutes * 60000));
    const [saved] = await db.update(shopPayments).set({
      providerPaymentId: String(p.payment_id), address: p.pay_address, payAmount: String(p.pay_amount),
      extraId: p.payin_extra_id ?? null, network: p.network || input.coin.toUpperCase(),
      expiresAt, status: p.payment_status, updatedAt: new Date(),
    }).where(eq(shopPayments.id, result.payment.id)).returning();
    return saved!;
  } catch (error) {
    // A timeout does not prove the provider failed to create a payment.
    // Keep the reservation; never recreate the same payment or silently free its stock.
    await db.update(shopPayments).set({ fulfillment: "review", updatedAt: new Date() }).where(eq(shopPayments.id, result.payment.id));
    await db.insert(shopActivity).values({
      ownerId: input.ownerId, title: "Payment creation needs review",
      description: `Order ${result.payment.id}: check NOWPayments by order ID before releasing stock.`, type: "payment",
    });
    throw error;
  }
}

export function matchesInvoice(payment: Payment, provider: ProviderPayment) {
  return String(provider.payment_id) === payment.providerPaymentId &&
    provider.order_id === payment.id && provider.price_currency?.toLowerCase() === "usd" &&
    Number.isFinite(Number(provider.price_amount)) &&
    Math.abs(Number(provider.price_amount) * 100 - payment.amountCents) < 0.00001 &&
    provider.pay_currency?.toLowerCase() === payment.coin &&
    provider.pay_address === payment.address && (provider.payin_extra_id ?? null) === payment.extraId;
}

export async function checkPayment(id: string) {
  const payment = await getPayment(id);
  if (!payment) throw new CommerceError("Payment not found.", 404);
  if (payment.kind === "wallet" || ["allocated", "delivered", "credited"].includes(payment.fulfillment)) {
    await deliverPayment(payment.id);
    return (await getPayment(id))!;
  }
  if (!payment.providerPaymentId) throw new CommerceError("Invoice creation needs manual review; check the order ID in NOWPayments before retrying.", 409);
  const provider = await nowpayments(`/payment/${encodeURIComponent(payment.providerPaymentId)}`);
  if (!matchesInvoice(payment, provider)) {
    await db.update(shopPayments).set({ fulfillment: "review" }).where(eq(shopPayments.id, id));
    throw new CommerceError("Provider payment identity or amount does not match. Manual review required.", 409);
  }
  await applyVerifiedPayment(payment.id, provider);
  await deliverPayment(payment.id);
  return (await getPayment(id))!;
}

// Only called with an authenticated provider response, never a client/IPN status alone.
export async function applyVerifiedPayment(id: string, provider: ProviderPayment) {
  await db.transaction(async tx => {
    const [p] = await tx.select().from(shopPayments).where(eq(shopPayments.id, id)).for("update");
    if (!p || !matchesInvoice(p, provider)) throw new CommerceError("Payment mismatch.", 409);
    if (["allocated", "delivered", "credited"].includes(p.fulfillment)) return;
    if (provider.payment_status === "finished") {
      // Be conservative about partial, wrong-asset and additional/child deposits.
      if (!decimalAtLeast(provider.actually_paid, p.payAmount)) {
        await tx.update(shopPayments).set({ status: "finished", fulfillment: "review", updatedAt: new Date() }).where(eq(shopPayments.id, p.id));
        return;
      }
      if (p.kind === "deposit") {
        const [customer] = await tx.select().from(botCustomers).where(eq(botCustomers.id, p.customerId)).for("update");
        if (!customer || customer.balanceCents + p.amountCents > 2000000000) throw new CommerceError("Wallet requires manual review.", 409);
        await tx.insert(walletEntries).values({ id: randomUUID(), customerId: p.customerId, paymentId: p.id, amountCents: p.amountCents });
        await tx.update(botCustomers).set({ balanceCents: sql`${botCustomers.balanceCents} + ${p.amountCents}` }).where(eq(botCustomers.id, p.customerId));
        await tx.update(shopPayments).set({ status: "finished", fulfillment: "credited", updatedAt: new Date() }).where(eq(shopPayments.id, p.id));
      } else {
        const [stock] = p.inventoryId ? await tx.select().from(shopInventory).where(eq(shopInventory.id, p.inventoryId)).for("update") : [];
        if (!stock || stock.status !== "reserved" || stock.ownerId !== p.ownerId || stock.productId !== p.productId) {
          await tx.update(shopPayments).set({ status: "finished", fulfillment: "review", updatedAt: new Date() }).where(eq(shopPayments.id, p.id));
          return;
        }
        await tx.update(shopInventory).set({ status: "delivered" }).where(eq(shopInventory.id, stock.id));
        await tx.update(shopPayments).set({ status: "finished", fulfillment: "allocated", updatedAt: new Date() }).where(eq(shopPayments.id, p.id));
      }
      await tx.insert(shopActivity).values({
        ownerId: p.ownerId, title: p.kind === "deposit" ? "Wallet credited" : "Payment finished",
        description: `Order ${p.id}: verified directly with NOWPayments.`, type: "payment",
      });
    } else {
      if (terminal.includes(provider.payment_status) && p.inventoryId) {
        await tx.update(shopInventory).set({ status: "available" }).where(and(eq(shopInventory.id, p.inventoryId), eq(shopInventory.status, "reserved")));
        // Retain the order snapshot, but detach stock so a late completion cannot take a resold line.
        await tx.update(shopPayments).set({ inventoryId: null }).where(eq(shopPayments.id, p.id));
      }
      await tx.update(shopPayments).set({ status: provider.payment_status, updatedAt: new Date() }).where(eq(shopPayments.id, p.id));
    }
  });
}

export async function deliverPayment(id: string) {
  // Distributed lock: IPN, buyer checks and admin checks cannot concurrently send.
  // If Telegram acknowledges but the process dies before DB commit, retry sends
  // the SAME assigned line, never takes another account.
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 1)) AS locked", [id]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return;
    const p = await getPayment(id);
    if (!p || p.deliveredAt || !["allocated", "credited"].includes(p.fulfillment)) return;
    const [customer] = await db.select().from(botCustomers).where(eq(botCustomers.id, p.customerId));
    if (!customer) throw new CommerceError("Customer not found.");
    let text: string;
    if (p.kind === "deposit") {
      text = `Payment finished. $${(p.amountCents / 100).toFixed(2)} was credited once to your wallet.\nReference: ${p.id}`;
    } else {
      const [stock] = p.inventoryId ? await db.select().from(shopInventory).where(eq(shopInventory.id, p.inventoryId)) : [];
      if (!stock || p.productId === null) throw new CommerceError("Assigned stock needs manual review.", 409);
      text = `Payment complete · ${p.productName}\nOrder: ${p.id}\n\n${decryptCredential(stock.encryptedCredential, p.ownerId, p.productId)}\n\nKeep these credentials private.`;
    }
    // Delivery goes only to the stored buyer chat, never an IPN/client-supplied chat.
    await telegram("sendMessage", { chat_id: customer.chatId, text, protect_content: true });
    await db.update(shopPayments).set({
      fulfillment: p.kind === "deposit" ? "credited" : "delivered", deliveredAt: new Date(), updatedAt: new Date(),
    }).where(eq(shopPayments.id, id));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 1))", [id]);
    client.release();
  }
}

export async function sendCheckout(payment: Payment) {
  if (payment.kind === "wallet") { await deliverPayment(payment.id); return; }
  const [customer] = await db.select().from(botCustomers).where(eq(botCustomers.id, payment.customerId));
  if (!customer) throw new CommerceError("Customer not found.");
  if (!payment.address || !payment.payAmount || !payment.expiresAt) throw new CommerceError("Invoice needs manual review. Please contact support.");
  if (payment.expiresAt.getTime() < Date.now()) throw new CommerceError("This quote has expired. Do not send funds. Use Check payment for any funds already sent.");
  if (payment.status !== "waiting") {
    await telegram("sendMessage", { chat_id: customer.chatId, text: `Payment status: ${payment.status}. Use Check payment for updates.` });
    return;
  }
  await sendPaymentQr(customer.chatId, {
    id: payment.id, address: payment.address, payAmount: payment.payAmount, coin: payment.coin,
    network: payment.network || payment.coin.toUpperCase(), extraId: payment.extraId, expiresAt: payment.expiresAt,
  });
}
