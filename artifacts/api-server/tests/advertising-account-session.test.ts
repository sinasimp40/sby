import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { pool } from "@workspace/db";
import { logger } from "../src/lib/logger";
import { createAccountDriver, type AccountFactory } from "../src/lib/advertising-account-driver";
import { safeAccountError, reportAccountError, isSessionStopped } from "../src/lib/advertising-account-errors";
import { connectedAccountSession, closeAccountSession, shutdownAccountSessions, accountConnectionKey } from "../src/lib/advertising-account-session";
import { beginAccountLogin, advanceAccountLogin, accountStatus, checkAccountConnection, withAccountDriver, disconnectAccount, cancelAccountLogin } from "../src/lib/advertising-account-auth";
import { checkAccountGroups, discoverAccountGroups } from "../src/lib/advertising-account-groups";
import { withAdvertisingLock } from "../src/lib/advertising-store";

test("safe diagnostics preserve known codes but never RPC payloads, credentials or arbitrary error text", () => {
  const warn = logger.warn;
  const entries: unknown[] = [];
  logger.warn = ((entry: unknown) => { entries.push(entry); }) as typeof logger.warn;
  const secret = "TEST_ONLY_DO_NOT_LOG_SESSION_PASSWORD_PHONE";
  try {
    for (const code of ["SESSION_REVOKED", "AUTH_KEY_DUPLICATED", "AUTH_KEY_UNREGISTERED", "PEER_FLOOD"]) {
      const safe = reportAccountError("discover_groups", { errorMessage: code, message: secret, stack: secret, request: { password: secret } });
      assert.equal(safe.telegramCode, code);
      assert.ok(["auth", "restricted"].includes(safe.kind));
    }
    assert.equal(reportAccountError("connect", { errorMessage: secret }).telegramCode, "UNKNOWN");
    assert.doesNotMatch(JSON.stringify(entries), /DO_NOT_LOG|password|stack|request/);
    assert.ok(JSON.stringify(entries).includes("discover_groups"));
  } finally { logger.warn = warn; }
});

test("disposal destroys the SDK client and prevents a delayed preflight from posting", async () => {
  const getEntity = TelegramClient.prototype.getEntity, invoke = TelegramClient.prototype.invoke, destroy = TelegramClient.prototype.destroy;
  let resolveEntity: (value: Api.Channel) => void = () => {};
  const entityReady = new Promise<Api.Channel>(resolve => { resolveEntity = resolve; });
  let requests = 0, destroyed = 0;
  TelegramClient.prototype.getEntity = async () => entityReady;
  TelegramClient.prototype.invoke = async () => { requests++; throw new Error("TEST_ONLY RPC should be blocked"); };
  TelegramClient.prototype.destroy = async function () { this._destroyed = true; destroyed++; };
  try {
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    const send = driver.send("@TEST_ONLY_group", { text: "TEST_ONLY", imageUrl: null, buttonText: "Shop", buttonUrl: null }, "1");
    await driver.disconnect();
    resolveEntity(new Api.Channel({
      id: bigInt(12345), accessHash: bigInt(123), title: "TEST_ONLY",
      photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true,
    }));
    await assert.rejects(send, /closed/);
    assert.equal(destroyed, 1);
    assert.equal(requests, 0, "no follow-up RPC or message may be dispatched after disposal");
    await assert.rejects(driver.qr(), /closed/);
  } finally {
    TelegramClient.prototype.getEntity = getEntity;
    TelegramClient.prototype.invoke = invoke;
    TelegramClient.prototype.destroy = destroy;
  }
});

