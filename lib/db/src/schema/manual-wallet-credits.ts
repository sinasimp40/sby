import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, uniqueIndex, index, check } from "./columns";
import { botCustomers } from "./shop-commerce";

/** Explicit owner-issued funds, never represented as a paid provider invoice. */
export const manualWalletCredits = pgTable("manual_wallet_credits", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  customerId: text("customer_id").notNull().references(() => botCustomers.id),
  requestKey: text("request_key").notNull(),
  actorId: text("actor_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  balanceBeforeCents: integer("balance_before_cents").notNull(),
  balanceAfterCents: integer("balance_after_cents").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("manual_wallet_credit_request_idx").on(t.ownerId, t.requestKey),
  index("manual_wallet_credit_customer_idx").on(t.ownerId, t.customerId, t.createdAt, t.id),
  check("manual_wallet_credit_values", sql`${t.amountCents} > 0 AND ${t.amountCents} <= 2000000000
    AND ${t.balanceBeforeCents} >= 0 AND ${t.balanceAfterCents} <= 2000000000
    AND ${t.balanceAfterCents} = ${t.balanceBeforeCents} + ${t.amountCents}`),
]);
