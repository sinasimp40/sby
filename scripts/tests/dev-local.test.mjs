import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalAppAfterBuild } from "../dev-local.mjs";
import {
  assertPortAvailable,
  DATABASE_TABLES,
  hasCompleteSchema,
  isLoopbackDatabase,
  makeChildEnvironment,
  parseLocalEnv,
  processCommand,
  schemaAction,
  serializeLocalEnv,
  shouldAskProcessingConsent,
  stopOwnedChildren,
  supportedNodeVersion,
  validateLocalConfig,
  waitForLocalServices,
} from "../local-core.mjs";
import { inspectLocalDatabase } from "../../artifacts/api-server/scripts/check-local-db.mjs";
import { makeFirstRunConfig, saveFirstRunConfig } from "../local-setup.mjs";

const config = {
  TELECART_SQLITE_PATH: "data/telecart.db",
  SESSION_SECRET: "s".repeat(64),
  TELECART_OWNER_ID: "local-owner",
  TELECART_ADMIN_EMAIL: "owner@example.com",
  TELECART_ADMIN_INITIAL_PASSWORD: "a-local-password-with-specials",
};

test("the supported Node versions match the documented local prerequisites", () => {
  assert.equal(supportedNodeVersion("v22.15.9"), false);
  assert.equal(supportedNodeVersion("v22.16.0"), true);
  assert.equal(supportedNodeVersion("v22.20.0"), true);
  assert.equal(supportedNodeVersion("v23.1.0"), false);
  assert.equal(supportedNodeVersion("v24.0.0"), true);
});

test("Windows package commands use cmd.exe without shell argument forwarding", () => {
  const windows = processCommand("pnpm.cmd", ["--filter", "@workspace/api-server", "run", "start"], "win32");
  assert.deepEqual(windows, {
    executable: "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm.cmd --filter @workspace/api-server run start"],
    shell: false,
  });
  assert.throws(() => processCommand("pnpm.cmd", ["install & whoami"], "win32"), /unsupported argument/);
  assert.deepEqual(processCommand("pnpm", ["--version"], "linux"), {
    executable: "pnpm", args: ["--version"], shell: false,
  });
});

test("private environment serialization round-trips quotes, slashes and spaces", () => {
  const original = {
    ...config,
    TELECART_SQLITE_PATH: "C:\\My Shop\\data\\telecart.db",
    TELECART_ADMIN_INITIAL_PASSWORD: `space pass with "quotes", a slash \\\\ and $ symbol`,
  };
  const serialized = serializeLocalEnv(original);
  const parsed = parseLocalEnv(serialized);
  assert.deepEqual(
    Object.fromEntries(Object.keys(config).map(key => [key, parsed[key]])),
    original,
  );
  assert.equal(parsed.TELECART_TELEGRAM_DISABLED, "true");
  assert.equal(validateLocalConfig(parsed), null);
  assert.equal(parseLocalEnv('PASSWORD="one # two" # local comment').PASSWORD, "one # two");
});

test("invalid and incomplete settings stop without printing any credential", () => {
  const invalid = { ...config, TELECART_SQLITE_PATH: "postgresql://not-a-sqlite-file" };
  const message = validateLocalConfig(invalid);
  assert.match(message, /SQLite file/);
  assert.doesNotMatch(message, /password/);
  assert.equal(validateLocalConfig({
    ...config, SESSION_SECRET: "legacy-secret", TELECART_ADMIN_INITIAL_PASSWORD: "legacy",
  }), null, "existing installations keep their original secret and login");
});

