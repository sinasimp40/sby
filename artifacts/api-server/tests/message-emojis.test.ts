import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, shopCustomEmojis, shopSettings } from "@workspace/db";
import { messageEmojiToken, parseMessageEmojis, removeMessageEmoji } from "@workspace/api-zod";
import { messageEmojiBody, sendMessageWithEmojis } from "../src/lib/message-emojis";
import { sendWelcomeMessage } from "../src/lib/welcome-message";
import { TelegramRequestError } from "../src/lib/commerce-providers";
import { validateMessageEmojis, removeCustomEmoji } from "../src/lib/custom-emoji-library";
import { defaultSettings } from "../src/lib/shop-defaults";
import { readShopTransferData } from "../src/lib/shop-transfer-store";
import { encodeSqliteShopArchive } from "../src/lib/shop-transfer-sqlite";
import { decodeShopArchive } from "../src/lib/shop-transfer-archive";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";

const id = "9876500000000000001";
const second = "9876500000000000002";
const marker = messageEmojiToken(id, "🌟");

test("custom message emojis preserve literal text and Telegram's UTF-16 offsets", () => {
  const prefix = "😀 Hello <b>& shop\n";
  const parsed = parseMessageEmojis(prefix + marker + " " + messageEmojiToken(second, "👩‍💻"));
  assert.equal(parsed.text, prefix + "🌟 👩‍💻");
  assert.deepEqual(parsed.entities, [
    { type: "custom_emoji", offset: prefix.length, length: 2, custom_emoji_id: id },
    { type: "custom_emoji", offset: prefix.length + 3, length: "👩‍💻".length, custom_emoji_id: second },
  ]);
  const malformed = '{{emoji:1|<script>}} {{emoji:bad|🌟}} {{emoji:1|not emoji}}';
  assert.equal(parseMessageEmojis(malformed).text, malformed);
  assert.equal(parseMessageEmojis(malformed).entities.length, 0);
  assert.throws(() => messageEmojiToken("bad", "🌟"));
  assert.equal(removeMessageEmoji(marker + messageEmojiToken(second, "👩‍💻"), id), "🌟" + messageEmojiToken(second, "👩‍💻"));
});

test("support uses entity formatting, plain fallback only on a definite custom-emoji rejection", async () => {
  const calls: Record<string, unknown>[] = [];
  await sendMessageWithEmojis("TEST_ONLY", marker + " Help & <support>\n@shop", async (_method, body) => {
    calls.push(body);
    if (calls.length === 1) throw new TelegramRequestError("sendMessage", 400, "custom_emoji_unavailable");
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.text, "🌟 Help & <support>\n@shop");
  assert.ok(calls[0]!.entities);
  assert.equal(calls[1]!.entities, undefined);
  assert.equal(calls[1]!.text, calls[0]!.text);
  assert.equal(calls[0]!.parse_mode, undefined, "merchant text must never be interpreted as HTML");
  for (const status of [0, 500]) {
    let attempts = 0;
    await assert.rejects(sendMessageWithEmojis("TEST_ONLY", marker, async () => {
      attempts++; throw new TelegramRequestError("sendMessage", status);
    }));
    assert.equal(attempts, 1, "an uncertain send must never be retried");
  }
});

test("welcome photo caption counts rendered text and retains media and menu on emoji fallback", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const keyboard = { keyboard: [[{ text: "Products" }]] };
  await sendWelcomeMessage("TEST_ONLY", {
    welcomeMessage: marker + "a".repeat(1022), welcomeImageUrl: "https://cdn.example.com/welcome.png",
  }, keyboard, "This optional note cannot fit.", async (method, body) => {
    calls.push({ method, body });
    if (calls.length === 1) throw new TelegramRequestError(method, 400, "custom_emoji_unavailable");
  });
  assert.deepEqual(calls.map(call => call.method), ["sendPhoto", "sendPhoto"]);
  assert.equal(String(calls[0]!.body.caption).length, 1024);
  assert.ok(calls[0]!.body.caption_entities);
  assert.equal(calls[1]!.body.caption_entities, undefined);
  assert.equal(calls[1]!.body.photo, "https://cdn.example.com/welcome.png");
  assert.deepEqual(calls[1]!.body.reply_markup, keyboard);
  assert.deepEqual(messageEmojiBody("plain & <text>"), { text: "plain & <text>" });
});

test("ownership, SQLite ZIP preservation and deleting library emojis cover both message fields", async () => {
  const owner = `TEST_ONLY_${randomUUID()}`;
  const foreign = `TEST_ONLY_${randomUUID()}`;
  try {
    await db.insert(shopCustomEmojis).values([
      { ownerId: owner, customEmojiId: id, emoji: "🌟", format: "static" },
      { ownerId: foreign, customEmojiId: second, emoji: "👩‍💻", format: "animated" },
    ]);
    await validateMessageEmojis(owner, [marker, "No emoji here."]);
    await assert.rejects(validateMessageEmojis(owner, [messageEmojiToken(second, "👩‍💻")]), /own library/);
    await db.insert(shopSettings).values({ ownerId: owner, preferences: {
      ...defaultSettings, welcomeMessage: marker + " welcome", supportMessage: "Help " + marker,
    } });
    const client = await pool.connect();
    try {
      const data = await readShopTransferData(client, owner);
      const archive = decodeShopArchive(encodeSqliteShopArchive(owner, data).zip);
      validateShopRelationships(archive.data, owner);
      const preferences = JSON.parse(String(archive.data.settings[0]!.preferences));
      assert.equal(preferences.welcomeMessage, marker + " welcome");
      assert.equal(preferences.supportMessage, "Help " + marker);
    } finally { client.release(); }
    await removeCustomEmoji(owner, id);
    const [saved] = await db.select().from(shopSettings).where(eq(shopSettings.ownerId, owner));
    assert.equal(saved!.preferences.welcomeMessage, "🌟 welcome");
    assert.equal(saved!.preferences.supportMessage, "Help 🌟");
    await validateMessageEmojis(owner, [String(saved!.preferences.welcomeMessage)]);
  } finally {
    for (const tenant of [owner, foreign]) {
      await db.delete(shopSettings).where(eq(shopSettings.ownerId, tenant));
      await db.delete(shopCustomEmojis).where(eq(shopCustomEmojis.ownerId, tenant));
    }
  }
});
