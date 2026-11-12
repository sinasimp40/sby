import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  emojiPackName, loadEmojiPack, saveEmojiStickers, customEmojiLibrary,
  assertOwnedCustomEmoji, removeCustomEmoji,
} from "../src/lib/custom-emoji-library";
import { claimEmojiImportSession, messageCustomEmojiIds, handleEmojiImportMessage, stopEmojiImportSession } from "../src/lib/emoji-import-session";
import { productCatalogMenu } from "../src/lib/telegram-catalog";
import { withCustomEmojiFallback } from "../src/lib/custom-emoji-delivery";
import { TelegramRequestError } from "../src/lib/commerce-providers";
import { readEmojiThumbnail } from "../src/lib/emoji-thumbnail";

test("pack names accept addemoji links only, never arbitrary URLs or sticker links", () => {
  for (const value of ["Crypto_Icons", "https://t.me/addemoji/Crypto_Icons", "t.me/addemoji/Crypto_Icons/"]) {
    assert.equal(emojiPackName(value), "Crypto_Icons");
  }
  for (const value of ["https://evil.example/addemoji/Icons", "https://t.me/addstickers/Icons", "http://t.me/addemoji/Icons",
    "https://user@t.me/addemoji/Icons", "https://t.me/addemoji/Icons?secret=1", "../Icons", ""]) assert.throws(() => emojiPackName(value));
});

test("thumbnail proxy sniffs real images and rejects oversized files or disguised HTML", async () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10]);
  const parsed = await readEmojiThumbnail(new Response(png, { headers: { "content-type": "application/octet-stream" } }));
  assert.equal(parsed.type, "image/png");
  await assert.rejects(readEmojiThumbnail(new Response("<html>bad</html>", { headers: { "content-type": "image/png" } })));
  await assert.rejects(readEmojiThumbnail(new Response(new Uint8Array(512001))));
  await assert.rejects(readEmojiThumbnail(new Response(png, { headers: { "content-length": "99999999" } })));
});

test("custom emoji IDs come from real Telegram entities/stickers, not plain Unicode or numbers", () => {
  assert.deepEqual(messageCustomEmojiIds({ text: "🛍" }), []);
  assert.deepEqual(messageCustomEmojiIds({
    entities: [{ type: "custom_emoji", custom_emoji_id: "900000000000000001" }, { type: "bold", custom_emoji_id: "2" }],
    caption_entities: [{ type: "custom_emoji", custom_emoji_id: "900000000000000001" }],
    sticker: { type: "custom_emoji", custom_emoji_id: "900000000000000002" },
  }), ["900000000000000001", "900000000000000002"]);
  assert.deepEqual(messageCustomEmojiIds({ sticker: { type: "regular", custom_emoji_id: "3" } }), []);
});

test("custom icons preserve two-column navigation and ordinary fallback", () => {
  const products = [{ id: 1, name: "Product", price: 1, stock: 5, status: "active", buttonEmoji: "🔑", buttonCustomEmojiId: "900000000000000001" }];
  const custom = productCatalogMenu(products).reply_markup.inline_keyboard[0][0];
  assert.equal(custom.icon_custom_emoji_id, "900000000000000001");
  assert.ok(!custom.text.startsWith("🔑"));
  const normal = productCatalogMenu(products, 0, false).reply_markup.inline_keyboard[0][0];
  assert.ok(!("icon_custom_emoji_id" in normal));
  assert.ok(normal.text.startsWith("🔑"));
  assert.equal(normal.callback_data, custom.callback_data);
});

test("only definite custom-emoji rejection retries as ordinary emoji, not network or other errors", async () => {
  let fallback = 0;
  await withCustomEmojiFallback(async () => { throw new TelegramRequestError("sendMessage", 400, "custom_emoji_unavailable"); },
    async () => { fallback++; });
  assert.equal(fallback, 1);
  for (const error of [new TelegramRequestError("sendMessage", 0), new TelegramRequestError("sendMessage", 400),
    new TelegramRequestError("sendMessage", 500, "custom_emoji_unavailable")]) {
    await assert.rejects(withCustomEmojiFallback(async () => { throw error; }, async () => { fallback++; }));
  }
  assert.equal(fallback, 1);
});

