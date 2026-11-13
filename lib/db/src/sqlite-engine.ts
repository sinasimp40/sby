import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, openSync, closeSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { EventEmitter } from "node:events";
import { is, getTableName } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

function projectRoot() {
  let directory = process.cwd();
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Run Telecart from its project directory.");
    directory = parent;
  }
  return directory;
}
export const root = projectRoot();
export const sqlitePath = resolve(root, process.env.TELECART_SQLITE_PATH || "data/telecart.db");
mkdirSync(dirname(sqlitePath), { recursive: true, mode: 0o700 });

// Exactly one server per file: long-lived Telegram connections cannot safely
// share their authorization across independent server processes.
const lockPath = `${sqlitePath}.lock`;
const lockToken = randomUUID();
function claimFile() {
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: lockToken })); }
    finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const prior = JSON.parse(readFileSync(lockPath, "utf8"));
      if (prior.host === hostname() && Number.isInteger(prior.pid)) {
        try { process.kill(prior.pid, 0); }
        catch (failure) { stale = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
      }
    } catch { /* Unknown locks require operator review, never forced takeover. */ }
    if (!stale) throw new Error("This SQLite shop is already open or its lock needs review. Stop the other Telecart process before retrying.");
    // Only one contender may recover a dead process's lock. Without this
    // exclusive recovery claim, two restarts could delete each other's locks.
    const recoveryPath = `${lockPath}.recovery`;
    let fd: number;
    try { fd = openSync(recoveryPath, "wx", 0o600); }
    catch { throw new Error("Another process is recovering the SQLite lock. Retry after it finishes."); }
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8"));
      let dead = false;
      if (current.host === hostname() && Number.isInteger(current.pid)) {
        try { process.kill(current.pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (!dead) throw new Error("The SQLite database was opened by another process during recovery.");
      unlinkSync(lockPath);
      claimFile();
    } finally { closeSync(fd); unlinkSync(recoveryPath); }
  }
}
claimFile();
function releaseFile() {
  try {
    if (JSON.parse(readFileSync(lockPath, "utf8")).token === lockToken) unlinkSync(lockPath);
  } catch { /* Never remove another process's lock. */ }
}
process.once("exit", releaseFile);
export const sqlite = new DatabaseSync(sqlitePath);
chmodSync(sqlitePath, 0o600);
sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
sqlite.function("telecart_uuid", () => randomUUID());
sqlite.function("gen_random_uuid", () => randomUUID());
export function canonicalTime(value: string | Date) {
  const source = value instanceof Date ? value.toISOString() : value;
  const iso = new Date(source).toISOString();
  const extra = /\.(\d{3})(\d{0,3})/.exec(source)?.[2] ?? "";
  return `${iso.slice(0, 23)}${extra.padEnd(3, "0")}Z`;
}
sqlite.function("now", () => canonicalTime(new Date()));
sqlite.function("greatest", { varargs: true }, (...values) => values.reduce<string | number | null>((a, b) =>
  a === null || b === null ? null : a > b ? a : b as string | number, values[0] as string | number));
sqlite.function("split_part", (value, delimiter, position) => String(value).split(String(delimiter))[Number(position) - 1] ?? "");
sqlite.function("date_add", (value, amount, unit) => {
  const original = canonicalTime(String(value));
  const micros = BigInt(new Date(original).getTime()) * 1000n + BigInt(original.slice(23, 26));
  const factor = { microsecond: 1, microseconds: 1, millisecond: 1000, milliseconds: 1000,
    second: 1e6, seconds: 1e6, minute: 60e6, minutes: 60e6, hour: 3600e6, hours: 3600e6,
    day: 86400e6, days: 86400e6 }[String(unit)];
  if (factor === undefined) throw new Error("Unsupported time unit.");
  const result = micros + BigInt(Math.round(Number(amount) * factor));
  return `${new Date(Number(result / 1000n)).toISOString().slice(0, 23)}${String(result % 1000n).padStart(3, "0")}Z`;
});
sqlite.function("iso_time", value => value === null ? null : canonicalTime(String(value)));

