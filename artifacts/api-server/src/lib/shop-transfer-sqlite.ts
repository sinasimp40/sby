import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { z } from "zod/v4";
import { CommerceError } from "./commerce-providers";
import { decryptCredential, encryptCredential, credentialFingerprint } from "./inventory-encryption";
import { decryptProviderSecret, encryptProviderSecret } from "./provider-credentials";
import {
  tableKeys, tableInfo, quote, parseTransferData, transferSchemaHash, preManualCreditTransferSchemaHash, prePromotionsTransferSchemaHash, promotionTransferKeys,
  MAX_TRANSFER_BYTES, MAX_TRANSFER_ROWS, MAX_ZIP_BYTES, type TransferData, type TransferTable,
} from "./shop-transfer-tables";

// These fields travel as portable values, not installation-bound ciphertext.
// Never put SESSION_SECRET, login passwords or Telegram account sessions here.
const portableFields = {
  inventory: { encryptedCredential: "credential" },
  providerCredentials: {
    telegramTokenEncrypted: "telegramToken",
    nowpaymentsApiKeyEncrypted: "nowpaymentsApiKey",
    nowpaymentsIpnSecretEncrypted: "nowpaymentsIpnSecret",
  },
  advertisingBots: { tokenEncrypted: "token" },
} as const;
const providerFields = [
  ["telegramTokenEncrypted", "telegram"],
  ["nowpaymentsApiKeyEncrypted", "nowpayments-api-key"],
  ["nowpaymentsIpnSecretEncrypted", "nowpayments-ipn-secret"],
] as const;
const dbName = (key: TransferTable, field: string) =>
  (portableFields[key as keyof typeof portableFields] as Record<string, string> | undefined)?.[field] ?? field;
const columns = (key: TransferTable) => tableInfo(key).columns.filter(([field]) => !(key === "inventory" && field === "fingerprint"));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tableSql = (key: TransferTable) => `CREATE TABLE ${quote(key)} (_ordinal INTEGER PRIMARY KEY, ${columns(key).map(([name, col]) =>
  `${quote(dbName(key, name))} ${col.dataType === "number" ? "REAL" : col.dataType === "boolean" ? "INTEGER" : "TEXT"}`).join(",")}) STRICT`;
const metaSql = "CREATE TABLE transfer_meta (format TEXT, version INTEGER, schema_hash TEXT, created_at TEXT, source_owner TEXT) STRICT";
const countsSql = "CREATE TABLE transfer_counts (dataset TEXT, row_count INTEGER, data_hash TEXT) STRICT";
function rowHash(key: TransferTable, rows: TransferData[TransferTable]) {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(JSON.stringify(columns(key).map(([name]) => row[name])) + "\n");
  return digest.digest("hex");
}

export const portableReadme = `TELECART PORTABLE SQLITE SHOP DATA — FORMAT 2

shop.db is a SQLite database with separate tables for the shop's business data.
No JSON files, installation secret or transfer password are needed to import it.
SQLite is also the live application database. This portable shop.db uses a
separate transfer schema: import its ZIP through the dashboard; do not use the
exported shop.db as your live database file.

WARNING: Possession of this ZIP grants access to its contents, including stock
credentials, saved bot/payment keys, customer information and financial history.
This archive is NOT password-protected. Keep it private and never share it publicly.
Checksums detect accidental corruption, not who created the file. Import only a
trusted export you obtained yourself.

Admin login passwords, login sessions, SESSION_SECRET, database credentials,
personal Telegram login sessions and environment-only provider keys are excluded.
On import, stock and saved provider credentials are encrypted with the destination's
own installation key. You do not need to copy the source SESSION_SECRET.

Import requires an empty shop and does not merge or overwrite business records.
Stop the source before making a final export. The destination stays paused until
you review the imported data, then explicitly resume processing. Never run two
copies of the same shop.

Legacy JSON ZIPs still require their original SESSION_SECRET. A new-format importer
cannot recover encrypted values from an old ZIP whose original key has been lost.
`;

