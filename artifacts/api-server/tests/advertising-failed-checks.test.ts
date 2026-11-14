import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { TelegramClient } from "telegram";
import { pool } from "@workspace/db";
import { checkAccountGroups } from "../src/lib/advertising-account-groups";
import { processAccountMembership } from "../src/lib/advertising-membership-worker";
import { LEGACY_UNRESOLVED_GROUP } from "../src/lib/advertising-failed-checks";
import { AccountError, type AccountFactory } from "../src/lib/advertising-account-driver";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { closeAccountSession } from "../src/lib/advertising-account-session";
import { initializeAccountAdvertising } from "../src/lib/advertising-account-auth";
import { advertisingWorkspace } from "../src/lib/advertising-store";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";
import app from "../src/app";

test("failed group checks cannot remain enabled and known resolution failures are removed with safe leave work", async t => {
  const owner = process.env.TELECART_OWNER_ID!, accountId = "TEST_ONLY_ACCOUNT";
  const originalConnect = TelegramClient.prototype.connect;
  TelegramClient.prototype.connect = async () => { throw new Error("Real Telegram forbidden."); };
  const modes = new Map<string, string>();
  const left: string[] = [];
  const factory: AccountFactory = () => ({
    connect: async () => {}, disconnect: async () => {}, logout: async () => {}, session: () => "TEST_ONLY_SESSION",
    me: async () => ({ id: accountId, username: "TEST_ONLY", displayName: "TEST_ONLY" }),
    sendCode: async () => "", code: async () => {}, password: async () => {}, qr: async () => ({ authorized: true }),
    groups: async () => [],
    inspect: async target => {
      const mode = modes.get(target);
      if (mode === "unresolved") throw new AccountError("TEST_ONLY unresolved destination", "destination", 0, "DESTINATION_UNRESOLVED", true);
      if (mode === "network") throw new AccountError("TEST_ONLY temporary network", "network", 0, "TRANSPORT_UNAVAILABLE");
      if (mode === "unknown") throw new AccountError("TEST_ONLY unclassified validation", "validation");
      return { target, chatId: target, title: "TEST_ONLY verified" };
    },
    leave: async (_target, expected) => { left.push(expected); return "left"; },
    send: async () => { throw new Error("No advertisements allowed."); },
  });
  const save = async (target: string, status = "ready", note = "") => (await pool.query(
    `INSERT INTO advertising_groups(owner_id,target,kind,chat_id,title,status,enabled,note)
      VALUES($1,$2,'chat_id',$2,'TEST_ONLY',$3,true,$4) RETURNING *`, [owner, target, status, note])).rows[0];
  const read = async (id: string) => (await pool.query("SELECT * FROM advertising_groups WHERE id=$1", [id])).rows[0];
  const seal = (value: string) => encryptProviderSecret(value, owner, "advertising-account");
  let server: ReturnType<typeof app.listen> | undefined;
  try {
    await pool.query(`INSERT INTO advertising_accounts(owner_id,api_id,api_hash_encrypted,session_encrypted,account_id,generation,checked_at)
      VALUES($1,12345,$2,$3,$4,1,now())`, [owner, seal("a".repeat(32)), seal("TEST_ONLY_SESSION"), accountId]);
    const healthy = await save("-10011111");
    await t.test("a destination resolution failure disables, removes, stops sending and queues the actual leave", async () => {
      const group = await save("-10022222");
      modes.set(group.target, "unresolved");
      await pool.query(`INSERT INTO advertising_schedules(owner_id,group_id,running,account_generation,interval_seconds,draft)
        VALUES($1,$2,true,1,60,'{}')`, [owner, group.id]);
      await checkAccountGroups(owner, [group.id], factory);
      assert.equal((await read(group.id)).status, "removed");
      assert.equal((await read(group.id)).enabled, false);
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [group.id])).rows[0].running, false);
      assert.ok(!(await advertisingWorkspace(owner)).groups.some(groupInList => groupInList.id === group.id));
      await processAccountMembership(owner, factory);
      assert.deepEqual(left, [group.target]);
      assert.equal((await read(healthy.id)).status, "ready");
      assert.equal((await read(healthy.id)).enabled, true);
    });
    await t.test("existing resolver errors are disabled and rechecked, removing only those that still fail", async () => {
      const good = await save("-10044444", "error", LEGACY_UNRESOLVED_GROUP);
      const bad = await save("-10055555", "error", LEGACY_UNRESOLVED_GROUP);
      modes.set(bad.target, "unresolved");
      await processAccountMembership(owner, factory);
      assert.equal((await read(good.id)).status, "ready");
      assert.equal((await read(good.id)).enabled, false, "recovery cannot enable or start a group");
      assert.equal(await read(bad.id), undefined, "confirmed departure permanently erases the failed destination");
      assert.ok(left.includes(bad.target));
      assert.ok(!left.includes(good.target));
      assert.equal((await read(healthy.id)).enabled, true);
    });
    await t.test("non-destination validation errors stay disabled and cannot be re-enabled before verification", async () => {
      const group = await save("-10066666");
      modes.set(group.target, "unknown");
      await checkAccountGroups(owner, [group.id], factory);
      assert.equal((await read(group.id)).status, "error");
      assert.equal((await read(group.id)).enabled, false);
      assert.ok(!left.includes(group.target));
      process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
      process.env.TELECART_ADMIN_INITIAL_PASSWORD = "TEST_ONLY_PASSWORD";
      const token = await issueAdminSession();
      server = app.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/shop/advertising/groups/${group.id}`, {
        method: "PATCH", headers: { Cookie: `${adminCookieName()}=${token}`, Origin: "https://test-only.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /successfully before enabling/);
      assert.equal((await read(group.id)).enabled, false);
      modes.delete(group.target);
      await checkAccountGroups(owner, [group.id], factory);
      assert.equal((await read(group.id)).status, "ready");
      assert.equal((await read(group.id)).enabled, false);
    });
    await t.test("temporary connection failures disable the affected group without leaving it or healthy groups", async () => {
      const group = await save("-10033333");
      const before = [...left];
      modes.set(group.target, "network");
      await assert.rejects(checkAccountGroups(owner, [group.id], factory), /temporary network/);
      assert.equal((await read(group.id)).enabled, false);
      assert.equal((await read(group.id)).status, "pending");
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE group_id=$1", [group.id])).rowCount, 0);
      assert.equal((await read(healthy.id)).enabled, true);
      assert.deepEqual(left, before);
    });
    await t.test("startup disables old errored groups even while the Telegram account is disconnected", async () => {
      const group = await save("-10077777", "error", "TEST_ONLY earlier validation failure");
      const before = [...left];
      await initializeAccountAdvertising(owner);
      assert.equal((await read(group.id)).enabled, false);
      assert.equal((await read(healthy.id)).enabled, true);
      assert.deepEqual(left, before, "local safety repair must not make a Telegram request");
    });
  } finally {
    server?.closeAllConnections(); server?.close();
    await closeAccountSession(owner);
    TelegramClient.prototype.connect = originalConnect;
    await pool.end();
  }
});