const version = Number((sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
if (!version) {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (tables.length) throw new Error("This file is not an initialized Telecart live database. Import portable shop.db ZIPs through the dashboard, not as the live database file.");
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const migrations = readdirSync(join(root, "lib/db/migrations")).filter(file => file.endsWith(".sql")).sort();
    if (!migrations.length) throw new Error("SQLite schema migrations are missing. No database was initialized.");
    for (const file of migrations) {
      sqlite.exec(readFileSync(join(root, "lib/db/migrations", file), "utf8"));
    }
    sqlite.exec("PRAGMA user_version=1; COMMIT;");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
} else if (version !== 1) throw new Error("Unsupported SQLite database version. The database was left unchanged.");
const actualTables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
for (const model of Object.values(schema)) {
  if (is(model, SQLiteTable) && !actualTables.has(getTableName(model)))
    throw new Error("The SQLite live schema is incomplete. No repair or destructive rewrite was attempted.");
}

let tail: Promise<void> = Promise.resolve();
export async function acquireDatabase(): Promise<() => void> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}
export function bindValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return canonicalTime(value);
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value)) return canonicalTime(value);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "object" && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as SQLInputValue;
}

// The raw-query surface is deliberately small and parameterized. This adapter
// retains established business queries while executing them solely in SQLite.
export function sqliteSql(source: string, values: unknown[] = []) {
  let text = source
    .replace(/::(?:jsonb|text|integer|int|uuid|timestamptz)(?:\[\])?/gi, "")
    .replace(/=\s*ANY\((\$\d+)\)/gi, " IN (SELECT value FROM json_each($1))")
    .replace(/FOR\s+UPDATE(?:\s+SKIP\s+LOCKED)?/gi, "")
    .replace(/to_char\(([\s\S]*?)\s+AT TIME ZONE 'UTC',\s*'[^']*'\)/gi, "iso_time($1)")
    .replace(/COALESCE\(draft,'\{\}'\)\s*\?\s*'forward'/gi, "json_type(COALESCE(draft,'{}'),'$.forward') IS NOT NULL")
    .replace(/\bdraft\s*\?\s*'forward'/gi, "json_type(draft,'$.forward') IS NOT NULL")
    .replace(/(\b\w+(?:\.\w+)?)->>'(\w+)'/gi, "CAST(json_extract($1,'$.$2') AS TEXT)");
  text = text.replace(/extract\(epoch\s+FROM\s+(\w+)-now\(\)\)/gi, "(unixepoch($1,'subsec')-unixepoch(now(),'subsec'))");
  text = text.replace(/(now\(\)|\$\d+|\b[a-z_]+)\s*([+-])\s*(\$\d+|[a-z_]+)\s*\*\s*interval\s*'1 (second|millisecond|microsecond|minute|hour|day)'/gi,
    (_, base, sign, amount, unit) => `date_add(${base},${sign === "-" ? "-" : ""}${amount},'${unit}')`);
  text = text.replace(/(now\(\)|\$\d+|\b[a-z_]+)\s*([+-])\s*interval\s*'(\d+) (seconds?|days?|milliseconds?|minutes?|hours?)'/gi,
    (_, base, sign, amount, unit) => `date_add(${base},${sign === "-" ? "-" : ""}${amount},'${unit}')`);
  // Forward-loop ordering combines a day offset and millisecond queue position.
  text = text.replace(/date_add\(now\(\),-1,'day'\)\s*\+\s*(\$\d+)\s*\*\s*interval '1 millisecond'/gi,
    "date_add(date_add(now(),-1,'day'),$1,'millisecond')");
  const parameters: SQLInputValue[] = [];
  // Do not substitute parameter-like text inside SQL literals or identifiers.
  text = text.replace(/'(?:''|[^'])*'|"(?:\"\"|[^"])*"|\$(\d+)/g, (match, index) => {
    if (!index) return match;
    parameters.push(bindValue(values[Number(index) - 1]));
    return "?";
  });
  return { text, parameters };
}
const jsonColumns = new Set(["draft", "state", "payload", "preferences", "inventory_ids"]);
const boolColumns = new Set(["enabled", "running", "invoice_needs_update", "configured", "telegram_enabled",
  "transfer_review_required", "shop_bot_connected", "advertising_scheduled", "pending_payments"]);
