import { pgTable, text, timestamp, primaryKey } from "./columns";
import { createInsertSchema } from "drizzle-zod";

export const shopCustomEmojis = pgTable("shop_custom_emojis", {
  ownerId: text("owner_id").notNull(),
  customEmojiId: text("custom_emoji_id").notNull(),
  emoji: text("emoji").notNull(),
  setName: text("set_name"),
  format: text("format").$type<"static" | "animated" | "video">().notNull(),
  thumbnailFileId: text("thumbnail_file_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.ownerId, table.customEmojiId] })]);

// Short-lived authorization, like login sessions: deliberately not portable shop data.
export const emojiImportSessions = pgTable("emoji_import_sessions", {
  ownerId: text("owner_id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  chatId: text("chat_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const insertShopCustomEmojiSchema = createInsertSchema(shopCustomEmojis).omit({ createdAt: true });
export const insertEmojiImportSessionSchema = createInsertSchema(emojiImportSessions);
export type ShopCustomEmoji = typeof shopCustomEmojis.$inferSelect;
