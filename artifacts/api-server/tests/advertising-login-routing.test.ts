import test from "node:test";
import assert from "node:assert/strict";
import { Api, TelegramClient } from "telegram";
import { PhoneMigrateError } from "telegram/errors/index.js";
import { invoke } from "telegram/client/users.js";
import { createAccountDriver } from "../src/lib/advertising-account-driver";

test("phone login follows Telegram DC migration and restores the no-retry sending policy", async () => {
  const original = TelegramClient.prototype.sendCode;
  let captured: TelegramClient | undefined;
  let requests = 0;
  let switches = 0;
  TelegramClient.prototype.sendCode = async function () {
    captured = this;
    const sender = {
      userDisconnected: false,
      addStateToQueue(state: any) {
        requests++;
        if (requests === 1) state.reject(new PhoneMigrateError({ capture: 4 }));
        else state.resolve({ phoneCodeHash: "TEST_ONLY_HASH" });
      },
    };
    const fakeClient = {
      _sender: sender,
      _connectedDeferred: { promise: Promise.resolve() },
      _requestRetries: this._requestRetries,
      session: { processEntities() {} },
      _entityCache: { add() {} },
      _log: { info() {}, warn() {} },
      isUserAuthorized: async () => false,
      _switchDC: async (dc: number) => { assert.equal(dc, 4); switches++; },
    };
    const request = new Api.auth.SendCode({
      phoneNumber: "+15555550123", apiId: 12345, apiHash: "a".repeat(32), settings: new Api.CodeSettings({}),
    });
    request.resolve = async () => {};
    return await invoke(fakeClient as any, request) as any;
  };
  try {
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    assert.equal(await driver.sendCode("+15555550123"), "TEST_ONLY_HASH");
    assert.equal(switches, 1);
    assert.equal(requests, 2);
    assert.equal(captured!._requestRetries, 1);
    TelegramClient.prototype.sendCode = async function () { captured = this; throw new Error("TEST_ONLY network failure"); };
    await assert.rejects(driver.sendCode("+15555550123"), /Telegram did not confirm/);
    assert.equal(captured!._requestRetries, 1);
  } finally {
    TelegramClient.prototype.sendCode = original;
  }
});
