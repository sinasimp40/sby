import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { processCustomerPromotions } from "../src/lib/customer-promotions-worker";
import { customerPromotionStatus, saveCustomerPromotionSettings, setPromotedProductFlags, setCustomerPromotionPreference, eligiblePromotionProducts } from "../src/lib/customer-promotions-store";
import { TelegramRequestError } from "../src/lib/commerce-providers";
import { encryptCredential, credentialFingerprint } from "../src/lib/inventory-encryption";
import { customerPromotionCard } from "../src/lib/customer-promotion-card";
import { newStockAnnouncement } from "../src/lib/product-announcements";
import { exportShopTransfer, importShopTransfer, previewShopTransfer } from "../src/lib/shop-transfer";
import { decodeShopArchive } from "../src/lib/shop-transfer-archive";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";
import app from "../src/app";
import { once } from "node:events";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";
import { handleTelegramUpdate } from "../src/lib/telegram-shop";
import { settingsForOwner } from "../src/lib/shop-store";

async function fixture(owner = `TEST_ONLY_PROMOTIONS_${randomUUID()}`, customers = 3) {
  let clock = new Date(Date.now() + 600000);
  const ids: string[] = [], products: number[] = [];
  await pool.query(`INSERT INTO bot_connections(id,owner_id,bot_id,bot_username,public_url,active)
    VALUES('primary',$1,'900000001','TEST_ONLY_BOT','','yes') ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,active='yes'`, [owner]);
  await pool.query("INSERT INTO bot_runtime_settings(owner_id,enabled) VALUES($1,1) ON CONFLICT(owner_id) DO UPDATE SET enabled=1", [owner]);
  for (let i = 0; i < customers; i++) {
    const id = `${owner}-customer-${i}`;
    ids.push(id);
    await pool.query("INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username) VALUES($1,$2,$1,$3,'TEST_ONLY')", [id, owner, `TEST_ONLY_CHAT_${i}`]);
  }
  const group = randomUUID();
  for (const [i, option] of ["15–20k points", "20–40k points"].entries()) {
    const product = (await pool.query(`INSERT INTO shop_products(owner_id,name,category,description,price_cents,delivery_format,status,
      group_id,group_name,group_description,option_name,image_url)
      VALUES($1,$2,'',$3,$4,'user:pass','active',$5,'Southwest','TEST_ONLY common terms',$3,'https://example.com/card.gif') RETURNING id`,
    [owner, `Southwest — ${option}`, option, 500 + i * 100, group])).rows[0].id as number;
    products.push(product);
    const plain = `TEST_ONLY stock ${product}`;
    await pool.query("INSERT INTO shop_inventory(owner_id,product_id,encrypted_credential,fingerprint) VALUES($1,$2,$3,$4)",
      [owner, product, encryptCredential(plain, owner, product), credentialFingerprint(plain, owner, product)]);
  }
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  const send = async (method: string, body: Record<string, unknown>) => { sent.push({ method, body }); return { message_id: sent.length }; };
  const step = async (custom = send) => { await processCustomerPromotions(owner, { now: () => clock, random: () => 0, send: custom }); };
  const advance = (ms = 1001) => { clock = new Date(clock.getTime() + ms); };
  const enable = async () => { await setPromotedProductFlags(owner, { productIds: products, enabled: true }); await saveCustomerPromotionSettings(owner, { enabled: true, intervalMinutes: 1 }, clock); advance(60001); };
  return { owner, ids, products, sent, send, step, advance, enable, now: () => clock };
}
test("customer promotions stay safe across scheduling, recipient changes and interrupted sends", async t => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No real Telegram or provider requests are permitted."); };
  try {
    await t.test("defaults are off; grouped cards use each real option without stock-event labels", async () => {
      const f = await fixture();
      assert.equal((await customerPromotionStatus(f.owner)).enabled, false);
      await f.step(); assert.equal(f.sent.length, 0);
      await f.enable();
      for (let i = 0; i < 4; i++) { await f.step(); f.advance(); }
      assert.equal(f.sent.length, 3);
      for (const message of f.sent) {
        assert.equal(message.method, "sendAnimation");
        assert.equal(message.body.animation, "https://example.com/card.gif");
        assert.match(String(message.body.caption), /Southwest — 15–20k points/);
        assert.match(String(message.body.caption), /\$5\.00/);
        assert.match(String(message.body.caption), /1 in stock/);
        assert.doesNotMatch(String(message.body.caption), /NEW PRODUCT|ADDED STOCK|just added/i);
        assert.equal((message.body.reply_markup as any).inline_keyboard[0][0].callback_data, `buy:${f.products[0]}`);
        assert.equal((message.body.reply_markup as any).inline_keyboard[1][0].callback_data, "promotions:off");
      }
      assert.equal((await pool.query("SELECT stock_announced_at FROM shop_products WHERE id=$1", [f.products[0]])).rows[0].stock_announced_at, null);
      f.advance(60001); await f.step();
      const second = f.sent[3];
      assert.match(String(second.body.caption), /Southwest — 20–40k points/);
      assert.match(String(second.body.caption), /\$6\.00/);
      assert.equal((second.body.reply_markup as any).inline_keyboard[0][0].callback_data, `buy:${f.products[1]}`);
      const item = { id: 1, name: "TEST_ONLY", description: "", priceCents: 100, buttonEmoji: "", status: "active", stock: 1 };
      assert.match(newStockAnnouncement(item, 1, true).text, /NEW PRODUCT/);
      assert.match(newStockAnnouncement(item, 1, false).text, /ADDED STOCK/);
      assert.doesNotMatch(customerPromotionCard({ ...item, groupDescription: null, imageUrl: null, buttonCustomEmojiId: null }).body, /just added/);
    });
    await t.test("group flags are atomic and disabled, draft, archived or sold-out options are skipped live", async () => {
      const f = await fixture();
      await assert.rejects(setPromotedProductFlags(f.owner, { productIds: [f.products[0], 9999999], enabled: true }));
      assert.equal((await customerPromotionStatus(f.owner)).products.length, 0);
      await f.enable();
      await f.step();
      await setPromotedProductFlags(f.owner, { productIds: [f.products[0]], enabled: false });
      f.advance(); await f.step();
      assert.equal(f.sent.length, 1, "disable during a round must stop the remaining recipients");
      assert.equal((await customerPromotionStatus(f.owner)).rounds[0].status, "stopped");
      await pool.query("UPDATE shop_products SET status='archived' WHERE id=$1", [f.products[1]]);
      f.advance(60001); await f.step(); assert.equal(f.sent.length, 1);
      assert.match((await customerPromotionStatus(f.owner)).info, /No eligible/);
      await pool.query("UPDATE shop_products SET status='draft' WHERE id=$1", [f.products[1]]);
      f.advance(60001); await f.step(); assert.equal(f.sent.length, 1);
      await pool.query("UPDATE shop_products SET status='active' WHERE id=$1", [f.products[1]]);
      await pool.query("DELETE FROM shop_inventory WHERE product_id=$1", [f.products[1]]);
      f.advance(60001); await f.step(); assert.equal(f.sent.length, 1);
      assert.equal((await pool.query("SELECT count(*) AS n FROM shop_products WHERE owner_id=$1", [f.owner])).rows[0].n, 2);
    });
    await t.test("archiving, removal and selling out stop an already-running round", async () => {
      for (const change of [
        "UPDATE shop_products SET status='archived' WHERE id=$1",
        "DELETE FROM shop_products WHERE id=$1",
        "UPDATE shop_inventory SET status='delivered' WHERE product_id=$1",
      ]) {
        const f = await fixture(); await f.enable(); await f.step();
        await pool.query(change, [f.products[0]]);
        f.advance(); await f.step();
        assert.equal(f.sent.length, 1);
        assert.equal((await customerPromotionStatus(f.owner)).rounds[0].status, "stopped");
      }
    });
    await t.test("opt-outs, unreachable chats, owner binding, runtime and maintenance are respected", async () => {
      const f = await fixture();
      await f.enable();
      await setCustomerPromotionPreference(f.owner, f.ids[2], true);
      await f.step(async () => { throw new TelegramRequestError("sendAnimation", 403, "chat_unavailable"); });
      assert.equal(Boolean((await pool.query("SELECT blocked FROM customer_promotion_preferences WHERE customer_id=$1", [f.ids[0]])).rows[0].blocked), true);
      f.advance(); await f.step(); assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].body.chat_id, "TEST_ONLY_CHAT_1");
      f.advance(); await f.step(); assert.equal(f.sent.length, 1);
      assert.equal((await customerPromotionStatus(f.owner)).recipientCount, 1);
      await setCustomerPromotionPreference(f.owner, f.ids[2], false);
      assert.equal((await customerPromotionStatus(f.owner)).recipientCount, 2);
      await pool.query("UPDATE bot_runtime_settings SET enabled=0 WHERE owner_id=$1", [f.owner]);
      f.advance(60001); await f.step(); assert.equal(f.sent.length, 1);
      await pool.query("UPDATE bot_runtime_settings SET enabled=1 WHERE owner_id=$1", [f.owner]);
      await pool.query("INSERT INTO shop_settings(owner_id,preferences) VALUES($1,$2)", [f.owner, JSON.stringify({ maintenanceMode: true })]);
      await f.step(); assert.equal(f.sent.length, 1);
      await pool.query("DELETE FROM shop_settings WHERE owner_id=$1", [f.owner]);
      await pool.query("UPDATE bot_connections SET owner_id='TEST_ONLY_FOREIGN' WHERE id='primary'");
      await f.step(); assert.equal(f.sent.length, 1);
    });
    await t.test("overlap and restart recovery never resubmit a potentially sent delivery", async () => {
      const f = await fixture();
      await f.enable();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const called = new Promise<void>(resolve => { entered = resolve; });
      let attempts = 0;
      const first = f.step(async () => { attempts++; entered(); await gate; return { message_id: 100 }; });
      await called;
      await f.step(async () => { attempts++; return { message_id: 101 }; });
      assert.equal(attempts, 1, "a concurrent worker cannot claim the same active owner");
      f.advance(61001);
      await f.step(); assert.equal(f.sent.length, 1);
      release(); await first;
      assert.equal(attempts, 1);
      const entries = (await pool.query("SELECT customer_id,status FROM customer_promotion_deliveries WHERE owner_id=$1 ORDER BY customer_id", [f.owner])).rows;
      assert.deepEqual(entries.map(row => row.status), ["unknown", "sent"]);
      assert.equal(new Set(entries.map(row => row.customer_id)).size, 2);
    });
    await t.test("rate-limit retries use a persisted shared cooldown; network failures are not retried", async () => {
      const f = await fixture(undefined, 1);
      await f.enable(); let attempts = 0;
      const rateLimited = async () => { attempts++; throw new TelegramRequestError("sendAnimation", 429, "provider_error", 7); };
      await f.step(rateLimited);
      f.advance(6999); await f.step(rateLimited); assert.equal(attempts, 1);
      f.advance(2); await f.step(rateLimited); assert.equal(attempts, 2);
      f.advance(7001); await f.step(rateLimited); assert.equal(attempts, 3);
      assert.equal((await customerPromotionStatus(f.owner)).rounds[0].failed, 1);
      f.advance(7001); await f.step(); f.advance(60001);
      await f.step(async () => { attempts++; throw new TelegramRequestError("sendAnimation", 0); });
      assert.equal((await customerPromotionStatus(f.owner)).rounds[0].uncertain, 1);
      f.advance(60001); await f.step();
      assert.equal(attempts, 4); assert.equal(f.sent.length, 0);
    });
    await t.test("pause and interval edits apply without catch-up bursts or resuming stopped rounds", async () => {
      const f = await fixture(); await f.enable();
      await f.step(async (method, body) => {
        await saveCustomerPromotionSettings(f.owner, { enabled: false, intervalMinutes: 2 }, f.now());
        return f.send(method, body);
      });
      f.advance(1000000); await f.step(); assert.equal(f.sent.length, 1);
      const status = await customerPromotionStatus(f.owner);
      assert.equal(status.enabled, false); assert.equal(status.rounds[0].status, "stopped");
      await saveCustomerPromotionSettings(f.owner, { enabled: true, intervalMinutes: 2 }, f.now());
      f.advance(60001); await f.step(); assert.equal(f.sent.length, 1);
      await saveCustomerPromotionSettings(f.owner, { enabled: true, intervalMinutes: 3 }, f.now());
      f.advance(179999); await f.step(); assert.equal(f.sent.length, 1);
      f.advance(2); await f.step(); assert.equal(f.sent.length, 2);
      f.advance(10 * 86400000); await f.step(); assert.equal(f.sent.length, 3, "a long downtime resumes at most one bounded delivery");
    });
    await t.test("portable transfers preserve flags/preferences/history but stop all imported sending", async () => {
      const f = await fixture(); await f.enable();
      await setCustomerPromotionPreference(f.owner, f.ids[2], true);
      await f.step(async () => { throw new TelegramRequestError("sendAnimation", 0); });
      const archive = await exportShopTransfer(f.owner);
      const data = decodeShopArchive(archive.zip).data;
      validateShopRelationships(data, f.owner);
      assert.equal(data.promotionProducts.length, 2);
      assert.equal(data.promotionDeliveries[0].status, "unknown");
      const destination = `TEST_ONLY_PROMO_IMPORT_${randomUUID()}`;
      // Empty receiving installation, avoiding global-ID collisions in one test DB.
      for (const table of ["customer_promotion_deliveries", "customer_promotion_rounds", "customer_promotion_preferences", "customer_promotion_products", "customer_promotion_settings",
        "shop_inventory", "shop_products", "bot_customers", "bot_runtime_settings"])
        await pool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [f.owner]);
      await pool.query("DELETE FROM bot_connections WHERE owner_id=$1", [f.owner]);
      const preview = await previewShopTransfer(destination, archive.zip);
      assert.equal(preview.canImport, true);
      await importShopTransfer(destination, archive.zip, preview.confirmationToken);
      const imported = decodeShopArchive((await exportShopTransfer(destination)).zip).data;
      assert.equal(imported.promotionSettings[0].enabled, false);
      assert.equal(imported.promotionSettings[0].activeRoundId, null);
      assert.equal(imported.promotionSettings[0].leaseToken, null);
      assert.equal(imported.promotionRounds[0].status, "stopped");
      assert.equal(imported.promotionDeliveries[0].status, "unknown");
      assert.equal(imported.promotionPreferences[0].optedOut, true);
      assert.equal(imported.promotionProducts.length, 2);
      assert.equal((await customerPromotionStatus(destination)).enabled, false);
    });
    await t.test("unsubscribe works during maintenance without clearing orders; promotional Buy selects the right option", async () => {
      const f = await fixture();
      await setPromotedProductFlags(f.owner, { productIds: f.products, enabled: true });
      const pending = { type: "purchase-quantity", productId: f.products[0], token: randomUUID() };
      await pool.query("UPDATE bot_customers SET telegram_id='900001',chat_id='900001',state=$1 WHERE id=$2", [JSON.stringify(pending), f.ids[0]]);
      const connection = { id: "primary", ownerId: f.owner, botId: "900000001", botUsername: "TEST_ONLY_BOT", publicUrl: "", active: "yes", verifiedAt: new Date() };
      let maintenance = true;
      const notices: string[] = [];
      const services = {
        activeConnection: async () => connection,
        getBotRuntime: async () => ({ enabled: true, transport: "polling" as const, publicUrl: "" }),
        settingsForOwner: async () => ({ ...await settingsForOwner(f.owner), maintenanceMode: maintenance }),
        telegram: async <T>(_method: string, body: Record<string, unknown> = {}) => { if (body.text) notices.push(String(body.text)); return { message_id: 5 } as T; },
      };
      const message = { message_id: 1, chat: { id: 900001, type: "private" }, from: { id: 900001, first_name: "TEST_ONLY" } };
      await handleTelegramUpdate({ update_id: 1001, message: { ...message, text: "/promotions_off" } }, services);
      assert.equal(Boolean((await pool.query("SELECT opted_out FROM customer_promotion_preferences WHERE customer_id=$1", [f.ids[0]])).rows[0].opted_out), true);
      assert.deepEqual((await pool.query("SELECT state FROM bot_customers WHERE id=$1", [f.ids[0]])).rows[0].state, pending);
      await handleTelegramUpdate({ update_id: 1002, message: { ...message, text: "/promotions_on" } }, services);
      assert.equal(Boolean((await pool.query("SELECT opted_out FROM customer_promotion_preferences WHERE customer_id=$1", [f.ids[0]])).rows[0].opted_out), false);
      assert.ok(notices.some(text => text.includes("ordering and support are unchanged")));
      maintenance = false;
      const product = (await eligiblePromotionProducts(pool, f.owner)).find(p => p.id === f.products[1])!;
      const callback = customerPromotionCard(product).reply_markup.inline_keyboard[0][0].callback_data;
      const denyNetwork = globalThis.fetch;
      const telegramBodies: Record<string, unknown>[] = [];
      globalThis.fetch = async (input, init) => {
        assert.match(String(input), /^https:\/\/api\.telegram\.org\/botTEST_ONLY_TELEGRAM_TOKEN\//);
        telegramBodies.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
      };
      try {
        await handleTelegramUpdate({ update_id: 1003, callback_query: { id: "TEST_ONLY", from: message.from, message, data: callback } }, services);
      } finally { globalThis.fetch = denyNetwork; }
      const state = (await pool.query("SELECT state FROM bot_customers WHERE id=$1", [f.ids[0]])).rows[0].state;
      assert.equal(state.type, "purchase-quantity"); assert.equal(state.productId, f.products[1]);
      assert.ok(telegramBodies.some(body => String(body.caption).includes("20–40k points") && String(body.caption).includes("$6.00")));
    });
    await t.test("authenticated API enforces scope and validates one atomic bulk flag request", async () => {
      const f = await fixture(process.env.TELECART_OWNER_ID);
      process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
      process.env.TELECART_ADMIN_INITIAL_PASSWORD = "TEST_ONLY_PASSWORD";
      const token = await issueAdminSession();
      const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/api/shop/customer-promotions`;
      const headers = { Cookie: `${adminCookieName()}=${token}`, Origin: "https://test-only.invalid", "Content-Type": "application/json" };
      try {
        assert.equal((await realFetch(url)).status, 401);
        assert.equal((await realFetch(url, { headers })).status, 200);
        assert.equal((await realFetch(url, { method: "PUT", headers, body: JSON.stringify({ enabled: true, intervalMinutes: 1.5 }) })).status, 400);
        assert.equal((await realFetch(`${url}/products`, { method: "POST", headers, body: JSON.stringify({ productIds: [f.products[0], 999999], enabled: true }) })).status, 404);
        assert.equal((await customerPromotionStatus(f.owner)).products.length, 0);
        const response = await realFetch(`${url}/products`, { method: "POST", headers, body: JSON.stringify({ productIds: f.products, enabled: true }) });
        assert.equal(response.status, 200);
        const saved = await response.json();
        assert.equal(saved.products.length, 2); assert.equal(saved.enabled, false);
      } finally { server.closeAllConnections(); server.close(); }
    });
  } finally { globalThis.fetch = realFetch; await pool.end(); }
});