test("SDK sender reconnects are blocked even when autoReconnect:false is ignored, including queued retries", async () => {
  const connect = TelegramClient.prototype.connect, destroy = TelegramClient.prototype.destroy;
  let reconnects = 0, underlyingConnects = 0, disposed = 0, failures = 0;
  let captured: TelegramClient | undefined;
  TelegramClient.prototype.connect = async function () {
    captured = this;
    this._sender = {
      reconnect: () => { reconnects++; },
      _reconnect: async () => { reconnects++; },
      connect: async () => { underlyingConnects++; return true; },
      disconnect: async () => {},
    } as any;
    return true;
  };
  TelegramClient.prototype.destroy = async function () { this._destroyed = true; disposed++; };
  try {
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    driver.onFailure!(error => { failures++; assert.equal(error.telegramCode, "CONNECTION_LOST"); void driver.disconnect(); });
    await driver.connect();
    captured!._sender!.reconnect();
    await captured!._sender!._reconnect();
    await assert.rejects(captured!._sender!.connect({} as any), /connection was lost/);
    assert.equal(reconnects, 0);
    assert.equal(underlyingConnects, 0);
    assert.equal(failures, 1);
    assert.equal(disposed, 1);
  } finally {
    TelegramClient.prototype.connect = connect;
    TelegramClient.prototype.destroy = destroy;
  }
});

