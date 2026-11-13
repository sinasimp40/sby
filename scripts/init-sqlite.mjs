import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSqlitePath } from "./sqlite-path.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const sqliteSchemaVersion = readdirSync(join(root, "lib/db/migrations")).filter(name => name.endsWith(".sql")).length;
export function initializeSqlite(path) {
  const file = resolveSqlitePath(path);
  const migrations = readdirSync(join(root, "lib/db/migrations")).filter(name => name.endsWith(".sql")).sort();
  if (!migrations.length) throw new Error("SQLite schema migrations are missing.");
  if (existsSync(`${file}.lock`)) {
    const current = new DatabaseSync(file, { readOnly: true });
    try {
      if (current.prepare("PRAGMA user_version").get().user_version === migrations.length) return;
    } finally { current.close(); }
    throw new Error("Stop Telecart before initializing its database.");
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    db.function("telecart_uuid", () => randomUUID());
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version === migrations.length) return;
    if (version < 0 || version > migrations.length) throw new Error("Unknown SQLite schema version. No tables were changed.");
    if (!version && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)
      throw new Error("This file already contains tables without the Telecart live schema version. No tables were changed.");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const name of migrations.slice(version))
        db.exec(readFileSync(join(root, "lib/db/migrations", name), "utf8"));
      db.exec(`PRAGMA user_version=${migrations.length}; COMMIT;`);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { initializeSqlite(process.env.TELECART_SQLITE_PATH); console.log("SQLite database ready. Existing data was preserved."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
