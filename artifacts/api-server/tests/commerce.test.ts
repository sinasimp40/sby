import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, pool, botConnections, botCustomers, botUpdates, shopPayments, walletEntries,
  shopProducts, shopInventory, shopSettings, shopActivity,
} from "@workspace/db";
import { encryptCredential } from "../src/lib/inventory-encryption";
import { createCheckout, applyVerifiedPayment, checkPayment, deliverPayment, getPayment, sendCheckout } from "../src/lib/commerce-payments";
import { decimalAtLeast, moneyCents, verifyIpn, sortedJson, type ProviderPayment } from "../src/lib/commerce-providers";
import { handleTelegramUpdate } from "../src/lib/telegram-shop";

test("finished-only checkout, stock allocation, wallet ledger and Telegram delivery", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Never run isolated development tests in production.");
  const owner = `commerce-test-${randomUUID()}`;
  const botId = `test-${randomUUID()}`;
  const envKeys = ["TELECART_OWNER_ID", "TELEGRAM_BOT_TOKEN", "NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const provider = new Map<string, ProviderPayment>();
  const sent: Array<{ method: string; body: Record<string, unknown> | FormData }> = [];
  let apiCreates = 0;
  let failNextCreate = false;
  let failNextDelivery = false;
  const [existing] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  assert.equal(existing, undefined, "Run before live activation: this test never replaces an existing bot connection.");
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELEGRAM_BOT_TOKEN = "TEST_ONLY_TELEGRAM_TOKEN";
  process.env.NOWPAYMENTS_API_KEY = "TEST_ONLY_NOWPAYMENTS_KEY";
  process.env.NOWPAYMENTS_IPN_SECRET = "TEST_ONLY_NOWPAYMENTS_IPN_SECRET";
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://api.telegram.org/")) {
      const method = target.slice(target.lastIndexOf("/") + 1);
      const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body ?? "{}"));
      if (method === "sendMessage" && failNextDelivery) { failNextDelivery = false; throw new Error("Mock delivery timeout"); }
      sent.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
    }
    if (target.startsWith("https://api.nowpayments.io/v1/min-amount?")) {
      return new Response(JSON.stringify({ fiat_equivalent: 1 }), { status: 200 });
    }
    if (target === "https://api.nowpayments.io/v1/payment" && init?.method === "POST") {
      apiCreates++;
      if (failNextCreate) { failNextCreate = false; throw new Error("Mock creation timeout"); }
      const request = JSON.parse(String(init.body));
      const p: ProviderPayment = {
        payment_id: String(900000 + apiCreates), payment_status: "waiting", order_id: request.order_id,
        price_amount: request.price_amount, price_currency: request.price_currency, pay_currency: request.pay_currency,
        pay_amount: "1.25", actually_paid: "0", pay_address: `TEST_ONLY_ADDRESS_${apiCreates}`,
        network: "LTC", payin_extra_id: null, expiration_estimate_date: new Date(Date.now() + 20 * 60000).toISOString(),
      };
      assert.match(request.ipn_callback_url, /^https:\/\/test-only\.invalid\/api\/nowpayments\/ipn$/);
      provider.set(String(p.payment_id), p);
      return new Response(JSON.stringify(p), { status: 201 });
    }
    if (target.startsWith("https://api.nowpayments.io/v1/payment/")) {
      const id = target.slice(target.lastIndexOf("/") + 1);
      assert.ok(provider.has(id));
      return new Response(JSON.stringify(provider.get(id)), { status: 200 });
    }
    throw new Error("Unexpected network request blocked by test.");
  };
  const makeCustomer = async () => (await db.insert(botCustomers).values({
    id: randomUUID(), ownerId: owner, telegramId: String(Math.floor(Math.random() * 1e12)),
    chatId: "1000000001", username: "TEST_ONLY_BUYER",
  }).returning())[0]!;
  const makeProduct = async (stockCount = 3) => {
    const [product] = await db.insert(shopProducts).values({
      ownerId: owner, name: "TEST_ONLY_PRODUCT", category: "test", priceCents: 1000, status: "active", deliveryFormat: "email:pass",
    }).returning();
    const stocks = await db.insert(shopInventory).values(Array.from({ length: stockCount }, () => {
      const line = `test-${randomUUID()}@example.invalid:TEST_ONLY_PASSWORD`;
      return { ownerId: owner, productId: product!.id, encryptedCredential: encryptCredential(line, owner, product!.id), fingerprint: randomUUID() };
    })).returning();
    return { product: product!, stocks };
  };
  const makePurchase = async (stockCount = 3) => {
    const customer = await makeCustomer();
    const { product, stocks } = await makeProduct(stockCount);
    const input = { ownerId: owner, customerId: customer.id, token: randomUUID(), coin: "ltc", productId: product.id, expectedAmountCents: 1000 };
    // Seed a legacy direct-purchase fixture from a mocked deposit quote.
    // New direct product checkout is forbidden; old invoices must still settle.
    const quote = await createCheckout({ ownerId: owner, customerId: customer.id, token: randomUUID(), coin: "ltc", depositCents: 1000 });
    const [payment] = await db.update(shopPayments).set({
      kind: "purchase", productId: product.id, inventoryId: stocks[0]!.id, productName: product.name,
    }).where(eq(shopPayments.id, quote.id)).returning();
    await db.update(shopInventory).set({ status: "reserved" }).where(eq(shopInventory.id, stocks[0]!.id));
    return { customer, product, stocks, input, payment: payment! };
  };
  const ledgerCount = async (paymentId: string) => (await db.select({ n: sql<number>`count(*)::integer` }).from(walletEntries).where(eq(walletEntries.paymentId, paymentId)))[0]!.n;
  try {
    await db.insert(botConnections).values({ id: "primary", ownerId: owner, botId, botUsername: "TEST_ONLY_BOT", publicUrl: "https://test-only.invalid" });
    await t.test("IPN signature rejects invalid/tampered bodies; decimal and USD parsing are exact", async () => {
      const body = { b: { z: 3, a: 2 }, payment_id: 1, payment_status: "finished" };
      const signature = createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET!).update(JSON.stringify(sortedJson(body))).digest("hex");
      assert.equal(await verifyIpn(body, signature), true);
      assert.equal(await verifyIpn({ ...body, payment_id: 2 }, signature), false);
      assert.equal(await verifyIpn(body, "wrong"), false);
      assert.equal(decimalAtLeast("1.249999999999999999", "1.25"), false);
      assert.equal(decimalAtLeast(1e-8, "0.00000001"), true);
      assert.equal(decimalAtLeast("1.25", "1.250"), true);
      assert.equal(moneyCents("10.01"), 1001);
      assert.throws(() => moneyCents("1.999"));
      assert.throws(() => moneyCents("-10"));
    });
    await t.test("start keyboard uses saved labels; duplicate Telegram updates are ignored", async () => {
      const before = sent.length;
      const update = { update_id: 111, message: { chat: { id: 12345, type: "private" }, from: { id: 12345, username: "TEST_ONLY" }, text: "/start" } };
      await handleTelegramUpdate(update);
      await handleTelegramUpdate(update);
      const messages = sent.slice(before).filter(s => s.method === "sendMessage");
      assert.equal(messages.length, 1);
      const keyboard = (messages[0]!.body as any).reply_markup.keyboard;
      assert.equal(keyboard.length, 2);
      assert.equal(keyboard[0].length, 2);
      assert.match(keyboard[0][0].text, /Products/);
      assert.match(keyboard[1][1].text, /Order History/);
    });
    await t.test("legacy invoice response becomes a PNG QR with amount/network/expiry", async () => {
      const { payment } = await makePurchase();
      const stock = (await db.select().from(shopInventory).where(eq(shopInventory.id, payment.inventoryId!)))[0]!;
      assert.equal(stock.status, "reserved");
      await sendCheckout(payment);
      const photo = sent.at(-1)!;
      assert.equal(photo.method, "sendPhoto");
      const form = photo.body as FormData;
      const png = new Uint8Array(await (form.get("photo") as Blob).arrayBuffer());
      assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.match(String(form.get("caption")), /1.25 LTC/);
      assert.match(String(form.get("caption")), /Litecoin/);
      assert.match(String(form.get("caption")), /TEST_ONLY_ADDRESS_/);
      assert.match(String(form.get("caption")), /Quote expires:/);
      assert.equal(form.get("reply_markup"), null);
    });
    await t.test("all pre-finished statuses withhold credentials; finished consumes only its reserved line once", async () => {
      const { payment, product } = await makePurchase();
      const p = provider.get(payment.providerPaymentId!)!;
      const before = sent.length;
      for (const status of ["waiting", "confirming", "confirmed", "sending", "partially_paid"]) {
        p.payment_status = status; p.actually_paid = "1.25";
        await checkPayment(payment.id);
        assert.equal((await getPayment(payment.id))!.fulfillment, "pending");
        assert.equal(sent.length, before);
      }
      p.payment_status = "finished";
      await Promise.all([applyVerifiedPayment(payment.id, p), applyVerifiedPayment(payment.id, p), applyVerifiedPayment(payment.id, p)]);
      await Promise.all([deliverPayment(payment.id), deliverPayment(payment.id)]);
      await checkPayment(payment.id);
      const stocks = await db.select().from(shopInventory).where(eq(shopInventory.productId, product.id));
      assert.equal(stocks.filter(s => s.status === "delivered").length, 1);
      assert.equal(stocks.filter(s => s.status === "available").length, 2);
      assert.equal(sent.length, before + 1);
      assert.match(String((sent.at(-1)!.body as any).text), /@example\.invalid:TEST_ONLY_PASSWORD/);
      assert.equal((sent.at(-1)!.body as any).protect_content, true);
    });
    await t.test("wrong identity and underpayments never credit or deliver", async () => {
      const { payment } = await makePurchase();
      const p = provider.get(payment.providerPaymentId!)!;
      p.payment_status = "finished"; p.actually_paid = "1.25"; p.order_id = randomUUID();
      await assert.rejects(() => checkPayment(payment.id));
      assert.equal((await getPayment(payment.id))!.fulfillment, "review");
      p.order_id = payment.id; p.actually_paid = "1.2499";
      await checkPayment(payment.id);
      assert.equal((await getPayment(payment.id))!.fulfillment, "review");
      assert.equal((await db.select().from(shopInventory).where(eq(shopInventory.id, payment.inventoryId!)))[0]!.status, "reserved");
    });
    await t.test("deposit credits integer ledger once; wallet double-click debits only once", async () => {
      const customer = await makeCustomer();
      const deposit = await createCheckout({ ownerId: owner, customerId: customer.id, token: randomUUID(), coin: "ltc", depositCents: 2000 });
      const p = provider.get(deposit.providerPaymentId!)!;
      p.payment_status = "confirming"; p.actually_paid = "1.25";
      await checkPayment(deposit.id);
      assert.equal((await db.select().from(botCustomers).where(eq(botCustomers.id, customer.id)))[0]!.balanceCents, 0);
      p.payment_status = "finished";
      await Promise.all([applyVerifiedPayment(deposit.id, p), applyVerifiedPayment(deposit.id, p)]);
      await checkPayment(deposit.id);
      await checkPayment(deposit.id);
      assert.equal(await ledgerCount(deposit.id), 1);
      assert.equal((await db.select().from(botCustomers).where(eq(botCustomers.id, customer.id)))[0]!.balanceCents, 2000);
      const { product } = await makeProduct(2);
      const input = { ownerId: owner, customerId: customer.id, token: randomUUID(), coin: "usd", productId: product.id, wallet: true };
      const [a, b] = await Promise.all([createCheckout(input), createCheckout(input)]);
      assert.equal(a.id, b.id);
      await Promise.all([deliverPayment(a.id), deliverPayment(b.id)]);
      assert.equal(await ledgerCount(a.id), 1);
      assert.equal((await db.select().from(botCustomers).where(eq(botCustomers.id, customer.id)))[0]!.balanceCents, 1000);
    });
    await t.test("simultaneous buyers cannot buy the same last line", async () => {
      const { product } = await makeProduct(1);
      const a = await makeCustomer(); const b = await makeCustomer();
      // Test-only funded customers; no real wallet or provider is touched.
      await db.update(botCustomers).set({ balanceCents: 1000 }).where(inArray(botCustomers.id, [a.id, b.id]));
      const results = await Promise.allSettled([a, b].map(c => createCheckout({ ownerId: owner, customerId: c.id, token: randomUUID(), coin: "usd", wallet: true, productId: product.id, expectedAmountCents: 1000 })));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.filter(r => r.status === "rejected").length, 1);
    });
    await t.test("expired provider invoice releases reservation; late completion cannot steal resold stock", async () => {
      const { payment } = await makePurchase(1);
      const p = provider.get(payment.providerPaymentId!)!;
      p.payment_status = "expired";
      await checkPayment(payment.id);
      assert.equal((await getPayment(payment.id))!.inventoryId, null);
      p.payment_status = "finished"; p.actually_paid = "1.25";
      await checkPayment(payment.id);
      assert.equal((await getPayment(payment.id))!.fulfillment, "review");
    });
    await t.test("ambiguous provider timeout never recreates the same deposit invoice", async () => {
      const customer = await makeCustomer();
      const input = { ownerId: owner, customerId: customer.id, token: randomUUID(), coin: "ltc", depositCents: 1000 };
      failNextCreate = true;
      const before = apiCreates;
      await assert.rejects(() => createCheckout(input));
      const payment = await createCheckout(input);
      assert.equal(apiCreates, before + 1);
      assert.equal(payment.fulfillment, "review");
      assert.equal(payment.inventoryId, null);
    });
    await t.test("failed Telegram delivery retries the assigned credential without allocating again", async () => {
      const { payment } = await makePurchase(1);
      const p = provider.get(payment.providerPaymentId!)!;
      p.payment_status = "finished"; p.actually_paid = "1.25";
      failNextDelivery = true;
      await assert.rejects(() => checkPayment(payment.id));
      assert.equal((await getPayment(payment.id))!.fulfillment, "allocated");
      await checkPayment(payment.id);
      assert.equal((await getPayment(payment.id))!.fulfillment, "delivered");
      assert.equal((await getPayment(payment.id))!.inventoryId, payment.inventoryId);
    });
  } finally {
    globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    const customerIds = db.select({ id: botCustomers.id }).from(botCustomers).where(eq(botCustomers.ownerId, owner));
    await db.delete(walletEntries).where(sql`${walletEntries.customerId} in (${customerIds})`);
    await db.delete(shopPayments).where(eq(shopPayments.ownerId, owner));
    await db.delete(shopInventory).where(eq(shopInventory.ownerId, owner));
    await db.delete(shopProducts).where(eq(shopProducts.ownerId, owner));
    await db.delete(botCustomers).where(eq(botCustomers.ownerId, owner));
    await db.delete(botConnections).where(and(eq(botConnections.id, "primary"), eq(botConnections.ownerId, owner)));
    await db.delete(botUpdates).where(sql`${botUpdates.id} like ${`${botId}:%`}`);
    await db.delete(shopActivity).where(eq(shopActivity.ownerId, owner));
    await db.delete(shopSettings).where(eq(shopSettings.ownerId, owner));
    await pool.end();
  }
});
