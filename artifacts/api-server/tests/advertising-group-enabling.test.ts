import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { pool } from "@workspace/db";
import app from "../src/app";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";

test("bulk enable uses one rate-limited write for 181 groups, stays atomic and never starts posting", async () => {
  process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = "TEST_ONLY_PASSWORD";
  const owner = process.env.TELECART_OWNER_ID!;
  const token = await issueAdminSession();
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/shop/advertising/groups/enable`;
  const request = (groupIds: string[], authenticated = true) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://test-only.invalid", ...(authenticated ? { Cookie: `${adminCookieName()}=${token}` } : {}) },
    body: JSON.stringify({ groupIds }),
  });
  const save = async (target: string, status = "ready", tenant = owner) => (await pool.query(
    `INSERT INTO advertising_groups(owner_id,target,kind,chat_id,title,status,enabled)
      VALUES($1,$2,'chat_id',$2,'TEST_ONLY',$3,false) RETURNING *`, [tenant, target, status])).rows[0];
  const read = async (id: string) => (await pool.query("SELECT * FROM advertising_groups WHERE id=$1", [id])).rows[0];
  try {
    const groups = [];
    for (let i = 0; i < 181; i++) groups.push(await save(`-100${10000 + i}`));
    const ids = groups.map(group => group.id as string);
    const hidden = await save("-10099990");
    const foreign = await save("-10099991", "ready", "TEST_ONLY_OTHER_OWNER");
    const failed = await save("-10099992", "error");
    const removed = await save("-10099993", "removed");
    assert.equal((await request(ids, false)).status, 401);
    assert.equal((await request([])).status, 400);
    assert.equal((await request(["invalid"])).status, 400);
    assert.equal((await request([ids[0], ids[0]])).status, 400);
    assert.equal((await request(Array.from({ length: 1001 }, () => randomUUID()))).status, 400);
    assert.equal((await request([ids[0], foreign.id])).status, 404);
    assert.equal((await request([ids[0], randomUUID()])).status, 404);
    assert.equal((await request([ids[0], failed.id])).status, 409);
    assert.equal((await request([ids[0], removed.id])).status, 409);
    assert.equal((await read(ids[0])).enabled, false, "rejected selections must not partially enable groups");
    assert.equal((await read(failed.id)).enabled, false);
    assert.equal((await read(removed.id)).enabled, false);
    await pool.query(`INSERT INTO advertising_schedules(owner_id,group_id,running,account_generation,interval_seconds,draft)
      VALUES($1,$2,false,1,60,'{}')`, [owner, ids[0]]);
    const schedulesBefore = (await pool.query("SELECT * FROM advertising_schedules")).rows;
    const response = await request(ids);
    assert.equal(response.status, 200, "181 groups must fit in one request without exhausting the 60-write limit");
    const workspace = await response.json();
    assert.equal(workspace.groups.filter((group: any) => ids.includes(group.id) && group.enabled).length, 181);
    assert.equal(workspace.forwarding.running, false);
    assert.deepEqual(workspace.forwarding.groupIds, []);
    assert.deepEqual((await pool.query("SELECT * FROM advertising_schedules")).rows, schedulesBefore);
    for (const group of groups) {
      const saved = await read(group.id);
      assert.equal(saved.enabled, true);
      assert.equal(saved.status, "ready");
      assert.equal(saved.chat_id, group.chat_id);
    }
    assert.equal((await read(hidden.id)).enabled, false, "groups outside the confirmed filter snapshot remain unchanged");
    assert.equal((await read(foreign.id)).enabled, false);
    assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs")).rowCount, 0);
    assert.equal((await request(ids)).status, 200, "retrying a completed batch is safe");
    // Rate limiting still protects the endpoint; the fix must not bypass it.
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      lastStatus = (await request([ids[0]])).status;
      if (lastStatus === 429) break;
      assert.equal(lastStatus, 200);
    }
    assert.equal(lastStatus, 429);
  } finally {
    server.closeAllConnections(); server.close();
    await pool.end();
  }
});
