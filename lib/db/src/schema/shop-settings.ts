import { pgTable, text, jsonb, timestamp, serial, index } from "./columns";
import { createInsertSchema } from "drizzle-zod";

export const shopSettings = pgTable("shop_settings", {
  ownerId: text("owner_id").primaryKey(),
  preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shopActivity = pgTable("shop_activity", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  type: text("type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("shop_activity_owner_idx").on(table.ownerId)]);

export const insertShopSettingsSchema = createInsertSchema(shopSettings).omit({ updatedAt: true });
export const insertShopActivitySchema = createInsertSchema(shopActivity).omit({ id: true, createdAt: true });
