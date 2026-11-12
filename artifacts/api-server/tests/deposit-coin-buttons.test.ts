import test from "node:test";
import assert from "node:assert/strict";
import { depositCoinKeyboard, sendDepositCoinMenu, staticCoinLabels } from "../src/lib/deposit-coin-buttons";
import { TelegramRequestError } from "../src/lib/commerce-providers";

test("static coin symbols and full names work without custom emoji eligibility", () => {
  const token = "12345678-1234-1234-1234-123456789012";
  const keyboard = depositCoinKeyboard(["BTC", "ETH", "LTC", "SOL"], token);
  for (const [index, coin] of ["btc","eth","ltc","sol"].entries()) {
    const button = keyboard.inline_keyboard[index]![0]!;
    assert.equal(button.text, staticCoinLabels[coin]);
    assert.equal(button.callback_data, `pay:${token}:${coin}`);
    assert.ok(!("icon_custom_emoji_id" in button));
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  assert.equal(keyboard.inline_keyboard.at(-1)![0]!.callback_data, "cancel_home");
});
test("coin menu sends exactly once and does not duplicate on errors", async () => {
  for (const status of [0,400]) {
    let calls = 0;
    await assert.rejects(sendDepositCoinMenu(async () => { calls++; throw new TelegramRequestError("sendMessage",status); },["BTC"],"TOKEN"));
    assert.equal(calls,1);
  }
});

test("coin icons are independent, custom wins, and both USDT networks remain explicit", () => {
  const icons = { BTC: { emoji: "💎", customEmojiId: "1234567890" }, ETH: { emoji: "🚀" }, LTC: { emoji: "" } };
  const rows = depositCoinKeyboard(["BTC", "ETH", "LTC", "USDTTRC20", "USDTERC20", "BNBBSC"], "TOKEN", icons).inline_keyboard;
  assert.equal(rows[0]![0]!.text, "Bitcoin · BTC");
  assert.equal((rows[0]![0]! as { icon_custom_emoji_id: string }).icon_custom_emoji_id, "1234567890");
  assert.equal(rows[1]![0]!.text, "🚀  Ethereum · ETH");
  assert.equal(rows[2]![0]!.text, "Litecoin · LTC");
  assert.match(rows[3]![0]!.text, /TRON \(TRC20\)/);
  assert.match(rows[4]![0]!.text, /Ethereum \(ERC20\)/);
  assert.match(rows[5]![0]!.text, /Smart Chain \(BSC\)/);
  assert.equal(rows[3]![0]!.callback_data, "pay:TOKEN:usdttrc20");
  assert.equal(rows[4]![0]!.callback_data, "pay:TOKEN:usdterc20");
});

test("only definite custom-icon rejection retries with the chosen fallback", async () => {
  const sent: ReturnType<typeof depositCoinKeyboard>[] = [];
  await sendDepositCoinMenu(async keyboard => {
    sent.push(keyboard);
    if (sent.length === 1) throw new TelegramRequestError("sendMessage", 400, "custom_emoji_unavailable");
  }, ["BTC", "ETH"], "TOKEN", { BTC: { emoji: "💎", customEmojiId: "1234567890" }, ETH: { emoji: "" } });
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.inline_keyboard[0]![0]!.text, "💎  Bitcoin · BTC");
  assert.equal(sent[1]!.inline_keyboard[1]![0]!.text, "Ethereum · ETH");
  assert.equal(sent[0]!.inline_keyboard[0]![0]!.callback_data, sent[1]!.inline_keyboard[0]![0]!.callback_data);
  for (const error of [new TelegramRequestError("sendMessage", 0), new TelegramRequestError("sendMessage", 400)]) {
    let calls = 0;
    await assert.rejects(sendDepositCoinMenu(async () => { calls++; throw error; }, ["BTC"], "TOKEN", { BTC: { customEmojiId: "123" } }));
    assert.equal(calls, 1);
  }
});
