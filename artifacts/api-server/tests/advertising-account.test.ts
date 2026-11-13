import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../src/app";
import { adminCookieName, issueAdminSession } from "../src/lib/admin-auth";
import { beginAccountLogin, advanceAccountLogin, accountStatus, cancelAccountLogin, disconnectAccount, checkAccountConnection, saveAccountApp } from "../src/lib/advertising-account-auth";
import { AccountError, accountMessage, type AccountFactory } from "../src/lib/advertising-account-driver";
import { checkAccountGroups, discoverAccountGroups } from "../src/lib/advertising-account-groups";
import { processAccountSchedules, stopSelectedAccountSchedules } from "../src/lib/advertising-account-schedules";
import { exportShopTransfer, previewShopTransfer, importShopTransfer } from "../src/lib/shop-transfer";
import { decodeShopArchive } from "../src/lib/shop-transfer-archive";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";
import { withAdvertisingLock } from "../src/lib/advertising-store";
import { recoverAccountConnection, recoveryState } from "../src/lib/advertising-account-recovery";

test("account message includes a plain shop link, never a bot button, and validates its complete length", () => {
  const draft = { text: "Hello", imageUrl: null, buttonText: "Visit shop", buttonUrl: "https://t.me/TEST_ONLY_shop_bot" };
  assert.equal(accountMessage(draft).text, `Hello\n\nVisit shop: ${draft.buttonUrl}`);
  assert.throws(() => accountMessage({ ...draft, text: "x".repeat(1020), imageUrl: "https://example.com/ad.gif" }), /complete message/);
});

