import test from "node:test";
import assert from "node:assert/strict";
import { newStockAnnouncement } from "../src/lib/product-announcements";

const product = {
  id: 42,
  name: "⭐ VIP <Bundle>",
  description: "Fast delivery & full access.",
  priceCents: 425,
  buttonEmoji: "🎮",
  status: "active",
  stock: 8,
};

test("new-stock announcement shows escaped product details and its purchase callback", () => {
  const message = newStockAnnouncement(product, 3);
  assert.match(message.text, /✨ <b>NEW IN STOCK<\/b>/);
  assert.match(message.text, /🎮 <b>⭐ VIP &lt;Bundle&gt;<\/b>/);
  assert.match(message.text, /Fast delivery &amp; full access\./);
  assert.match(message.text, /💵 <b>\$4\.25<\/b>/);
  assert.match(message.text, /📦 <b>8 in stock<\/b>/);
  assert.match(message.text, /🆕 3 accounts just added/);
  assert.deepEqual(message.reply_markup.inline_keyboard, [[{
    text: "🛒 Buy now",
    callback_data: "buy:42",
  }]]);
});

test("restock and activation announcements omit a misleading stock-added count", () => {
  const restock = newStockAnnouncement({ ...product, stock: 1 }, 0);
  assert.match(restock.text, /📦 <b>1 in stock<\/b>/);
  assert.doesNotMatch(restock.text, /just added/);
});

test("catalog buttons plainly offer Buy now while retaining product and stock details", async () => {
  const { productCatalogMenu } = await import("../src/lib/telegram-catalog");
  const menu = productCatalogMenu([{ ...product, price: 4.25 }]);
  const button = menu.reply_markup.inline_keyboard.flat().find(item => item.callback_data === "buy:42");
  assert.ok(button);
  assert.match(button.text, /Buy now/);
  assert.match(button.text, /VIP/);
  assert.match(button.text, /\$4\.25/);
  assert.match(button.text, /📦 8/);
});
