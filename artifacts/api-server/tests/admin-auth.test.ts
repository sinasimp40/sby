import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { db, pool, adminSessions, adminLoginLimits } from "@workspace/db";

test("password-only admin login, secure sessions, origin protection and revocation", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development tests only.");
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const owner = `auth-test-${randomUUID()}`;
  const password = `TEST_ONLY-${randomUUID()}`;
  process.env.TELECART_ADMIN_EMAIL = "test-admin@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = password;
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELECART_PUBLIC_URL = "https://test-only.invalid";
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: {
    origin: "https://test-only.invalid", "content-type": "application/json", ...init.headers,
  } });
  const login = (body: object) => request("/admin/login", { method: "POST", body: JSON.stringify(body) });
  try {
    let response = await request("/admin/session");
    assert.equal((await response.json()).signedIn, false);
    assert.equal((await request("/shop/settings", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await login({ email: "test-admin@example.invalid", password: "incorrect" })).status, 401);
    response = await login({ email: "test-admin@example.invalid", password });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ownerId, owner);
    const setCookie = response.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Partitioned/);
    assert.match(setCookie, /SameSite=None/);
    const cookie = setCookie.split(";")[0]!;
    assert.equal((await (await request("/admin/session", { headers: { cookie } })).json()).signedIn, true);
    const integration = await (await request("/shop/integration", { headers: { cookie } })).json();
    assert.equal(integration.isOperator, true);
    assert.equal(integration.ownerId, owner);
    assert.equal((await request("/shop/settings", { method: "POST", body: "{}", headers: { cookie, origin: "https://evil.invalid" } })).status, 403);
    assert.equal((await request("/admin/logout", { method: "POST", headers: { cookie, origin: "https://evil.invalid" } })).status, 403);
    assert.equal((await request("/admin/logout", { method: "POST", headers: { cookie } })).status, 204);
    assert.equal((await (await request("/admin/session", { headers: { cookie } })).json()).signedIn, false);
    assert.equal((await request("/shop/settings", { method: "POST", headers: { cookie }, body: "{}" })).status, 401);
    for (let n = 0; n < 10; n++) await login({ email: "test-admin@example.invalid", password: "wrong" });
    assert.equal((await login({ email: "test-admin@example.invalid", password })).status, 429);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(adminSessions).where(eq(adminSessions.ownerId, owner));
    await db.delete(adminLoginLimits).where(eq(adminLoginLimits.bucket, `admin-login:development:${owner}`));
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await pool.end();
  }
});
