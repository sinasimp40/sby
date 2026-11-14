import type { PoolClient } from "@workspace/db";
import {
  tableKeys, tableInfo, quote, MAX_TRANSFER_ROWS, type TransferTable, type TransferRow, type TransferData,
} from "./shop-transfer-tables";
import { CommerceError } from "./commerce-providers";
import { PROMOTION_HISTORY_ROUNDS, PROMOTION_HISTORY_DELIVERIES } from "./customer-promotions-retention";

export async function readShopTransferData(client: PoolClient, ownerId: string): Promise<TransferData> {
  const data = {} as TransferData;
  let total = 0;
  // Financial/shop state gets the existing budget first. Optional recent
  // promotion audit must never make an otherwise exportable shop unexportable.
  const history = ["promotionRounds", "promotionDeliveries"] as const;
  for (const key of [...tableKeys.filter(key => !history.includes(key as typeof history[number])), ...history]) {
    const info = tableInfo(key);
    const columns = info.columns.map(([name, column]) => {
      const field = `t.${quote(column.name)}`;
      const value = column.dataType === "date" ? `iso_time(${field})` : field;
      return `${value} AS ${quote(name)}`;
    }).join(", ");
    let where = 't."owner_id" = $1';
    let value = ownerId;
    if (key === "walletEntries") where = 't."customer_id" IN (SELECT id FROM bot_customers WHERE owner_id = $1)';
    if (key === "updates") {
      const connection = data.connection[0];
      if (!connection) { data[key] = []; continue; }
      where = `split_part(t."id", ':', 1) = $1`;
      value = String(connection.botId);
    }
    let limit = MAX_TRANSFER_ROWS + 1, order = "";
    const parameters: unknown[] = [value];
    if (key === "promotionRounds") {
      limit = Math.min(PROMOTION_HISTORY_ROUNDS, MAX_TRANSFER_ROWS - total);
      parameters.push(data.promotionSettings[0]?.activeRoundId ?? "");
      order = " ORDER BY CASE WHEN t.id=$2 THEN 0 ELSE 1 END,t.created_at DESC,t.id DESC";
    } else if (key === "promotionDeliveries") {
      if (!data.promotionRounds.length) { data[key] = []; continue; }
      limit = Math.min(PROMOTION_HISTORY_DELIVERIES, MAX_TRANSFER_ROWS - total);
      where += " AND t.round_id=ANY($2::text[])";
      parameters.push(data.promotionRounds.map(row => row.id));
      order = " ORDER BY CASE WHEN t.status IN ('sending','retry') THEN 0 ELSE 1 END,t.updated_at DESC,t.id DESC";
    }
    const result = await client.query(`SELECT /*portable*/ ${columns} FROM ${quote(info.name)} t WHERE ${where}${order} LIMIT ${limit}`, parameters);
    total += result.rowCount ?? 0;
    if (total > MAX_TRANSFER_ROWS) throw new CommerceError("Shop exceeds the 50,000-row portable transfer limit. No partial export was created.", 413);
    data[key] = result.rows.map(row => Object.fromEntries(info.columns.map(([name, column]) => [
      name, column.dataType === "boolean" && row[name] !== null ? Boolean(row[name]) : row[name],
    ])));
  }
  const roundIds = new Set(data.promotionRounds.map(row => row.id));
  for (const config of data.promotionSettings) if (config.activeRoundId && !roundIds.has(config.activeRoundId)) {
    config.activeRoundId = null; config.leaseToken = null; config.leaseUntil = null;
  }
  // If the budget omitted an in-flight/retry detail, still carry its safe
  // transfer outcome in the retained aggregate. Import converts included ones.
  if (roundIds.size) {
    const pending = await client.query(`SELECT round_id,status,count(*)::integer AS count FROM customer_promotion_deliveries
      WHERE owner_id=$1 AND round_id=ANY($2::text[]) AND status IN ('sending','retry') GROUP BY round_id,status`, [ownerId, [...roundIds]]);
    for (const row of pending.rows) {
      const round = data.promotionRounds.find(round => round.id === row.round_id)!;
      const included = data.promotionDeliveries.filter(delivery => delivery.roundId === row.round_id && delivery.status === row.status).length;
      const key = row.status === "sending" ? "uncertain" : "skipped";
      round[key] = Number(round[key]) + Number(row.count) - included;
    }
  }
  return data;
}

