import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import { pool } from "@workspace/db";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";
import { decryptCredential } from "../src/lib/inventory-encryption";

test("inventory accepts arbitrary non-empty lines without a credential format and preserves their contents", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const owner = `inventory-lines-${randomUUID()}`;
  process.env.TELECART_ADMIN_EMAIL = "test-admin@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = `TEST_ONLY-${randomUUID()}`;
  process.env.TELECART_OWNER_ID = owner;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/products`;
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const request = (path: string, body?: object, authenticated = true, method = body ? "POST" : "GET") => fetch(base + path, {
    method,
    headers: { cookie: authenticated ? cookie : "", origin: "https://test-only.invalid", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const created = await request("", {
      name: "TEST_ONLY arbitrary stock", description: "", price: 1,
      status: "draft", deliveryFormat: "user:pass",
    });
    assert.equal(created.status, 201);
    const product = await created.json();
    const path = `/${product.id}/inventory`;
    const lines = [
      "TEST_ONLY-REDEMPTION-CODE",
      "TEST_ONLY text with spaces",
      "https://example.invalid/redeem?code=TEST_ONLY",
      "TEST_ONLY:user:pass:extra",
      ":TEST_ONLY",
      "TEST_ONLY:",
      "  TEST_ONLY spacing <literal>& preserved  ",
      "TEST_ONLY 中文 🎁",
    ];
    assert.equal((await request(path, { entries: lines.join("\n") }, false)).status, 401);
    const imported = await request(path, { entries: ["", "   ", ...lines, lines[0], ""].join("\r\n") });
    assert.equal(imported.status, 201);
    assert.deepEqual(await imported.json(), { imported: lines.length, skipped: 1 });
    const stored = (await pool.query(
      "SELECT encrypted_credential FROM shop_inventory WHERE owner_id=$1 AND product_id=$2 ORDER BY id",
      [owner, product.id],
    )).rows;
    assert.deepEqual(stored.map(row => decryptCredential(String(row.encrypted_credential), owner, product.id)), lines);
    assert.ok(stored.every((row, i) => row.encrypted_credential !== lines[i]));
    const metadata = await (await request(path)).json();
    assert.equal(metadata.length, lines.length);
    assert.ok(metadata.every((row: Record<string, unknown>) => !("encryptedCredential" in row) && !("credential" in row)));
    const repeated = await request(path, { entries: lines.join("\n") });
    assert.deepEqual(await repeated.json(), { imported: 0, skipped: lines.length });
    assert.equal((await request(path, { entries: " \n\t\r\n" })).status, 400);
    assert.equal((await request(path, { entries: Array.from({ length: 501 }, (_, i) => `TEST_ONLY_${i}`).join("\n") })).status, 400);
    assert.equal((await (await request(path)).json()).length, lines.length);
    // Bulk deletion is scoped to one product and only its available stock.
    const beforeClear = await (await request(path)).json() as { id: number; status: string }[];
    await pool.query("UPDATE shop_inventory SET status='reserved' WHERE id=$1", [beforeClear[0]!.id]);
    await pool.query("UPDATE shop_inventory SET status='delivered' WHERE id=$1", [beforeClear[1]!.id]);
    const secondCreated = await request("", {
      name: "TEST_ONLY other product", description: "", price: 1,
      status: "draft", deliveryFormat: "email:pass",
    });
    assert.equal(secondCreated.status, 201);
    const second = await secondCreated.json();
    await request(`/${second.id}/inventory`, { entries: "TEST_ONLY_KEEP_OTHER_PRODUCT" });
    assert.equal((await request(path, undefined, false, "DELETE")).status, 401);
    assert.equal((await request("/invalid/inventory", undefined, true, "DELETE")).status, 400);
    process.env.TELECART_OWNER_ID = `${owner}-other`;
    const otherCookie = `${adminCookieName()}=${await issueAdminSession()}`;
    const forbidden = await fetch(base + path, {
      method: "DELETE", headers: { cookie: otherCookie, origin: "https://test-only.invalid" },
    });
    assert.equal(forbidden.status, 404);
    process.env.TELECART_OWNER_ID = owner;
    assert.equal((await (await request(path)).json()).length, lines.length);
    const cleared = await request(path, undefined, true, "DELETE");
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { deleted: lines.length - 2 });
    const remaining = await (await request(path)).json() as { id: number; status: string }[];
    assert.deepEqual(remaining.map(row => row.id).sort((a, b) => a - b), beforeClear.slice(0, 2).map(row => row.id).sort((a, b) => a - b));
    assert.deepEqual(remaining.map(row => row.status).sort(), ["delivered", "reserved"]);
    assert.equal((await (await request(`/${second.id}/inventory`)).json()).length, 1);
    const products = await (await request("")).json() as { id: number; stock: number }[];
    assert.equal(products.find(row => row.id === product.id)!.stock, 0);
    assert.equal(products.find(row => row.id === second.id)!.stock, 1);
    const audit = (await pool.query("SELECT description FROM shop_activity WHERE owner_id=$1 AND title='Inventory cleared'", [owner])).rows;
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes("TEST_ONLY-REDEMPTION-CODE"));
    const repeatedClear = await request(path, undefined, true, "DELETE");
    assert.equal(repeatedClear.status, 200);
    assert.deepEqual(await repeatedClear.json(), { deleted: 0 });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query("DELETE FROM shop_inventory WHERE owner_id=$1", [owner]);
    await pool.query("DELETE FROM shop_activity WHERE owner_id=$1", [owner]);
    await pool.query("DELETE FROM shop_products WHERE owner_id=$1", [owner]);
    await pool.query("DELETE FROM admin_sessions WHERE owner_id=ANY($1::text[])", [[owner, `${owner}-other`]]);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await pool.end();
  }
});
