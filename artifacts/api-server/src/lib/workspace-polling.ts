import { pool } from "@workspace/db";
import { activeConnection } from "./commerce-connection";
import { telegram } from "./commerce-providers";
import { handleTelegramUpdate, type TelegramUpdate } from "./telegram-shop";
import { logger } from "./logger";

export function workspacePollingEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.TELECART_ALLOW_WORKSPACE_TESTING === "true";
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function pollBatch(
  updates: TelegramUpdate[],
  handle: (update: TelegramUpdate) => Promise<void>,
  offset: number,
) {
  for (const update of updates) {
    await handle(update);
    // A failed handler must not acknowledge this update or any later update.
    offset = update.update_id + 1;
  }
  return offset;
}

// Workspace-only outbound transport. Production continues to use webhooks.
// A session lock prevents competing pollers during overlapping server restarts.
export async function runWorkspacePolling() {
  if (!workspacePollingEnabled()) return;
  for (;;) {
    const client = await pool.connect();
    let locked = false;
    try {
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('telecart-workspace-poller', 3)) AS locked");
      locked = lock.rows[0]?.locked === true;
      if (!locked) { await delay(3000); continue; }
      let offset = 0;
      let initializedBot = "";
      for (;;) {
        const connection = await activeConnection();
        if (!connection || connection.active !== "yes") {
          initializedBot = "";
          await delay(2000);
          continue;
        }
        try {
          if (initializedBot !== connection.botId) {
            await telegram("deleteWebhook", { drop_pending_updates: false });
            initializedBot = connection.botId;
            logger.info("Workspace Telegram polling connected; pending messages are preserved.");
          }
          const updates = await telegram<TelegramUpdate[]>("getUpdates", {
            offset, timeout: 8, limit: 20, allowed_updates: ["message", "callback_query"],
          });
          offset = await pollBatch(updates, handleTelegramUpdate, offset);
          if (updates.length) logger.info({ count: updates.length }, "Telegram messages processed successfully.");
        } catch {
          logger.warn("Workspace Telegram processing failed; unacknowledged messages will retry.");
          await delay(3000);
        }
      }
    } catch {
      logger.warn("Workspace Telegram poller disconnected; reconnecting.");
      await delay(3000);
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('telecart-workspace-poller', 3))").catch(() => undefined);
      client.release();
    }
  }
}
