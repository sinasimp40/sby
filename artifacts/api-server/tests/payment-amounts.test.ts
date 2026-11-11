import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { moneyCents } from "../src/lib/commerce-providers";
import { SaveSettingsBody } from "@workspace/api-zod";
import { defaultSettings } from "../src/lib/shop-defaults";
import { createCheckout } from "../src/lib/commerce-payments";

test("USD parsing, five-dollar deposits and wallet-only product checkout", async () => {
  try {
    for (const [amount, cents] of [["0.01", 1], ["0.04", 4], ["0.09", 9], ["0.10", 10], ["5", 500]] as const) {
      assert.equal(moneyCents(amount), cents);
    }
    for (const invalid of ["0", "0.00", "-0.01", "0.001", "NaN", "100000.01"]) {
      assert.throws(() => moneyCents(invalid));
    }
    assert.equal(defaultSettings.minDeposit, 5);
    assert.equal(defaultSettings.rateMode, "floating");
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: 5 }).success, true);
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: 10 }).success, true);
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: 4.99 }).success, false);
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: -1 }).success, false);
    const input = { ownerId: "unused", customerId: "unused", token: "unused", coin: "ltc", productId: 1, expectedAmountCents: 10 };
    await assert.rejects(createCheckout(input), /wallet balance/);
    await assert.rejects(createCheckout({ ...input, wallet: false }), /wallet balance/);
    await assert.rejects(createCheckout({ ...input, wallet: true, productId: undefined }), /only be used to purchase a product/);
  } finally {
    await pool.end();
  }
});
