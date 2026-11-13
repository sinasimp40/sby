import { integer, jsonb, pgTable, text, timestamp } from "./columns";
import { createInsertSchema } from "drizzle-zod";

// Installation-local authorization/progress, deliberately excluded from ZIPs.
export const advertisingCheckpoints = pgTable("advertising_checkpoints", {
  ownerId: text("owner_id").primaryKey(),
  planId: text("plan_id").notNull(),
  accountId: text("account_id").notNull(),
  revision: integer("revision").notNull().default(1),
  state: text("state").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertAdvertisingCheckpointSchema = createInsertSchema(advertisingCheckpoints);
export type AdvertisingCheckpointRow = typeof advertisingCheckpoints.$inferSelect;
