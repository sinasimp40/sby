import { spawnSync } from "node:child_process";
import { readdirSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const api = join(root, "artifacts/api-server");
const require = createRequire(join(api, "package.json"));
const cli = require.resolve("tsx/cli");
const tests = process.argv.slice(2);
const files = tests.length ? tests : readdirSync(join(api, "tests")).filter(file => file.endsWith(".test.ts"));
const directory = join(root, "data", "tests", randomUUID());
mkdirSync(directory, { recursive: true });
let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} (isolated SQLite; external provider responses must be mocked) ===`);
  const result = spawnSync(process.execPath, [cli, "--test", "--test-timeout=45000", join(api, "tests", file)], {
    cwd: api,
    env: { ...process.env, TELECART_SQLITE_PATH: join(directory, `${file}.db`),
      TELECART_OWNER_ID: "TEST_ONLY_OWNER", SESSION_SECRET: `TEST_ONLY_${randomUUID()}`,
      TELECART_PUBLIC_URL: "https://test-only.invalid", TELECART_ADMIN_ORIGIN: "https://test-only.invalid",
      TELECART_TELEGRAM_DISABLED: "false", TELEGRAM_BOT_TOKEN: "TEST_ONLY_TELEGRAM_TOKEN",
      NOWPAYMENTS_API_KEY: "TEST_ONLY_NOWPAYMENTS_KEY", NOWPAYMENTS_IPN_SECRET: "TEST_ONLY_IPN_SECRET" },
    stdio: "inherit", timeout: 60_000,
  });
  if (result.status !== 0 || result.error) { failed++; console.error(`FAILED: ${file}${result.error ? ` (${result.error.code})` : ""}`); }
}
console.log(`\nSQLite regression files: ${files.length - failed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
