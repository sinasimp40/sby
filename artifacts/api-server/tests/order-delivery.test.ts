import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, botCustomers, shopProducts, shopInventory, shopPayments, shopActivity } from "@workspace/db";
import { encryptCredential } from "../src/lib/inventory-encryption";
import { customerDeliveredInventory, revealDeliveredInventory } from "../src/lib/order-delivery";
import { recordsForOwner } from "../src/lib/shop-store";
import { RevealOrderDeliveryResponse } from "@workspace/api-zod";

test("delivered inventory reveal is exact, owner-scoped, audited and read-only", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development tests only.");
  const owner = `delivery-test-${randomUUID()}`;
  const customerId = randomUUID();
  const orderId = randomUUID();
  const plaintext = "SYNTHETIC_TEST_ONLY:user:password\n<literal>& spaces preserved";
  try {
    await db.insert(botCustomers).values({ id: customerId, ownerId: owner, telegramId: randomUUID(), chatId: "TEST_ONLY", username: "TEST_ONLY" });
    const [product] = await db.insert(shopProducts).values({
      ownerId: owner, name: "TEST_ONLY_DELIVERY", status: "draft",
      priceCents: 10, category: "test", deliveryFormat: "text",
    }).returning();
    const [stock] = await db.insert(shopInventory).values({
      ownerId: owner, productId: product!.id, encryptedCredential: encryptCredential(plaintext, owner, product!.id),
      fingerprint: randomUUID(), status: "delivered",
    }).returning();
    await db.insert(shopPayments).values({
      id: orderId, ownerId: owner, customerId, requestKey: randomUUID(), kind: "wallet",
      productId: product!.id, inventoryId: stock!.id, amountCents: 10, coin: "usd",
      status: "finished", fulfillment: "delivered", deliveredAt: new Date(),
    });
    await t.test("signed-out and other-owner requests cannot retrieve credentials", async () => {
      await assert.rejects(revealDeliveredInventory(null, orderId), e => (e as { status: number }).status === 401);
      await assert.rejects(revealDeliveredInventory("OTHER_OWNER", orderId), e => (e as { status: number }).status === 404);
      assert.equal((await db.select().from(shopActivity).where(eq(shopActivity.ownerId, owner))).length, 0);
    });
    await t.test("owning admin receives the exact delivered stock and audit omits plaintext", async () => {
      const result = RevealOrderDeliveryResponse.parse(await revealDeliveredInventory(owner, orderId));
      assert.equal(result.credential, plaintext);
      assert.equal(result.inventoryId, stock!.id);
      assert.equal(result.orderId, orderId);
      assert.ok(Date.parse(result.deliveredAt));
      const audit = await db.select().from(shopActivity).where(eq(shopActivity.ownerId, owner));
      assert.equal(audit.length, 1);
      assert.doesNotMatch(JSON.stringify(audit), /SYNTHETIC_TEST_ONLY|password|encryptedCredential/);
      assert.doesNotMatch(JSON.stringify(await recordsForOwner(owner, "order")), /SYNTHETIC_TEST_ONLY|password/);
      assert.equal((await db.select().from(shopInventory).where(eq(shopInventory.id, stock!.id)))[0]!.status, "delivered");
    });
    await t.test("Telegram customers can retrieve only their own delivered order", async () => {
      assert.equal((await customerDeliveredInventory(owner, customerId, orderId)).credential, plaintext);
      await assert.rejects(customerDeliveredInventory(owner, "OTHER_CUSTOMER", orderId), e => (e as { status: number }).status === 404);
      await assert.rejects(customerDeliveredInventory("OTHER_OWNER", customerId, orderId), e => (e as { status: number }).status === 404);
      await assert.rejects(customerDeliveredInventory(owner, "", orderId), e => (e as { status: number }).status === 404);
    });
    await t.test("allocated or undelivered orders and mismatched stock ownership cannot be revealed", async () => {
      await db.update(shopPayments).set({ fulfillment: "allocated", deliveredAt: null }).where(eq(shopPayments.id, orderId));
      await assert.rejects(revealDeliveredInventory(owner, orderId), e => (e as { status: number }).status === 404);
      await db.update(shopPayments).set({ fulfillment: "delivered", deliveredAt: new Date() }).where(eq(shopPayments.id, orderId));
      await db.update(shopInventory).set({ ownerId: "OTHER_OWNER" }).where(eq(shopInventory.id, stock!.id));
      await assert.rejects(revealDeliveredInventory(owner, orderId), e => (e as { status: number }).status === 404);
    });
  } finally {
    await db.delete(shopPayments).where(eq(shopPayments.ownerId, owner));
    await db.delete(shopInventory).where(eq(shopInventory.productId, (await db.select().from(shopProducts).where(eq(shopProducts.ownerId, owner)))[0]?.id ?? -1));
    await db.delete(shopProducts).where(eq(shopProducts.ownerId, owner));
    await db.delete(botCustomers).where(eq(botCustomers.ownerId, owner));
    await db.delete(shopActivity).where(eq(shopActivity.ownerId, owner));
    await pool.end();
  }
});
