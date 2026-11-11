import { eq } from "drizzle-orm";
import { db, botConnections } from "@workspace/db";
import { requireOperator } from "./commerce-connection";
import { CommerceError, telegramControl, webhookSecret } from "./commerce-providers";
import { getBotRuntime, httpsOrigin, type BotRuntimeConfig } from "./bot-runtime";

// Verifies identity before changing Telegram's receiver. Does not enable processing.
export async function connectShop(ownerId: string, config?: BotRuntimeConfig) {
  requireOperator(ownerId);
  const settings = config ?? await getBotRuntime(ownerId);
  const baseUrl = httpsOrigin(settings.publicUrl);
  if (settings.transport === "webhook" && !baseUrl) {
    throw new CommerceError("Webhook mode needs a public HTTPS origin. Choose Polling for localhost.");
  }
  const me = await telegramControl<{ id: number; username: string }>("getMe");
  const [existing] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  if (existing?.ownerId && existing.ownerId !== ownerId) throw new CommerceError("This bot is bound to another shop.", 409);
  if (existing && existing.botId !== String(me.id)) throw new CommerceError("The token belongs to a different bot. Existing buyers and payments require an explicit migration.", 409);
  if (settings.transport === "polling") {
    await telegramControl("deleteWebhook", { drop_pending_updates: false });
  } else {
    await telegramControl("setWebhook", {
      url: `${baseUrl}/api/telegram/webhook`, secret_token: webhookSecret(),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: false,
    });
  }
  await db.insert(botConnections).values({
    id: "primary", ownerId, botId: String(me.id), botUsername: me.username, publicUrl: baseUrl, active: "yes",
  }).onConflictDoUpdate({ target: botConnections.id, set: {
    ownerId, botId: String(me.id), botUsername: me.username, publicUrl: baseUrl, active: "yes", verifiedAt: new Date(),
  } });
  return { botUsername: me.username };
}
