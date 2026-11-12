import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import { pool } from "@workspace/db";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";
import { allocateCheckout } from "../src/lib/checkout-allocation";
import { assignedInventoryIds } from "../src/lib/payment-inventory";
import { productCatalogMenu, productOptionsMenu } from "../src/lib/telegram-catalog";
import { quantityPrompt } from "../src/lib/purchase-copy";
import { cleanTransferFixture } from "./helpers/shop-transfer-fixture";

test("grouped options preserve existing stock IDs and independently allocate the selected option", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `transfer-test-options-${randomUUID()}`, other = `${owner}-other`;
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = `TEST_ONLY-${randomUUID()}`;
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELECART_PUBLIC_URL = process.env.TELECART_ADMIN_ORIGIN = "https://test-only.invalid";
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop`;
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const request = (path: string, method = "GET", body?: object, auth = cookie) => fetch(base + path, {
    method, headers: { cookie: auth, origin: "https://test-only.invalid", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const input = { name: "TEST_ONLY Replit", description: "Basic details", price: 1.25, status: "active", deliveryFormat: "email:pass" };
  const option = (name: string, price: number, id?: number) => ({
    name, price, ...(id === undefined ? {} : { id }), description: `${name} features`,
    status: "active" as const, deliveryFormat: "email:pass" as const,
  });
  const settings = { minDeposit: 5, rateMode: "floating" as const };
  try {
    assert.equal((await request("/product-groups", "POST", {}, "")).status, 401);
    const standalone = await (await request("/products", "POST", input)).json();
    assert.ok(standalone.id);
    await request(`/products/${standalone.id}/inventory`, "POST", { entries: "TEST_ONLY-basic1:password\nTEST_ONLY-basic2:password" });
    const stockBefore = (await pool.query("SELECT id,product_id,encrypted_credential,fingerprint FROM shop_inventory WHERE owner_id=$1 ORDER BY id", [owner])).rows;
    const body = { name: "TEST_ONLY Replit", description: "Common product details", buttonEmoji: "", imageUrl: null,
      options: [option("Basic", 1.25, standalone.id), option("Plus", 2.5), option("Pro", 5)] };
    const createdResponse = await request("/product-groups", "POST", body);
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    let group = await createdResponse.json();
    const basic = group.options.find((p: { optionName: string }) => p.optionName === "Basic");
    const plus = group.options.find((p: { optionName: string }) => p.optionName === "Plus");
    const pro = group.options.find((p: { optionName: string }) => p.optionName === "Pro");
    assert.equal(basic.id, standalone.id);
    assert.equal(basic.stock, 2);
    assert.equal(plus.stock, 0);
    assert.equal(pro.stock, 0);
    assert.deepEqual((await pool.query("SELECT id,product_id,encrypted_credential,fingerprint FROM shop_inventory WHERE owner_id=$1 ORDER BY id", [owner])).rows, stockBefore);
    await t.test("one parent entry leads to available leaf options with independent descriptions and prices", async () => {
      assert.equal((await (await request("/product-groups")).json()).length, 1);
      const catalog = productCatalogMenu(group.options);
      const root = catalog.reply_markup.inline_keyboard[0]![0]!;
      assert.equal(root.callback_data, `group:${group.id}`);
      assert.equal(root.text, "TEST_ONLY Replit · $1.25");
      const choice = productOptionsMenu(group.options, group.id)!;
      assert.match(choice.body, /Common product details/);
      assert.equal(choice.reply_markup.inline_keyboard[0]![0]!.text, "Basic · $1.25");
      assert.equal(choice.reply_markup.inline_keyboard[0]![0]!.callback_data, `buy:${basic.id}`);
      assert.equal(choice.reply_markup.inline_keyboard.length, 2); // Basic + navigation; no sold-out options.
      assert.match(quantityPrompt(basic, 1000), /Common product details/);
      assert.match(quantityPrompt(basic, 1000), /Basic features/);
    });
    await request(`/products/${plus.id}/inventory`, "POST", { entries: "TEST_ONLY-plus1:password\nTEST_ONLY-plus2:password\nTEST_ONLY-plus3:password" });
    group = (await (await request("/product-groups")).json())[0];
    await t.test("wallet checkout allocates only selected-option inventory and keeps other stock untouched", async () => {
      const customerId = randomUUID();
      await pool.query("INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username,balance_cents) VALUES($1,$2,$1,'TEST_ONLY','TEST_ONLY customer',10000)", [customerId, owner]);
      const purchase = { ownerId: owner, customerId, productId: plus.id, token: randomUUID(), coin: "usd", wallet: true, quantity: 2, expectedAmountCents: 250 };
      const allocated = await allocateCheckout(purchase, settings);
      assert.equal(allocated.payment.amountCents, 500);
      assert.equal(allocated.payment.productName, "TEST_ONLY Replit — Plus × 2");
      const ids = assignedInventoryIds(allocated.payment);
      assert.equal(ids.length, 2);
      const assigned = (await pool.query("SELECT product_id FROM shop_inventory WHERE id=ANY($1::integer[])", [ids])).rows;
      assert.ok(assigned.every(row => row.product_id === plus.id));
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM shop_inventory WHERE product_id=$1 AND status='available'", [basic.id])).rows[0].n, 2);
      assert.equal((await pool.query("SELECT balance_cents FROM bot_customers WHERE id=$1", [customerId])).rows[0].balance_cents, 9500);
      assert.equal((await allocateCheckout(purchase, settings)).payment.id, allocated.payment.id);
      await assert.rejects(allocateCheckout({ ...purchase, productId: pro.id, token: randomUUID(), expectedAmountCents: 500 }, settings), /stock|available/i);
      assert.equal((await pool.query("SELECT balance_cents FROM bot_customers WHERE id=$1", [customerId])).rows[0].balance_cents, 9500);
      assert.equal((await request(`/product-groups/${group.id}`, "DELETE")).status, 409);
    });
    await t.test("edits preserve option IDs and prevent silent option loss or cross-owner changes", async () => {
      const update = { ...body, name: "TEST_ONLY Replit updated",
        options: [option("Basic", 2, basic.id), option("Plus", 2.5, plus.id), option("Pro", 5, pro.id)] };
      const edited = await request(`/product-groups/${group.id}`, "PATCH", update);
      assert.equal(edited.status, 200, await edited.clone().text());
      group = await edited.json();
      assert.deepEqual(group.options.map((p: { id: number }) => p.id), [basic.id, plus.id, pro.id]);
      assert.equal(group.options[0].stock, 2);
      assert.equal(group.options[1].stock, 1);
      assert.equal(group.options[0].price, 2);
      assert.equal((await request(`/product-groups/${group.id}`, "PATCH", { ...update, options: update.options.slice(0, 2) })).status, 409);
      assert.equal((await request(`/products/${basic.id}`, "PATCH", input)).status, 409);
      assert.equal((await request(`/products/${basic.id}`, "DELETE")).status, 409);
      assert.equal((await request("/product-groups", "POST", { ...body, options: [option("Same", 1), option("same", 2)] })).status, 400);
      process.env.TELECART_OWNER_ID = other;
      const otherCookie = `${adminCookieName()}=${await issueAdminSession()}`;
      assert.equal((await request(`/product-groups/${group.id}`, "PATCH", update, otherCookie)).status, 404);
      assert.equal((await request(`/product-groups/${group.id}`, "DELETE", undefined, otherCookie)).status, 404);
      process.env.TELECART_OWNER_ID = owner;
    });
    await t.test("fresh grouped products can be deleted with their unsold stock without touching other groups", async () => {
      const disposable = await (await request("/product-groups", "POST", { ...body, name: "TEST_ONLY disposable", options: [option("One", 1), option("Two", 2)] })).json();
      await request(`/products/${disposable.options[0].id}/inventory`, "POST", { entries: "TEST_ONLY-disposable:password" });
      assert.equal((await request(`/product-groups/${disposable.id}`, "DELETE")).status, 204);
      assert.equal((await (await request("/product-groups")).json()).length, 1);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM shop_inventory WHERE product_id=$1", [basic.id])).rows[0].n, 2);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanTransferFixture(owner); await cleanTransferFixture(other);
    await pool.query("DELETE FROM admin_sessions WHERE owner_id=ANY($1::text[])", [[owner, other]]);
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await pool.end();
  }
});