test("child processes receive only local installation settings, not Replit credentials", () => {
  const env = makeChildEnvironment({
    PATH: "/safe/path",
    HOME: "/home/user",
    SESSION_SECRET: "do-not-use-the-Replit-secret",
    DATABASE_URL: "postgresql://unexpected/production",
    CLERK_SECRET_KEY: "do-not-forward",
    OPENAI_API_KEY: "do-not-forward",
    TELEGRAM_API_HASH: "do-not-forward",
    REPLIT_DB_URL: "do-not-forward",
  }, config);
  assert.equal(env.PATH, "/safe/path");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.SESSION_SECRET, config.SESSION_SECRET);
  assert.equal(env.TELECART_SQLITE_PATH, config.TELECART_SQLITE_PATH);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.TELECART_LOCAL_ONLY, "true");
  assert.equal(env.TELECART_TELEGRAM_DISABLED, "true");
  for (const key of ["CLERK_SECRET_KEY", "OPENAI_API_KEY", "TELEGRAM_API_HASH", "REPLIT_DB_URL"]) {
    assert.equal(Object.hasOwn(env, key), false);
  }
});

test("database safety checks distinguish local hosts, complete schema and resumable work", () => {
  assert.equal(isLoopbackDatabase(config.TELECART_SQLITE_PATH), true);
  assert.equal(isLoopbackDatabase("postgresql://db.example.net/shop"), false);
  assert.equal(isLoopbackDatabase("postgresql:///telecart"), true);
  assert.equal(hasCompleteSchema({ missingTables: [] }), true);
  assert.equal(hasCompleteSchema({ missingTables: ["shop_settings"] }), false);
  assert.equal(schemaAction({ missingTables: [], tableCount: 24 }, false), "ready");
  assert.equal(schemaAction({ missingTables: [], tableCount: 24 }, true), "review_changes");
  assert.equal(schemaAction({ missingTables: ["shop_settings"], tableCount: 0 }, false), "initialize_empty");
  assert.equal(schemaAction({ missingTables: ["shop_settings"], tableCount: 2 }, false), "blocked");
  assert.equal(schemaAction({ missingTables: ["shop_settings"], tableCount: 2 }, true), "review_changes");
  assert.equal(shouldAskProcessingConsent({
    telegramEnabled: false, shopBotConnected: false, advertisingScheduled: false, pendingPayments: false,
  }), false);
  for (const key of ["telegramEnabled", "shopBotConnected", "advertisingScheduled", "pendingPayments"]) {
    assert.equal(shouldAskProcessingConsent({ [key]: true }), true, `${key} must require explicit approval`);
  }
});

test("database readiness inspection uses only synthetic tables and owner-scoped job flags", async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("sqlite_master")) {
      return { rows: DATABASE_TABLES.map(table_name => ({ table_name })) };
    }
    return { rows: [{
      telegram_enabled: true,
      shop_bot_connected: false,
      advertising_scheduled: true,
      pending_payments: false,
    }] };
  };
  const status = await inspectLocalDatabase(query, "synthetic-owner");
  assert.equal(status.tableCount, DATABASE_TABLES.length);
  assert.deepEqual(status.missingTables, []);
  assert.equal(status.telegramEnabled, true);
  assert.equal(status.advertisingScheduled, true);
  assert.deepEqual(calls[1].params, ["synthetic-owner"]);
  assert.match(calls[1].sql, /WHERE owner_id = \$1/);

  calls.length = 0;
  const incomplete = await inspectLocalDatabase(async sql => {
    calls.push(sql);
    return { rows: [{ table_name: "shop_settings" }] };
  }, "synthetic-owner");
  assert.equal(incomplete.missingTables.length, DATABASE_TABLES.length - 1);
  assert.equal(calls.length, 1, "incomplete schemas must not query saved jobs");
});

test("first-run configuration generates a fresh secret without reading Replit environment", async () => {
  const visible = ["1", "", "admin@example.com"];
  const hidden = [config.TELECART_ADMIN_INITIAL_PASSWORD, config.TELECART_ADMIN_INITIAL_PASSWORD];
  const result = await makeFirstRunConfig({
    ask: async () => visible.shift(),
    askSecret: async () => hidden.shift(),
  });
  assert.equal(result.TELECART_OWNER_ID, "local-admin");
  assert.equal(result.TELECART_ADMIN_EMAIL, "admin@example.com");
  assert.equal(result.SESSION_SECRET.length, 96);
  assert.match(result.SESSION_SECRET, /^[a-f0-9]{96}$/);
  assert.equal(validateLocalConfig(result), null);
});

