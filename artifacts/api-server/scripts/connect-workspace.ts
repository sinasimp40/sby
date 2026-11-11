import { initializeAdminBootstrap, configuredOwnerId } from "../src/lib/admin-bootstrap";
import { connectShop } from "../src/lib/connect-shop";
import { CommerceError, publicBaseUrl, telegram, nowpayments } from "../src/lib/commerce-providers";
import { pool } from "@workspace/db";

try {
  if (process.env.NODE_ENV === "production" || process.env.TELECART_ALLOW_WORKSPACE_TESTING !== "true") {
    throw new CommerceError("This command requires explicit workspace testing configuration.");
  }
  await initializeAdminBootstrap();
  const owner = configuredOwnerId();
  if (!owner) throw new CommerceError("Configure the first admin securely before connecting.");
  const result = await connectShop(owner);
  const hook = await telegram<{ url: string; pending_update_count: number }>("getWebhookInfo");
  const currencies = await nowpayments<{ currencies: string[] }>("/currencies");
  console.info(JSON.stringify({
    bot: `@${result.botUsername}`,
    webhookMatches: hook.url === `${publicBaseUrl()}/api/telegram/webhook`,
    pendingUpdates: hook.pending_update_count,
    nowpaymentsAuthenticated: Array.isArray(currencies.currencies) && currencies.currencies.length > 0,
    settlement: "finished",
  }));
} catch (error) {
  // Never log raw SDK errors, which may embed request credentials.
  console.error(error instanceof CommerceError ? error.message : "Workspace setup failed; check the configured admin and server settings.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