export async function insertTransferRow(client: PoolClient, key: TransferTable, row: TransferRow, omitId = false) {
  const info = tableInfo(key);
  const columns = info.columns.filter(([name]) => !omitId || name !== "id");
  const values = columns.map(([name, column]) => column.dataType === "json" && typeof row[name] !== "string" ? JSON.stringify(row[name]) : row[name]);
  const result = await client.query(
    `INSERT INTO ${quote(info.name)} (${columns.map(([, col]) => quote(col.name)).join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`, values,
  );
  return result.rows[0] as Record<string, unknown>;
}

export async function insertTransferRows(client: PoolClient, key: TransferTable, rows: TransferRow[], omitId: boolean, deadline: number) {
  const info = tableInfo(key);
  const columns = info.columns.filter(([name]) => !omitId || name !== "id");
  for (let start = 0; start < rows.length; start += 250) {
    if (Date.now() > deadline) throw new CommerceError("Import exceeded its safety time limit. All changes were rolled back.", 409);
    const batch = rows.slice(start, start + 250);
    const values = batch.flatMap(row => columns.map(([name, column]) => column.dataType === "json" && typeof row[name] !== "string" ? JSON.stringify(row[name]) : row[name]));
    const placeholders = batch.map((_, row) => `(${columns.map((_, col) => `$${row * columns.length + col + 1}`).join(",")})`).join(",");
    await client.query(`INSERT INTO ${quote(info.name)} (${columns.map(([, col]) => quote(col.name)).join(",")}) VALUES ${placeholders}`, values);
  }
}

export async function destinationTransferState(client: PoolClient, ownerId: string) {
  const keys: TransferTable[] = ["products", "inventory", "customers", "payments", "manualCredits", "records", "customEmojis", "advertisingBots", "advertisingGroups", "advertisingCampaigns", "advertisingDeliveries", "advertisingAccountSchedules", "advertisingAccountRuns", "advertisingAccountCommands",
    "promotionProducts", "promotionPreferences", "promotionRounds", "promotionDeliveries"];
  const counts: Record<string, number> = {};
  for (const key of keys) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${quote(tableInfo(key).name)} WHERE owner_id = $1`, [ownerId]);
    counts[key] = result.rows[0].count;
  }
  const wallet = await client.query("SELECT count(*)::integer AS count FROM wallet_entries w JOIN bot_customers c ON c.id=w.customer_id WHERE c.owner_id=$1", [ownerId]);
  counts.walletEntries = wallet.rows[0].count;
  const runtime = await client.query("SELECT enabled, transfer_review_required FROM bot_runtime_settings WHERE owner_id=$1", [ownerId]);
  const connection = await client.query("SELECT owner_id, active FROM bot_connections WHERE id='primary'");
  const blockers: string[] = [];
  if (Object.values(counts).some(n => n > 0)) blockers.push("This shop already contains business data. Import is restricted to an empty shop; nothing will be overwritten.");
  if (runtime.rows[0]?.enabled || (connection.rows[0]?.owner_id === ownerId && connection.rows[0]?.active === "yes")) blockers.push("Disable Telegram processing before importing.");
  if ((await client.query("SELECT 1 FROM advertising_accounts WHERE owner_id=$1 AND (session_encrypted IS NOT NULL OR login_encrypted IS NOT NULL)", [ownerId])).rowCount)
    blockers.push("Disconnect the advertising account and cancel pending login before importing.");
  return { counts, empty: !Object.values(counts).some(n => n > 0), blockers, reviewRequired: runtime.rows[0]?.transfer_review_required === true, connectionOwner: connection.rows[0]?.owner_id as string | undefined };
}
