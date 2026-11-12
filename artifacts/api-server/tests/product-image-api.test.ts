import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import { pool } from "@workspace/db";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";

test("product image links persist through create/edit/reload, omission preserves and null removes", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const owner = `product-image-test-${randomUUID()}`;
  const otherOwner = `${owner}-other`;
  process.env.TELECART_ADMIN_EMAIL = "test-admin@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = `TEST_ONLY-${randomUUID()}`;
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELECART_PUBLIC_URL = "https://test-only.invalid";
  process.env.TELECART_ADMIN_ORIGIN = "https://test-only.invalid";
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/products`;
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const request = (path = "", method = "GET", body?: object, customCookie = cookie) => fetch(base + path, {
    method, headers: { cookie: customCookie, origin: "https://test-only.invalid", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const input = { name: "TEST_ONLY product image", description: "Description", price: 1, status: "draft", deliveryFormat: "email:pass" };
  const imageUrl = "https://cdn.example.com/product.png";
  const gifUrl = "https://cdn.example.com/product.gif?v=1";
  try {
    assert.equal((await request("", "POST", { ...input, imageUrl }, "")).status, 401);
    const created = await request("", "POST", { ...input, imageUrl, buttonEmoji: "" });
    assert.equal(created.status, 201);
    const product = await created.json();
    assert.equal(product.imageUrl, imageUrl);
    assert.equal(product.buttonEmoji, "");
    const path = `/${product.id}`;
    const read = async () => (await (await request()).json() as { id: number; imageUrl: string | null; buttonEmoji: string }[]).find(row => row.id === product.id)!;
    assert.equal((await read()).imageUrl, imageUrl);
    assert.equal((await (await request(path, "PATCH", { ...input, imageUrl: gifUrl })).json()).imageUrl, gifUrl);
    assert.equal((await read()).imageUrl, gifUrl);
    assert.equal((await read()).buttonEmoji, "");
    assert.equal((await (await request(path, "PATCH", { ...input, buttonEmoji: "🎵" })).json()).buttonEmoji, "🎵");
    assert.equal((await (await request(path, "PATCH", { ...input, buttonEmoji: "" })).json()).buttonEmoji, "");
    assert.equal((await read()).buttonEmoji, "");
    assert.equal((await request(path, "PATCH", { ...input, buttonEmoji: "not an emoji" })).status, 400);
    assert.equal((await (await request(path, "PATCH", { ...input, name: "TEST_ONLY renamed" })).json()).imageUrl, gifUrl);
    const rejected = await request(path, "PATCH", { ...input, imageUrl: "https://127.0.0.1/private.png" });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /public HTTPS image link/);
    assert.equal((await read()).imageUrl, gifUrl);
    assert.equal((await (await request(path, "PATCH", { ...input, imageUrl: null })).json()).imageUrl, null);
    assert.equal((await read()).imageUrl, null);
    assert.equal((await request(path, "PATCH", { ...input, imageUrl: "  " })).status, 200);
    assert.equal((await read()).imageUrl, null);
    process.env.TELECART_OWNER_ID = otherOwner;
    const otherCookie = `${adminCookieName()}=${await issueAdminSession()}`;
    assert.equal((await request(path, "PATCH", { ...input, imageUrl }, otherCookie)).status, 404);
    process.env.TELECART_OWNER_ID = owner;
    assert.equal((await request(path, "DELETE")).status, 204);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.query("DELETE FROM shop_activity WHERE owner_id=ANY($1::text[])", [[owner, otherOwner]]);
    await pool.query("DELETE FROM shop_products WHERE owner_id=ANY($1::text[])", [[owner, otherOwner]]);
    await pool.query("DELETE FROM admin_sessions WHERE owner_id=ANY($1::text[])", [[owner, otherOwner]]);
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await pool.end();
  }
});
