import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, botCustomers, shopPayments } from "@workspace/db";
import { customerHistoryPage, customerHistorySummary } from "../src/lib/telegram-history-store";

test("history filters and paginates all customer records without leaking other histories", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development tests only.");
  const owner = `history-test-${randomUUID()}`;
  const customer = randomUUID();
  const otherCustomer = randomUUID();
  const otherOwnerCustomer = randomUUID();
  const customerIds = [customer, otherCustomer, otherOwnerCustomer];
  const now = new Date();
  const expired = new Date(now.getTime() - 60000);
  const future = new Date(now.getTime() + 60000);
  try {
    await db.insert(botCustomers).values(customerIds.map((id, index) => ({
      id, ownerId: index === 2 ? `other-${owner}` : owner, telegramId: randomUUID(), chatId: "TEST_ONLY", username: "TEST_ONLY",
    })));
    const base = () => ({
      id: randomUUID(), requestKey: randomUUID(), ownerId: owner, customerId: customer,
      kind: "deposit", amountCents: 500, coin: "sol", status: "waiting", expiresAt: future,
    });
    await db.insert(shopPayments).values([
      ...Array.from({ length: 23 }, (_, index) => ({ ...base(), status: index === 22 ? "waiting" : "expired", expiresAt: expired })),
      { ...base(), cancelledAt: now },
      { ...base(), status: "finished", fulfillment: "credited", cancelledAt: now },
      base(),
      { ...base(), status: "confirming", expiresAt: expired },
      ...Array.from({ length: 12 }, () => ({ ...base(), kind: "wallet", coin: "usd", status: "finished", fulfillment: "delivered" })),
      { ...base(), customerId: otherCustomer, status: "expired" },
      { ...base(), customerId: otherOwnerCustomer, ownerId: `other-${owner}`, status: "expired" },
    ]);
    const summary = await customerHistorySummary(owner, customer, now);
    assert.equal(summary.orders, 12);
    assert.deepEqual(summary.topups, { w: 1, c: 1, e: 23, s: 1, p: 1, f: 0, r: 0, v: 0 });
    const seen = new Set<string>();
    for (let page = 0; page < 3; page++) {
      const list = await customerHistoryPage(owner, customer, "e", page, summary.topups.e, now);
      assert.equal(list.payments.length, page === 2 ? 3 : 10);
      assert.equal(list.hasNext, page < 2);
      assert.equal(list.hasPrevious, page > 0);
      for (const entry of list.payments) {
        assert.equal(entry.kind, "deposit");
        assert.ok(!seen.has(entry.id));
        seen.add(entry.id);
      }
    }
    assert.equal(seen.size, 23);
    const orderPage = await customerHistoryPage(owner, customer, "o", 1, summary.orders, now);
    assert.equal(orderPage.payments.length, 2);
    assert.ok(orderPage.payments.every(p => p.kind === "wallet"));
    assert.equal((await customerHistoryPage(owner, customer, "e", 9999, 23, now)).page, 2);
    assert.equal((await customerHistoryPage(owner, customer, "e", -1, 23, now)).page, 0);
    const unrelated = await customerHistorySummary("UNKNOWN_OWNER", customer, now);
    assert.equal(unrelated.orders, 0);
    assert.equal(Object.values(unrelated.topups).reduce((a, b) => a + b, 0), 0);
  } finally {
    await db.delete(shopPayments).where(inArray(shopPayments.customerId, customerIds));
    await db.delete(botCustomers).where(inArray(botCustomers.id, customerIds));
    await pool.end();
  }
});
