import { eq, and } from "drizzle-orm";
import { db, pool, botConnections } from "@workspace/db";
import { requireOperator } from "./commerce-connection";
import { CommerceError } from "./commerce-providers";
import { connectShop } from "./connect-shop";
import { getBotRuntime, saveBotRuntime, httpsOrigin, setPollingHealth, type BotRuntimeConfig } from "./bot-runtime";

interface RuntimeEffects {
  get: () => Promise<BotRuntimeConfig>;
  save: (config: BotRuntimeConfig) => Promise<void>;
  connect: (config: BotRuntimeConfig) => Promise<unknown>;
  deactivate: () => Promise<unknown>;
}
export async function applyBotRuntime(input: BotRuntimeConfig, acknowledgePolicy: boolean, effects: RuntimeEffects) {
  const publicUrl = httpsOrigin(input.publicUrl);
  if (input.publicUrl.trim() && !publicUrl) throw new CommerceError("Use a public HTTPS origin without a path, query, or credentials.");
  if (input.enabled && !acknowledgePolicy) throw new CommerceError("Confirm live Telegram processing and the provider rules first.");
  if (input.enabled && input.transport === "webhook" && !publicUrl) throw new CommerceError("Webhook mode requires a public HTTPS origin. Use Polling on localhost.");
  const previous = await effects.get();
  const changed = previous.transport !== input.transport || previous.publicUrl !== publicUrl;
  if (previous.enabled && input.enabled && changed) throw new CommerceError("Disable Telegram before changing its mode or callback URL.", 409);
  const config = { enabled: input.enabled, transport: input.transport, publicUrl };
  if (!input.enabled) {
    await effects.save(config);
    await effects.deactivate();
    setPollingHealth("disabled");
    return;
  }
  await effects.save({ ...config, enabled: false });
  try {
    await effects.connect(config);
    await effects.save(config);
    setPollingHealth("starting");
  } catch (error) {
    await effects.deactivate();
    throw error;
  }
}

export async function updateBotRuntime(ownerId: string, input: BotRuntimeConfig, acknowledgePolicy: boolean) {
  requireOperator(ownerId);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('telecart-runtime-control', 5))");
    await applyBotRuntime(input, acknowledgePolicy, {
      get: () => getBotRuntime(ownerId),
      save: config => saveBotRuntime(ownerId, config),
      connect: config => connectShop(ownerId, config),
      deactivate: () => db.update(botConnections).set({ active: "no" }).where(and(eq(botConnections.id, "primary"), eq(botConnections.ownerId, ownerId))),
    });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('telecart-runtime-control', 5))").catch(() => undefined);
    client.release();
  }
}
