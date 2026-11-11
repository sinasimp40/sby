import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, botCustomers, shopPayments, walletEntries, shopActivity } from "@workspace/db";
import { checkProviderMinimum, moneyCents, nowpayments, ProviderRejectedError, sendPaymentQr, type ProviderPayment } from "../src/lib/commerce-providers";
import { checkPayment, getPayment } from "../src/lib/commerce-payments";
import { reconcilePaymentBatch } from "../src/lib/payment-reconciliation";

test("provider minimums, QR and automatic amount-verified deposits", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development tests only.");
  const owner = `payment-recovery-test-${randomUUID()}`;
  const savedOwner = process.env.TELECART_OWNER_ID;
  const savedFetch = globalThis.fetch;
  process.env.TELECART_OWNER_ID = owner;
  const sent: Array<{ method: string; body: any }> = [];
  let invoiceCreates = 0;
  let rejectCreate = false;
  let timeoutCreate = false;
  let provider: ProviderPayment;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://api.nowpayments.io/v1/min-amount?")) {
      return new Response(JSON.stringify({ fiat_equivalent: target.includes("is_fixed_rate=true") ? 7.72639166 : 0.032 }));
    }
    if (target === "https://api.nowpayments.io/v1/payment" && init?.method === "POST") {
      invoiceCreates++;
      if (timeoutCreate) throw new Error("Synthetic network timeout");
      if (rejectCreate) return new Response(JSON.stringify({ code: "AMOUNT_MINIMAL_ERROR", message: "RAW PROVIDER BODY MUST NOT ESCAPE" }), { status: 400 });
      throw new Error("Unexpected invoice creation blocked");
    }
    if (target === "https://api.nowpayments.io/v1/payment/999999991") return new Response(JSON.stringify(provider));
    if (target.startsWith("https://api.telegram.org/")) {
      sent.push({ method: target.slice(target.lastIndexOf("/") + 1), body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    throw new Error("Unexpected network request blocked");
  };
  const customerId = randomUUID();
  const paymentId = randomUUID();
  try {
    await t.test("$5 is rejected before invoice creation, $8 passes the current LTC minimum", async () => {
      await assert.rejects(checkProviderMinimum("ltc", 500), /\$7\.73/);
      await checkProviderMinimum("ltc", 800);
      assert.equal(invoiceCreates, 0);
      await checkProviderMinimum("ltc", 10, "floating");
      assert.equal(moneyCents("0.10"), 10);
      assert.throws(() => moneyCents("0.09"));
    });
    await t.test("known rejection differs from ambiguous timeout and never exposes raw errors", async () => {
      rejectCreate = true;
      await assert.rejects(nowpayments("/payment", {}), error => error instanceof ProviderRejectedError && !error.message.includes("RAW PROVIDER"));
      rejectCreate = false; timeoutCreate = true;
      await assert.rejects(nowpayments("/payment", {}), error => error instanceof Error && !(error instanceof ProviderRejectedError));
    });
    await db.insert(botCustomers).values({ id: customerId, ownerId: owner, telegramId: `TEST-${randomUUID()}`, chatId: "TEST_ONLY_CHAT", username: "TEST_ONLY" });
    await db.insert(shopPayments).values({
      id: paymentId, requestKey: `TEST-${randomUUID()}`, ownerId: owner, customerId,
      kind: "deposit", amountCents: 1000, coin: "ltc", providerPaymentId: "999999991",
      address: "TEST_ONLY_ADDRESS", payAmount: "1.25", status: "waiting",
      rateMode: "floating", invoiceMessageId: 111, invoiceNeedsUpdate: true,
      expiresAt: new Date(Date.now() + 600000),
    });
    provider = {
      payment_id: "999999991", order_id: paymentId, payment_status: "confirming",
      price_amount: 10, price_currency: "usd", pay_currency: "ltc",
      pay_address: "TEST_ONLY_ADDRESS", pay_amount: "1.25", actually_paid: "0.5",
    };
    await t.test("automatic reconciliation fetches status and actual amount without incoming IPN", async () => {
      await reconcilePaymentBatch();
      const p = await getPayment(paymentId);
      assert.equal(p!.status, "confirming");
      assert.equal(p!.receivedAmount, "0.5");
      assert.ok(p!.lastCheckedAt);
      assert.equal((await db.select().from(botCustomers).where(eq(botCustomers.id, customerId)))[0]!.balanceCents, 0);
      const edits = sent.filter(s => s.method === "editMessageCaption");
      assert.equal(edits.length, 1);
      assert.equal(edits[0]!.body.message_id, 111);
      assert.match(edits[0]!.body.caption, /Payment detected/);
      await checkPayment(paymentId);
      assert.equal(sent.filter(s => s.method === "editMessageCaption").length, 1, "unchanged captions are not resent");
    });
    await t.test("even finished underpayment cannot credit; full finished payment credits once", async () => {
      provider.payment_status = "finished";
      provider.pay_amount = "1.4"; // Floating estimates are authoritative, never the old quote.
      provider.actually_paid = "1.25";
      await checkPayment(paymentId);
      assert.equal((await getPayment(paymentId))!.fulfillment, "review");
      provider.actually_paid = "1.4";
      await Promise.all([checkPayment(paymentId), checkPayment(paymentId), checkPayment(paymentId)]);
      assert.equal((await getPayment(paymentId))!.receivedAmount, "1.4");
      assert.equal((await getPayment(paymentId))!.payAmount, "1.4");
      assert.equal((await db.select().from(botCustomers).where(eq(botCustomers.id, customerId)))[0]!.balanceCents, 1000);
      assert.equal((await db.select().from(walletEntries).where(eq(walletEntries.paymentId, paymentId))).length, 1);
      assert.equal(sent.filter(s => s.method === "sendMessage").length, 1);
      await checkPayment(paymentId);
      const lastEdit = sent.filter(s => s.method === "editMessageCaption").at(-1)!;
      assert.match(lastEdit.body.caption, /wallet credited/);
      assert.equal(lastEdit.body.message_id, 111);
      assert.deepEqual(lastEdit.body.reply_markup, { inline_keyboard: [] });
    });
    await t.test("QR image contains provider address and caption shows exact amount, coin and expiry", async () => {
      await sendPaymentQr("TEST_ONLY_CHAT", { id: paymentId, address: "TEST_ONLY_ADDRESS", payAmount: "1.25", coin: "ltc", network: "LTC", extraId: null, expiresAt: new Date(Date.now() + 600000) });
      const photo = sent.at(-1)!;
      assert.equal(photo.method, "sendPhoto");
      const bytes = Buffer.from(await (photo.body.get("photo") as Blob).arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.match(photo.body.get("caption"), /1.25 LTC/);
      assert.match(photo.body.get("caption"), /TEST_ONLY_ADDRESS/);
      assert.equal(photo.body.get("reply_markup"), null);
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedOwner === undefined) delete process.env.TELECART_OWNER_ID; else process.env.TELECART_OWNER_ID = savedOwner;
    await db.delete(walletEntries).where(eq(walletEntries.customerId, customerId));
    await db.delete(shopPayments).where(eq(shopPayments.ownerId, owner));
    await db.delete(botCustomers).where(eq(botCustomers.ownerId, owner));
    await db.delete(shopActivity).where(eq(shopActivity.ownerId, owner));
    await pool.end();
  }
});
