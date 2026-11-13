import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "./columns";
import { createInsertSchema } from "drizzle-zod";

// Installation-local work: outcomes also live on advertising_groups and travel
// in shop ZIPs, but these authorized RPC jobs must never resume after import.
export const advertisingMembershipJobs = pgTable("advertising_membership_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  accountId: text("account_id").notNull(),
  generation: integer("generation").notNull(),
  groupId: text("group_id"),
  target: text("target").notNull(),
  chatId: text("chat_id"),
  title: text("title").notNull().default(""),
  action: text("action").notNull(),
  status: text("status").notNull().default("pending"),
  note: text("note").notNull().default("Waiting"),
  requestKey: text("request_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  restoreAllowed: boolean("restore_allowed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("advertising_membership_request").on(table.ownerId, table.requestKey, table.target, table.action)]);
export const insertAdvertisingMembershipJobSchema = createInsertSchema(advertisingMembershipJobs);
