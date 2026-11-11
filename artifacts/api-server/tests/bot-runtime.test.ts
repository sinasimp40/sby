import test from "node:test";
import assert from "node:assert/strict";
import { applyBotRuntime } from "../src/lib/bot-runtime-control";
import { botRuntimeHealth, httpsOrigin, setPollingHealth, type BotRuntimeConfig } from "../src/lib/bot-runtime";
import { adminCookieName, adminCookieOptions, localAdminHttp } from "../src/lib/admin-auth";

function fixture() {
  let state: BotRuntimeConfig = { enabled: false, transport: "polling", publicUrl: "" };
  const events: string[] = [];
  const effects = {
    get: async () => ({ ...state }),
    save: async (value: BotRuntimeConfig) => { state = { ...value }; events.push(`saved:${value.enabled}`); },
    connect: async (_config: BotRuntimeConfig) => { events.push("configured-provider"); },
    deactivate: async () => { events.push("deactivated"); },
  };
  return { effects, events, state: () => state };
}
test("polling can be enabled without a public URL only after live-processing consent", async () => {
  const f = fixture();
  await assert.rejects(applyBotRuntime({ ...f.state(), enabled: true }, false, f.effects), /Confirm live/);
  assert.deepEqual(f.events, []);
  await applyBotRuntime({ ...f.state(), enabled: true }, true, f.effects);
  assert.deepEqual(f.events, ["saved:false", "configured-provider", "saved:true"]);
  assert.equal(f.state().enabled, true);
  await applyBotRuntime({ ...f.state(), enabled: false }, false, f.effects);
  assert.equal(f.state().enabled, false);
  assert.deepEqual(f.events.slice(-2), ["saved:false", "deactivated"]);
});
test("a failed activation remains paused and never reports running", async () => {
  const f = fixture();
  f.effects.connect = async () => { throw new Error("TEST_ONLY_PROVIDER_FAILURE"); };
  await assert.rejects(applyBotRuntime({ ...f.state(), enabled: true }, true, f.effects), /TEST_ONLY_PROVIDER/);
  assert.equal(f.state().enabled, false);
  assert.deepEqual(f.events, ["saved:false", "deactivated"]);
  assert.equal(botRuntimeHealth(f.state(), true).state, "disabled");
});
test("webhooks require HTTPS and mode changes require a pause", async () => {
  const f = fixture();
  await assert.rejects(applyBotRuntime({ ...f.state(), transport: "webhook", enabled: true }, true, f.effects), /requires a public/);
  await assert.rejects(applyBotRuntime({ ...f.state(), enabled: true, publicUrl: "http://localhost:5173" }, true, f.effects), /public HTTPS/);
  await applyBotRuntime({ ...f.state(), enabled: true }, true, f.effects);
  await assert.rejects(applyBotRuntime({ ...f.state(), enabled: true, transport: "webhook", publicUrl: "https://shop.example.com" }, true, f.effects), /Disable Telegram before/);
  assert.equal(httpsOrigin("https://shop.example.com/path"), "");
  assert.equal(httpsOrigin("https://user:pass@shop.example.com"), "");
  assert.equal(httpsOrigin("https://shop.example.com/"), "https://shop.example.com");
});
test("worker status distinguishes saved enablement from a working receiver", () => {
  const config: BotRuntimeConfig = { enabled: true, transport: "polling", publicUrl: "" };
  setPollingHealth("starting");
  assert.equal(botRuntimeHealth(config, true).state, "starting");
  setPollingHealth("running");
  assert.equal(botRuntimeHealth(config, true).state, "running");
  assert.equal(botRuntimeHealth(config, false).state, "disabled");
  setPollingHealth("error", "TEST_ONLY_ERROR");
  assert.equal(botRuntimeHealth(config, true).state, "error");
  assert.equal(botRuntimeHealth({ ...config, transport: "webhook" }, true).state, "webhook");
});
test("HTTP cookies are permitted only for an explicitly trusted local development origin", () => {
  const saved = { origin: process.env.TELECART_ADMIN_ORIGIN, mode: process.env.NODE_ENV };
  try {
    process.env.NODE_ENV = "development";
    process.env.TELECART_ADMIN_ORIGIN = "http://localhost:5173";
    assert.equal(localAdminHttp(), true);
    assert.equal(adminCookieName(), "telecart_admin_local");
    assert.equal(adminCookieOptions().secure, false);
    assert.equal(adminCookieOptions().sameSite, "lax");
    process.env.TELECART_ADMIN_ORIGIN = "http://untrusted.example";
    assert.equal(localAdminHttp(), false);
    assert.equal(adminCookieOptions().secure, true);
    process.env.TELECART_ADMIN_ORIGIN = "http://localhost:5173";
    process.env.NODE_ENV = "production";
    assert.equal(localAdminHttp(), false);
  } finally {
    if (saved.origin === undefined) delete process.env.TELECART_ADMIN_ORIGIN; else process.env.TELECART_ADMIN_ORIGIN = saved.origin;
    if (saved.mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.mode;
  }
});
