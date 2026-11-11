import { eq } from "drizzle-orm";
import { botRuntimeSettings, db } from "@workspace/db";
import { configuredOwnerId } from "./admin-bootstrap";

export interface BotRuntimeConfig {
  enabled: boolean;
  transport: "polling" | "webhook";
  publicUrl: string;
}

export function httpsOrigin(raw: string): string {
  if (!raw.trim()) return "";
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "") ||
      /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)) return "";
    return url.origin;
  } catch { return ""; }
}

export function legacyPublicUrl() {
  const origin = httpsOrigin(process.env.TELECART_PUBLIC_URL ?? "");
  if (!origin) return "";
  const host = new URL(origin).hostname;
  if (host.endsWith(".replit.dev") && !(process.env.NODE_ENV !== "production" &&
    process.env.TELECART_ALLOW_WORKSPACE_TESTING === "true" && host === process.env.REPLIT_DEV_DOMAIN)) return "";
  return origin;
}

export async function getBotRuntime(ownerId = configuredOwnerId()): Promise<BotRuntimeConfig> {
  const [row] = ownerId ? await db.select().from(botRuntimeSettings).where(eq(botRuntimeSettings.ownerId, ownerId)) : [];
  if (row) return { enabled: row.enabled && !row.transferReviewRequired, transport: row.transport, publicUrl: row.publicUrl };
  return {
    enabled: process.env.TELECART_TELEGRAM_DISABLED !== "true",
    transport: process.env.NODE_ENV === "production" ? "webhook" : "polling",
    publicUrl: legacyPublicUrl(),
  };
}

export async function saveBotRuntime(ownerId: string, config: BotRuntimeConfig) {
  await db.insert(botRuntimeSettings).values({ ownerId, ...config }).onConflictDoUpdate({
    target: botRuntimeSettings.ownerId, set: { ...config, updatedAt: new Date() },
  });
}

type RuntimeState = "disabled" | "starting" | "running" | "error" | "webhook";
let pollingHealth: { state: RuntimeState; error: string; checkedAt: string | null } = {
  state: "starting", error: "", checkedAt: null,
};
export function setPollingHealth(state: RuntimeState, error = "") {
  pollingHealth = { state, error, checkedAt: new Date().toISOString() };
}
export function botRuntimeHealth(config: BotRuntimeConfig, bound: boolean) {
  if (!config.enabled || !bound) return { state: "disabled" as const, error: "", checkedAt: null };
  if (config.transport === "webhook") return { state: "webhook" as const, error: "", checkedAt: null };
  if (!pollingHealth.checkedAt || Date.now() - Date.parse(pollingHealth.checkedAt) > 30000) {
    return { state: "starting" as const, error: "Waiting for this server's Telegram poller.", checkedAt: pollingHealth.checkedAt };
  }
  return pollingHealth;
}
