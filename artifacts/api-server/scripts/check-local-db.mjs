import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DATABASE_TABLES } from "../../../scripts/local-core.mjs";
import { resolveSqlitePath } from "../../../scripts/sqlite-path.mjs";
import { sqliteSchemaVersion } from "../../../scripts/init-sqlite.mjs";

export async function inspectLocalDatabase(query, ownerId) {
  const tables = await query(`
    SELECT name AS table_name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `);
  const actualTables = new Set(tables.rows.map(row => row.table_name));
  const status = {
    tableCount: actualTables.size,
    missingTables: DATABASE_TABLES.filter(table => !actualTables.has(table)),
    telegramEnabled: false,
    shopBotConnected: false,
    advertisingScheduled: false,
    pendingPayments: false,
  };
  if (status.missingTables.length === 0 && ownerId) {
    const active = await query(`
      SELECT
        EXISTS (SELECT 1 FROM bot_runtime_settings
          WHERE owner_id = $1 AND enabled = true AND transfer_review_required = false) AS telegram_enabled,
        EXISTS (SELECT 1 FROM bot_connections connection
          JOIN bot_runtime_settings runtime USING (owner_id)
          WHERE connection.owner_id = $1 AND connection.active = 'yes'
            AND runtime.enabled = true AND runtime.transfer_review_required = false) AS shop_bot_connected,
        EXISTS (SELECT 1 FROM advertising_schedules
          WHERE owner_id = $1 AND running = true) AS advertising_scheduled,
        EXISTS (SELECT 1 FROM shop_payments
          WHERE owner_id = $1 AND provider_payment_id IS NOT NULL
            AND (delivered_at IS NULL OR invoice_needs_update = true)) AS pending_payments
    `, [ownerId]);
    const row = active.rows[0];
    status.telegramEnabled = row.telegram_enabled;
    status.shopBotConnected = row.shop_bot_connected;
    status.advertisingScheduled = row.advertising_scheduled;
    status.pendingPayments = row.pending_payments;
  }
  return status;
}

async function main() {
  const configuredPath = process.env.TELECART_SQLITE_PATH;
  if (!configuredPath) {
    console.error("TELECART_SQLITE_PATH is missing.");
    process.exitCode = 1;
    return;
  }
  let database;
  try {
    const path = resolveSqlitePath(configuredPath);
    if (!existsSync(path)) {
      console.log(JSON.stringify({ tableCount: 0, missingTables: DATABASE_TABLES,
        telegramEnabled: false, shopBotConnected: false, advertisingScheduled: false, pendingPayments: false }));
      return;
    }
    database = new DatabaseSync(path, { readOnly: true });
    const query = async (source, values = []) => {
      const params = [];
      const sql = source.replace(/\$(\d+)/g, (_, n) => { params.push(values[Number(n) - 1]); return "?"; });
      return { rows: database.prepare(sql).all(...params) };
    };
    const status = await inspectLocalDatabase(query, process.env.TELECART_OWNER_ID);
    const version = Number(database.prepare("PRAGMA user_version").get().user_version);
    status.needsMigration = version > 0 && version < sqliteSchemaVersion;
    status.unsupportedSchema = version > sqliteSchemaVersion || (version === 0 && status.tableCount > 0);
    console.log(JSON.stringify(status));
  } catch {
    console.log(JSON.stringify({ errorCode: "SQLITE_OPEN_FAILED" }));
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) void main();