function temporaryDb<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "telecart-transfer-"));
  chmodSync(dir, 0o700);
  try { return run(join(dir, "shop.db")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function portableData(data: TransferData, owner: string): TransferData {
  const result = structuredClone(data);
  for (const stock of result.inventory) {
    stock.encryptedCredential = decryptCredential(String(stock.encryptedCredential), owner, Number(stock.productId));
    delete stock.fingerprint;
  }
  for (const row of result.providerCredentials) for (const [field, purpose] of providerFields) {
    if (row[field] !== null) row[field] = decryptProviderSecret(String(row[field]), owner, purpose);
  }
  for (const row of result.advertisingBots) if (row.tokenEncrypted !== null) {
    row.tokenEncrypted = decryptProviderSecret(String(row.tokenEncrypted), owner, "advertising");
  }
  return result;
}

function protectData(data: TransferData, owner: string): TransferData {
  for (const stock of data.inventory) {
    const value = stock.encryptedCredential;
    if (typeof value !== "string" || !value.length) throw new Error("Invalid stock value.");
    stock.fingerprint = credentialFingerprint(value, owner, Number(stock.productId));
    stock.encryptedCredential = encryptCredential(value, owner, Number(stock.productId));
  }
  for (const row of data.providerCredentials) for (const [field, purpose] of providerFields) {
    if (row[field] !== null) {
      if (typeof row[field] !== "string" || !row[field].length) throw new Error("Invalid credential.");
      row[field] = encryptProviderSecret(row[field], owner, purpose);
    }
  }
  for (const row of data.advertisingBots) if (row.tokenEncrypted !== null) {
    if (typeof row.tokenEncrypted !== "string" || !row.tokenEncrypted.length) throw new Error("Invalid advertising credential.");
    row.tokenEncrypted = encryptProviderSecret(row.tokenEncrypted, owner, "advertising");
  }
  return parseTransferData(data);
}

export function encodeSqliteShopArchive(sourceOwnerId: string, input: TransferData) {
  const parsed = parseTransferData(input);
  const data = portableData(parsed, sourceOwnerId);
  const createdAt = new Date().toISOString();
  const counts = Object.fromEntries(tableKeys.map(key => [key, data[key].length]));
  const bytes = temporaryDb(path => {
    const db = new DatabaseSync(path, { allowExtension: false });
    chmodSync(path, 0o600);
    try {
      db.exec("PRAGMA journal_mode=MEMORY; PRAGMA trusted_schema=OFF; BEGIN");
      db.exec(metaSql);
      db.prepare("INSERT INTO transfer_meta VALUES (?,?,?,?,?)").run("telecart-shop-data", 2, transferSchemaHash, createdAt, sourceOwnerId);
      db.exec(countsSql);
      const addCount = db.prepare("INSERT INTO transfer_counts VALUES (?,?,?)");
      for (const key of tableKeys) {
        const fields = columns(key);
        db.exec(tableSql(key));
        const statement = db.prepare(`INSERT INTO ${quote(key)} VALUES (${Array(fields.length + 1).fill("?").join(",")})`);
        data[key].forEach((row, ordinal) => {
          const values = fields.map(([name]): SQLInputValue => {
            const value = row[name];
            if (typeof value === "boolean") return Number(value);
            if (value === null || typeof value === "string" || typeof value === "number") return value;
            throw new Error("Unsupported transfer value.");
          });
          statement.run(ordinal, ...values);
        });
        addCount.run(key, data[key].length, rowHash(key, data[key]));
        // Avoid writing an unbounded temporary file before checking the limit.
        const pages = db.prepare("PRAGMA page_count").get()!.page_count as number;
        const pageSize = db.prepare("PRAGMA page_size").get()!.page_size as number;
        if (pages * pageSize > MAX_TRANSFER_BYTES) throw new CommerceError("SQLite shop data exceeds the 30 MB transfer limit. No partial export was created.", 413);
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    return readFileSync(path);
  });
  const zip = Buffer.from(zipSync({ "shop.db": bytes, "README.txt": strToU8(portableReadme) }, { level: 6 }));
  if (zip.length > MAX_ZIP_BYTES) throw new CommerceError("ZIP exceeds the 20 MB portable transfer limit. No partial export was created.", 413);
  return { zip, manifest: { format: "telecart-shop-data" as const, version: 2 as const, schemaHash: transferSchemaHash, createdAt, sourceOwnerId, counts } };
}

const metadata = z.object({
  format: z.literal("telecart-shop-data"), version: z.literal(2),
  schema_hash: z.enum([transferSchemaHash, prePromotionsTransferSchemaHash, preManualCreditTransferSchemaHash]), created_at: z.iso.datetime(),
  source_owner: z.string().min(1).max(300),
}).strict();

export function decodeSqliteShopArchive(bytes: Uint8Array, zip: Buffer) {
  try {
    if (bytes.length > MAX_TRANSFER_BYTES || !Buffer.from(bytes.subarray(0, 16)).equals(Buffer.from("SQLite format 3\0"))) throw new Error();
    return temporaryDb(path => {
      writeFileSync(path, bytes, { mode: 0o600 });
      const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      try {
        db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
        const definitions = db.prepare("SELECT type,name,sql FROM sqlite_schema LIMIT ?").all(tableKeys.length + 3);
        const expected = ["transfer_meta", "transfer_counts", ...tableKeys];
        if (definitions.some(row => row.type !== "table" || !expected.includes(String(row.name)))) throw new Error();
        // Reject generated columns, views, triggers, virtual tables and altered SQL
        // before selecting from any uploaded table. Never execute uploaded SQL.
        for (const row of definitions) {
          const sql = row.name === "transfer_meta" ? metaSql : row.name === "transfer_counts" ? countsSql : tableSql(row.name as TransferTable);
          if (row.sql !== sql) throw new Error();
        }
        const metaRows = db.prepare("SELECT * FROM transfer_meta LIMIT 2").all();
        if (metaRows.length !== 1) throw new Error();
        const meta = metadata.parse(metaRows[0]);
        // Previous SQLite exports contain all the same tables except manualCredits.
        // Check their exact original table/count sets before adding an empty default.
        const archiveKeys = tableKeys.filter(key =>
          !(meta.schema_hash === preManualCreditTransferSchemaHash && key === "manualCredits") &&
          !(meta.schema_hash !== transferSchemaHash && (promotionTransferKeys as readonly string[]).includes(key)));
        const archiveTables = ["transfer_meta", "transfer_counts", ...archiveKeys];
        if (definitions.length !== archiveTables.length || definitions.some(row => !archiveTables.includes(String(row.name)))) throw new Error();
        const countRows = db.prepare("SELECT * FROM transfer_counts LIMIT ?").all(tableKeys.length + 1);
        if (countRows.length !== archiveKeys.length || new Set(countRows.map(row => row.dataset)).size !== archiveKeys.length ||
          countRows.some(row => !archiveKeys.includes(row.dataset as TransferTable))) throw new Error();
        const counts: Record<string, number> = {};
        const data = Object.fromEntries(tableKeys.map(key => [key, []])) as unknown as TransferData;
        let total = 0;
        for (const key of archiveKeys) {
          const count = countRows.find(row => row.dataset === key)?.row_count;
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || (total += count) > MAX_TRANSFER_ROWS) throw new Error();
          counts[key] = count;
          const fields = columns(key);
          const schema = db.prepare(`PRAGMA table_info(${quote(key)})`).all();
          const expectedFields = ["_ordinal", ...fields.map(([name]) => dbName(key, name))];
          if (schema.length !== expectedFields.length || schema.some((col, i) => col.name !== expectedFields[i])) throw new Error();
          // LIMIT guards forged counts and unexpectedly large tables.
          const rows = db.prepare(`SELECT * FROM ${quote(key)} ORDER BY _ordinal LIMIT ?`).all(count + 1);
          if (rows.length !== count) throw new Error();
          data[key] = rows.map((row, ordinal) => {
            if (row._ordinal !== ordinal) throw new Error();
            return Object.fromEntries(fields.map(([name, col]) => {
              let value: unknown = row[dbName(key, name)];
              if (col.dataType === "boolean" && value !== null) {
                if (value !== 0 && value !== 1) throw new Error();
                value = value === 1;
              }
              if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error();
              return [name, value];
            }));
          });
          if (rowHash(key, data[key]) !== countRows.find(row => row.dataset === key)?.data_hash) throw new Error();
        }
        const check = db.prepare("PRAGMA quick_check(1)").get();
        if (!check || Object.values(check)[0] !== "ok") throw new Error();
        for (const key of tableKeys) if (!(key in counts)) counts[key] = 0;
        return {
          data: protectData(data, meta.source_owner),
          manifest: { format: meta.format, version: meta.version, schemaHash: meta.schema_hash, createdAt: meta.created_at, sourceOwnerId: meta.source_owner, counts },
          archiveHash: hash(zip),
        };
      } finally { db.close(); }
    });
  } catch (error) {
    if (error instanceof CommerceError) throw error;
    throw new CommerceError("Invalid, damaged or incompatible SQLite shop ZIP. Nothing was imported. Use an unmodified export from this app.", 400);
  }
}
