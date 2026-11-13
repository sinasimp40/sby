// Runs the real local API and Vite processes, then shuts down only its own
// children. It never reads/writes the user's .env.local or contacts providers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPortAvailable, makeChildEnvironment, LOCAL_API_PORT, LOCAL_WEB_PORT } from "../local-core.mjs";
import { initializeSqlite } from "../init-sqlite.mjs";
import { loadConfig, startLocalAppAfterBuild } from "../dev-local.mjs";
import { saveFirstRunConfig } from "../local-setup.mjs";
import { checkNativePackages } from "../check-local-native.mjs";
const directory = mkdtempSync(join(tmpdir(), "Telecart real launcher "));
try {
  checkNativePackages();
  await Promise.all([LOCAL_API_PORT, LOCAL_WEB_PORT].map(port => assertPortAvailable(port)));
  const savedConfig = {
    TELECART_SQLITE_PATH: directory, SESSION_SECRET: "TEST_ONLY_LAUNCHER_SECRET_NOT_A_CREDENTIAL",
    TELECART_OWNER_ID: "TEST_ONLY_LOCAL_OWNER", TELECART_ADMIN_EMAIL: "test@example.invalid",
    TELECART_ADMIN_INITIAL_PASSWORD: "TEST_ONLY_LOCAL_PASSWORD_NOT_A_CREDENTIAL",
  };
  const configPath = join(directory, ".env.local");
  await saveFirstRunConfig(configPath, savedConfig);
  const config = loadConfig(configPath);
  assert.equal(config.TELECART_SQLITE_PATH, join(directory, "telecart.db"));
  initializeSqlite(config.TELECART_SQLITE_PATH);
  let ready = false;
  let browserFailure;
  const code = await startLocalAppAfterBuild(makeChildEnvironment(process.env, config), {
    openBrowser: () => {
      ready = true;
      void (async () => {
        const origin = `http://127.0.0.1:${LOCAL_WEB_PORT}`;
        const entry = await fetch(`${origin}/src/main.tsx`, { signal: AbortSignal.timeout(30000) });
        assert.equal(entry.status, 200, "Vite must compile the real React entry, not only serve index.html");
        const source = await entry.text();
        const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)]
          .map(match => match[1] || match[2]).filter(url => url.startsWith("/"));
        assert.ok(imports.length > 0);
        for (const url of new Set(imports)) {
          const response = await fetch(new URL(url, origin), { signal: AbortSignal.timeout(30000) });
          assert.equal(response.status, 200, `Vite dependency/CSS transform failed: ${url}`);
          await response.text();
        }
      })().catch(error => { browserFailure = error; }).finally(() => process.emit("SIGINT"));
    },
  });
  if (browserFailure) throw browserFailure;
  assert.equal(code, 0);
  assert.equal(ready, true, "both real services must be ready before the launcher opens a browser");
  await Promise.all([LOCAL_API_PORT, LOCAL_WEB_PORT].map(port => assertPortAvailable(port)));
  console.log("Real local startup and owned-process shutdown passed.");
} finally { rmSync(directory, { recursive: true, force: true }); }
