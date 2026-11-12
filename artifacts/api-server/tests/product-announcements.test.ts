import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, shopInventory, shopProducts } from "@workspace/db";
import { claimProductAnnouncement, newStockAnnouncement } from "../src/lib/product-announcements";

after(() => pool.end());

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
  const message = newStockAnnouncement(product, 3, true);
  assert.match(message.text, /✨ <b>NEW PRODUCT<\/b>/);
  assert.match(message.text, /🎮 <b>⭐ VIP &lt;Bundle&gt;<\/b>/);
  assert.match(message.text, /Fast delivery &amp; full access\./);
  assert.match(message.text, /💵 <b>\$4\.25<\/b>/);
  assert.match(message.text, /📦 <b>8 in stock<\/b>/);
  assert.match(message.text, /➕ 3 accounts just added/);
  assert.deepEqual(message.reply_markup.inline_keyboard, [[{
    text: "🛒 Buy now",
    callback_data: "buy:42",
  }]]);
});

test("restock and activation announcements omit a misleading stock-added count", () => {
  const restock = newStockAnnouncement({ ...product, stock: 1 }, 0);
  assert.match(restock.text, /📦 <b>ADDED STOCK<\/b>/);
  assert.match(restock.text, /📦 <b>1 in stock<\/b>/);
  assert.doesNotMatch(restock.text, /just added/);
});

test("later imports say added stock while keeping the amount and Buy now button", () => {
  const message = newStockAnnouncement(product, 2, false);
  assert.match(message.text, /<b>ADDED STOCK<\/b>/);
  assert.match(message.text, /2 accounts just added/);
  assert.doesNotMatch(message.text, /NEW PRODUCT/);
  assert.equal(message.reply_markup.inline_keyboard[0][0].callback_data, "buy:42");
});

test("first stocked announcement is remembered across concurrent calls and empty inventory", async () => {
  const ownerId = `announcement-test-${randomUUID()}`;
  const [row] = await db.insert(shopProducts).values({
    ownerId, name: "Announcement test", category: "", priceCents: 100,
    status: "active", deliveryFormat: "email:pass",
  }).returning();
  const productId = row!.id;
  const addStock = () => db.insert(shopInventory).values({
    ownerId, productId, encryptedCredential: "TEST_ONLY", fingerprint: randomUUID(),
  });
  try {
    assert.equal(await claimProductAnnouncement(ownerId, productId), null);
    await addStock();
    await db.update(shopProducts).set({ status: "draft" }).where(eq(shopProducts.id, productId));
    assert.equal(await claimProductAnnouncement(ownerId, productId), null);
    await db.update(shopProducts).set({ status: "active" }).where(eq(shopProducts.id, productId));
    const announcements = await Promise.all([
      claimProductAnnouncement(ownerId, productId),
      claimProductAnnouncement(ownerId, productId),
    ]);
    assert.equal(announcements.filter(item => item?.isNewProduct).length, 1);
    assert.equal(announcements.filter(item => item && !item.isNewProduct).length, 1);
    await db.delete(shopInventory).where(eq(shopInventory.productId, productId));
    assert.equal(await claimProductAnnouncement(ownerId, productId), null);
    await addStock();
    assert.equal((await claimProductAnnouncement(ownerId, productId))?.isNewProduct, false);
    assert.equal(await claimProductAnnouncement(`${ownerId}-other`, productId), null);
  } finally {
    await db.delete(shopProducts).where(eq(shopProducts.id, productId));
  }
});

test("catalog buttons show icon, name and price without stock count or Buy now label", async () => {
  const { productCatalogMenu } = await import("../src/lib/telegram-catalog");
  const menu = productCatalogMenu([{ ...product, price: 4.25 }]);
  const button = menu.reply_markup.inline_keyboard.flat().find(item => item.callback_data === "buy:42");
  assert.ok(button);
  assert.doesNotMatch(button.text, /Buy now/i);
  assert.match(button.text, /VIP/);
  assert.match(button.text, /\$4\.25/);
  assert.doesNotMatch(button.text, /📦|stock/i);
  assert.doesNotMatch(menu.text, /Available stock/);
  assert.doesNotMatch(button.text, /🛒/);
  const musicProduct = { ...product, name: "test1", price: 1, buttonEmoji: "🎵" };
  const ordinary = productCatalogMenu([musicProduct]).reply_markup.inline_keyboard[0]![0]!;
  assert.equal(ordinary.text, "🎵 test1 · $1.00");
  const custom = productCatalogMenu([{ ...musicProduct, buttonCustomEmojiId: "12345" }]).reply_markup.inline_keyboard[0]![0]!;
  assert.equal("icon_custom_emoji_id" in custom && custom.icon_custom_emoji_id, "12345");
  assert.equal(custom.text, "test1 · $1.00");
  const fallback = productCatalogMenu([{ ...musicProduct, buttonCustomEmojiId: "12345" }], 0, false).reply_markup.inline_keyboard[0]![0]!;
  assert.equal(fallback.text, "🎵 test1 · $1.00");
});
