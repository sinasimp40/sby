import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  shopProducts, shopInventory, botCustomers, shopPayments, walletEntries, shopRecords,
  shopSettings, shopActivity, providerCredentials, botRuntimeSettings, botConnections, botUpdates,
  shopCustomEmojis,
  advertisingBots, advertisingGroups, advertisingCampaigns, advertisingDeliveries,
} from "@workspace/db";

// Explicit allowlist: login sessions and database/platform credentials never travel.
export const transferTables = {
  products: shopProducts, inventory: shopInventory, customers: botCustomers,
  payments: shopPayments, walletEntries, records: shopRecords, settings: shopSettings,
  activity: shopActivity, providerCredentials, runtime: botRuntimeSettings,
  connection: botConnections, updates: botUpdates, customEmojis: shopCustomEmojis,
  advertisingBots, advertisingGroups, advertisingCampaigns, advertisingDeliveries,
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
function schemaHash() { return createHash("sha256").update(JSON.stringify(tableKeys.map(key => ({
  key, table: tableInfo(key).name,
  columns: tableInfo(key).columns.map(([name, column]) => ({
    name, sqlName: column.name, type: column.getSQLType(), nullable: !column.notNull,
  })),
})))).digest("hex"); }
export const transferSchemaHash = schemaHash();
export const preAdvertisingTransferSchemaHash = "3713eeb9bf5cd5165800e1c7bd281f307d9e62213111a1d198ce415eb46a3468";
export const advertisingTransferKeys = ["advertisingBots", "advertisingGroups", "advertisingCampaigns", "advertisingDeliveries"] as const;
export const productImageTransferSchemaHash = "3be12df019faf16f9003b94852b3901d49efdd326334563d078ceeee9a5f419d";
export const stockAnnouncementTransferSchemaHash = "31b3e0ba15d0ec9c6c50fe4459d27c51fa66bf8a303c521d7bfabeeedb1bcc37";
export const customEmojiTransferSchemaHash = "77ef1802650bd259a6a5be7810dd487d2c3f55fc4a24096d0e22780e6c5604f2";
// Immutable fingerprints of previous signed formats, not recomputed from the live schema.
export const singleItemTransferSchemaHash = "c2df18244024c0f53fbaa510fc9e817791f4c396471322e28f6b460728d78aa2";
export const quantityTransferSchemaHash = "dc5b747920c146462b82548aaeebf8c014a686dca0999d80b81d55a93292ec31";
export const productEmojiTransferSchemaHash = "6f7453f0f72a548f8ee69454133b7262a5b7031ee8b5ce8a62d4931286c87488";

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
