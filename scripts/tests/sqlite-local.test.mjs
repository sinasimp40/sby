import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeSqlite } from "../init-sqlite.mjs";
import { DATABASE_TABLES } from "../local-core.mjs";

test("new SQLite files initialize in folders with spaces and preserve data on repeat setup", () => {
  const directory = mkdtempSync(join(tmpdir(), "telecart SQLite space "));
  const file = join(directory, "shop database.db");
  try {
    initializeSqlite(file);
    const database = new DatabaseSync(file);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.ok(DATABASE_TABLES.every(name => names.includes(name)));
    database.prepare("INSERT INTO shop_settings(owner_id,preferences) VALUES(?,?)").run("TEST_ONLY", '{"persistent":true}');
    database.close();
    initializeSqlite(file);
    const reopened = new DatabaseSync(file, { readOnly: true });
    assert.equal(reopened.prepare("SELECT preferences FROM shop_settings").get().preferences, '{"persistent":true}');
    assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("setup refuses an unrelated SQLite file without deleting its rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "telecart unrelated "));
  const file = join(directory, "unrelated.db");
  try {
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');");
    database.close();
    assert.throws(() => initializeSqlite(file), /already contains tables/);
    const unchanged = new DatabaseSync(file, { readOnly: true });
    assert.equal(unchanged.prepare("SELECT value FROM unrelated").get().value, "keep");
    assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 0);
    unchanged.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