test("account sign-in, selected-group schedules and transfers are safe without real Telegram requests", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `account-test-${randomUUID()}`, destination = `${owner}-destination`, foreign = `${owner}-foreign`;
  const originalFetch = globalThis.fetch;
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { TELECART_ADMIN_EMAIL: "test-admin@example.invalid", TELECART_ADMIN_INITIAL_PASSWORD: `TEST_ONLY-${randomUUID()}`,
    TELECART_OWNER_ID: owner, TELECART_PUBLIC_URL: "https://test-only.invalid", TELECART_ADMIN_ORIGIN: "https://test-only.invalid" });
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).hostname !== "127.0.0.1") throw new Error("No external calls permitted in account tests.");
    return originalFetch(input, init);
  };
  const identity = { id: "900000009", username: "TEST_ONLY_account", displayName: "TEST_ONLY account" };
  const api = { apiId: 12345, apiHash: "a".repeat(32) };
  let needPassword = true, qrApproved = false, sendMode = "ok", revoked = false, logouts = 0;
  const posts: { chatId: string; text: string; randomId: string; entities?: unknown }[] = [];
  const joined = [
    { chatId: "-100111111111", target: "-100111111111", title: "TEST_ONLY first group" },
    { chatId: "-100222222222", target: "-100222222222", title: "TEST_ONLY second group" },
    { chatId: "-100333333333", target: "-100333333333", title: "TEST_ONLY unselected group" },
  ];
  const factory: AccountFactory = input => {
    assert.equal(input.apiId, api.apiId);
    assert.equal(input.apiHash, api.apiHash);
    let state = input.session ? JSON.parse(input.session) as { authorized: boolean } : { authorized: false };
    return {
      connect: async () => {},
      disconnect: async () => {},
      session: () => JSON.stringify(state),
      me: async () => { if (revoked) throw new AccountError("TEST_ONLY session revoked", "auth"); return state.authorized ? identity : null; },
      sendCode: async phone => { assert.equal(phone, "+15555550123"); return "TEST_ONLY_PHONE_HASH"; },
      code: async (_phone, _hash, code) => {
        if (code !== "12345") throw new AccountError("Code not accepted.");
        if (needPassword) throw new AccountError("Two-step password required.", "password");
        state.authorized = true;
      },
      password: async password => { if (password !== "TEST_ONLY_PASSWORD") throw new AccountError("Password not accepted."); state.authorized = true; },
      qr: async () => {
        if (!qrApproved) return { authorized: false, url: "tg://login?token=TEST_ONLY_QR_TOKEN", expires: Math.floor(Date.now() / 1000) + 60 };
        if (needPassword) throw new AccountError("Two-step password required.", "password");
        state.authorized = true; return { authorized: true };
      },
      groups: async () => joined,
      inspect: async target => { const group = joined.find(group => group.chatId === target); if (!group) throw new AccountError("Not a member of this group."); return group; },
      send: async (chatId, draft, randomId) => {
        posts.push({ chatId, text: accountMessage(draft).text, randomId, entities: accountMessage(draft).entities });
        if (sendMode === "flood") throw new AccountError("Wait for Telegram.", "rate_limit", 120);
        if (sendMode === "unknown") throw new AccountError("Unconfirmed send.", "network");
        if (sendMode === "transport") throw new AccountError("TEST_ONLY lost transport", "network", 0, "CONNECTION_LOST");
        if (sendMode === "missing_receipt") return undefined as any;
        return { chatId, messageId: posts.length };
      },
      logout: async () => { logouts++; state.authorized = false; },
    };
  };
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/advertising`;
  const request = async (path = "", method = "GET", data?: unknown, auth = cookie, origin = "https://test-only.invalid") => {
    const response = await fetch(`${base}${path}`, { method, headers: { cookie: auth, origin, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    await t.test("app setup is saved once, encrypted, owner-scoped and never starts advertising", async () => {
      await assert.rejects(beginAccountLogin(owner, { method: "qr" }, factory), /one-time/);
      assert.equal((await request("/account/app", "PUT", api, "")).status, 401);
      assert.equal((await request("/account/app", "PUT", { ...api, apiHash: "invalid" })).status, 400);
      const result = await request("/account/app", "PUT", api);
      assert.equal(result.status, 200);
      assert.equal(result.data.account.appConfigured, true);
      assert.equal(result.data.account.connected, false);
      assert.ok(!JSON.stringify(result.data).includes(api.apiHash));
      const row = (await pool.query("SELECT api_hash_encrypted FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      assert.ok(row.api_hash_encrypted && !row.api_hash_encrypted.includes(api.apiHash));
      assert.equal((await accountStatus(foreign)).appConfigured, false);
      assert.equal(posts.length, 0);
    });
    await t.test("phone code and two-step password are verified without exposing credentials", async () => {
      assert.equal((await request("", "GET", undefined, "")).status, 401);
      await assert.rejects(beginAccountLogin(owner, { ...api, method: "phone", phone: "invalid" }, factory), /international/);
      await beginAccountLogin(owner, { method: "phone", phone: "+15555550123" }, factory);
      const pending = await accountStatus(owner);
      assert.equal(pending.login!.step, "code"); assert.equal(pending.connected, false);
      assert.ok(!JSON.stringify(pending).includes(api.apiHash));
      await assert.rejects(advanceAccountLogin(owner, { loginId: pending.login!.id, code: "00000" }, false, factory), /Code/);
      await advanceAccountLogin(owner, { loginId: pending.login!.id, code: "12345" }, false, factory);
      assert.equal((await accountStatus(owner)).login!.step, "password");
      await assert.rejects(advanceAccountLogin(owner, { loginId: pending.login!.id, password: "wrong" }, false, factory), /Password/);
      await advanceAccountLogin(owner, { loginId: pending.login!.id, password: "TEST_ONLY_PASSWORD" }, false, factory);
      const status = await accountStatus(owner);
      assert.equal(status.connected, true); assert.equal(status.username, identity.username); assert.equal(status.login, null);
      await assert.rejects(saveAccountApp(owner, { apiId: 999, apiHash: "b".repeat(32) }), /Disconnect/);
      const raw = (await pool.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      assert.ok(!JSON.stringify(raw).includes(api.apiHash)); assert.ok(!JSON.stringify(raw).includes("TEST_ONLY_PASSWORD"));
      assert.equal((await request("/connection", "POST", { token: "12345:TEST_ONLY_TOKEN_NOT_USED" })).status, 410);
    });
    await t.test("QR cancellation, expiry and QR two-step login preserve secure states", async () => {
      await beginAccountLogin(owner, { method: "qr" }, factory);
      let status = await accountStatus(owner);
      assert.match(status.login!.qrImage!, /^data:image\/png;base64,/);
      await assert.rejects(advanceAccountLogin(owner, { loginId: randomUUID() }, true, factory), /no longer active/);
      await cancelAccountLogin(owner, factory); assert.equal((await accountStatus(owner)).login, null);
      assert.equal((await accountStatus(owner)).appConfigured, true);
      await beginAccountLogin(owner, { ...api, method: "qr" }, factory);
      status = await accountStatus(owner);
      await pool.query("UPDATE advertising_accounts SET login_expires_at=now()-interval '1 second' WHERE owner_id=$1", [owner]);
      assert.equal((await accountStatus(owner)).login!.step, "expired");
      await assert.rejects(advanceAccountLogin(owner, { loginId: status.login!.id }, true, factory), /expired/);
      await beginAccountLogin(owner, { ...api, method: "qr" }, factory);
      status = await accountStatus(owner); qrApproved = true;
      await advanceAccountLogin(owner, { loginId: status.login!.id }, true, factory);
      assert.equal((await accountStatus(owner)).login!.step, "password");
      await advanceAccountLogin(owner, { loginId: status.login!.id, password: "TEST_ONLY_PASSWORD" }, false, factory);
      assert.equal((await accountStatus(owner)).connected, true);
      needPassword = false;
      await beginAccountLogin(owner, { ...api, method: "qr" }, factory);
      status = await accountStatus(owner);
      await advanceAccountLogin(owner, { loginId: status.login!.id }, true, factory);
      assert.equal((await accountStatus(owner)).connected, true);
    });
    let groups: { id: string; chatId: string }[] = [];
    const draft = { text: "TEST_ONLY confirmed recurring message ⭐", imageUrl: null, buttonText: "Visit shop", buttonUrl: "https://t.me/TEST_ONLY_shop_bot",
      entities: [{ type: "bold" as const, offset: 0, length: 9 }, { type: "custom_emoji" as const, offset: 38, length: 1, documentId: "123456789" }] };
    await t.test("formatted drafts persist across reloads and bad entities/pack lookups fail safely", async () => {
      assert.equal((await request("/account/emoji-set", "POST", { link: "TEST_ONLY" }, "")).status, 401);
      assert.equal((await request("/account/emoji-set", "POST", { link: "https://example.invalid/addemoji/TEST_ONLY" })).status, 400);
      assert.equal((await request("/draft", "PUT", draft)).status, 200);
      assert.deepEqual((await request()).data.draft.entities, draft.entities);
      assert.equal((await request("/draft", "PUT", { ...draft, entities: [{ type: "bold", offset: 9999, length: 1 }] })).status, 400);
      assert.deepEqual((await request()).data.draft.entities, draft.entities, "invalid changes cannot erase saved formatting");
    });
    const start = async (ids: string[], key = randomUUID(), message = draft) => {
      const current = (await request()).data;
      return request("/schedules/start", "POST", {
        accountId: current.account.accountId ?? "0", groupIds: ids,
        expectedGroups: ids.map(id => {
          const group = current.groups.find((g: { id: string }) => g.id === id);
          return { id, chatId: group?.chatId ?? "-100999999999", intervalSeconds: group?.intervalSeconds ?? 1800 };
        }), idempotencyKey: key, draft: message, permissionConfirmed: true,
      });
    };
    const resetGlobalWait = () => pool.query("UPDATE advertising_accounts SET next_send_at=now(),telegram_wait_until=now() WHERE owner_id=$1", [owner]);
    const explicitlyAuthorizeAgain = async () => {
      // Independent cases restore synthetic group fixtures explicitly. Real
      // sign-in must never restore removed destinations by itself.
      await pool.query("UPDATE advertising_groups SET status='pending',enabled=true WHERE owner_id=$1 AND status='removed'", [owner]);
      await beginAccountLogin(owner, { method: "phone", phone: "+15555550123" }, factory);
      const login = (await accountStatus(owner)).login!;
      await advanceAccountLogin(owner, { loginId: login.id, code: "12345" }, false, factory);
      const ids = (await request()).data.groups.map((group: { id: string }) => group.id);
      if (ids.length) await checkAccountGroups(owner, ids, factory);
    };
    await t.test("group discovery, different intervals and selected-only start/stop preserve scope", async () => {
      await discoverAccountGroups(owner, factory);
      const ws = (await request()).data;
      groups = ws.groups.map((group: { id: string; target: string }) => ({ id: group.id, chatId: group.target }));
      await checkAccountGroups(owner, groups.map(group => group.id), factory);
      assert.equal((await request(`/groups/${groups[0]!.id}`, "PATCH", { intervalSeconds: 59 })).status, 400);
      assert.equal((await request(`/groups/${groups[0]!.id}`, "PATCH", { intervalSeconds: 60 })).status, 200);
      assert.equal((await request(`/groups/${groups[1]!.id}`, "PATCH", { intervalSeconds: 1800 })).status, 200);
      const key = randomUUID(), selected = groups.slice(0, 2).map(group => group.id);
      assert.equal((await start(selected, key)).status, 200); assert.equal(posts.length, 0, "connecting/enqueueing never sends inline");
      const revisions = (await pool.query("SELECT group_id,revision FROM advertising_schedules WHERE owner_id=$1 ORDER BY group_id", [owner])).rows;
      assert.equal((await start(selected, key)).status, 200);
      assert.deepEqual((await pool.query("SELECT group_id,revision FROM advertising_schedules WHERE owner_id=$1 ORDER BY group_id", [owner])).rows, revisions);
      assert.equal((await start(selected, key, { ...draft, text: "different" })).status, 400);
      await processAccountSchedules(owner, factory); await resetGlobalWait(); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, 2);
      assert.deepEqual(new Set(posts.map(post => post.chatId)), new Set(groups.slice(0, 2).map(group => group.chatId)));
      assert.ok(posts.every(post => post.text === accountMessage(draft).text));
      let current = (await request()).data;
      assert.ok(current.accountRuns.every((run: { status: string; note: string }) =>
        run.status === "sent" && run.note.startsWith("Verified in selected group: message #")));
      const afterVerifiedSend = (await pool.query("SELECT running,next_send_at FROM advertising_schedules WHERE owner_id=$1", [owner])).rows;
      assert.ok(afterVerifiedSend.every(row => row.running && new Date(row.next_send_at).getTime() > Date.now()),
        "a verified send leaves schedules running for the next interval");
      assert.equal(current.groups.find((group: { id: string }) => group.id === groups[2]!.id).running, false);
      assert.equal(current.groups.find((group: { id: string }) => group.id === groups[0]!.id).intervalSeconds, 60);
      assert.equal((await request("/schedules/stop", "POST", { groupIds: [groups[0]!.id] })).status, 200);
      current = (await request()).data;
      assert.equal(current.groups.find((group: { id: string }) => group.id === groups[0]!.id).running, false);
      assert.equal(current.groups.find((group: { id: string }) => group.id === groups[1]!.id).running, true);
      await request(`/groups/${groups[1]!.id}`, "PATCH", { intervalSeconds: 120 });
      assert.equal((await request()).data.groups.find((group: { id: string }) => group.id === groups[1]!.id).running, false);
      await processAccountSchedules(owner, factory); assert.equal(posts.length, 2);
    });
    await t.test("message snapshots, account waits and uncertain sends never create catch-up spam", async () => {
      const group = groups[0]!;
      await start([group.id]);
      assert.equal((await request("/draft", "PUT", { ...draft, text: "TEST_ONLY edited after start", entities: [draft.entities[0]] })).status, 200);
      await resetGlobalWait(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1)!.text, accountMessage(draft).text);
      assert.deepEqual(posts.at(-1)!.entities, draft.entities, "running schedules keep the original formatted snapshot");
      const count = posts.length;
      await processAccountSchedules(owner, factory); assert.equal(posts.length, count, "interval prevents an immediate repeat");
      await pool.query("UPDATE advertising_schedules SET next_send_at=now()-interval '1 day' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      await resetGlobalWait(); await processAccountSchedules(owner, factory); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, count + 1, "send once after downtime, not one per missed interval");
      await start([group.id]); sendMode = "flood"; await resetGlobalWait(); await processAccountSchedules(owner, factory);
      const afterFlood = posts.length; await processAccountSchedules(owner, factory); assert.equal(posts.length, afterFlood);
      assert.equal((await request()).data.accountRuns[0].status, "rate_limited");
      sendMode = "unknown"; await start([group.id]); await resetGlobalWait(); await processAccountSchedules(owner, factory);
      const afterUnknown = posts.length;
      await resetGlobalWait(); await processAccountSchedules(owner, factory);
      const current = (await request()).data;
      assert.equal(current.groups.some((item: { id: string }) => item.id === group.id), false);
      assert.equal(current.accountRuns[0].status, "uncertain"); assert.equal(posts.length, afterUnknown);
      assert.equal(current.account.connected, false, "uncertain network outcomes stop the account instead of reconnecting");
      assert.equal((await start([group.id])).status, 400);
      sendMode = "ok";
      await explicitlyAuthorizeAgain();
    });
    await t.test("transport recovery never replays an uncertain post or re-enables its stopped group", async () => {
      sendMode = "transport";
      await start(groups.slice(0, 2).map(group => group.id)); await resetGlobalWait();
      await processAccountSchedules(owner, factory);
      const state = recoveryState((await accountStatus(owner)).error)!;
      assert.ok(state);
      const failed = (await pool.query("SELECT group_id,status FROM advertising_account_runs WHERE owner_id=$1 ORDER BY started_at DESC LIMIT 1", [owner])).rows[0];
      assert.equal(failed.status, "uncertain");
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [failed.group_id])).rows[0].running, false);
      const before = posts.length;
      sendMode = "ok";
      await withAdvertisingLock(owner, client => recoverAccountConnection(owner, client, factory, state.next));
      assert.equal((await accountStatus(owner)).connected, true);
      await resetGlobalWait(); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before, "no replay or catch-up burst after recovery");
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [failed.group_id])).rows[0].running, false);
      await stopSelectedAccountSchedules(owner);
    });
    await t.test("a completed send without a receipt removes the group without logging out a healthy account", async () => {
      sendMode = "missing_receipt";
      await start([groups[0]!.id]); await resetGlobalWait();
      await processAccountSchedules(owner, factory);
      const current = (await request()).data;
      assert.equal(current.accountRuns[0].status, "uncertain");
      assert.equal(current.account.connected, true);
      assert.equal(current.account.error, null);
      const before = posts.length;
      await resetGlobalWait(); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before);
      sendMode = "ok";
      await explicitlyAuthorizeAgain();
    });
    await t.test("crash recovery, disabled/deleted groups and foreign IDs fail closed", async () => {
      const group = groups[1]!;
      await start([group.id]);
      const schedule = (await pool.query("SELECT * FROM advertising_schedules WHERE owner_id=$1 AND group_id=$2", [owner, group.id])).rows[0];
      // Make this interrupted attempt the latest outcome for this synthetic
      // group; a later verified success must protect historical destinations.
      await pool.query("UPDATE advertising_account_runs SET started_at=now()-interval '3 minutes' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,started_at)
        VALUES($1,$2,'TEST_ONLY crash',$3,$4,$5,$6,$7::jsonb,'123456',now()-interval '2 minutes')`,
        [owner, group.id, group.chatId, schedule.account_generation, schedule.revision, schedule.next_send_at, JSON.stringify(draft)]);
      const before = posts.length; await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before); assert.equal((await request()).data.groups.some((item: { id: string }) => item.id === group.id), false);
      const otherId = randomUUID();
      await pool.query("INSERT INTO advertising_groups(id,owner_id,target,kind) VALUES($1,$2,'-100999999999','chat_id')", [otherId, foreign]);
      assert.equal((await start([otherId])).status, 400);
      await pool.query("UPDATE advertising_groups SET status='ready',enabled=true WHERE owner_id=$1 AND id=$2", [owner, group.id]);
      await start([group.id]); await request(`/groups/${group.id}`, "PATCH", { enabled: false });
      await resetGlobalWait(); await processAccountSchedules(owner, factory); assert.equal(posts.length, before);
      await request(`/groups/${group.id}`, "PATCH", { enabled: true });
      await start([groups[2]!.id]); await request(`/groups/${groups[2]!.id}`, "DELETE");
      await processAccountSchedules(owner, factory); assert.equal(posts.length, before);
    });
    await t.test("portable exports keep groups/schedules/history but exclude account credentials and restart nothing", async () => {
      await start([groups[0]!.id]);
      const exported = await exportShopTransfer(owner);
      const decoded = decodeShopArchive(exported.zip);
      assert.ok(decoded.data.advertisingAccountSchedules.length > 0 && decoded.data.advertisingAccountRuns.length > 0);
      const rawDraft = decoded.data.advertisingAccountSchedules[0]!.draft;
      assert.deepEqual((typeof rawDraft === "string" ? JSON.parse(rawDraft) : rawDraft).entities, draft.entities);
      assert.ok(!("advertisingAccounts" in decoded.data));
      assert.ok(!JSON.stringify(decoded.data).includes(api.apiHash));
      validateShopRelationships(decoded.data, owner);
      const preview = await previewShopTransfer(destination, exported.zip);
      assert.equal(preview.canImport, true);
      await importShopTransfer(destination, exported.zip, preview.confirmationToken);
      const restored = (await pool.query("SELECT draft FROM advertising_schedules WHERE owner_id=$1", [destination])).rows;
      assert.deepEqual(restored.find(row => row.draft?.text === draft.text)?.draft.entities, draft.entities,
        "portable ZIP restores formatting independently of PostgreSQL JSON object-key order");
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM advertising_schedules WHERE owner_id=$1 AND running=true", [destination])).rows[0].n, 0);
      assert.equal((await accountStatus(destination)).configured, false);
    });
    await t.test("revoked sessions, stop all and disconnect stop every future post", async () => {
      await start(groups.slice(0, 2).map(group => group.id));
      revoked = true; await checkAccountConnection(owner, factory);
      assert.equal((await accountStatus(owner)).connected, false);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM advertising_schedules WHERE owner_id=$1 AND running=true", [owner])).rows[0].n, 0);
      revoked = false; await checkAccountConnection(owner, factory);
      assert.equal((await accountStatus(owner)).connected, false, "a check cannot reopen a previously revoked session");
      await explicitlyAuthorizeAgain();
      await start([groups[0]!.id]); await request("/schedules/stop-all", "POST");
      const before = posts.length; await resetGlobalWait(); await processAccountSchedules(owner, factory); assert.equal(posts.length, before);
      await start([groups[0]!.id]); const beforeLogout = logouts; await disconnectAccount(owner, factory);
      assert.equal(logouts, beforeLogout + 1); assert.equal((await accountStatus(owner)).configured, false);
      assert.equal((await accountStatus(owner)).appConfigured, true, "normal disconnect preserves one-time app setup");
      await processAccountSchedules(owner, factory); assert.equal(posts.length, before);
      assert.equal((await start([groups[0]!.id])).status, 400);
      await beginAccountLogin(owner, { method: "phone", phone: "+15555550123" }, factory);
      const reconnect = await accountStatus(owner);
      await advanceAccountLogin(owner, { loginId: reconnect.login!.id, code: "12345" }, false, factory);
      assert.equal((await accountStatus(owner)).connected, true, "reconnect uses only phone/code and saved app credentials");
      await disconnectAccount(owner, factory, true);
      assert.equal((await accountStatus(owner)).appConfigured, false);
      assert.equal((await request("/account/app", "DELETE", undefined, "")).status, 401);
      assert.equal((await request("/account/app", "DELETE")).status, 200);
      await assert.rejects(beginAccountLogin(owner, { method: "qr" }, factory), /one-time/);
      assert.equal(posts.length, before, "reconnect and forgetting setup never start ads");
    });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const table of ["advertising_account_runs", "advertising_account_commands", "advertising_schedules", "advertising_accounts",
      "advertising_deliveries", "advertising_campaigns", "advertising_groups", "advertising_bots", "shop_activity", "shop_settings", "bot_runtime_settings", "provider_credentials"])
      await pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [[owner, destination, foreign]]);
    await pool.query("DELETE FROM admin_sessions WHERE owner_id=$1", [owner]);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    await pool.end();
  }
});
