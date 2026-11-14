import { pgTable, text, integer, boolean, timestamp, primaryKey, index, uniqueIndex } from "./columns";
import { shopProducts } from "./shop-products";
import { botCustomers } from "./shop-commerce";

export const customerPromotionSettings = pgTable("customer_promotion_settings", {
  ownerId: text("owner_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  intervalMinutes: integer("interval_minutes").notNull().default(60),
  nextAt: timestamp("next_at", { withTimezone: true }),
  activeRoundId: text("active_round_id"),
  lastProductId: integer("last_product_id"),
  leaseToken: text("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true }),
  info: text("info").notNull().default("Customer promotions are disabled."),
});
export const customerPromotionProducts = pgTable("customer_promotion_products", {
  ownerId: text("owner_id").notNull(),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
}, t => [primaryKey({ columns: [t.ownerId, t.productId] })]);
export const customerPromotionPreferences = pgTable("customer_promotion_preferences", {
  ownerId: text("owner_id").notNull(),
  customerId: text("customer_id").notNull().references(() => botCustomers.id, { onDelete: "cascade" }),
  optedOut: boolean("opted_out").notNull().default(false),
  blocked: boolean("blocked").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.ownerId, t.customerId] })]);
export const customerPromotionRounds = pgTable("customer_promotion_rounds", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  productId: integer("product_id").references(() => shopProducts.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  status: text("status").notNull().default("running"),
  cursor: text("cursor").notNull().default(""),
  highwater: text("highwater").notNull().default(""),
  sent: integer("sent").notNull().default(0), failed: integer("failed").notNull().default(0),
  uncertain: integer("uncertain").notNull().default(0), skipped: integer("skipped").notNull().default(0),
  info: text("info").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [index("customer_promotion_round_owner_idx").on(t.ownerId, t.createdAt)]);
export const customerPromotionDeliveries = pgTable("customer_promotion_deliveries", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  roundId: text("round_id").notNull().references(() => customerPromotionRounds.id, { onDelete: "cascade" }),
  customerId: text("customer_id").notNull().references(() => botCustomers.id, { onDelete: "cascade" }),
  status: text("status").notNull(), attempts: integer("attempts").notNull().default(1),
  messageId: integer("message_id"), retryAt: timestamp("retry_at", { withTimezone: true }),
  error: text("error").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("customer_promotion_delivery_once_idx").on(t.roundId, t.customerId),
  index("customer_promotion_delivery_round_idx").on(t.roundId, t.status)]);
