import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../src/app";
import { adminCookieName, issueAdminSession } from "../src/lib/admin-auth";
import { removeCustomEmoji } from "../src/lib/custom-emoji-library";

test("coin icon preferences persist, stay owner-scoped, clear safely and survive unrelated settings saves", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `coin-icon-test-${randomUUID()}`, other = `${owner}-other`;
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.TELECART_ADMIN_EMAIL = "test-admin@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = `TEST_ONLY-${randomUUID()}`;
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELECART_PUBLIC_URL = process.env.TELECART_ADMIN_ORIGIN = "https://test-only.invalid";
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/settings`;
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const request = (body?: object, auth = cookie) => fetch(base, {
    method: body ? "PUT" : "GET", headers: { cookie: auth, origin: "https://test-only.invalid", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await pool.query("INSERT INTO shop_custom_emojis(owner_id,custom_emoji_id,emoji,set_name,format) VALUES($1,'900000000000000001','💎','TEST_ONLY','static'),($2,'900000000000000002','🚀','TEST_ONLY','static')", [owner, other]);
    const baseline = await (await request()).json();
    const icons = { BTC: { emoji: "💎", customEmojiId: "900000000000000001" }, ETH: { emoji: "🚀" }, LTC: { emoji: "" },
      USDTTRC20: { customEmojiId: "900000000000000001" } };
    assert.equal((await request({ ...baseline, coinButtonIcons: icons }, "")).status, 401);
    const saved = await request({ ...baseline, coinButtonIcons: icons });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual((await saved.json()).coinButtonIcons, icons);
    assert.deepEqual((await (await request()).json()).coinButtonIcons, icons);
    const { coinButtonIcons: _, ...withoutIcons } = baseline;
    assert.equal((await request({ ...withoutIcons, supportMessage: "TEST_ONLY edited elsewhere" })).status, 200);
    assert.deepEqual((await (await request()).json()).coinButtonIcons, icons);
    for (const invalid of [
      { BAD: { emoji: "💎" } }, { BTC: { emoji: "not an emoji" } }, { BTC: { customEmojiId: "900000000000000002" } },
    ]) assert.equal((await request({ ...baseline, coinButtonIcons: invalid })).status, 400);
    assert.deepEqual((await (await request()).json()).coinButtonIcons, icons);
    const cleared = { ...icons, BTC: { emoji: "", customEmojiId: null } };
    assert.equal((await request({ ...baseline, coinButtonIcons: cleared })).status, 200);
    assert.deepEqual((await (await request()).json()).coinButtonIcons, cleared);
    await removeCustomEmoji(owner, "900000000000000001");
    const afterRemoval = await (await request()).json();
    assert.equal(afterRemoval.coinButtonIcons.USDTTRC20.customEmojiId, null);
    assert.equal(afterRemoval.coinButtonIcons.ETH.emoji, "🚀");
    const raw = (await pool.query("SELECT preferences FROM shop_settings WHERE owner_id=$1", [owner])).rows[0].preferences;
    assert.equal(raw.coinButtonIcons.USDTTRC20.customEmojiId, null);
    assert.equal((await request({ ...baseline, coinButtonIcons: {} })).status, 200);
    const reset = await (await request()).json();
    assert.deepEqual(reset.coinButtonIcons, {});
    for (const field of ["acceptedCoins", "minDeposit", "rateMode", "invoiceExpiryMinutes"]) assert.deepEqual(reset[field], baseline[field]);
    const welcome = { ...baseline, coinButtonIcons: {}, welcomeMessage: "TEST_ONLY Welcome", welcomeImageUrl: "https://cdn.example.com/welcome.gif" };
    assert.equal((await request(welcome)).status, 200);
    assert.equal((await (await request()).json()).welcomeImageUrl, welcome.welcomeImageUrl);
    const { welcomeImageUrl: omitted, ...withoutWelcomeImage } = welcome;
    assert.equal((await request(withoutWelcomeImage)).status, 200);
    assert.equal((await (await request()).json()).welcomeImageUrl, omitted);
    assert.equal((await request({ ...welcome, welcomeImageUrl: "https://127.0.0.1/private.png" })).status, 400);
    assert.equal((await request({ ...welcome, welcomeMessage: "a".repeat(1025) })).status, 400);
    assert.equal((await request({ ...welcome, welcomeImageUrl: null })).status, 200);
    assert.equal((await (await request()).json()).welcomeImageUrl, null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const table of ["shop_settings", "shop_activity", "shop_custom_emojis", "admin_sessions"]) {
      await pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [[owner, other]]);
    }
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await pool.end();
  }
});
