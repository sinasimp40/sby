import { spawn } from "node:child_process";
import { createServer } from "node:net";

export const LOCAL_HTTP_ORIGIN = "http://localhost";
export const LOCAL_WEB_PORT = 5173;
export const LOCAL_API_PORT = 8080;
export const DATABASE_TABLES = [
  "admin_sessions", "admin_login_limits", "advertising_account_commands", "advertising_account_runs",
  "advertising_accounts", "advertising_bots", "advertising_campaigns", "advertising_deliveries",
  "advertising_groups", "advertising_schedules", "bot_connections", "bot_customers", "bot_runtime_settings",
  "bot_updates", "emoji_import_sessions", "provider_credentials", "shop_activity", "shop_custom_emojis",
  "shop_inventory", "shop_payments", "shop_products", "shop_records", "shop_settings", "wallet_entries",
];

export function processCommand(executable, args, platform = process.platform) {
  if (platform !== "win32") return { executable, args, shell: false };
  const words = [executable, ...args];
  if (words.some(word => !/^[A-Za-z0-9@._:/-]+$/.test(word))) {
    throw new Error("The Windows command contains an unsupported argument; it was not executed.");
  }
  return {
    executable: "cmd.exe",
    args: ["/d", "/s", "/c", words.join(" ")],
    shell: false,
  };
}

const LOCAL_ENV_KEYS = [
  "TELECART_SQLITE_PATH",
  "SESSION_SECRET",
  "TELECART_OWNER_ID",
  "TELECART_ADMIN_EMAIL",
  "TELECART_ADMIN_INITIAL_PASSWORD",
];

export function parseLocalEnv(contents) {
  const values = {};
  for (const [index, sourceLine] of contents.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env.local line ${index + 1}.`);
    const [, key, raw] = match;
    let value;
    if (raw.startsWith('"')) {
      let end = -1;
      let escaped = false;
      for (let i = 1; i < raw.length; i++) {
        if (raw[i] === '"' && !escaped) {
          end = i;
          break;
        }
        if (raw[i] === "\\" && !escaped) escaped = true;
        else escaped = false;
      }
      if (end < 1 || (raw.slice(end + 1).trim() && !raw.slice(end + 1).trim().startsWith("#"))) {
        throw new Error(`Invalid quoted value on .env.local line ${index + 1}.`);
      }
      try {
        value = JSON.parse(raw.slice(0, end + 1));
      } catch {
        throw new Error(`Invalid quoted value on .env.local line ${index + 1}.`);
      }
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      if (end < 1 || (raw.slice(end + 1).trim() && !raw.slice(end + 1).trim().startsWith("#"))) {
        throw new Error(`Invalid quoted value on .env.local line ${index + 1}.`);
      }
      value = raw.slice(1, end);
    } else {
      value = raw.replace(/\s+#.*$/, "").trim();
    }
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate .env.local key: ${key}.`);
    values[key] = value;
  }
  return values;
}

export function serializeLocalEnv(values) {
  return [
    "# Private local installation settings. Do not commit or share this file.",
    ...LOCAL_ENV_KEYS.map(key => `${key}=${JSON.stringify(values[key] ?? "")}`),
    "TELECART_TELEGRAM_DISABLED=true",
    "",
  ].join("\n");
}

export function validateLocalConfig(values) {
  for (const key of LOCAL_ENV_KEYS) {
    if (typeof values[key] !== "string" || !values[key].trim()) {
      return `Set ${key} in .env.local. Start the launcher again when it is complete.`;
    }
    if (/[\u0000-\u001f\u007f]/.test(values[key])) {
      return `${key} contains an unsupported control character. Edit .env.local and try again.`;
    }
  }
  if (/^[a-z]+:\/\//i.test(values.TELECART_SQLITE_PATH) || values.TELECART_SQLITE_PATH === ":memory:") {
    return "TELECART_SQLITE_PATH must name a persistent local SQLite file, not a server URL or in-memory database.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.TELECART_ADMIN_EMAIL.trim())) {
    return "TELECART_ADMIN_EMAIL must be a valid email address.";
  }
  if (!values.TELECART_OWNER_ID.trim() || values.TELECART_OWNER_ID.length > 200) {
    return "TELECART_OWNER_ID must contain 1–200 characters.";
  }
  return null;
}

export function supportedNodeVersion(version) {
  const [major, minor = 0, patch = 0] = version.replace(/^v/, "").split(".").map(Number);
  return (major === 22 && (minor > 16 || (minor === 16 && patch >= 0))) || major >= 24;
}

