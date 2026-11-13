import pg from "pg";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATABASE_TABLES } from "../../../scripts/local-core.mjs";

export async function inspectLocalDatabase(query, ownerId) {
  const tables = await query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
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
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is missing.");
    process.exitCode = 1;
    return;
  }
  const { Pool } = pg;
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const status = await inspectLocalDatabase(pool.query.bind(pool), process.env.TELECART_OWNER_ID);
    console.log(JSON.stringify(status));
  } catch {
    console.error("Could not connect to the configured PostgreSQL database. Check that PostgreSQL is running and its local connection details are correct. The connection URL was not displayed.");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) void main();
