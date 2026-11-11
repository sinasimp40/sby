import test from "node:test";
import assert from "node:assert/strict";
import { paymentCaption, paymentStatusLabel, type InvoiceMessage } from "../src/lib/payment-message";
import { customerMessageText, depositCoinPrompt, depositPrompt, depositReceipt, walletSummary } from "../src/lib/telegram-copy";

const now = Date.parse("2026-11-11T12:00:00Z");
const invoice: InvoiceMessage = {
  id: "abcd1234-TEST-ONLY", address: "TEST_ONLY_LTC_ADDRESS",
  payAmount: "0.0978356", coin: "ltc", network: "Litecoin",
  extraId: null, expiresAt: new Date(now + 30 * 60000),
  title: "Wallet deposit", amountUSD: "5.00", status: "waiting", fulfillment: "pending",
};

test("deposit and wallet copy is formatted, clear and provider-neutral", () => {
  const messages = [depositPrompt(5), walletSummary(1234, 5), depositCoinPrompt(500), depositReceipt(500, invoice.id)];
  for (const message of messages) {
    assert.match(message, /<b>/);
    assert.doesNotMatch(message, /nowpayments|status: finished|credit\/delivery/i);
  }
  assert.match(messages[0]!, /Minimum deposit: <b>\$5\.00/);
  assert.match(messages[0]!, /\/cancel/);
  assert.match(messages[1]!, /\$12\.34/);
  assert.match(messages[2]!, /\$5\.00/);
  assert.match(customerMessageText("NOWPayments currently requires $7.00."), /\$7\.00/);
  assert.doesNotMatch(customerMessageText("NOWPayments / nowpayments / NowPayments"), /nowpayments/i);
});

test("waiting invoice preserves exact amount, network, address and QR warning", () => {
  const caption = paymentCaption(invoice, now);
  assert.match(caption, /<b>Wallet deposit<\/b>/);
  assert.match(caption, /Total: <b>\$5\.00<\/b>/);
  assert.match(caption, /Awaiting payment/);
  assert.match(caption, /<code>0\.0978356 LTC<\/code>/);
  assert.match(caption, /<code>TEST_ONLY_LTC_ADDRESS<\/code>/);
  assert.match(caption, /Litecoin/);
  assert.match(caption, /Pay before: <b>2026-11-11 12:30 UTC/);
  assert.match(caption, /QR contains the address only/);
  assert.match(caption, /Reference: abcd1234/);
  assert.doesNotMatch(caption, /nowpayments|after finished|Check payment/i);
  assert.ok(caption.length <= 1024);
});

test("every status remains neutral and never promises early wallet credit", () => {
  for (const status of ["waiting", "confirming", "confirmed", "sending", "partially_paid", "finished", "expired", "failed", "refunded", "rejected", "creating", "unexpected"]) {
    const caption = paymentCaption({ ...invoice, status }, now);
    assert.doesNotMatch(caption, /nowpayments|wallet credited|order delivered|after finished/i);
    assert.ok(caption.length <= 1024);
    if (status !== "waiting") {
      assert.doesNotMatch(caption, /<b>Send exactly<\/b>|TEST_ONLY_LTC_ADDRESS/);
    }
  }
  assert.match(paymentStatusLabel({ ...invoice, status: "finished", fulfillment: "credited" }, now), /wallet credited/);
  assert.match(paymentStatusLabel({ ...invoice, status: "finished", fulfillment: "delivered" }, now), /order delivered/);
  assert.match(paymentCaption({ ...invoice, status: "finished", fulfillment: "credited" }, now), /Do not send another payment/);
});

test("expired and review invoices cannot invite another payment", () => {
  for (const p of [{ ...invoice, expiresAt: new Date(now - 1) }, { ...invoice, fulfillment: "review" }]) {
    const caption = paymentCaption(p, now);
    assert.doesNotMatch(caption, /TEST_ONLY_LTC_ADDRESS|<b>Send exactly<\/b>/);
    assert.match(caption, /[Dd]o not (send|pay)/);
  }
});

test("HTML is escaped and required memo remains exact", () => {
  const caption = paymentCaption({ ...invoice, title: "<unsafe> & NOWPayments", extraId: "memo<&123" }, now);
  assert.match(caption, /&lt;unsafe&gt; &amp;/);
  assert.match(caption, /Required memo \/ tag/);
  assert.match(caption, /<code>memo&lt;&amp;123<\/code>/);
  assert.doesNotMatch(caption, /<unsafe>|nowpayments/i);
  const sol = paymentCaption({ ...invoice, coin: "sol", network: "SOL", payAmount: "0.05965059" }, now);
  assert.match(sol, /0\.05965059 SOL/);
  assert.match(sol, /Solana/);
});
