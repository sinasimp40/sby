// Runs the real local API and Vite processes, then shuts down only its own
// children. It never reads/writes the user's .env.local or contacts providers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPortAvailable, makeChildEnvironment, LOCAL_API_PORT, LOCAL_WEB_PORT } from "../local-core.mjs";
import { initializeSqlite } from "../init-sqlite.mjs";
import { startLocalAppAfterBuild } from "../dev-local.mjs";
const directory = mkdtempSync(join(tmpdir(), "Telecart real launcher "));
try {
  await Promise.all([LOCAL_API_PORT, LOCAL_WEB_PORT].map(port => assertPortAvailable(port)));
  const path = join(directory, "shop database.db");
  initializeSqlite(path);
  const config = {
    TELECART_SQLITE_PATH: path, SESSION_SECRET: "TEST_ONLY_LAUNCHER_SECRET_NOT_A_CREDENTIAL",
    TELECART_OWNER_ID: "TEST_ONLY_LOCAL_OWNER", TELECART_ADMIN_EMAIL: "test@example.invalid",
    TELECART_ADMIN_INITIAL_PASSWORD: "TEST_ONLY_LOCAL_PASSWORD_NOT_A_CREDENTIAL",
  };
  let ready = false;
  const code = await startLocalAppAfterBuild(makeChildEnvironment(process.env, config), {
    openBrowser: () => { ready = true; process.emit("SIGINT"); },
  });
  assert.equal(code, 0);
  assert.equal(ready, true, "both real services must be ready before the launcher opens a browser");
  await Promise.all([LOCAL_API_PORT, LOCAL_WEB_PORT].map(port => assertPortAvailable(port)));
  console.log("Real local startup and owned-process shutdown passed.");
} finally { rmSync(directory, { recursive: true, force: true }); }
