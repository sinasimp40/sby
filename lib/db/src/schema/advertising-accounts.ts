import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "./columns";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";

export const advertisingAccounts = pgTable("advertising_accounts", {
  ownerId: text("owner_id").primaryKey(),
  apiId: integer("api_id"),
  apiHashEncrypted: text("api_hash_encrypted"),
  sessionEncrypted: text("session_encrypted"),
  accountId: text("account_id"),
  username: text("username").notNull().default(""),
  displayName: text("display_name").notNull().default(""),
  generation: integer("generation").notNull().default(0),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  nextSendAt: timestamp("next_send_at", { withTimezone: true }).notNull().defaultNow(),
  telegramWaitUntil: timestamp("telegram_wait_until", { withTimezone: true }).notNull().default(sql`'1970-01-01T00:00:00.000000Z'`),
  loginId: uuid("login_id"),
  loginEncrypted: text("login_encrypted"),
  loginExpiresAt: timestamp("login_expires_at", { withTimezone: true }),
});
export const advertisingSchedules = pgTable("advertising_schedules", {
  groupId: uuid("group_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  running: boolean("running").notNull().default(false),
  intervalSeconds: integer("interval_seconds").notNull().default(1800),
  batchSentCount: integer("batch_sent_count").notNull().default(0),
  revision: integer("revision").notNull().default(0),
  accountGeneration: integer("account_generation").notNull().default(0),
  draft: jsonb("draft"),
  nextSendAt: timestamp("next_send_at", { withTimezone: true }),
  lastStatus: text("last_status").notNull().default("stopped"),
  note: text("note").notNull().default("Select this group and confirm Start to begin."),
});
export const advertisingAccountRuns = pgTable("advertising_account_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  groupId: uuid("group_id").notNull(),
  target: text("target").notNull(),
  chatId: text("chat_id").notNull(),
  accountGeneration: integer("account_generation").notNull(),
  revision: integer("revision").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  draft: jsonb("draft").notNull(),
  randomId: text("random_id").notNull(),
  status: text("status").notNull().default("sending"),
  note: text("note").notNull().default("Waiting for Telegram confirmation."),
}, table => [uniqueIndex("advertising_account_occurrence").on(table.ownerId, table.groupId, table.revision, table.scheduledFor)]);
export const advertisingAccountCommands = pgTable("advertising_account_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  requestKey: uuid("request_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("advertising_account_start_request").on(table.ownerId, table.requestKey)]);
export const insertAdvertisingAccountSchema = createInsertSchema(advertisingAccounts);
export const insertAdvertisingScheduleSchema = createInsertSchema(advertisingSchedules);
export const insertAdvertisingAccountRunSchema = createInsertSchema(advertisingAccountRuns);
export const insertAdvertisingAccountCommandSchema = createInsertSchema(advertisingAccountCommands);
