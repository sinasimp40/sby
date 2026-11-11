import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const providerCredentials = pgTable("provider_credentials", {
  ownerId: text("owner_id").primaryKey(),
  telegramTokenEncrypted: text("telegram_token_encrypted"),
  telegramVerifiedAt: timestamp("telegram_verified_at", { withTimezone: true }),
  telegramBotUsername: text("telegram_bot_username"),
  nowpaymentsApiKeyEncrypted: text("nowpayments_api_key_encrypted"),
  nowpaymentsVerifiedAt: timestamp("nowpayments_verified_at", { withTimezone: true }),
  nowpaymentsIpnSecretEncrypted: text("nowpayments_ipn_secret_encrypted"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProviderCredentialsSchema = createInsertSchema(providerCredentials);
export type ProviderCredentials = typeof providerCredentials.$inferSelect;
