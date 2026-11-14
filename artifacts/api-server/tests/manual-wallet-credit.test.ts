import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { pool, sqlitePath } from "@workspace/db";
import app from "../src/app";
import { adminCookieName, issueAdminSession } from "../src/lib/admin-auth";
import { addManualWalletCredit, manualWalletCreditHistory } from "../src/lib/manual-wallet-credit";
import { allocateCheckout } from "../src/lib/checkout-allocation";
import { applyVerifiedPayment } from "../src/lib/commerce-payments";
import { encryptCredential, credentialFingerprint } from "../src/lib/inventory-encryption";
import { exportShopTransfer, importShopTransfer, previewShopTransfer } from "../src/lib/shop-transfer";
import { decodeShopArchive } from "../src/lib/shop-transfer-archive";

test("manual credits are private, atomic, idempotent, spendable and portable", async t => {
  process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = "TEST_ONLY_PASSWORD";
  const owner = process.env.TELECART_OWNER_ID!;
  const token = await issueAdminSession();
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/shop`;
  const network = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Real provider/Telegram calls are forbidden in credit tests."); };
  const headers = { "Content-Type": "application/json", Origin: "https://test-only.invalid", Cookie: `${adminCookieName()}=${token}` };
  const seed = async (tenant = owner, cents = 0) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username,balance_cents)
      VALUES($1,$2,$1,'TEST_ONLY_CHAT','TEST_ONLY customer',$3)`, [id, tenant, cents]);
    return id;
  };
  const customer = await seed();
  const foreign = await seed("TEST_ONLY_OTHER_OWNER");
  const makeInput = (amountCents = 1250) => ({ amountCents, reason: "TEST_ONLY support credit", requestKey: randomUUID() });
  const post = (id: string, input: unknown, override = headers) => network(`${base}/customers/${id}/credits`, {
    method: "POST", headers: override, body: JSON.stringify(input),
  });
  const balance = async (id = customer) => (await pool.query("SELECT balance_cents FROM bot_customers WHERE id=$1", [id])).rows[0].balance_cents as number;
  try {
    await t.test("authentication, ownership, origin and exact positive cents are enforced", async () => {
      assert.equal((await post(customer, makeInput(), { ...headers, Cookie: "" })).status, 401);
      assert.equal((await post(customer, makeInput(), { ...headers, Origin: "https://foreign.invalid" })).status, 403);
      assert.equal((await network(`${base}/customers/${customer}/credits`)).status, 401);
      for (const id of [foreign, randomUUID()]) {
        assert.equal((await post(id, makeInput())).status, 404);
        assert.equal((await network(`${base}/customers/${id}/credits`, { headers })).status, 404);
      }
      for (const amountCents of [0, -1, 1.5, 2_000_000_001, "100", null]) {
        assert.equal((await post(customer, { ...makeInput(), amountCents })).status, 400);
      }
      for (const reason of ["", " \n\t", "x".repeat(501)]) assert.equal((await post(customer, { ...makeInput(), reason })).status, 400);
      assert.equal((await post(customer, { ...makeInput(), requestKey: "invalid" })).status, 400);
      assert.equal(await balance(), 0);
      assert.equal((await pool.query("SELECT 1 FROM manual_wallet_credits")).rowCount, 0);
    });
    await t.test("one credit changes the wallet and audit exactly once, including concurrent retries", async () => {
      const input = makeInput();
      const responses = await Promise.all(Array.from({ length: 6 }, () => post(customer, input)));
      const results = await Promise.all(responses.map(async response => { assert.equal(response.status, 200); return response.json(); }));
      assert.equal(results.filter(result => !result.replayed).length, 1);
      assert.equal(new Set(results.map(result => result.credit.id)).size, 1);
      assert.equal(await balance(), 1250);
      assert.equal((await pool.query("SELECT 1 FROM manual_wallet_credits")).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM shop_activity WHERE type='wallet'")).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM shop_payments")).rowCount, 0, "manual credit must not fabricate paid invoices");
      const credit = results[0].credit;
      assert.equal(credit.actorId, owner);
      assert.equal(credit.balanceBeforeCents, 0);
      assert.equal(credit.balanceAfterCents, 1250);
      assert.equal(credit.reason, input.reason);
      for (const change of [{ amountCents: 1251 }, { reason: "Different reason" }]) {
        assert.equal((await post(customer, { ...input, ...change })).status, 409);
      }
      const other = await seed();
      assert.equal((await post(other, input)).status, 409, "a retry key cannot silently credit another customer");
      assert.equal(await balance(other), 0);
      assert.equal((await post(customer, { ...input, reason: ` ${input.reason} ` })).status, 200);
      assert.equal(await balance(), 1250);
    });
    await t.test("a failed audit write rolls back both the ledger and balance", async () => {
      await pool.query(`CREATE TRIGGER TEST_ONLY_credit_rollback BEFORE INSERT ON shop_activity
        WHEN NEW.type='wallet' BEGIN SELECT RAISE(ABORT,'TEST_ONLY failure'); END`);
      const input = makeInput(10);
      try { await assert.rejects(addManualWalletCredit(owner, customer, input)); }
      finally { await pool.query("DROP TRIGGER TEST_ONLY_credit_rollback"); }
      assert.equal(await balance(), 1250);
      assert.equal((await pool.query("SELECT 1 FROM manual_wallet_credits WHERE request_key=$1", [input.requestKey])).rowCount, 0);
      await addManualWalletCredit(owner, customer, input);
      assert.equal(await balance(), 1260, "the same operation may be retried safely after rollback");
    });
    await t.test("credits serialize with verified deposits and real wallet purchase allocation", async () => {
      const id = await seed();
      const product = (await pool.query(`INSERT INTO shop_products(owner_id,name,category,price_cents,delivery_format,status)
        VALUES($1,'TEST_ONLY product','',250,'user:pass','active') RETURNING id`, [owner])).rows[0].id as number;
      const plain = "TEST_ONLY stock line";
      await pool.query(`INSERT INTO shop_inventory(owner_id,product_id,encrypted_credential,fingerprint,status)
        VALUES($1,$2,$3,$4,'available')`, [owner, product, encryptCredential(plain, owner, product), credentialFingerprint(plain, owner, product)]);
      const paymentId = randomUUID();
      await pool.query(`INSERT INTO shop_payments(id,owner_id,customer_id,request_key,kind,amount_cents,coin,provider_payment_id,address,pay_amount,status)
        VALUES($1,$2,$3,$1,'deposit',500,'ltc','TEST_ONLY_PROVIDER','TEST_ONLY_ADDRESS','1','waiting')`, [paymentId, owner, id]);
      const provider = { payment_id: "TEST_ONLY_PROVIDER", order_id: paymentId, price_currency: "usd", price_amount: 5,
        pay_currency: "ltc", pay_address: "TEST_ONLY_ADDRESS", pay_amount: "1", actually_paid: "1", payment_status: "finished" };
      await Promise.all([addManualWalletCredit(owner, id, makeInput(500)), applyVerifiedPayment(paymentId, provider)]);
      assert.equal(await balance(id), 1000);
      const purchase = allocateCheckout({ ownerId: owner, customerId: id, productId: product, wallet: true, token: randomUUID(), coin: "usd" }, { minDeposit: 1, rateMode: "fixed" });
      await Promise.all([purchase, addManualWalletCredit(owner, id, makeInput(75)), addManualWalletCredit(owner, id, makeInput(25))]);
      assert.equal(await balance(id), 850);
      assert.equal((await purchase).payment.kind, "wallet");
      assert.equal((await pool.query("SELECT status FROM shop_inventory WHERE product_id=$1", [product])).rows[0].status, "delivered");
      assert.deepEqual((await pool.query("SELECT amount_cents FROM wallet_entries WHERE customer_id=$1 ORDER BY amount_cents", [id])).rows.map(row => row.amount_cents), [-250, 500]);
    });
    await t.test("balance limits and imported-shop holds are atomic", async () => {
      const capped = await seed(owner, 1_999_999_999);
      assert.equal((await post(capped, makeInput(2))).status, 409);
      assert.equal(await balance(capped), 1_999_999_999);
      assert.equal((await post(capped, makeInput(1))).status, 200);
      assert.equal(await balance(capped), 2_000_000_000);
      await pool.query("INSERT INTO bot_runtime_settings(owner_id,transfer_review_required) VALUES($1,true)", [owner]);
      assert.equal((await post(customer, makeInput(1))).status, 503);
      assert.equal(await balance(), 1260);
      await pool.query("DELETE FROM bot_runtime_settings WHERE owner_id=$1", [owner]);
    });
    await t.test("history paginates with owner-scoped cursors and stable ordering", async () => {
      const id = await seed();
      for (let i = 0; i < 53; i++) await addManualWalletCredit(owner, id, makeInput(1));
      const first = await manualWalletCreditHistory(owner, id);
      assert.equal(first.entries.length, 50);
      assert.ok(first.nextCursor);
      const second = await manualWalletCreditHistory(owner, id, first.nextCursor!);
      assert.equal(second.entries.length, 3);
      assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, 53);
      assert.equal(first.balanceCents, 53);
      await assert.rejects(manualWalletCreditHistory(owner, customer, first.nextCursor!), error => (error as { status: number }).status === 409);
      const response = await network(`${base}/customers/${id}/credits`, { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).entries.length, 50);
    });
    await t.test("credits, balances, original actors and retry keys survive portable import", async () => {
      const exported = await exportShopTransfer(owner);
      const decoded = decodeShopArchive(exported.zip);
      assert.ok(decoded.data.manualCredits.length > 0);
      const destination = `TEST_ONLY_IMPORTED_${randomUUID()}`;
      // Simulate a separate, empty installation without colliding with globally
      // unique customer/payment IDs still present in the source test database.
      await pool.query("DELETE FROM wallet_entries WHERE customer_id IN (SELECT id FROM bot_customers WHERE owner_id=$1)", [owner]);
      for (const table of ["manual_wallet_credits", "shop_payments", "shop_inventory", "shop_products", "bot_customers", "shop_activity"])
        await pool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      const preview = await previewShopTransfer(destination, exported.zip);
      assert.equal(preview.canImport, true);
      await importShopTransfer(destination, exported.zip, preview.confirmationToken);
      const imported = decodeShopArchive((await exportShopTransfer(destination)).zip);
      assert.deepEqual(imported.data.manualCredits.map(row => ({ ...row, ownerId: owner })), decoded.data.manualCredits);
      assert.deepEqual(imported.data.customers.map(row => [row.id, row.balanceCents]), decoded.data.customers.map(row => [row.id, row.balanceCents]));
      const prior = imported.data.manualCredits.find(row => row.customerId === customer)!;
      const result = await addManualWalletCredit(destination, customer, { requestKey: String(prior.requestKey), amountCents: Number(prior.amountCents), reason: String(prior.reason) });
      assert.equal(result.replayed, true, "import must retain deduplication even while the destination awaits review");
    });
  } finally {
    globalThis.fetch = network;
    server.closeAllConnections(); server.close();
    await pool.end();
  }
  const reopened = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    assert.ok(Number(reopened.prepare("SELECT count(*) AS n FROM manual_wallet_credits").get()!.n) > 0);
    assert.equal(reopened.prepare("SELECT balance_cents AS cents FROM bot_customers WHERE id=?").get(customer)!.cents, 1260);
  } finally { reopened.close(); }
});
