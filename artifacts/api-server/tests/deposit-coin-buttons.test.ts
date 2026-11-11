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
