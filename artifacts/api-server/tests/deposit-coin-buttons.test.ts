import test from "node:test";
import assert from "node:assert/strict";
import { depositCoinKeyboard, sendDepositCoinMenu, coinEmojiIds } from "../src/lib/deposit-coin-buttons";
import { TelegramRequestError } from "../src/lib/commerce-providers";

test("deposit buttons use the matching animated crypto logo without changing payment callbacks", () => {
  const keyboard = depositCoinKeyboard(["BTC", "ETH", "LTC", "SOL"], "12345678-1234-1234-1234-123456789012");
  for (const [index, coin] of ["btc", "eth", "ltc", "sol"].entries()) {
    const button = keyboard.inline_keyboard[index]![0]!;
    assert.equal(button.icon_custom_emoji_id, coinEmojiIds[coin]);
    assert.equal(button.text, coin.toUpperCase());
    assert.equal(button.callback_data, `pay:12345678-1234-1234-1234-123456789012:${coin}`);
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  assert.equal(keyboard.inline_keyboard.at(-1)![0]!.callback_data, "cancel_home");
});

test("unsupported custom emoji falls back to usable plain buttons after a definite rejection", async () => {
  const sent: Array<ReturnType<typeof depositCoinKeyboard>> = [];
  await sendDepositCoinMenu(async keyboard => {
    sent.push(keyboard);
    if (sent.length === 1) throw new TelegramRequestError("sendMessage", 400, "custom_emoji_unavailable");
  }, ["BTC", "SOL"], "TOKEN");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.inline_keyboard[0]![0]!.icon_custom_emoji_id, coinEmojiIds.btc);
  assert.ok(!("icon_custom_emoji_id" in sent[1]!.inline_keyboard[0]![0]!));
  assert.equal(sent[0]!.inline_keyboard[0]![0]!.callback_data, sent[1]!.inline_keyboard[0]![0]!.callback_data);
});

test("ambiguous network failures do not create duplicate coin menus", async () => {
  let attempts = 0;
  await assert.rejects(sendDepositCoinMenu(async () => {
    attempts++;
    throw new TelegramRequestError("sendMessage", 0);
  }, ["LTC"], "TOKEN"));
  assert.equal(attempts, 1);
});

test("unknown Telegram button-icon rejection also falls back without blocking deposits", async () => {
  let attempts = 0;
  await sendDepositCoinMenu(async keyboard => {
    attempts++;
    if (attempts === 1) throw new TelegramRequestError("sendMessage", 400);
    assert.ok(!("icon_custom_emoji_id" in keyboard.inline_keyboard[0]![0]!));
  }, ["ETH"], "TOKEN");
  assert.equal(attempts, 2);
});
