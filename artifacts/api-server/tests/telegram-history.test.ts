import test from "node:test";
import assert from "node:assert/strict";
import { historyCard, historyMenu, historyOrderView, historyStatus, topupCategoryMenu, topupListMenu, type HistoryPage } from "../src/lib/telegram-history";

const now = Date.parse("2026-11-11T14:00:00Z");
const payment = {
  id: "12345678-1234-1234-1234-123456789012", kind: "deposit", productName: "Wallet deposit",
  amountCents: 500, coin: "sol", status: "waiting", fulfillment: "pending",
  cancelledAt: null as Date | null, expiresAt: new Date(now + 60000), createdAt: new Date(now - 60000),
};
const pageOf = (payments: HistoryPage["payments"], page = 0, total = payments.length): HistoryPage => ({
  payments, page, total, hasPrevious: page > 0, hasNext: (page + 1) * 10 < total,
});

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

test("history lists products and one Top-ups category, not individual deposits", () => {
  const order = { ...payment, kind: "wallet", productName: "Premium Account", status: "finished", fulfillment: "delivered" };
  const menu = historyMenu(pageOf([order]), 4, now);
  assert.doesNotMatch(menu.text, /<blockquote>|Premium Account/);
  const buttons = menu.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b => b.text.includes("Premium Account") && b.callback_data === `ho:${order.id}:0:o:0`));
  assert.equal(buttons.filter(b => b.text.includes("Top-ups")).length, 1);
  assert.ok(buttons.some(b => b.callback_data === "hist:t"));
  assert.ok(buttons.some(b => b.callback_data === "history_home"));
  assert.ok(buttons.every(b => Buffer.byteLength(b.callback_data) <= 64));
  assert.match(historyMenu(pageOf([]), 0, now).text, /No purchases yet/);
});

test("order detail shows exact delivered data without provider-name substitution", () => {
  const order = { ...payment, kind: "wallet", productName: "Premium Account", fulfillment: "delivered" };
  const view = historyOrderView(order, "user:NOWPayments<&>\nsecond line", 0, now);
  assert.match(view.text, /<pre>user:NOWPayments&lt;&amp;&gt;\nsecond line<\/pre>/);
  assert.ok(view.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "hist:o:0"));
  assert.ok(view.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "history_home"));
  assert.match(historyOrderView({ ...order, fulfillment: "pending" }, undefined, 0, now).text, /No inventory has been delivered/);
  assert.doesNotMatch(historyOrderView(payment, undefined, 0, now).text, /Delivered inventory|No inventory/);
});

test("top-up categories show waiting, cancelled, expired and successful buttons", () => {
  const view = topupCategoryMenu({ w: 1, c: 2, e: 23, s: 1, p: 0, f: 0, r: 0, v: 0 });
  const buttons = view.reply_markup.inline_keyboard.flat();
  for (const category of ["w", "c", "e", "s"]) {
    assert.ok(buttons.some(b => b.callback_data === `hist:${category}:0`));
  }
  assert.ok(buttons.some(b => b.text === "⌛ Expired (23)"));
});

test("lists show ten items with Next and Previous in that specific category", () => {
  const records = Array.from({ length: 10 }, (_, i) => ({
    ...payment, id: `12345678-1234-1234-1234-${String(i).padStart(12, "0")}`, status: "expired",
  }));
  const first = topupListMenu(pageOf(records, 0, 23), "e", now);
  const firstButtons = first.reply_markup.inline_keyboard.flat();
  assert.equal(firstButtons.filter(b => b.callback_data.startsWith("ho:")).length, 10);
  assert.ok(firstButtons.some(b => b.callback_data === "hist:e:1"));
  assert.ok(!firstButtons.some(b => b.text === "⬅️ Previous"));
  const last = topupListMenu(pageOf(records.slice(0, 3), 2, 23), "e", now);
  const lastButtons = last.reply_markup.inline_keyboard.flat();
  assert.equal(lastButtons.filter(b => b.callback_data.startsWith("ho:")).length, 3);
  assert.ok(lastButtons.some(b => b.callback_data === "hist:e:1"));
  assert.ok(!lastButtons.some(b => b.text === "Next ➡️"));
  assert.ok(!topupListMenu(pageOf(records), "e", now).reply_markup.inline_keyboard.flat().some(b => b.text === "Next ➡️"));
  const detail = historyOrderView(records[0]!, undefined, 0, now, "e", 2);
  assert.ok(detail.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "hist:e:2"));
  const orders = records.map(p => ({ ...p, kind: "wallet", productName: "Product" }));
  const root = historyMenu(pageOf(orders, 0, 11), 23, now);
  assert.ok(root.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "hist:o:1"));
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
