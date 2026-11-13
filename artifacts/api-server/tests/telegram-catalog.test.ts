import test from "node:test";
import assert from "node:assert/strict";
import { productCatalogMenu } from "../src/lib/telegram-catalog";
import { isProductEmoji } from "../src/lib/product-emoji";

const products = Array.from({ length: 30 }, (_, index) => ({
  id: index + 1, name: `Sample ${index + 1}`, price: 2.5, stock: 5, status: "active",
}));
const buttons = (page: ReturnType<typeof productCatalogMenu>) => page.reply_markup.inline_keyboard.flat();
const purchases = (page: ReturnType<typeof productCatalogMenu>) =>
  buttons(page).filter(button => button.callback_data.startsWith("buy:"));

test("all 30 products are reachable across three ten-item pages", () => {
  const pages = [0, 1, 2].map(page => productCatalogMenu(products, page));
  for (const [index, page] of pages.entries()) {
    assert.equal(purchases(page).length, 10);
    assert.equal(page.reply_markup.inline_keyboard.filter(row =>
      row.some(button => button.callback_data.startsWith("buy:"))).length, 5);
    assert.ok(page.reply_markup.inline_keyboard.filter(row =>
      row.some(button => button.callback_data.startsWith("buy:"))).every(row => row.length === 2));
    assert.match(page.text, new RegExp(`Page <b>${index + 1} of 3`));
    assert.ok(purchases(page).every(button => button.text.includes("$2.50")));
    assert.ok(purchases(page).every(button => !button.text.includes("📦")), "catalog stock is shown when opening a product, not on its button");
    assert.ok(buttons(page).every(button => Buffer.byteLength(button.callback_data) <= 64));
  }
  assert.deepEqual(pages.flatMap(page => purchases(page).map(button => button.callback_data)),
    products.map(product => `buy:${product.id}`));
  assert.ok(!buttons(pages[0]).some(button => button.text.includes("Previous")));
  assert.ok(buttons(pages[0]).some(button => button.callback_data === "products:1"));
  assert.ok(buttons(pages[1]).some(button => button.callback_data === "products:0"));
  assert.ok(buttons(pages[1]).some(button => button.callback_data === "products:2"));
  assert.ok(!buttons(pages[2]).some(button => button.text.includes("Next")));
});

test("filters unavailable products before pagination without mutating input", () => {
  const input = [...products].reverse().concat([
    { ...products[0], id: 31, status: "draft" },
    { ...products[0], id: 32, status: "archived" },
    { ...products[0], id: 33, stock: 0 },
  ]);
  const snapshot = structuredClone(input);
  const page = productCatalogMenu(input);
  assert.equal(purchases(page)[0].callback_data, "buy:1");
  assert.match(page.text, /of 30/);
  assert.deepEqual(input, snapshot);
});

test("stale pages clamp when stock changes; invalid pages reset safely", () => {
  assert.equal(purchases(productCatalogMenu(products.slice(0, 12), 2)).length, 2);
  assert.match(productCatalogMenu(products.slice(0, 12), 2).text, /Page <b>2 of 2/);
  for (const page of [-1, NaN, Infinity, 0.5]) {
    assert.equal(purchases(productCatalogMenu(products, page))[0].callback_data, "buy:1");
  }
  const empty = productCatalogMenu([], 999);
  assert.match(empty.text, /No stock available/);
  assert.equal(purchases(empty).length, 0);
  assert.ok(buttons(empty).some(button => button.callback_data === "products:0"));
  assert.ok(buttons(empty).some(button => button.callback_data === "cancel_home"));
});

test("odd product counts keep the final product in a single-button row", () => {
  const page = productCatalogMenu(products.slice(0, 3));
  const rows = page.reply_markup.inline_keyboard.filter(row =>
    row.some(button => button.callback_data.startsWith("buy:")));
  assert.deepEqual(rows.map(row => row.length), [2, 1]);
  assert.deepEqual(purchases(page).map(button => button.callback_data), ["buy:1", "buy:2", "buy:3"]);
});

test("each product uses its saved ordinary emoji, with a safe legacy default", () => {
  const page = productCatalogMenu([
    { ...products[0], buttonEmoji: "🎮" },
    { ...products[1], buttonEmoji: "🔑" },
    { ...products[2], buttonEmoji: "not an emoji" },
    products[3],
  ]);
  assert.deepEqual(purchases(page).map(button => button.text.split(" ")[0]), ["🎮", "🔑", "🛍", "🛍"]);
  for (const emoji of ["🛍", "🎮", "👨‍👩‍👧‍👦", "🇩🇪", "👍🏽", "1️⃣"]) assert.equal(isProductEmoji(emoji), true);
  for (const value of ["", "VIP", "🎮🔑", "https://example.invalid/photo.png", "1", null]) assert.equal(isProductEmoji(value), false);
});

test("single and exact ten-item pages need no navigation, refresh preserves the page", () => {
  for (const size of [1, 10]) {
    const page = productCatalogMenu(products.slice(0, size));
    assert.equal(purchases(page).length, size);
    assert.ok(!buttons(page).some(button => /Previous|Next/.test(button.text)));
  }
  assert.ok(buttons(productCatalogMenu(products, 1)).some(button =>
    button.text.includes("Refresh") && button.callback_data === "products:1"));
});
