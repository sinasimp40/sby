import test from "node:test";
import assert from "node:assert/strict";
import { decryptProviderSecret, encryptProviderSecret } from "../src/lib/provider-credentials";
import { checkNOWPaymentsKey, checkTelegramToken, sortedJson, verifyIpn } from "../src/lib/commerce-providers";
import { createHmac, randomUUID } from "node:crypto";
import app from "../src/app";
import { adminLoginLimits, adminSessions, botConnections, db, pool, providerCredentials } from "@workspace/db";
import { eq } from "drizzle-orm";

test("provider credentials are encrypted and bound to their owner and purpose", () => {
  const owner = "TEST_ONLY_OWNER";
  const plaintext = "TEST_ONLY_PROVIDER_SECRET";
  const encrypted = encryptProviderSecret(plaintext, owner, "telegram");
  assert.notEqual(encrypted, plaintext);
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal(decryptProviderSecret(encrypted, owner, "telegram"), plaintext);
  assert.throws(() => decryptProviderSecret(encrypted, "OTHER_TEST_OWNER", "telegram"));
  assert.throws(() => decryptProviderSecret(encrypted, owner, "nowpayments-api-key"));
});

test("provider checks call only read-only identity and currency endpoints", async t => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string | undefined; apiKey: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method,
      apiKey: new Headers(init?.headers).get("x-api-key"),
    });
    if (String(url).endsWith("/getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: 12345, username: "TEST_ONLY_BOT" } }), { status: 200 });
    }
    return new Response(JSON.stringify({ currencies: ["btc", "ltc"] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.deepEqual(await checkTelegramToken("TEST_ONLY_TOKEN"), { id: 12345, username: "TEST_ONLY_BOT" });
  await checkNOWPaymentsKey("TEST_ONLY_API_KEY");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[1]?.url, "https://api.nowpayments.io/v1/currencies");
  assert.equal(requests[1]?.apiKey, "TEST_ONLY_API_KEY");
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), [
    "/botTEST_ONLY_TOKEN/getMe",
    "/v1/currencies",
  ]);
});

test("provider checks return safe errors without echoing submitted credentials", async t => {
  const originalFetch = globalThis.fetch;
  const submitted = "TEST_ONLY_REJECTED_SECRET";
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: submitted }), { status: 401 });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(checkTelegramToken(submitted), error =>
    error instanceof Error && !error.message.includes(submitted) && error.message.includes("did not accept"));
});

test("admin can verify and save provider credentials without returning their values", async t => {
  const envKeys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN", "TELECART_TELEGRAM_DISABLED"];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const owner = `credential-test-${randomUUID()}`;
  const email = "credential-test@example.invalid";
  const password = `TEST_ONLY-${randomUUID()}-long`;
  const telegramToken = "TEST_ONLY_TELEGRAM_TOKEN";
  const nowpaymentsApiKey = "TEST_ONLY_NOWPAYMENTS_KEY";
  const ipnSecret = "TEST_ONLY_NOWPAYMENTS_IPN_SECRET";
  const originalFetch = globalThis.fetch;
  const [existingConnection] = await db.select({ botId: botConnections.botId }).from(botConnections).where(eq(botConnections.id, "primary"));
  process.env.TELECART_ADMIN_EMAIL = email;
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = password;
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELECART_PUBLIC_URL = "https://credential-test.invalid";
  process.env.TELECART_ADMIN_ORIGIN = "https://credential-test.invalid";
  process.env.TELECART_TELEGRAM_DISABLED = "true";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      return new Response(JSON.stringify({ ok: true, result: { id: 12345, username: "TEST_ONLY_BOT" } }), { status: 200 });
    }
    if (url === "https://api.nowpayments.io/v1/currencies") {
      return new Response(JSON.stringify({ currencies: ["btc"] }), { status: 200 });
    }
    return originalFetch(input, init);
  };

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init,
    headers: {
      origin: "https://credential-test.invalid",
      "content-type": "application/json",
      ...init.headers,
    },
  });
  try {
    let response = await request("/admin/login", { method: "POST", body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;

    response = await request("/shop/integration/credentials/telegram", {
      method: "POST", headers: { cookie }, body: JSON.stringify({ token: telegramToken }),
    });
    if (existingConnection) {
      const result = await response.json() as { verified: boolean; botUsername: string; saved: boolean; message: string };
      assert.equal(result.verified, true);
      assert.equal(result.botUsername, "TEST_ONLY_BOT");
      assert.equal(result.saved, false);
      assert.match(result.message, /not saved/);
    } else {
      assert.deepEqual(await response.json(), {
        verified: true, botUsername: "TEST_ONLY_BOT", saved: true,
        message: "Telegram bot token verified and encrypted for this shop.",
      });
    }

    response = await request("/shop/integration/credentials/nowpayments", {
      method: "POST", headers: { cookie }, body: JSON.stringify({ apiKey: nowpaymentsApiKey, ipnSecret }),
    });
    assert.deepEqual(await response.json(), { verified: true, ipnSecretSaved: true });

    response = await request("/shop/integration", { headers: { cookie } });
    const status = await response.json() as Record<string, unknown>;
    assert.equal(status.telegramVerified, !existingConnection);
    assert.equal(status.nowpaymentsVerified, true);
    assert.equal(status.telegramProcessingEnabled, false);
    assert.equal(status.botUsername, existingConnection ? "" : "TEST_ONLY_BOT");
    assert.equal(JSON.stringify(status).includes(telegramToken), false);
    assert.equal(JSON.stringify(status).includes(nowpaymentsApiKey), false);
    assert.equal(JSON.stringify(status).includes(ipnSecret), false);
    const notification = { payment_id: "987654", payment_status: "waiting" };
    const signature = createHmac("sha512", ipnSecret).update(JSON.stringify(sortedJson(notification))).digest("hex");
    assert.equal(await verifyIpn(notification, signature), true);

    const [stored] = await db.select().from(providerCredentials).where(eq(providerCredentials.ownerId, owner));
    assert.ok(stored);
    assert.equal(stored.telegramTokenEncrypted?.includes(telegramToken) ?? false, false);
    assert.equal(Boolean(stored.telegramTokenEncrypted), !existingConnection);
    assert.equal(stored.nowpaymentsApiKeyEncrypted?.includes(nowpaymentsApiKey) ?? false, false);
    assert.equal(stored.nowpaymentsIpnSecretEncrypted?.includes(ipnSecret) ?? false, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    globalThis.fetch = originalFetch;
    await db.delete(providerCredentials).where(eq(providerCredentials.ownerId, owner));
    await db.delete(adminSessions).where(eq(adminSessions.ownerId, owner));
    await db.delete(adminLoginLimits).where(eq(adminLoginLimits.bucket, `admin-login:development:${owner}`));
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await pool.end();
  }
});
