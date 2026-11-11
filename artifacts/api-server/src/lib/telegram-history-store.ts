import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, shopPayments } from "@workspace/db";
import type { HistoryPage, TopupCategory } from "./telegram-history";

const categorySql = (now: Date) => sql<string>`case
  when ${shopPayments.status} = 'refunded' then 'r'
  when ${shopPayments.fulfillment} in ('credited', 'delivered') then 's'
  when ${shopPayments.fulfillment} = 'review' then 'v'
  when ${shopPayments.cancelledAt} is not null and ${shopPayments.status} in ('creating', 'waiting', 'expired', 'failed', 'rejected') then 'c'
  when ${shopPayments.status} = 'expired' or (${shopPayments.status} in ('waiting', 'creating') and ${shopPayments.expiresAt} <= ${now.toISOString()}) then 'e'
  when ${shopPayments.status} in ('failed', 'rejected') then 'f'
  when ${shopPayments.status} in ('waiting', 'creating') then 'w'
  else 'p' end`;

export async function customerHistorySummary(ownerId: string, customerId: string, now = new Date()) {
  const category = categorySql(now);
  const rows = await db.select({
    kind: shopPayments.kind, category, count: sql<number>`count(*)::integer`,
  }).from(shopPayments).where(and(
    eq(shopPayments.ownerId, ownerId), eq(shopPayments.customerId, customerId),
  // Group by the selected CASE column, avoiding a second time parameter in
  // GROUP BY that PostgreSQL could treat as a different expression.
  )).groupBy(shopPayments.kind, sql`2`);
  const topups: Record<TopupCategory, number> = { w: 0, c: 0, e: 0, s: 0, p: 0, f: 0, r: 0, v: 0 };
  let orders = 0;
  for (const row of rows) {
    if (row.kind === "deposit") topups[row.category as TopupCategory] += row.count;
    else orders += row.count;
  }
  return { orders, topups };
}

export async function customerHistoryPage(
  ownerId: string, customerId: string, scope: "o" | TopupCategory, requestedPage: number,
  total: number, now = new Date(),
): Promise<HistoryPage> {
  const lastPage = Math.max(0, Math.ceil(total / 10) - 1);
  const page = Math.min(lastPage, Number.isSafeInteger(requestedPage) ? Math.max(0, requestedPage) : 0);
  const payments = await db.select().from(shopPayments).where(and(
    eq(shopPayments.ownerId, ownerId), eq(shopPayments.customerId, customerId),
    scope === "o" ? ne(shopPayments.kind, "deposit") : and(
      eq(shopPayments.kind, "deposit"), eq(categorySql(now), scope),
    ),
  )).orderBy(desc(shopPayments.createdAt), desc(shopPayments.id)).limit(10).offset(page * 10);
  return { payments, page, total, hasPrevious: page > 0, hasNext: page < lastPage };
}
