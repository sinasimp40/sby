import { pgTable, serial, text, integer, timestamp, uniqueIndex, index, foreignKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { shopCustomEmojis } from "./custom-emojis";

export const shopProducts = pgTable("shop_products", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  imageUrl: text("image_url"),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(),
  status: text("status").$type<"active" | "draft" | "archived">().notNull().default("draft"),
  deliveryFormat: text("delivery_format").$type<"email:pass" | "user:pass">().notNull(),
  buttonEmoji: text("button_emoji").notNull().default("🛍"),
  buttonCustomEmojiId: text("button_custom_emoji_id"),
  stockAnnouncedAt: timestamp("stock_announced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("shop_products_owner_idx").on(table.ownerId),
  foreignKey({ columns: [table.ownerId, table.buttonCustomEmojiId],
    foreignColumns: [shopCustomEmojis.ownerId, shopCustomEmojis.customEmojiId] }),
]);

export const shopInventory = pgTable("shop_inventory", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  encryptedCredential: text("encrypted_credential").notNull(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").$type<"available" | "reserved" | "delivered">().notNull().default("available"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("shop_inventory_product_fingerprint_idx").on(table.productId, table.fingerprint),
  index("shop_inventory_owner_idx").on(table.ownerId),
]);

export const insertShopProductSchema = createInsertSchema(shopProducts).omit({ id: true, createdAt: true });
export const insertShopInventorySchema = createInsertSchema(shopInventory).omit({ id: true, createdAt: true });
export type ShopProduct = typeof shopProducts.$inferSelect;
export type ShopInventory = typeof shopInventory.$inferSelect;
