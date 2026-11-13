import { pgTable, serial, text, jsonb, timestamp, index } from "./columns";
import { createInsertSchema } from "drizzle-zod";

// Provider-created business records; no administrator endpoint can fabricate payment confirmations.
export const shopRecords = pgTable("shop_records", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").$type<"order" | "customer" | "deposit">().notNull(),
  externalId: text("external_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("shop_records_owner_kind_idx").on(table.ownerId, table.kind)]);
export const insertShopRecordSchema = createInsertSchema(shopRecords).omit({ id: true, createdAt: true });
