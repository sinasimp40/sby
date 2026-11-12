import test from "node:test";
import assert from "node:assert/strict";
import { Api, TelegramClient } from "telegram";
import { createAccountDriver, safeAccountError } from "../src/lib/advertising-account-driver";
import { connectedQrDriver, closeQrDriver } from "../src/lib/advertising-account-qr";
import { pool } from "@workspace/db";
import { randomUUID } from "node:crypto";
import type { AccountFactory } from "../src/lib/advertising-account-driver";

test("QR keeps a stable token until expiry or acceptance and scopes migration retries to login", async () => {
  const invoke = TelegramClient.prototype.invoke;
  const on = TelegramClient.prototype.addEventHandler;
  const switchDC = TelegramClient.prototype._switchDC;
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  let update: (value: unknown) => void = () => {};
  let calls = 0, migrations = 0;
  let client: TelegramClient | undefined;
  let mode: "token" | "migrate" | "password" = "token";
  TelegramClient.prototype.addEventHandler = function (handler: any) {
    update = handler;
    return on.call(this, handler);
  };
  TelegramClient.prototype._switchDC = async function (dc) { assert.equal(dc, 4); migrations++; };
  TelegramClient.prototype.invoke = async function (request: any): Promise<any> {
    client = this;
    assert.equal(this._requestRetries, 3, "extra attempts are available only inside QR authentication");
    if (request instanceof Api.auth.ImportLoginToken) {
      assert.equal(migrations, 1);
      return new Api.auth.LoginTokenSuccess({ authorization: {} as any });
    }
    assert.ok(request instanceof Api.auth.ExportLoginToken);
    calls++;
    if (mode === "password") throw { errorMessage: "SESSION_PASSWORD_NEEDED" };
    if (mode === "migrate") return new Api.auth.LoginTokenMigrateTo({ dcId: 4, token: Buffer.from("TEST_ONLY_MIGRATE") });
    return new Api.auth.LoginToken({ expires: Math.floor(clock / 1000) + 30, token: Buffer.from(`TEST_ONLY_QR_${calls}`) });
  };
  try {
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    const first = await driver.qr();
    assert.equal(calls, 1);
    assert.deepEqual(await driver.qr(), first);
    assert.equal(calls, 1, "five-second UI checks must not replace an unexpired QR");
    clock += 31000;
    const refreshed = await driver.qr();
    assert.notEqual(refreshed.url, first.url);
    assert.equal(calls, 2);
    assert.equal(client!._requestRetries, 1);
    update(new Api.UpdateLoginToken());
    mode = "migrate";
    assert.equal((await driver.qr()).authorized, true);
    assert.equal(calls, 3, "accepted QR is completed immediately rather than waiting for expiry");
    assert.equal(migrations, 1);
    assert.equal(client!._requestRetries, 1, "posting still has no automatic retry");
    mode = "password";
    await assert.rejects(driver.qr(), error => safeAccountError(error).kind === "password");
    assert.equal(client!._requestRetries, 1, "two-step failures also restore the sending policy");
  } finally {
    TelegramClient.prototype.invoke = invoke;
    TelegramClient.prototype.addEventHandler = on;
    TelegramClient.prototype._switchDC = switchDC;
    Date.now = now;
  }
});

test("security revocations are surfaced instead of swallowed as a pending QR", async () => {
  const getMe = TelegramClient.prototype.getMe;
  try {
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    TelegramClient.prototype.getMe = async () => { throw { errorMessage: "SESSION_REVOKED" }; };
    await assert.rejects(driver.me(), error => safeAccountError(error).kind === "auth");
    TelegramClient.prototype.getMe = async () => { throw { errorMessage: "AUTH_KEY_UNREGISTERED" }; };
    const pending = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    assert.equal(await pending.me(true), null, "an explicitly pending unauthorised key is normal during QR login");
    for (const code of ["AUTH_KEY_DUPLICATED", "SESSION_REVOKED", "USER_DEACTIVATED_BAN", "PEER_FLOOD"]) {
      const error = safeAccountError({ errorMessage: code });
      assert.ok(["auth", "restricted"].includes(error.kind));
      assert.match(error.message, /Devices|restriction/);
      assert.doesNotMatch(error.message, /sign in again/i);
    }
  } finally { TelegramClient.prototype.getMe = getMe; }
});

test("one connected QR client is reused and leased until cancellation; failed setup releases the lease", async () => {
  const owner = `qr-test-${randomUUID()}`;
  const pending = { id: randomUUID(), apiId: 12345, apiHash: "a".repeat(32), session: "", expires: Date.now() + 60000 };
  let creates = 0, connects = 0, disconnects = 0;
  const factory: AccountFactory = () => {
    creates++;
    return {
      connect: async () => { connects++; },
      disconnect: async () => { disconnects++; },
    } as ReturnType<AccountFactory>;
  };
  const contender = await pool.connect();
  const key = `advertising-qr:${owner}`;
  try {
    const first = await connectedQrDriver(owner, pending, factory);
    assert.equal(await connectedQrDriver(owner, pending, factory), first);
    assert.equal(creates, 1); assert.equal(connects, 1);
    assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [key])).rows[0].acquired, false);
    await closeQrDriver(owner, "different-challenge");
    assert.equal(disconnects, 0);
    await closeQrDriver(owner, pending.id);
    assert.equal(disconnects, 1);
    assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [key])).rows[0].acquired, true);
    await contender.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [key]);
    await assert.rejects(connectedQrDriver(owner, pending, () => ({
      connect: async () => { throw new Error("TEST_ONLY failed setup"); },
      disconnect: async () => {},
    }) as ReturnType<AccountFactory>));
    assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtextextended($1,76)) AS acquired", [key])).rows[0].acquired, true);
    await contender.query("SELECT pg_advisory_unlock(hashtextextended($1,76))", [key]);
  } finally {
    await closeQrDriver(owner);
    contender.release();
    await pool.end();
  }
});
