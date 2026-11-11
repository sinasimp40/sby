import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const adminSessions = pgTable("admin_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  credentialVersion: text("credential_version").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const adminLoginLimits = pgTable("admin_login_limits", {
  bucket: text("bucket").primaryKey(),
  attempts: integer("attempts").notNull().default(1),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});
export const insertAdminSessionSchema = createInsertSchema(adminSessions);
export const insertAdminLoginLimitSchema = createInsertSchema(adminLoginLimits);
