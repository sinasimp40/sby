// Explicit, one-time, read-only source migration. Never run during server startup.
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { initializeSqlite, root } from "./init-sqlite.mjs";
import { DATABASE_TABLES } from "./local-core.mjs";

const require = createRequire(join(root, "lib/db/package.json"));
const { Pool } = require("pg");
const path = resolve(root, process.env.TELECART_SQLITE_PATH || "data/telecart.db");
const quote = value => `"${value.replace(/"/g, '""')}"`;
const canonical = value => {
  const date = new Date(value).toISOString();
  const extra = /\.(\d{3})(\d{0,3})/.exec(value)?.[2] ?? "";
  return `${date.slice(0, 23)}${extra.padEnd(3, "0")}Z`;
};

async function migrate() {
  if (!process.argv.includes("--confirm-read-only-migration")) throw new Error("Pass --confirm-read-only-migration after stopping the old server. No PostgreSQL data will be changed.");
  if (!process.env.DATABASE_URL) throw new Error("The source DATABASE_URL is required privately in the environment.");
  if (existsSync(`${path}.lock`)) throw new Error("Stop the SQLite server before migration.");
  initializeSqlite(path);
  const destination = new DatabaseSync(path);
  const source = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  const client = await source.connect();
  try {
    for (const table of DATABASE_TABLES) {
      if (destination.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get())
        throw new Error("The SQLite destination is not empty. It was left unchanged.");
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    destination.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    try {
      for (const table of DATABASE_TABLES) {
        const columns = (await client.query(`SELECT column_name,data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
        if (!columns.length) throw new Error("The source is missing required Telecart tables. Migration stopped.");
        const projection = columns.map(column => {
          const name = quote(column.column_name);
          if (column.data_type === "timestamp with time zone") return `to_char(${name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${name}`;
          if (column.data_type === "jsonb") return `${name}::text AS ${name}`;
          return name;
        }).join(",");
        const rows = (await client.query(`SELECT ${projection} FROM ${quote(table)}`)).rows;
        const statement = destination.prepare(`INSERT INTO ${quote(table)} (${columns.map(c=>quote(c.column_name)).join(",")})
          VALUES (${columns.map(()=>"?").join(",")})`);
        for (const row of rows) statement.run(...columns.map(column => {
          const value = row[column.column_name];
          if (value === null) return null;
          if (column.data_type === "boolean") return Number(value);
          if (column.data_type === "timestamp with time zone") return canonical(value);
          return value;
        }));
        const count = destination.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n;
        if (count !== rows.length) throw new Error("Migration row count verification failed.");
        console.log(`${table}: ${count} rows verified`);
      }
      if (destination.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Migration relationship verification failed.");
      if (destination.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("SQLite integrity verification failed.");
      // Moving installations must never resume external processing automatically.
      destination.exec("UPDATE bot_runtime_settings SET enabled=0,transfer_review_required=1; UPDATE advertising_schedules SET running=0;");
      destination.exec("COMMIT");
      await client.query("COMMIT");
      console.log("Migration verified. PostgreSQL was not changed. SQLite processing is paused for review; keep the original SESSION_SECRET and owner binding.");
    } catch (error) {
      destination.exec("ROLLBACK");
      await client.query("ROLLBACK");
      throw error;
    }
  } finally { client.release(); await source.end(); destination.close(); }
}
migrate().catch(() => {
  // Do not print driver errors: they may include connection details or row values.
  console.error("Migration did not finish. No source data was changed. Check that the source is complete, the destination is empty, and both servers are stopped.");
  process.exitCode = 1;
});
