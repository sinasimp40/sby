import { eq } from "drizzle-orm";
import { db, botConnections } from "@workspace/db";
import { requireOperator } from "./commerce-connection";
import { CommerceError, nowpayments, telegram, publicBaseUrl, webhookSecret } from "./commerce-providers";
import { workspacePollingEnabled } from "./workspace-polling";

// Shared by the authenticated admin action and trusted operator setup scripts.
export async function connectShop(ownerId: string) {
  requireOperator(ownerId);
  if (process.env.NODE_ENV !== "production" && process.env.TELECART_ALLOW_WORKSPACE_TESTING !== "true") {
    throw new CommerceError("Enable TELECART_ALLOW_WORKSPACE_TESTING for workspace testing.", 409);
  }
  const baseUrl = publicBaseUrl();
  if (!baseUrl) throw new CommerceError("Configure an HTTPS callback origin. Workspace testing must use this workspace's own development URL.");
  if (!process.env.NOWPAYMENTS_IPN_SECRET) throw new CommerceError("NOWPayments IPN secret is missing.");
  const [me] = await Promise.all([
    telegram<{ id: number; username: string }>("getMe"),
    nowpayments<{ currencies: string[] }>("/currencies"),
  ]);
  // Providers cannot reach a private or sleeping workspace. Fail before replacing
  // an existing webhook if the callback origin redirects to authentication.
  try {
    if (!workspacePollingEnabled()) {
    const response = await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(12000), redirect: "error" });
    const body = await response.json() as { status?: string };
    if (!response.ok || body.status !== "ok") throw new Error();
    }
  } catch {
    throw new CommerceError("The callback URL is not publicly reachable. Keep the workspace running and allow external access before connecting.", 409);
  }
  const [existing] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  if (existing?.ownerId && existing.ownerId !== ownerId) throw new CommerceError("This bot is bound to another shop.", 409);
  if (existing && existing.botId !== String(me.id)) throw new CommerceError("The token belongs to a different bot. Existing buyers and payments require an explicit migration.", 409);
  if (workspacePollingEnabled()) {
    await telegram("deleteWebhook", { drop_pending_updates: false });
  } else await telegram("setWebhook", {
    url: `${baseUrl}/api/telegram/webhook`, secret_token: webhookSecret(),
    allowed_updates: ["message", "callback_query"], drop_pending_updates: false,
  });
  await db.insert(botConnections).values({
    id: "primary", ownerId, botId: String(me.id), botUsername: me.username, publicUrl: baseUrl, active: "yes",
  }).onConflictDoUpdate({ target: botConnections.id, set: {
    ownerId, botId: String(me.id), botUsername: me.username, publicUrl: baseUrl, active: "yes", verifiedAt: new Date(),
  } });
  return { botUsername: me.username };
}
