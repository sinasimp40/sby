import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertPortAvailable,
  hasCompleteSchema,
  LOCAL_API_PORT,
  LOCAL_WEB_PORT,
  makeChildEnvironment,
  makeSystemEnvironment,
  parseLocalEnv,
  processCommand,
  schemaAction,
  shouldAskProcessingConsent,
  stopOwnedChildren,
  supportedNodeVersion,
  validateLocalConfig,
  waitForLocalServices,
} from "./local-core.mjs";
import { makeFirstRunConfig, saveFirstRunConfig } from "./local-setup.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(scriptDir, "..");
const envPath = join(projectRoot, ".env.local");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runPnpm(args, env, { capture = false } = {}) {
  const command = processCommand(packageManager, args);
  return spawnSync(command.executable, command.args, {
    cwd: projectRoot,
    env,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: command.shell,
    windowsHide: true,
  });
}

function loadConfig() {
  if (!existsSync(envPath)) return null;
  let values;
  try {
    values = parseLocalEnv(readFileSync(envPath, "utf8"));
  } catch (error) {
    throw new Error(`${error.message} Fix the private .env.local file; it was not changed.`);
  }
  const config = Object.fromEntries([
    "TELECART_SQLITE_PATH",
    "SESSION_SECRET",
    "TELECART_OWNER_ID",
    "TELECART_ADMIN_EMAIL",
    "TELECART_ADMIN_INITIAL_PASSWORD",
  ].map(key => [key, values[key] ?? ""]));
  if (!config.TELECART_SQLITE_PATH && values.DATABASE_URL) {
    throw new Error("This .env.local belongs to the old PostgreSQL installation. It was left unchanged. Preserve its SESSION_SECRET and owner ID, migrate the old shop with the migration instructions, then set TELECART_SQLITE_PATH=data/telecart.db and remove DATABASE_URL.");
  }
  const error = validateLocalConfig(config);
  if (error) throw new Error(`${error} The launcher did not change .env.local.`);
  return config;
}

async function ensureConfig() {
  let config = loadConfig();
  if (config) return config;
  console.log("No local configuration file exists yet.");
  const values = await makeFirstRunConfig();
  await saveFirstRunConfig(envPath, values);
  config = loadConfig();
  if (!config) throw new Error("Could not load the new .env.local file. It has not been overwritten.");
  console.log("Saved private local settings. Secrets were not printed.");
  return config;
}