test("personal-account connection ownership, login promotion, failure stops and cleanup use only fake Telegram", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owners: string[] = [];
  const owner = () => { const id = `session-test-${randomUUID()}`; owners.push(id); return id; };
  const api = { apiId: 12345, apiHash: "a".repeat(32) };
  function harness() {
    const stats = { created: 0, connected: 0, disposed: 0, posts: 0, logouts: 0, fail: false, password: false };
    let background: (error: ReturnType<typeof safeAccountError>) => void = () => {};
    const factory: AccountFactory = input => {
      stats.created++;
      const state = input.session ? JSON.parse(input.session) as { authorized: boolean } : { authorized: false };
      return {
        connect: async () => { stats.connected++; },
        disconnect: async () => { stats.disposed++; },
        onFailure: handler => { background = handler; },
        session: () => JSON.stringify(state),
        me: async () => { if (stats.fail) throw { errorMessage: "SESSION_REVOKED", message: "TEST_ONLY_PRIVATE_PAYLOAD" }; return state.authorized ? { id: "900000001", username: "TEST_ONLY", displayName: "TEST_ONLY" } : null; },
        sendCode: async () => "TEST_ONLY_CODE_HASH",
        code: async () => { state.authorized = true; },
        password: async () => { state.authorized = true; },
        qr: async () => {
          if (stats.password) throw { errorMessage: "SESSION_PASSWORD_NEEDED" };
          state.authorized = true; return { authorized: true };
        },
        groups: async () => [{ chatId: "-100999999999", target: "-100999999999", title: "TEST_ONLY group" }],
        inspect: async target => ({ chatId: target, target, title: "TEST_ONLY group" }),
        send: async chatId => { stats.posts++; return { chatId, messageId: stats.posts }; },
        logout: async () => { stats.logouts++; state.authorized = false; },
      };
    };
    return { stats, factory, background: (code: string) => background(safeAccountError({ errorMessage: code })) };
  }
  async function phoneLogin(id: string, factory: AccountFactory) {
    await beginAccountLogin(id, { ...api, method: "phone", phone: "+15555550123" }, factory);
    await advanceAccountLogin(id, { loginId: (await accountStatus(id)).login!.id, code: "12345" }, false, factory);
  }
  try {
    await t.test("phone login promotes its original connection; discovery, checking and posting reuse it", async () => {
      const id = owner(), h = harness();
      await phoneLogin(id, h.factory);
      assert.equal((await accountStatus(id)).connected, true);
      await checkAccountConnection(id, h.factory);
      await discoverAccountGroups(id, h.factory);
      const group = (await pool.query("SELECT id FROM advertising_groups WHERE owner_id=$1", [id])).rows[0];
      await checkAccountGroups(id, [group.id], h.factory);
      await withAdvertisingLock(id, client => withAccountDriver(id, client,
        driver => driver.send("-100999999999", { text: "TEST_ONLY", imageUrl: null, buttonText: "Shop", buttonUrl: null }, "1"),
        h.factory, "post_ad"));
      assert.deepEqual(h.stats, { created: 1, connected: 1, disposed: 0, posts: 1, logouts: 0, fail: false, password: false });
      const contender = await pool.connect();
      const key = `advertising-qr:${id}`;
      try {
        assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [key])).rows[0].acquired, false);
        await disconnectAccount(id, h.factory);
        assert.equal(h.stats.disposed, 1);
        assert.equal(h.stats.logouts, 1);
        assert.equal((await accountStatus(id)).appConfigured, true);
        assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [key])).rows[0].acquired, true);
        await contender.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [key]);
      } finally { contender.release(); }
    });
    await t.test("QR two-step verification preserves the same connected client", async () => {
      const id = owner(), h = harness();
      h.stats.password = true;
      // Begin QR normally supplies a pending token; this fixture asks for 2FA
      // only after the first export, just as Telegram does after approval.
      let first = true;
      const factory: AccountFactory = input => {
        const driver = h.factory(input), qr = driver.qr;
        driver.qr = async () => { if (first) { first = false; return { authorized: false, url: "tg://login?token=TEST_ONLY" }; } return qr(); };
        return driver;
      };
      await beginAccountLogin(id, { ...api, method: "qr" }, factory);
      const loginId = (await accountStatus(id)).login!.id;
      await advanceAccountLogin(id, { loginId }, true, factory);
      assert.equal((await accountStatus(id)).login!.step, "password");
      await advanceAccountLogin(id, { loginId, password: "TEST_ONLY_PASSWORD" }, false, factory);
      await discoverAccountGroups(id, factory);
      assert.equal(h.stats.created, 1); assert.equal(h.stats.connected, 1); assert.equal(h.stats.disposed, 0);
      await disconnectAccount(id, factory);
    });
    await t.test("revocation stops all schedules, preserves its safe code and cannot reconnect on another click", async () => {
      const id = owner(), h = harness();
      await phoneLogin(id, h.factory);
      await discoverAccountGroups(id, h.factory);
      const group = (await pool.query("SELECT id FROM advertising_groups WHERE owner_id=$1", [id])).rows[0];
      await pool.query("INSERT INTO advertising_schedules(owner_id,group_id,running,next_send_at,draft) VALUES($1,$2,true,now(),$3::jsonb)", [id, group.id, JSON.stringify({ text: "TEST_ONLY" })]);
      h.stats.fail = true;
      await assert.rejects(discoverAccountGroups(id, h.factory), error => safeAccountError(error).telegramCode === "SESSION_REVOKED");
      const row = (await pool.query("SELECT last_error FROM advertising_accounts WHERE owner_id=$1", [id])).rows[0];
      assert.ok(isSessionStopped(row.last_error)); assert.match(row.last_error, /SESSION_REVOKED/);
      assert.doesNotMatch(row.last_error, /PRIVATE_PAYLOAD/);
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE owner_id=$1", [id])).rows[0].running, false);
      assert.equal(h.stats.disposed, 1);
      await assert.rejects(discoverAccountGroups(id, h.factory), /connection stopped/);
      await checkAccountConnection(id, h.factory);
      const checked = await accountStatus(id);
      assert.equal(checked.connected, false);
      assert.equal(checked.error, row.last_error, "repeated checks preserve the original error code without nesting stop messages");
      assert.equal(h.stats.created, 1, "checking again must not recreate the revoked session");
      await disconnectAccount(id, h.factory);
      assert.equal(h.stats.created, 1, "disconnect must not reconnect a known invalid authorization just to log it out");
    });
    await t.test("background revocation is observed after promotion and closes the active connection", async () => {
      const id = owner(), h = harness();
      await phoneLogin(id, h.factory);
      h.background("AUTH_KEY_DUPLICATED");
      await withAdvertisingLock(id, async () => {}); // queued persistence has completed
      assert.equal(h.stats.disposed, 1);
      const status = await accountStatus(id);
      assert.equal(status.connected, false);
      assert.match(status.error!, /AUTH_KEY_DUPLICATED/);
      await assert.rejects(discoverAccountGroups(id, h.factory), /connection stopped/);
      assert.equal(h.stats.created, 1);
    });
    await t.test("cancelling a pending phone login disposes it without leaving the exclusive lease", async () => {
      const id = owner(), h = harness();
      await beginAccountLogin(id, { ...api, method: "phone", phone: "+15555550123" }, h.factory);
      await cancelAccountLogin(id, h.factory);
      assert.equal((await accountStatus(id)).login, null);
      assert.equal(h.stats.disposed, 1); assert.equal(h.stats.created, 1);
    });
    await t.test("a pending login cannot silently reopen its key after losing the original client", async () => {
      const id = owner(), h = harness();
      await beginAccountLogin(id, { ...api, method: "phone", phone: "+15555550123" }, h.factory);
      const loginId = (await accountStatus(id)).login!.id;
      await closeAccountSession(id); // simulate a process losing its live client
      await assert.rejects(advanceAccountLogin(id, { loginId, code: "12345" }, false, h.factory), /original connection/);
      assert.equal(h.stats.created, 1);
      assert.equal((await accountStatus(id)).login, null);
    });
    await t.test("a failed disposal retains the lease and prevents creating a replacement", async () => {
      const id = owner(), key = accountConnectionKey(1);
      let fail = true, created = 0;
      const factory: AccountFactory = () => {
        created++;
        return { connect: async () => {}, disconnect: async () => { if (fail) throw new Error("TEST_ONLY failed close"); } } as ReturnType<AccountFactory>;
      };
      await connectedAccountSession(id, key, api, factory);
      await assert.rejects(closeAccountSession(id), /fully closed/);
      await assert.rejects(connectedAccountSession(id, accountConnectionKey(2), api, factory), /fully closed/);
      assert.equal(created, 1);
      fail = false;
      await closeAccountSession(id);
    });
    await t.test("lease loss disposes the connection, notifies the owner and cannot automatically reconnect", async () => {
      const id = owner(), key = accountConnectionKey(1), h = harness();
      const connect = pool.connect;
      let lease: Awaited<ReturnType<typeof pool.connect>> | undefined;
      let notified = "";
      pool.connect = (async () => {
        const client = await connect.call(pool);
        lease = client;
        return client;
      }) as typeof pool.connect;
      try {
        await connectedAccountSession(id, key, api, h.factory, { onFailure: error => { notified = error.telegramCode; } });
      } finally { pool.connect = connect; }
      assert.ok(lease);
      lease.emit("error", new Error("TEST_ONLY_PRIVATE_DATABASE_ERROR"));
      await closeAccountSession(id);
      assert.equal(notified, "CONNECTION_LEASE_LOST");
      assert.equal(h.stats.disposed, 1);
      await assert.rejects(connectedAccountSession(id, key, api, h.factory), /exclusive server lease/);
      assert.equal(h.stats.created, 1);
    });
    await t.test("shutdown disposes idle authorized connections and refuses new connections", async () => {
      const id = owner(), h = harness();
      await phoneLogin(id, h.factory);
      await shutdownAccountSessions();
      assert.equal(h.stats.disposed, 1);
      await assert.rejects(connectedAccountSession(id, accountConnectionKey(1), api, h.factory), /shutting down/);
      assert.equal(h.stats.created, 1);
    });
  } finally {
    await shutdownAccountSessions();
    for (const table of ["advertising_account_runs", "advertising_account_commands", "advertising_schedules", "advertising_accounts",
      "advertising_deliveries", "advertising_campaigns", "advertising_groups", "advertising_bots"])
      await pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [owners]);
    await pool.end();
  }
});
