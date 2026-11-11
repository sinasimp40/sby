import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { moneyCents } from "../src/lib/commerce-providers";
import { SaveSettingsBody } from "@workspace/api-zod";
import { defaultSettings } from "../src/lib/shop-defaults";

test("small payments have no ten-cent app floor and shop minimum is optional", async () => {
  try {
    for (const [amount, cents] of [["0.01", 1], ["0.04", 4], ["0.09", 9], ["0.10", 10], ["5", 500]] as const) {
      assert.equal(moneyCents(amount), cents);
    }
    for (const invalid of ["0", "0.00", "-0.01", "0.001", "NaN", "100000.01"]) {
      assert.throws(() => moneyCents(invalid));
    }
    assert.equal(defaultSettings.minDeposit, 0);
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: 0 }).success, true);
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: 0.01 }).success, true);
    assert.equal(SaveSettingsBody.safeParse({ ...defaultSettings, minDeposit: -1 }).success, false);
  } finally {
    await pool.end();
  }
});
