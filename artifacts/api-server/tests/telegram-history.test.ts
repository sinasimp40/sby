import test from "node:test";
import assert from "node:assert/strict";
import { historyCard, historyMenu, historyOrderView, historyStatus } from "../src/lib/telegram-history";

const now = Date.parse("2026-11-11T14:00:00Z");
const payment = {
  id: "12345678-1234-1234-1234-123456789012", kind: "deposit", productName: "Wallet deposit",
  amountCents: 500, coin: "sol", status: "waiting", fulfillment: "pending",
  cancelledAt: null as Date | null, expiresAt: new Date(now + 60000), createdAt: new Date(now - 60000),
};

test("top-up cards show the amount, method, date, reference and readable status", () => {
  const card = historyCard(payment, now);
  assert.match(card, /<blockquote>/);
  assert.match(card, /<b>Wallet top-up<\/b>/);
  assert.match(card, /\$5\.00/);
  assert.match(card, /SOL · Solana/);
  assert.match(card, /Waiting for payment/);
  assert.match(card, /2026-11-11 13:59 UTC/);
  assert.match(card, /<code>12345678-1234-1234-1234-123456789012<\/code>/);
  assert.doesNotMatch(card, /nowpayments|waiting · pending/i);
});

test("top-ups distinguish waiting, cancelled, expired, processing and actual success", () => {
  assert.match(historyStatus({ ...payment, cancelledAt: new Date(now) }, now), /Cancelled/);
  assert.match(historyStatus({ ...payment, expiresAt: new Date(now - 1) }, now), /Expired/);
  assert.match(historyStatus({ ...payment, status: "expired" }, now), /Expired/);
  assert.match(historyStatus({ ...payment, status: "finished" }, now), /not credited yet/);
  assert.match(historyStatus({ ...payment, status: "finished", fulfillment: "credited", cancelledAt: new Date(now) }, now), /Successful · wallet credited/);
  assert.match(historyStatus({ ...payment, status: "finished", fulfillment: "review" }, now), /Needs support review/);
  for (const status of ["confirming", "confirmed", "sending", "partially_paid"]) {
    assert.doesNotMatch(historyStatus({ ...payment, status, expiresAt: new Date(now - 1) }, now), /Expired|Successful/);
  }
  assert.match(historyStatus({ ...payment, status: "failed" }, now), /Failed/);
  assert.match(historyStatus({ ...payment, status: "refunded", fulfillment: "credited" }, now), /Refunded/);
});

test("purchase cards show product names and delivered success without exposing credentials", () => {
  const card = historyCard({
    ...payment, kind: "wallet", productName: "test1 <Premium> & NOWPayments", coin: "usd",
    amountCents: 10, status: "finished", fulfillment: "delivered",
  }, now);
  assert.match(card, /test1 &lt;Premium&gt; &amp;/);
  assert.match(card, /Product purchase/);
  assert.match(card, /Wallet balance/);
  assert.match(card, /\$0\.10/);
  assert.match(card, /Successful · delivered/);
  assert.doesNotMatch(card, /nowpayments|<Premium>/i);
});

test("history lists actual product and top-up buttons, not text-only cards", () => {
  const order = { ...payment, kind: "wallet", productName: "Premium Account", status: "finished", fulfillment: "delivered" };
  const menu = historyMenu([order, { ...payment, id: "87654321-1234-1234-1234-123456789012", cancelledAt: new Date(now) }], now);
  assert.doesNotMatch(menu.text, /<blockquote>|Premium Account/);
  const buttons = menu.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b => b.text.includes("Premium Account") && b.callback_data === `history_order:${order.id}:0`));
  assert.ok(buttons.some(b => b.text.includes("Top-up") && b.text.includes("Cancelled")));
  assert.ok(buttons.some(b => b.callback_data === "history_home"));
  assert.ok(buttons.every(b => Buffer.byteLength(b.callback_data) <= 64));
  assert.match(historyMenu([], now).text, /No purchases or wallet top-ups yet/);
});

test("order detail shows exact delivered data without provider-name substitution", () => {
  const order = { ...payment, kind: "wallet", productName: "Premium Account", fulfillment: "delivered" };
  const view = historyOrderView(order, "user:NOWPayments<&>\nsecond line", 0, now);
  assert.match(view.text, /<pre>user:NOWPayments&lt;&amp;&gt;\nsecond line<\/pre>/);
  assert.ok(view.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "history"));
  assert.ok(view.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "history_home"));
  assert.match(historyOrderView({ ...order, fulfillment: "pending" }, undefined, 0, now).text, /No inventory has been delivered/);
  assert.doesNotMatch(historyOrderView(payment, undefined, 0, now).text, /Delivered inventory|No inventory/);
});

test("long inventory details are paginated without truncation or broken HTML", () => {
  const credential = "<&>🔐".repeat(900);
  const order = { ...payment, kind: "wallet", productName: "<&>".repeat(100), fulfillment: "delivered" };
  const allParts: string[] = [];
  for (let page = 0; ; page++) {
    const view = historyOrderView(order, credential, page, now);
    assert.ok(view.text.length <= 4096);
    allParts.push(view.text.match(/<pre>([\s\S]*)<\/pre>/)![1]!);
    const next = view.reply_markup.inline_keyboard.flat().find(b => b.text === "Next part ➡️");
    if (!next) break;
    assert.ok(Buffer.byteLength(next.callback_data) <= 64);
  }
  assert.equal(allParts.join(""), credential.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
});
