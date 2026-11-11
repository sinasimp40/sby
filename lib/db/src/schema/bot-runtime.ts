import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botRuntimeSettings = pgTable("bot_runtime_settings", {
  ownerId: text("owner_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  transferReviewRequired: boolean("transfer_review_required").notNull().default(false),
  transport: text("transport").$type<"polling" | "webhook">().notNull().default("polling"),
  publicUrl: text("public_url").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