export function isLoopbackDatabase(databaseUrl) {
  if (!/^[a-z]+:\/\//i.test(databaseUrl)) return true;
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  return !hostname || hostname === "localhost" || hostname === "::1" || hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function shouldAskProcessingConsent(status) {
  return Boolean(status.telegramEnabled || status.shopBotConnected ||
    status.advertisingScheduled || status.pendingPayments);
}

export function hasCompleteSchema(status) {
  return status.missingTables.length === 0;
}

export function schemaAction(status, explicitSetup = false) {
  if (hasCompleteSchema(status)) return explicitSetup ? "review_changes" : "ready";
  if (status.tableCount === 0) return "initialize_empty";
  return explicitSetup ? "review_changes" : "blocked";
}

export function makeChildEnvironment(systemEnv, localConfig, overrides = {}) {
  const env = makeSystemEnvironment(systemEnv);
  Object.assign(env, Object.fromEntries(LOCAL_ENV_KEYS.map(key => [key, localConfig[key]])));
  return {
    ...env,
    NODE_ENV: "development",
    BASE_PATH: "/",
    TELECART_LOCAL_ONLY: "true",
    TELECART_LOCAL_API_PORT: String(LOCAL_API_PORT),
    TELECART_ADMIN_ORIGIN: `${LOCAL_HTTP_ORIGIN}:${LOCAL_WEB_PORT}`,
    // Local providers are configured through the dashboard, never inherited from Replit.
    TELECART_TELEGRAM_DISABLED: "true",
    ...overrides,
  };
}

export function makeSystemEnvironment(systemEnv) {
  const allowedSystemKeys = new Set([
    "path", "pathext", "systemroot", "systemdrive", "windir", "comspec", "home", "userprofile",
    "appdata", "localappdata", "temp", "tmp", "tmpdir", "pnpm_home", "corepack_home",
    "display", "wayland_display", "xauthority", "xdg_runtime_dir", "dbus_session_bus_address",
  ]);
  const env = {};
  const keysByLowercase = new Map(Object.keys(systemEnv).map(key => [key.toLowerCase(), key]));
  for (const allowed of allowedSystemKeys) {
    const key = keysByLowercase.get(allowed);
    if (key) env[key] = systemEnv[key];
  }
  return env;
}

export async function assertPortAvailable(port, {
  host = "127.0.0.1",
  serverFactory = () => createServer(),
} = {}) {
  const server = serverFactory();
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(error));
    server.listen(port, host, resolve);
  }).catch(error => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`Port ${port} is already in use. Close the other local app or change its port; this launcher will not stop unrelated processes.`);
    }
    throw new Error(`Could not check port ${port}. ${error?.code ?? "Check local network permissions."}`);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function waitForLocalServices({
  apiUrl,
  webUrl,
  fetchImpl = fetch,
  children = [],
  signal,
  timeoutMs = 60_000,
  intervalMs = 300,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  const healthy = async (url, isApi) => {
    try {
      const timeout = AbortSignal.timeout(1500);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(url, { signal: requestSignal });
      if (!response.ok) return false;
      if (!isApi) return true;
      return (await response.json()).status === "ok";
    } catch {
      return false;
    }
  };
  while (now() < deadline) {
    if (signal?.aborted) throw new Error("Local startup was cancelled.");
    const errored = children.find(child => child.startError);
    if (errored) throw new Error(`${errored.label ?? "A local service"} could not start. Check that pnpm and the project dependencies are available.`);
    const stopped = children.find(child => child.exitCode !== null || child.signalCode !== null);
    if (stopped) throw new Error(`${stopped.label ?? "A local service"} stopped before becoming ready. Review the error above.`);
    const [apiReady, webReady] = await Promise.all([healthy(apiUrl, true), healthy(webUrl, false)]);
    if (apiReady && webReady) return;
    await sleep(intervalMs);
  }
  throw new Error("The API and dashboard did not both become ready within 60 seconds. Review the service output above.");
}

export async function stopOwnedChildren(children, {
  platform = process.platform,
  signalProcess = (pid, signal) => process.kill(pid, signal),
  groupExists = pid => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { return error?.code === "EPERM"; }
  },
  killTree = pid => spawnTaskkill(pid, false),
  forceKillTree = pid => spawnTaskkill(pid, true),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  gracePeriodMs = 8500,
} = {}) {
  const owned = children.filter(child => child.pid);
  for (const child of owned) {
    if (platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid);
    } else {
      // Signal the process group even if pnpm (the group leader) already exited;
      // a spawned API or Vite child may still be alive in that same owned group.
      try { signalProcess(-child.pid, "SIGTERM"); } catch { /* This owned process group already ended. */ }
    }
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline) {
    const stillRunning = owned.some(child => platform === "win32"
      ? child.exitCode === null && child.signalCode === null
      : groupExists(child.pid));
    if (!stillRunning) return;
    await sleep(Math.min(150, deadline - Date.now()));
  }
  for (const child of owned) {
    if (platform === "win32") {
      // Avoid targeting a PID that Windows has already recycled for another app.
      if (child.exitCode === null && child.signalCode === null) forceKillTree(child.pid);
    }
    else {
      // The group leader may exit before one of its children finishes shutdown.
      if (!groupExists(child.pid)) continue;
      try { signalProcess(-child.pid, "SIGKILL"); } catch { /* This owned process group already ended. */ }
    }
  }
}

function spawnTaskkill(pid, force) {
  const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
  const child = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  return child;
}