test("attaching an existing database preserves its original secret and owner", async () => {
  const visible = ["2", "data/existing.db", "existing-shop-owner", "admin@example.com"];
  const hidden = [
    "the-original-session-secret-for-this-shop-123456",
    config.TELECART_ADMIN_INITIAL_PASSWORD,
    config.TELECART_ADMIN_INITIAL_PASSWORD,
  ];
  const result = await makeFirstRunConfig({
    ask: async () => visible.shift(),
    askSecret: async () => hidden.shift(),
  });
  assert.equal(result.SESSION_SECRET, "the-original-session-secret-for-this-shop-123456");
  assert.equal(result.TELECART_OWNER_ID, "existing-shop-owner");
});

test("new installations reject a short password without saving configuration", async () => {
  const visible = ["1", "", "admin@example.com"];
  const hidden = ["short", "short"];
  await assert.rejects(makeFirstRunConfig({
    ask: async () => visible.shift(),
    askSecret: async () => hidden.shift(),
  }), /at least 12 characters/);
});

test("the generated settings file is private and cannot overwrite an installation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "telecart local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, ".env.local");
  await saveFirstRunConfig(path, config);
  assert.deepEqual(parseLocalEnv(await readFile(path, "utf8")).TELECART_OWNER_ID, config.TELECART_OWNER_ID);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(saveFirstRunConfig(path, { ...config, SESSION_SECRET: "new-secret" }), /already exists/);
  assert.equal(parseLocalEnv(await readFile(path, "utf8")).SESSION_SECRET, config.SESSION_SECRET);
});

test("port conflict checks report a clear error without touching a process", async () => {
  const fakeServer = new EventEmitter();
  fakeServer.listen = () => process.nextTick(() => {
    const error = new Error("occupied");
    error.code = "EADDRINUSE";
    fakeServer.emit("error", error);
  });
  fakeServer.close = callback => callback();
  await assert.rejects(
    assertPortAvailable(5173, { serverFactory: () => fakeServer }),
    /Port 5173 is already in use/,
  );
});