export function decodeRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value !== null && jsonColumns.has(key) && typeof value === "string") value = JSON.parse(value);
    else if (value !== null && boolColumns.has(key)) value = Boolean(value);
    else if (value !== null && /(?:_at|At|scheduled_for|scheduledFor)$/.test(key) && typeof value === "string" && key !== "cursorAt") value = new Date(value);
    return [key, value];
  }));
}
type Row = any;
export type QueryResult = { rows: Row[]; rowCount: number };
const locks = new Map<string, { client: SQLiteClient; depth: number }>();
export class SQLiteClient extends EventEmitter {
  private transactionRelease?: () => void;
  private released = false;
  async query(source: string, values: any[] = []): Promise<QueryResult> {
    if (this.released) throw new Error("SQLite session was released.");
    const normalized = source.trim();
    if (/^BEGIN\b/i.test(normalized)) {
      if (this.transactionRelease) throw new Error("Transaction already open.");
      this.transactionRelease = await acquireDatabase();
      try { sqlite.exec("BEGIN IMMEDIATE"); } catch (error) { this.finish(); throw error; }
      return { rows: [], rowCount: 0 };
    }
    if (/^(COMMIT|ROLLBACK)\b/i.test(normalized)) {
      if (this.transactionRelease) {
        try { sqlite.exec(/^COMMIT/i.test(normalized) ? "COMMIT" : "ROLLBACK"); } finally { this.finish(); }
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^SET LOCAL (statement_timeout|lock_timeout|idle_in_transaction_session_timeout)\b/i.test(normalized))
      return { rows: [], rowCount: 0 }; // SQLite uses busy_timeout; transfer has its own deadline.
    if (/^SELECT pg_advisory_xact_lock\(/i.test(normalized)) {
      if (!this.transactionRelease) throw new Error("Transaction lock requires an active SQLite write transaction.");
      return { rows: [{}], rowCount: 1 }; // BEGIN IMMEDIATE owns the exclusive writer lock.
    }
    if (/^SELECT pg_(?:try_)?advisory_(?:lock|unlock)\(/i.test(normalized)) {
      const match = /hashtextextended\((\$\d+|'[^']*'),\s*(\d+)\)/i.exec(normalized);
      if (!match) throw new Error("Unsupported session lock.");
      const key = `${match[2]}:${match[1].startsWith("$") ? values[Number(match[1].slice(1)) - 1] : match[1].slice(1, -1)}`;
      const alias = /\bAS\s+(\w+)/i.exec(normalized)?.[1] ?? "pg_advisory_unlock";
      if (/advisory_unlock/i.test(normalized)) {
        const entry = locks.get(key);
        const held = entry?.client === this;
        if (held && --entry.depth === 0) locks.delete(key);
        return { rows: [{ [alias]: held }], rowCount: 1 };
      }
      while (locks.has(key) && locks.get(key)!.client !== this) {
        if (/try_advisory/i.test(normalized)) return { rows: [{ [alias]: false }], rowCount: 1 };
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const entry = locks.get(key);
      locks.set(key, { client: this, depth: (entry?.depth ?? 0) + 1 });
      return { rows: [{ [alias]: true }], rowCount: 1 };
    }
    const unlock = this.transactionRelease ? undefined : await acquireDatabase();
    try {
      const { text, parameters } = sqliteSql(source, values);
      const statement = sqlite.prepare(text);
      const rows = statement.columns().length ? statement.all(...parameters).map(row =>
        source.includes("/*portable*/") ? row : decodeRow(row)) : [];
      if (!statement.columns().length) {
        const result = statement.run(...parameters);
        return { rows, rowCount: Number(result.changes) };
      }
      return { rows, rowCount: rows.length };
    } catch (error) {
      // Preserve the known constraint classifications at the business boundary.
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint failed/i.test(message)) Object.assign(error as object, { code: "23505" });
      if (/FOREIGN KEY constraint failed/i.test(message)) Object.assign(error as object, { code: "23503" });
      throw error;
    } finally { unlock?.(); }
  }
  private finish() { this.transactionRelease?.(); this.transactionRelease = undefined; }
  release(_broken?: boolean) {
    if (this.transactionRelease) {
      try { sqlite.exec("ROLLBACK"); } finally { this.finish(); }
    }
    for (const [key, lock] of locks) if (lock.client === this) locks.delete(key);
    this.released = true;
  }
}
export const pool = {
  async connect() { return new SQLiteClient(); },
  async query(source: string, values: any[] = []) {
    const client = new SQLiteClient();
    try { return await client.query(source, values); } finally { client.release(); }
  },
  async end() { sqlite.close(); releaseFile(); },
};
export type PoolClient = SQLiteClient;
