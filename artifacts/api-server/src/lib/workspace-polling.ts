import { pool } from "@workspace/db";
import { activeConnection } from "./commerce-connection";
import { getBotRuntime, setPollingHealth, type BotRuntimeConfig } from "./bot-runtime";
import { telegram, TelegramRequestError } from "./commerce-providers";
import { handleTelegramUpdate, type TelegramUpdate } from "./telegram-shop";
import { logger } from "./logger";

export function pollingEnabled(config: BotRuntimeConfig) {
  return config.enabled && config.transport === "polling";
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

// Dashboard-selected outbound transport, including localhost/self-hosted installs.
// A session lock prevents competing pollers during overlapping server restarts.
export async function runWorkspacePolling() {
  for (;;) {
    const requested = await getBotRuntime().catch(() => null);
    if (!requested) {
      setPollingHealth("error", "Cannot read Telegram settings from the database. Retrying.");
      await delay(3000); continue;
    }
    if (!pollingEnabled(requested)) {
      await delay(1500);
      continue;
    }
    const client = await pool.connect().catch(() => null);
    if (!client) {
      setPollingHealth("error", "Cannot connect to the Telegram worker database. Retrying.");
      await delay(3000); continue;
    }
    let locked = false;
    try {
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('telecart-workspace-poller', 3)) AS locked");
      locked = lock.rows[0]?.locked === true;
      if (!locked) {
        setPollingHealth("error", "Another server is polling this bot. Run only one copy, then disable and re-enable Telegram.");
        await delay(3000); continue;
      }
      let offset = 0;
      setPollingHealth("starting");
      for (;;) {
        const runtime = await getBotRuntime();
        if (!runtime.enabled || runtime.transport !== "polling") break;
        const connection = await activeConnection();
        if (!connection || connection.active !== "yes") {
          setPollingHealth("disabled");
          await delay(2000);
          continue;
        }
        try {
          const updates = await telegram<TelegramUpdate[]>("getUpdates", {
            offset, timeout: 8, limit: 20, allowed_updates: ["message", "callback_query"],
          });
          const latest = await getBotRuntime();
          if (!latest.enabled || latest.transport !== "polling") break;
          setPollingHealth("running");
          offset = await pollBatch(updates, handleTelegramUpdate, offset);
          if (updates.length) logger.info({ count: updates.length }, "Telegram messages processed successfully.");
        } catch (error) {
          const latest = await getBotRuntime();
          if (!latest.enabled || latest.transport !== "polling") break;
          const reason = error instanceof TelegramRequestError ? error.reason : "";
          setPollingHealth("error", reason === "other_poller" ? "Another computer or server is using this bot. Stop the other copy, then retry." :
            reason === "webhook_active" ? "A webhook is active elsewhere. Disable and re-enable Telegram to switch to polling." :
            error instanceof TelegramRequestError && error.providerStatus === 401 ? "Telegram rejected the token. Check and save the bot token again." :
            "Telegram could not process updates. Check the token and internet connection; the server will retry.");
          logger.warn({
            stage: error instanceof TelegramRequestError ? error.operation : "update_handler",
            providerStatus: error instanceof TelegramRequestError ? error.providerStatus : undefined,
            reason: error instanceof TelegramRequestError ? error.reason : undefined,
          }, "Workspace Telegram processing failed; unacknowledged messages will retry.");
          await delay(3000);
        }
      }
    } catch {
      setPollingHealth("error", "The Telegram worker lost its database connection. Reconnecting.");
      logger.warn("Workspace Telegram poller disconnected; reconnecting.");
      await delay(3000);
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('telecart-workspace-poller', 3))").catch(() => undefined);
      client.release();
    }
  }
}
