import test from "node:test";
import assert from "node:assert/strict";
import { assertPendingPaymentLimit, isPendingCryptoPayment, pendingPaymentsMenu, PendingPaymentsError } from "../src/lib/pending-payments";
import type { Payment } from "../src/lib/commerce-payments";

const now = Date.now();
const pending = {
  kind: "deposit", status: "waiting", cancelledAt: null, fulfillment: "pending",
  expiresAt: new Date(now + 60000),
};

test("pending crypto invoices never block a wallet purchase", () => {
  assert.doesNotThrow(() => assertPendingPaymentLimit(true, Array(100).fill(pending), now));
  assert.throws(() => assertPendingPaymentLimit(false, [pending, pending, pending], now), PendingPaymentsError);
  assert.doesNotThrow(() => assertPendingPaymentLimit(false, [pending, pending], now));
});

test("cancelled and expired unpaid invoices do not consume pending slots", () => {
  const ignored = [
    { ...pending, cancelledAt: new Date(now) },
    { ...pending, expiresAt: new Date(now - 1) },
    { ...pending, status: "finished", fulfillment: "credited" },
    { ...pending, kind: "wallet" },
    { ...pending, status: "failed" },
  ];
  for (const row of ignored) assert.equal(isPendingCryptoPayment(row, now), false);
  assert.doesNotThrow(() => assertPendingPaymentLimit(false, [...ignored, pending, pending], now));
  for (const status of ["confirming", "confirmed", "sending", "partially_paid"]) {
    assert.equal(isPendingCryptoPayment({ ...pending, status, expiresAt: new Date(now - 1) }, now), true);
  }
});

test("pending menu provides view, cancel, refresh, home and new deposit controls", () => {
  const row = { ...pending, id: "12345678-1234-1234-1234-123456789012", amountCents: 500, coin: "sol" } as Payment;
  const menu = pendingPaymentsMenu([row]);
  assert.match(menu.text, /\$5\.00 · SOL/);
  assert.match(menu.text, /wallet balance is still available/);
  assert.match(menu.text, /already sent will still be verified/);
  const buttons = menu.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b => b.callback_data === `pending_view:${row.id}`));
  assert.ok(buttons.some(b => b.callback_data === `pending_cancel:${row.id}`));
  assert.ok(buttons.some(b => b.callback_data === "deposit_new"));
  assert.ok(buttons.every(b => Buffer.byteLength(b.callback_data) <= 64));
  assert.equal(pendingPaymentsMenu([row, row, row]).reply_markup.inline_keyboard.flat().some(b => b.callback_data === "deposit_new"), false);
  assert.match(pendingPaymentsMenu([]).text, /no pending crypto payments/);
});
