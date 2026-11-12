import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const advertisingBots = pgTable("advertising_bots", {
  ownerId: text("owner_id").primaryKey(),
  botId: text("bot_id"),
  username: text("username").notNull().default(""),
  tokenEncrypted: text("token_encrypted"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  updateOffset: integer("update_offset").notNull().default(0),
  nextSendAt: timestamp("next_send_at", { withTimezone: true }).notNull().defaultNow(),
  draft: jsonb("draft").notNull().default({ text: "", imageUrl: null, buttonText: "Visit shop", buttonUrl: null }),
}, table => [uniqueIndex("advertising_bot_identity").on(table.botId)]);
export const advertisingGroups = pgTable("advertising_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  target: text("target").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull().default(""),
  chatId: text("chat_id"),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").notNull().default("pending"),
  note: text("note").notNull().default("Check posting permissions before sending."),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  accountGeneration: integer("account_generation"),
}, table => [
  uniqueIndex("advertising_group_target").on(table.ownerId, table.target),
  uniqueIndex("advertising_group_chat").on(table.ownerId, table.chatId),
]);
export const advertisingCampaigns = pgTable("advertising_campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  botId: text("bot_id").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  draft: jsonb("draft").notNull(),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("advertising_campaign_request").on(table.ownerId, table.idempotencyKey)]);
export const advertisingDeliveries = pgTable("advertising_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id").notNull(),
  campaignId: uuid("campaign_id").notNull().references(() => advertisingCampaigns.id),
  groupId: uuid("group_id").notNull(),
  chatId: text("chat_id").notNull(),
  target: text("target").notNull(),
  status: text("status").notNull().default("pending"),
  note: text("note").notNull().default("Waiting to send."),
  attempts: integer("attempts").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, table => [uniqueIndex("advertising_campaign_recipient").on(table.campaignId, table.chatId)]);
export const insertAdvertisingBotSchema = createInsertSchema(advertisingBots);
export const insertAdvertisingGroupSchema = createInsertSchema(advertisingGroups);
export const insertAdvertisingCampaignSchema = createInsertSchema(advertisingCampaigns);
export const insertAdvertisingDeliverySchema = createInsertSchema(advertisingDeliveries);
export type AdvertisingBotRow = typeof advertisingBots.$inferSelect;
export type AdvertisingGroupRow = typeof advertisingGroups.$inferSelect;