test("browser readiness waits for both stubbed local services", async () => {
  let now = 0;
  let apiChecks = 0;
  let webChecks = 0;
  await waitForLocalServices({
    apiUrl: "http://127.0.0.1:8080/api/healthz",
    webUrl: "http://127.0.0.1:5173/",
    timeoutMs: 1200,
    intervalMs: 300,
    now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: async url => {
      if (url.includes("8080")) {
        apiChecks++;
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      webChecks++;
      return { ok: webChecks >= 3, json: async () => ({}) };
    },
  });
  assert.equal(apiChecks, 3);
  assert.equal(webChecks, 3);
});

test("startup builds first and opens the browser only after both synthetic services are ready", async () => {
  const events = [];
  const children = [];
  const runtimeEnv = makeChildEnvironment({ PATH: "/safe/path", CLERK_SECRET_KEY: "synthetic-only" }, config);
  const result = await startLocalAppAfterBuild(runtimeEnv, {
    buildApi: () => events.push("build"),
    spawnService: (label, _args, serviceEnv) => {
      if (label === "API server") {
        assert.equal(serviceEnv.SESSION_SECRET, config.SESSION_SECRET);
        assert.equal(serviceEnv.TELECART_ADMIN_INITIAL_PASSWORD, config.TELECART_ADMIN_INITIAL_PASSWORD);
        assert.equal(serviceEnv.CLERK_SECRET_KEY, undefined);
      } else {
        assert.equal(serviceEnv.SESSION_SECRET, undefined);
        assert.equal(serviceEnv.DATABASE_URL, undefined);
        assert.equal(serviceEnv.TELECART_ADMIN_INITIAL_PASSWORD, undefined);
      }
      events.push(`start:${label}`);
      const child = new EventEmitter();
      child.pid = null;
      child.exitCode = null;
      child.signalCode = null;
      children.push(child);
      return child;
    },
    supervise: (started, onStopping) => {
      assert.equal(started.length, 2);
      events.push("supervise");
      return { done: Promise.resolve(0), stop: () => onStopping() };
    },
    waitForServices: async ({ apiUrl, webUrl, children: started }) => {
      assert.match(apiUrl, /8080\/api\/healthz$/);
      assert.match(webUrl, /5173\/$/);
      assert.deepEqual(started, children);
      events.push("both-ready");
    },
    openBrowser: () => events.push("open-browser"),
  });
  assert.equal(result, 0);
  assert.deepEqual(events, [
    "build", "start:API server", "start:Dashboard", "supervise", "both-ready", "open-browser",
  ]);
});

test("startup failure never opens the browser and cleans up its own services", async () => {
  const events = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const result = await startLocalAppAfterBuild({ synthetic: true }, {
    buildApi: () => events.push("build"),
    spawnService: label => {
      const child = new EventEmitter();
      child.pid = null;
      child.exitCode = null;
      child.signalCode = null;
      events.push(`start:${label}`);
      return child;
    },
    supervise: (_children, onStopping) => ({
      done,
      stop: code => {
        events.push("cleanup");
        onStopping();
        resolveDone(code);
      },
    }),
    waitForServices: async () => { throw new Error("Synthetic readiness failure."); },
    openBrowser: () => events.push("open-browser"),
  });
  assert.equal(result, 1);
  assert.equal(events.includes("open-browser"), false);
  assert.equal(events.at(-1), "cleanup");
});

test("readiness stops early on service failure or timeout", async () => {
  await assert.rejects(waitForLocalServices({
    apiUrl: "http://api/health", webUrl: "http://web/",
    children: [{ label: "API server", exitCode: 1, signalCode: null }],
    timeoutMs: 100, fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok" }) }),
  }), /API server stopped/);

  let now = 0;
  await assert.rejects(waitForLocalServices({
    apiUrl: "http://api/health", webUrl: "http://web/",
    timeoutMs: 600, intervalMs: 300, now: () => now,
    sleep: async ms => { now += ms; },
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  }), /did not both become ready/);
});

test("shutdown signals only the process groups started by this launcher", async () => {
  const signals = [];
  const children = [
    { pid: 401, exitCode: null, signalCode: null },
    { pid: 402, exitCode: null, signalCode: null },
  ];
  await stopOwnedChildren(children, {
    platform: "linux",
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    groupExists: () => true,
    gracePeriodMs: 0,
    sleep: async () => {},
  });
  assert.deepEqual(signals, [
    [-401, "SIGTERM"], [-402, "SIGTERM"], [-401, "SIGKILL"], [-402, "SIGKILL"],
  ]);
});

test("Windows cleanup uses only the tracked process trees", async () => {
  const graceful = [];
  const forced = [];
  const children = [{ pid: 701, exitCode: null, signalCode: null }];
  await stopOwnedChildren(children, {
    platform: "win32",
    killTree: pid => graceful.push(pid),
    forceKillTree: pid => forced.push(pid),
    gracePeriodMs: 0,
    sleep: async () => {},
  });
  assert.deepEqual(graceful, [701]);
  assert.deepEqual(forced, [701]);
});

test("Windows launcher anchors and quotes its project path; shell launcher parses", async () => {
  const root = new URL("../../", import.meta.url);
  const batch = await readFile(new URL("start-local.bat", root), "utf8");
  const shell = await readFile(new URL("start-local.sh", root), "utf8");
  assert.match(batch, /pushd "%~dp0"/i);
  assert.match(batch, /node "%~dp0scripts\\dev-local\.mjs"/i);
  assert.match(shell, /SCRIPT_DIR=.*dirname -- "\$0"/);
});