function checkPrerequisites(env) {
  if (!supportedNodeVersion(process.versions.node)) {
    throw new Error(`This project needs Node.js 22.16+ or 24+. You have Node.js ${process.versions.node}. Install a supported version; the launcher will not install system software.`);
  }
  const command = processCommand(packageManager, ["--version"]);
  const result = spawnSync(command.executable, command.args, {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    shell: command.shell,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("pnpm was not found. Install Node.js and pnpm first; the launcher will not install system software.");
  }
  if (result.status !== 0) {
    throw new Error("pnpm could not start. Verify your pnpm installation, then try again.");
  }
  console.log(`Using Node.js ${process.versions.node} and pnpm ${result.stdout.trim()}.`);
}

function requiredDependenciesAvailable() {
  return [
    "node_modules/.pnpm/lock.yaml",
    "lib/db/node_modules/drizzle-orm",
    "artifacts/api-server/node_modules/esbuild",
    "artifacts/telecart/node_modules/vite",
    "lib/db/node_modules/drizzle-kit",
  ].every(path => existsSync(join(projectRoot, path)));
}

function dependenciesInstalled() {
  if (!requiredDependenciesAvailable()) return false;
  try {
    return readFileSync(join(projectRoot, "node_modules", ".telecart-local-install"), "utf8").trim() === dependencyFingerprint();
  } catch {
    return false;
  }
}

function dependencyFingerprint() {
  const manifestFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
  const visit = directory => {
    for (const entry of readdirSync(join(projectRoot, directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || ["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
      const child = join(directory, entry.name);
      if (existsSync(join(projectRoot, child, "package.json"))) manifestFiles.push(join(child, "package.json"));
      visit(child);
    }
  };
  for (const workspace of ["artifacts", "lib", "scripts"]) {
    if (existsSync(join(projectRoot, workspace))) visit(workspace);
  }
  const hash = createHash("sha256");
  for (const path of [...new Set(manifestFiles)].sort()) {
    hash.update(path).update("\0").update(readFileSync(join(projectRoot, path))).update("\0");
  }
  return hash.digest("hex");
}

function prepareDependencies() {
  if (dependenciesInstalled()) return;
  console.log("Installing this project's locked dependencies with pnpm. No system software will be installed.");
  const result = runPnpm(["install", "--frozen-lockfile"], makeSystemEnvironment(process.env));
  if (result.error || result.status !== 0) {
    throw new Error("Dependency setup failed. Review the pnpm output, install the project prerequisites, and run the launcher again.");
  }
  if (!requiredDependenciesAvailable()) {
    throw new Error("pnpm finished, but required workspace packages are still missing. Review the dependency output.");
  }
  writeFileSync(join(projectRoot, "node_modules", ".telecart-local-install"), `${dependencyFingerprint()}\n`, { mode: 0o600 });
}

function checkPorts() {
  return Promise.all([LOCAL_API_PORT, LOCAL_WEB_PORT].map(port => assertPortAvailable(port)));
}

function makeDatabaseEnvironment(config) {
  return {
    ...makeSystemEnvironment(process.env),
    NODE_ENV: "development",
    TELECART_SQLITE_PATH: config.TELECART_SQLITE_PATH,
    TELECART_OWNER_ID: config.TELECART_OWNER_ID,
  };
}

function makeDashboardEnvironment() {
  return {
    ...makeSystemEnvironment(process.env),
    NODE_ENV: "development",
    BASE_PATH: "/",
    TELECART_LOCAL_API_PORT: String(LOCAL_API_PORT),
    TELECART_TELEGRAM_DISABLED: "true",
  };
}

function checkDatabase(config, env) {
  const checkScript = join(projectRoot, "artifacts", "api-server", "scripts", "check-local-db.mjs");
  const result = spawnSync(process.execPath, [checkScript], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  let status;
  try {
    status = JSON.parse(result.stdout.trim());
  } catch {
    const message = "Could not open the SQLite database. Check TELECART_SQLITE_PATH, folder permissions, and whether another Telecart process is using the file.";
    throw new Error(message);
  }
  if (result.status !== 0 || !status || !Array.isArray(status.missingTables)) {
    throw new Error("Could not inspect the SQLite database. Check the file path and permissions; no servers were started.");
  }
  if (config.TELECART_SQLITE_PATH !== env.TELECART_SQLITE_PATH) {
    throw new Error("The local database configuration was not passed safely to the checker.");
  }
  return status;
}

async function prepareSchema(status, config, explicitSetup) {
  const databaseEnv = makeDatabaseEnvironment(config);
  const action = schemaAction(status, explicitSetup);
  if (action === "ready") return;
  if (action === "blocked") {
    throw new Error(
      `The database contains tables but is missing ${status.missingTables.length} required Telecart tables. The launcher did not change them. Back up and review the database, then run pnpm db:local and confirm each schema change.`,
    );
  }
  if (action === "initialize_empty") {
    console.log("This database has no tables in its selected schema.");
    console.log("The one-time setup will create Telecart tables and does not drop existing rows.");
    const answer = await askLine("Type CREATE TELECART TABLES to confirm, or press Enter to cancel: ");
    if (answer !== "CREATE TELECART TABLES") throw new Error("Database initialization cancelled. No schema changes were made.");
  } else {
    console.warn("This database already contains the Telecart tables. Schema setup may change its structure.");
    if (!hasCompleteSchema(status)) console.warn("Some required Telecart tables are missing.");
    console.warn("Existing SQLite data is preserved. Unknown or incomplete live schemas are refused, not silently rewritten.");
    const answer = await askLine("Type APPLY SCHEMA CHANGES to continue, or press Enter to cancel: ");
    if (answer !== "APPLY SCHEMA CHANGES") throw new Error("Database schema setup cancelled. The application schema was not changed.");
  }

  const result = runPnpm(["--filter", "@workspace/db", "run", "push"], databaseEnv);
  if (result.error || result.status !== 0) {
    throw new Error("SQLite initialization did not finish. The app was not started. Review the output and check the file before retrying.");
  }
  const verified = checkDatabase(config, databaseEnv);
  if (!hasCompleteSchema(verified)) {
    throw new Error("Database setup ended without all required Telecart tables. The app was not started.");
  }
  console.log("Telecart database schema is ready.");
}

async function approveSavedProcessing(status) {
  if (!shouldAskProcessingConsent(status)) return;
  console.warn("");
  console.warn("This database has saved Telegram processing, advertising schedules, or payments that may resume.");
  console.warn("Starting localhost can poll Telegram, send previously approved ads, and check existing payments.");
  console.warn("Disable Telegram and stop schedules on the old copy first. This prompt does not enable a provider or compose a new message.");
  const answer = await askLine("Type START LOCAL PROCESSING to approve this local copy, or press Enter to stop: ");
  if (answer !== "START LOCAL PROCESSING") {
    throw new Error("Local startup cancelled. No local server or background worker was started.");
  }
}

export async function askLine(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("A confirmation needs an interactive terminal. Start the app from Windows Terminal or a shell window.");
  }
  const readline = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    readline.question(question, answer => {
      readline.close();
      resolve(answer.trim());
    });
    readline.once("SIGINT", () => {
      readline.close();
      reject(new Error("Operation cancelled. No database changes were made."));
    });
  });
}

function buildApi() {
  const result = runPnpm(["--filter", "@workspace/api-server", "run", "build"], makeSystemEnvironment(process.env));
  if (result.error || result.status !== 0) {
    throw new Error("API build failed. Resolve the displayed build error before starting Telecart.");
  }
}

function launchBrowser() {
  const url = `http://localhost:${LOCAL_WEB_PORT}`;
  const env = makeSystemEnvironment(process.env);
  if (process.platform === "win32") {
    const opener = spawn("explorer.exe", [url], {
      cwd: projectRoot, env, detached: true, stdio: "ignore", windowsHide: true,
    });
    opener.on("error", () => console.log(`Open ${url} in your browser.`));
    opener.unref();
  } else {
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const opener = spawn(command, [url], { cwd: projectRoot, env, detached: true, stdio: "ignore" });
    opener.on("error", () => console.log(`Open ${url} in your browser.`));
    opener.unref();
  }
}

function spawnService(label, args, env) {
  const command = processCommand(packageManager, args);
  const child = spawn(command.executable, command.args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    shell: command.shell,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.label = label;
  child.on("error", error => { child.startError = error; });
  return child;
}

function supervise(children, onStopping) {
  let stopping = false;
  let resolveExit;
  const done = new Promise(resolve => { resolveExit = resolve; });
  const finish = (code, message = "") => {
    if (stopping) return;
    stopping = true;
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    onStopping();
    if (message) console.error(message);
    void stopOwnedChildren(children).finally(() => resolveExit(code));
  };
  const onInterrupt = () => finish(0);
  const onTerminate = () => finish(0);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  for (const child of children) {
    child.on("error", () => finish(1, `${child.label} could not start.`));
    child.once("exit", (code, signal) => {
      if (!stopping) {
        finish(code === 0 ? 1 : code ?? 1, `${child.label} stopped${signal ? ` (${signal})` : ""}. The other local service will be stopped too.`);
      }
    });
  }
  return { done, stop: finish };
}

export async function runLocalLauncher(argv = process.argv.slice(2)) {
  if (!supportedNodeVersion(process.versions.node)) {
    throw new Error(`This project needs Node.js 22.16+ or 24+. You have Node.js ${process.versions.node}. Install a supported version; the launcher will not install system software.`);
  }
  checkPrerequisites(makeSystemEnvironment(process.env));
  let config = await ensureConfig();
  const configError = validateLocalConfig(config);
  if (configError) throw new Error(configError);

  const env = makeChildEnvironment(process.env, config);
  const databaseEnv = makeDatabaseEnvironment(config);
  prepareDependencies();
  const setupOnly = argv.includes("--setup");
  if (!setupOnly) await checkPorts();

  let status = checkDatabase(config, databaseEnv);
  await prepareSchema(status, config, setupOnly);
  if (setupOnly) {
    console.log("Schema setup finished. Daily startup will not apply schema changes.");
    return 0;
  }

  status = checkDatabase(config, databaseEnv);
  if (!hasCompleteSchema(status)) {
    throw new Error("The database is not ready. No servers were started.");
  }
  await approveSavedProcessing(status);
  return startLocalAppAfterBuild(env);
}

export async function startLocalAppAfterBuild(env, dependencies = {}) {
  const build = dependencies.buildApi ?? buildApi;
  const spawnChild = dependencies.spawnService ?? spawnService;
  const waitForReady = dependencies.waitForServices ?? waitForLocalServices;
  const openBrowser = dependencies.openBrowser ?? launchBrowser;
  const superviseChildren = dependencies.supervise ?? supervise;
  build();
  const dashboardEnv = makeDashboardEnvironment();
  const children = [
    spawnChild("API server", ["--filter", "@workspace/api-server", "run", "start"], {
      ...env, PORT: String(LOCAL_API_PORT),
    }),
    spawnChild("Dashboard", [
      "--filter", "@workspace/telecart", "exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1",
    ], {
      ...dashboardEnv, PORT: String(LOCAL_WEB_PORT),
    }),
  ];
  const startupAbort = new AbortController();
  const lifecycle = superviseChildren(children, () => startupAbort.abort());
  try {
    const ready = await Promise.race([
      waitForReady({
        apiUrl: `http://127.0.0.1:${LOCAL_API_PORT}/api/healthz`,
        webUrl: `http://127.0.0.1:${LOCAL_WEB_PORT}/`,
        children,
        signal: startupAbort.signal,
      }).then(() => true),
      lifecycle.done.then(() => false),
    ]);
    if (!ready) return lifecycle.done;
  } catch (error) {
    lifecycle.stop(1, error instanceof Error ? error.message : "Local startup failed.");
    return lifecycle.done;
  }
  console.log(`API and dashboard are ready. Opening http://localhost:${LOCAL_WEB_PORT}.`);
  openBrowser();
  return lifecycle.done;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runLocalLauncher().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : "Local startup failed.");
    process.exitCode = 1;
  });
}
