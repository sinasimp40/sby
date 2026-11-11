import { eq } from "drizzle-orm";
import { db, botConnections } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { configuredOwnerId } from "./admin-bootstrap";
import { providerCredentialStatus } from "./provider-credentials";
import { getBotRuntime, botRuntimeHealth } from "./bot-runtime";

export async function activeConnection() {
  const [connection] = await db.select().from(botConnections).where(eq(botConnections.id, "primary"));
  return connection && connection.ownerId === configuredOwnerId() ? connection : null;
}
export async function integrationStatus(ownerId: string | null) {
  const connection = ownerId ? await activeConnection() : null;
  const isOperator = Boolean(ownerId && configuredOwnerId() === ownerId);
  const credentials = isOperator ? await providerCredentialStatus(ownerId!) : null;
  const runtime = await getBotRuntime();
  const health = botRuntimeHealth(runtime, Boolean(connection?.active === "yes"));
  return {
    signedIn: Boolean(ownerId), ownerId: ownerId ?? "",
    ownerBound: Boolean(configuredOwnerId()), isOperator,
    tokenPresent: Boolean(credentials?.telegramTokenPresent),
    apiKeyPresent: Boolean(credentials?.nowpaymentsApiKeyPresent),
    ipnSecretPresent: Boolean(credentials?.ipnSecretPresent),
    telegramVerified: Boolean(credentials?.telegramVerified),
    nowpaymentsVerified: Boolean(credentials?.nowpaymentsVerified),
    telegramProcessingEnabled: runtime.enabled,
    telegramTransport: runtime.transport,
    telegramRuntimeState: health.state,
    telegramRuntimeError: isOperator ? health.error : "",
    telegramLastCheckedAt: isOperator ? health.checkedAt : null,
    publicUrl: isOperator ? runtime.publicUrl : "",
    botUsername: isOperator ? connection?.botUsername ?? credentials?.verifiedBotUsername ?? "" : "",
    connected: Boolean(isOperator && runtime.enabled && connection?.active === "yes" && ["running", "webhook"].includes(health.state)),
    settlementStatus: "finished" as const,
  };
}
export function requireOperator(ownerId: string | null) {
  if (!ownerId) throw new CommerceError("Sign in first.", 401);
  if (configuredOwnerId() !== ownerId) throw new CommerceError("Sign in as the configured admin, or bind TELECART_OWNER_ID to your signed-in owner ID before using the shared bot.", 403);
}
