import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pool } from "@workspace/db";
import app from "../src/app";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";

test("bulk removal is authenticated, owner-scoped, atomic, history-preserving and never leaves Telegram", async t => {
  process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = "TEST_ONLY_PASSWORD";
  const owner = process.env.TELECART_OWNER_ID!;
  const token = await issueAdminSession();
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/shop/advertising/groups/remove`;
  const request = (groupIds: string[], authenticated = true) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://test-only.invalid", ...(authenticated ? { Cookie: `${adminCookieName()}=${token}` } : {}) },
    body: JSON.stringify({ groupIds }),
  });
  const save = async (target: string, status: string, tenant = owner) => (await pool.query(
    `INSERT INTO advertising_groups(owner_id,target,kind,chat_id,title,status,enabled)
      VALUES($1,$2,'chat_id',$2,'TEST_ONLY',$3,true) RETURNING *`, [tenant, target, status])).rows[0];
  const read = async (id: string) => (await pool.query("SELECT * FROM advertising_groups WHERE id=$1", [id])).rows[0];
  try {
    const error1 = await save("-10011111", "error"), error2 = await save("-10022222", "error");
    const hiddenReady = await save("-10033333", "ready");
    const otherOwner = await save("-10044444", "error", "TEST_ONLY_OTHER_OWNER");
    await t.test("sign-in and valid nonempty selection are required", async () => {
      assert.equal((await request([error1.id], false)).status, 401);
      assert.equal((await request([])).status, 400);
      assert.equal((await request(["not-a-uuid"])).status, 400);
      assert.equal((await request(Array.from({ length: 1001 }, () => randomUUID()))).status, 400);
      assert.equal((await request([error1.id, error1.id])).status, 400);
      assert.equal((await read(error1.id)).status, "error");
    });
    await t.test("a missing or foreign group rejects the complete batch without partial removal", async () => {
      assert.equal((await request([error1.id, randomUUID()])).status, 404);
      assert.equal((await request([error1.id, otherOwner.id])).status, 404);
      assert.equal((await read(error1.id)).status, "error");
      assert.equal((await read(otherOwner.id)).status, "error");
    });
    await t.test("only confirmed groups disappear; their schedules and records are kept, and pending joins stop", async () => {
      for (const group of [error1, error2, hiddenReady]) await pool.query(
        `INSERT INTO advertising_schedules(owner_id,group_id,running,account_generation,interval_seconds,draft)
          VALUES($1,$2,true,1,60,'{}')`, [owner, group.id]);
      await pool.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,chat_id,title,action,request_key,payload_hash)
        VALUES($1,'TEST_ONLY_ACCOUNT',1,$2,$3,$3,'TEST_ONLY','join','TEST_ONLY_JOIN','TEST_ONLY_HASH')`, [owner, error1.id, error1.target]);
      const response = await request([error1.id, error2.id]);
      assert.equal(response.status, 200);
      const workspace = await response.json();
      assert.ok(workspace.groups.some((group: any) => group.id === hiddenReady.id));
      for (const group of [error1, error2]) {
        assert.ok(!workspace.groups.some((remaining: any) => remaining.id === group.id));
        assert.equal((await read(group.id)).status, "removed");
        assert.equal((await read(group.id)).enabled, false);
        assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [group.id])).rows[0].running, false);
      }
      assert.equal((await read(hiddenReady.id)).enabled, true);
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [hiddenReady.id])).rows[0].running, true);
      assert.equal((await pool.query("SELECT status FROM advertising_membership_jobs WHERE group_id=$1", [error1.id])).rows[0].status, "stopped");
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE action='leave'")).rowCount, 0);
      assert.equal((await request([error1.id, error2.id])).status, 200, "safe retries cannot delete records or create leave work");
      assert.equal((await read(otherOwner.id)).enabled, true);
    });
    await t.test("single-row removal uses the same history-preserving semantics", async () => {
      const response = await fetch(`${url.slice(0, -"/remove".length)}/${hiddenReady.id}`, {
        method: "DELETE", headers: { Cookie: `${adminCookieName()}=${token}`, Origin: "https://test-only.invalid" },
      });
      assert.equal(response.status, 200);
      assert.equal((await read(hiddenReady.id)).status, "removed");
      assert.equal((await pool.query("SELECT 1 FROM advertising_schedules WHERE group_id=$1", [hiddenReady.id])).rowCount, 1);
    });
  } finally {
    server.closeAllConnections(); server.close();
    await pool.end();
  }
});
