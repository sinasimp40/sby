import { eq } from "drizzle-orm";
import { db, botConnections } from "@workspace/db";
import { CommerceError, publicBaseUrl } from "./commerce-providers";
import { configuredOwnerId } from "./admin-bootstrap";

export async function activeConnection() {
  const [connection] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  return connection && connection.ownerId === configuredOwnerId() ? connection : null;
}
export async function integrationStatus(ownerId: string | null) {
  const connection = ownerId ? await activeConnection() : null;
  const isOperator = Boolean(ownerId && configuredOwnerId() === ownerId);
  return {
    signedIn: Boolean(ownerId), ownerId: ownerId ?? "",
    ownerBound: Boolean(configuredOwnerId()), isOperator,
    tokenPresent: isOperator && Boolean(process.env.TELEGRAM_BOT_TOKEN),
    apiKeyPresent: isOperator && Boolean(process.env.NOWPAYMENTS_API_KEY),
    ipnSecretPresent: isOperator && Boolean(process.env.NOWPAYMENTS_IPN_SECRET),
    publicUrl: isOperator ? publicBaseUrl() : "",
    botUsername: isOperator ? connection?.botUsername ?? "" : "",
    connected: Boolean(isOperator && connection?.active === "yes"),
    settlementStatus: "finished" as const,
  };
}
export function requireOperator(ownerId: string | null) {
  if (!ownerId) throw new CommerceError("Sign in first.", 401);
  if (configuredOwnerId() !== ownerId) throw new CommerceError("Sign in as the configured admin, or bind TELECART_OWNER_ID to your signed-in owner ID before using the shared bot.", 403);
}
