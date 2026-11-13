import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initializeSqlite } from "../init-sqlite.mjs";
import { DATABASE_TABLES, makeSystemEnvironment } from "../local-core.mjs";
import { normalizeSqlitePath } from "../sqlite-path.mjs";
import { loadConfig } from "../dev-local.mjs";
import { makeFirstRunConfig, saveFirstRunConfig } from "../local-setup.mjs";

const checker = fileURLToPath(new URL("../../artifacts/api-server/scripts/check-local-db.mjs", import.meta.url));
const inspectFile = file => spawnSync(process.execPath, [checker], {
  env: { ...makeSystemEnvironment(process.env), TELECART_SQLITE_PATH: file },
  encoding: "utf8",
});

test("folder entered at setup is saved as a database file before credentials are requested", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telecart setup directory "));
  try {
    const visible = ["1", directory, "test@example.invalid"];
    const config = await makeFirstRunConfig({
      ask: async () => visible.shift(), askSecret: async () => "TEST_ONLY_PASSWORD",
    });
    assert.equal(config.TELECART_SQLITE_PATH, join(directory, "telecart.db"));
    assert.equal(existsSync(config.TELECART_SQLITE_PATH), false, "setup must not create a database before confirmation");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("saved directory path is repaired in memory without resetting the configuration or secret", async () => {
  const directory = mkdtempSync(join(tmpdir(), "telecart saved directory "));
  const configFile = join(directory, ".env.local");
  try {
    await saveFirstRunConfig(configFile, {
      TELECART_SQLITE_PATH: directory, SESSION_SECRET: "TEST_ONLY_ORIGINAL_KEY",
      TELECART_OWNER_ID: "TEST_ONLY", TELECART_ADMIN_EMAIL: "test@example.invalid",
      TELECART_ADMIN_INITIAL_PASSWORD: "TEST_ONLY_PASSWORD",
    });
    const before = readFileSync(configFile, "utf8");
    const config = loadConfig(configFile);
    assert.equal(config.TELECART_SQLITE_PATH, join(directory, "telecart.db"));
    assert.equal(config.SESSION_SECRET, "TEST_ONLY_ORIGINAL_KEY");
    assert.equal(readFileSync(configFile, "utf8"), before);
    const empty = inspectFile(directory);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(JSON.parse(empty.stdout).tableCount, 0);
    assert.equal(existsSync(join(directory, "telecart.db")), false, "readiness check must be read-only");
    initializeSqlite(directory);
    const initialized = inspectFile(directory);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.deepEqual(JSON.parse(initialized.stdout).missingTables, []);
    const database = new DatabaseSync(join(directory, "telecart.db"), { readOnly: true });
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    database.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows directory and quoted paths normalize without breaking drive letters or spaces", () => {
  const folder = "C:\\Users\\TEST_ONLY\\My Shop\\data";
  const options = { baseDir: "C:\\My Project", pathApi: win32,
    inspect: value => { assert.equal(value, folder); return { isDirectory: () => true }; } };
  assert.equal(normalizeSqlitePath(folder, options), `${folder}\\telecart.db`);
  assert.equal(normalizeSqlitePath(`"${folder}"`, options), `${folder}\\telecart.db`);
  const absent = { ...options, inspect: () => { throw Object.assign(new Error(), { code: "ENOENT" }); } };
  assert.equal(normalizeSqlitePath(folder, absent), `${folder}\\telecart.db`);
  assert.equal(normalizeSqlitePath(`${folder}\\`, absent), `${folder}\\telecart.db`);
  assert.equal(normalizeSqlitePath(`${folder}\\custom.sqlite`, absent), `${folder}\\custom.sqlite`);
  const file = { ...options, inspect: () => ({ isDirectory: () => false, isFile: () => true }) };
  assert.equal(normalizeSqlitePath(folder, file), folder, "existing extensionless databases stay unchanged");
  for (const input of [":memory:", "postgresql://example.invalid/db", '"https://example.invalid/db"']) {
    assert.throws(() => normalizeSqlitePath(input, absent), /local SQLite/);
  }
});

test("invalid database files produce a safe structured error, not an uncaught stack trace", () => {
  const directory = mkdtempSync(join(tmpdir(), "telecart invalid file "));
  const file = join(directory, "invalid.db");
  try {
    writeFileSync(file, "TEST_ONLY_NOT_SQLITE");
    const result = inspectFile(file);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { errorCode: "SQLITE_OPEN_FAILED" });
    assert.ok(!result.stderr.includes("at main"));
    assert.equal(readFileSync(file, "utf8"), "TEST_ONLY_NOT_SQLITE");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