test("private custom emoji import, deduplication, revocation and deletion are owner-scoped", async t => {
  const owner = `emoji-test-${randomUUID()}`;
  const other = `emoji-test-${randomUUID()}`;
  const oldFetch = globalThis.fetch;
  const oldOwner = process.env.TELECART_OWNER_ID;
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELECART_OWNER_ID = owner;
  process.env.TELEGRAM_BOT_TOKEN = "TEST_ONLY_TOKEN";
  const replies: string[] = [];
  let ordinaryPack = false;
  const sticker = { type: "custom_emoji", custom_emoji_id: "900000000000000001", emoji: "🔑", set_name: "TEST_ONLY", is_animated: true };
  globalThis.fetch = async (input, init) => {
    const method = String(input).split("/").at(-1);
    if (method === "getCustomEmojiStickers") return Response.json({ ok: true, result: [sticker] });
    if (method === "getStickerSet") return Response.json({ ok: true, result: {
      sticker_type: ordinaryPack ? "regular" : "custom_emoji", stickers: [sticker],
    } });
    if (method === "sendMessage") {
      replies.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: { message_id: replies.length } });
    }
    throw new Error("Unexpected network call blocked.");
  };
  const token = randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  try {
    await pool.query("INSERT INTO bot_runtime_settings(owner_id,enabled) VALUES($1,true)", [owner]);
    await t.test("real pack response is verified; ordinary sticker packs are rejected", async () => {
      const result = await loadEmojiPack("https://t.me/addemoji/TEST_ONLY");
      assert.deepEqual(result, [sticker]);
      ordinaryPack = true;
      await assert.rejects(loadEmojiPack("TEST_ONLY"), /ordinary sticker pack/);
      ordinaryPack = false;
    });
    await t.test("repeat imports deduplicate and never cross owners", async () => {
      assert.deepEqual(await saveEmojiStickers(owner, [sticker, sticker]), { imported: 1, updated: 0, total: 1 });
      assert.deepEqual(await saveEmojiStickers(owner, [sticker]), { imported: 0, updated: 1, total: 1 });
      assert.equal((await customEmojiLibrary(owner)).items[0].format, "animated");
      assert.equal((await customEmojiLibrary(other)).items.length, 0);
      await assert.rejects(customEmojiLibrary(null), e => (e as {status:number}).status === 401);
      await assert.rejects(assertOwnedCustomEmoji(other, sticker.custom_emoji_id));
      await assert.rejects(saveEmojiStickers(owner, [{ ...sticker, type: "regular" }]));
    });
    await t.test("private link claims only its owner and first chat, without storing the raw token", async () => {
      await pool.query("INSERT INTO emoji_import_sessions(owner_id,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [owner, hash]);
      assert.equal(await claimEmojiImportSession(other, token, "11"), false);
      assert.equal(await claimEmojiImportSession(owner, "invalid", "11"), false);
      assert.equal(await claimEmojiImportSession(owner, token, "11"), true);
      assert.equal(await claimEmojiImportSession(owner, token, "11"), true);
      assert.equal(await claimEmojiImportSession(owner, token, "12"), false);
      const stored = await pool.query("SELECT token_hash FROM emoji_import_sessions WHERE owner_id=$1", [owner]);
      assert.equal(stored.rows[0].token_hash, hash);
      assert.notEqual(stored.rows[0].token_hash, token);
    });
    await t.test("only the paired chat can capture custom emojis, and plain messages receive instructions", async () => {
      assert.equal(await handleEmojiImportMessage(owner, "12", { entities: [{ type: "custom_emoji", custom_emoji_id: sticker.custom_emoji_id }] }), false);
      assert.equal(await handleEmojiImportMessage(owner, "11", { text: "🔑" }), true);
      assert.match(replies.at(-1)!, /actual custom Telegram emojis/);
      assert.equal(await handleEmojiImportMessage(owner, "11", { entities: [{ type: "custom_emoji", custom_emoji_id: sticker.custom_emoji_id }] }), true);
      assert.match(replies.at(-1)!, /already in your library/);
      assert.equal((await customEmojiLibrary(owner)).items.length, 1);
      const customers = await pool.query("SELECT count(*)::int AS count FROM bot_customers WHERE owner_id=$1", [owner]);
      assert.equal(customers.rows[0].count, 0);
    });
    await t.test("stopping/expiry rejects later writes and leaves ordinary customer messages alone", async () => {
      await stopEmojiImportSession(owner);
      assert.equal(await claimEmojiImportSession(owner, token, "11"), false);
      await assert.rejects(saveEmojiStickers(owner, [sticker], { tokenHash: hash, chatId: "11" }), /expired or was stopped/);
      assert.equal(await handleEmojiImportMessage(owner, "11", { text: "normal shop message" }), false);
      await pool.query("INSERT INTO emoji_import_sessions(owner_id,token_hash,expires_at) VALUES($1,$2,now()-interval '1 minute')", [owner, hash]);
      assert.equal(await claimEmojiImportSession(owner, token, "11"), false);
    });
    await t.test("deleting an icon reverts only its owner's products without deleting the products", async () => {
      const product = await pool.query(`INSERT INTO shop_products(owner_id,name,category,price_cents,delivery_format,button_custom_emoji_id)
        VALUES($1,'TEST_ONLY','TEST_ONLY',100,'email:pass',$2) RETURNING id`, [owner, sticker.custom_emoji_id]);
      await assert.rejects(removeCustomEmoji(other, sticker.custom_emoji_id));
      assert.equal((await customEmojiLibrary(owner)).items.length, 1);
      await removeCustomEmoji(owner, sticker.custom_emoji_id);
      const saved = await pool.query("SELECT button_custom_emoji_id,button_emoji,price_cents FROM shop_products WHERE id=$1", [product.rows[0].id]);
      assert.equal(saved.rows[0].button_custom_emoji_id, null);
      assert.equal(saved.rows[0].button_emoji, "🛍");
      assert.equal(saved.rows[0].price_cents, 100);
      assert.equal((await customEmojiLibrary(owner)).items.length, 0);
    });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldOwner === undefined) delete process.env.TELECART_OWNER_ID; else process.env.TELECART_OWNER_ID = oldOwner;
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    for (const table of ["shop_products", "shop_custom_emojis", "emoji_import_sessions", "bot_runtime_settings"]) {
      await pool.query(`DELETE FROM "${table}" WHERE owner_id=ANY($1::text[])`, [[owner, other]]);
    }
    await pool.end();
  }
});
