import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  shopProducts, shopInventory, botCustomers, shopPayments, walletEntries, shopRecords,
  shopSettings, shopActivity, providerCredentials, botRuntimeSettings, botConnections, botUpdates,
} from "@workspace/db";

// Explicit allowlist: login sessions and database/platform credentials never travel.
export const transferTables = {
  products: shopProducts, inventory: shopInventory, customers: botCustomers,
  payments: shopPayments, walletEntries, records: shopRecords, settings: shopSettings,
  activity: shopActivity, providerCredentials, runtime: botRuntimeSettings,
  connection: botConnections, updates: botUpdates,
};
export type TransferTable = keyof typeof transferTables;
export type TransferRow = Record<string, unknown>;
export type TransferData = Record<TransferTable, TransferRow[]>;
export const tableKeys = Object.keys(transferTables) as TransferTable[];
export const MAX_TRANSFER_BYTES = 30 * 1024 * 1024;
export const MAX_ZIP_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSFER_ROWS = 50000;
export const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
export function tableInfo(key: TransferTable) {
  const table: PgTable = transferTables[key];
  return { name: getTableConfig(table).name, columns: Object.entries(getTableColumns(table)) };
}
function schemaHash(singleItem = false) { return createHash("sha256").update(JSON.stringify(tableKeys.map(key => ({
  key, table: tableInfo(key).name,
  columns: tableInfo(key).columns.filter(([name]) => !singleItem || key !== "payments" || !["quantity", "inventoryIds"].includes(name)).map(([name, column]) => ({
    name, sqlName: column.name, type: column.getSQLType(), nullable: !column.notNull,
  })),
})))).digest("hex"); }
export const transferSchemaHash = schemaHash();
export const singleItemTransferSchemaHash = schemaHash(true);

const schemas = Object.fromEntries(tableKeys.map(key => {
  const overrides: Record<string, z.ZodType> = {};
  for (const [name, column] of tableInfo(key).columns) {
    if (column.dataType === "date") {
      // Keep PostgreSQL's microseconds instead of truncating them through Date.
      const date = z.iso.datetime({ offset: true });
      overrides[name] = column.notNull ? date : date.nullable();
    }
    if (column.dataType === "json") {
      // JSONB travels as JSON text so large JSON numbers are not rounded by JS.
      const json = z.string().refine(value => { try { JSON.parse(value); return true; } catch { return false; } });
      overrides[name] = column.notNull ? json : json.nullable();
    }
  }
  return [key, createSelectSchema(transferTables[key] as PgTable, overrides).strict()];
})) as unknown as Record<TransferTable, z.ZodType<TransferRow>>;

export function parseTransferData(value: unknown): TransferData {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== tableKeys.length || tableKeys.some(key => !(key in value))) {
    throw new Error("Archive tables are missing or unexpected.");
  }
  const data = {} as TransferData;
  let total = 0;
  for (const key of tableKeys) {
    const rows = (value as Record<string, unknown>)[key];
    if (!Array.isArray(rows) || (total += rows.length) > MAX_TRANSFER_ROWS) throw new Error("Archive row limit exceeded.");
    data[key] = rows.map(row => schemas[key].parse(row));
  }
  return data;
}
