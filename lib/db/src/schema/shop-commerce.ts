import { pgTable, text, integer, timestamp, jsonb, boolean, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { shopProducts, shopInventory } from "./shop-products";

export const botConnections = pgTable("bot_connections", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  botId: text("bot_id").notNull(),
  botUsername: text("bot_username").notNull(),
  publicUrl: text("public_url").notNull(),
  active: text("active").notNull().default("yes"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
});
export const botCustomers = pgTable("bot_customers", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  telegramId: text("telegram_id").notNull(),
  chatId: text("chat_id").notNull(),
  username: text("username").notNull(),
  balanceCents: integer("balance_cents").notNull().default(0),
  state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("bot_customer_owner_telegram_idx").on(t.ownerId, t.telegramId),
  check("bot_customer_nonnegative_balance", sql`${t.balanceCents} >= 0`),
]);
export const shopPayments = pgTable("shop_payments", {
  id: text("id").primaryKey(),
  requestKey: text("request_key").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  customerId: text("customer_id").notNull().references(() => botCustomers.id),
  kind: text("kind").notNull(),
  productId: integer("product_id").references(() => shopProducts.id, { onDelete: "set null" }),
  inventoryId: integer("inventory_id").references(() => shopInventory.id, { onDelete: "restrict" }),
  productName: text("product_name").notNull().default("Wallet deposit"),
  amountCents: integer("amount_cents").notNull(),
  coin: text("coin").notNull(),
  rateMode: text("rate_mode").notNull().default("fixed"),
  providerPaymentId: text("provider_payment_id").unique(),
  address: text("address"),
  payAmount: text("pay_amount"),
  receivedAmount: text("received_amount"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  invoiceMessageId: integer("invoice_message_id"),
  invoiceCaptionHash: text("invoice_caption_hash"),
  invoiceNeedsUpdate: boolean("invoice_needs_update").notNull().default(false),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  extraId: text("extra_id"),
  network: text("network"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").notNull().default("creating"),
  fulfillment: text("fulfillment").notNull().default("pending"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("shop_payments_owner_idx").on(t.ownerId),
  check("shop_payment_positive_amount", sql`${t.amountCents} > 0`),
]);
export const walletEntries = pgTable("wallet_entries", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull().references(() => botCustomers.id),
  paymentId: text("payment_id").notNull().unique().references(() => shopPayments.id),
  amountCents: integer("amount_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const botUpdates = pgTable("bot_updates", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertBotConnectionSchema = createInsertSchema(botConnections);
export const insertBotCustomerSchema = createInsertSchema(botCustomers);
export const insertShopPaymentSchema = createInsertSchema(shopPayments);
export const insertWalletEntrySchema = createInsertSchema(walletEntries);
export type ShopPayment = typeof shopPayments.$inferSelect;
