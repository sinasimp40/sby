import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { pool, databaseChanges } from "@workspace/db";
import app from "../src/app";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { issueAdminSession, adminCookieName, revokeAdminSession } from "../src/lib/admin-auth";
import { accountGroupUpdate, applyAccountGroupUpdate } from "../src/lib/advertising-group-updates";
import { checkAccountGroups } from "../src/lib/advertising-account-groups";
import { processAccountMembership } from "../src/lib/advertising-membership-worker";
import { withAdvertisingLock } from "../src/lib/advertising-store";
import { repairMissingLeaveIdentities, MISSING_LEAVE_IDENTITY } from "../src/lib/advertising-leave-repair";
import { closeAccountSession } from "../src/lib/advertising-account-session";
import type { AccountFactory } from "../src/lib/advertising-account-driver";

test("Telegram updates ignore messages and other members, but recognize self kicks and group changes", () => {
  const channelId = bigInt(12345), chatId = bigInt(123), self = bigInt(99);
  assert.deepEqual(accountGroupUpdate(new Api.UpdateChannel({ channelId }), "99"), { chatId: "-10012345" });
  assert.deepEqual(accountGroupUpdate(new Api.UpdateChatParticipantDelete({ chatId, userId: self, version: 1 }), "99"),
    { chatId: "-123", left: true });
  assert.equal(accountGroupUpdate(new Api.UpdateChatParticipantDelete({ chatId, userId: bigInt(100), version: 1 }), "99"), null);
  assert.deepEqual(accountGroupUpdate(new Api.UpdateChannelParticipant({
    channelId, date: 0, actorId: self, userId: self, qts: 1,
  }), "99"), { chatId: "-10012345", left: true });
  assert.deepEqual(accountGroupUpdate(new Api.UpdateChatParticipants({
    participants: new Api.ChatParticipants({ chatId, participants: [], version: 1 }),
  }), "99"), { chatId: "-123", left: true });
  assert.equal(accountGroupUpdate({ message: "TEST_ONLY unrelated traffic" }, "99"), null);
});

test("missing leave identities recover safely and pushed snapshots update only the authenticated shop", async t => {
  const owner = process.env.TELECART_OWNER_ID!;
  // Only synthetic credentials are used inside this isolated test process.
  process.env.TELECART_ADMIN_EMAIL = "test-only@example.invalid";
  process.env.TELECART_ADMIN_INITIAL_PASSWORD = "TEST_ONLY_password_not_for_any_account";
  const accountId = "99", chatId = "-10012345";
  let permissionDenied = true, leaves = 0;
  const originalConnect = TelegramClient.prototype.connect;
  TelegramClient.prototype.connect = async () => { throw new Error("Real Telegram is forbidden."); };
  const factory: AccountFactory = () => ({
    connect: async () => {}, disconnect: async () => {}, logout: async () => {}, session: () => "TEST_ONLY_SESSION",
    me: async () => ({ id: accountId, username: "TEST_ONLY", displayName: "TEST_ONLY" }),
    sendCode: async () => "", code: async () => {}, password: async () => {}, qr: async () => ({ authorized: true }),
    groups: async () => [], membership: async target => ({ chatId: target.startsWith("@") ? "-10023456" : target, title: "TEST_ONLY", joined: true, approval: false }),
    inspect: async target => {
      if (permissionDenied) throw { errorMessage: "CHAT_WRITE_FORBIDDEN" };
      return { chatId: target, target, title: "TEST_ONLY renamed" };
    },
    leave: async (_target, expected) => { assert.ok([chatId, "-10023456"].includes(expected)); leaves++; return "left"; },
    send: async () => { throw new Error("Advertising sends are forbidden."); },
  });
  const seal = (text: string) => encryptProviderSecret(text, owner, "advertising-account");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await pool.query(`INSERT INTO advertising_accounts(owner_id,api_id,api_hash_encrypted,session_encrypted,account_id,generation,checked_at)
      VALUES($1,12345,$2,$3,$4,1,now())`, [owner, seal("a".repeat(32)), seal("TEST_ONLY_SESSION"), accountId]);
    const group = (await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,title,status,enabled)
      VALUES($1,$2,'chat_id','TEST_ONLY discovered','pending',true) RETURNING *`, [owner, chatId])).rows[0];
    await t.test("first permission failure preserves numeric target identity and actually reaches the leave driver", async () => {
      await checkAccountGroups(owner, [group.id], factory);
      const job = (await pool.query("SELECT * FROM advertising_membership_jobs WHERE owner_id=$1", [owner])).rows[0];
      assert.equal(job.chat_id, chatId);
      assert.equal((await pool.query("SELECT * FROM advertising_groups WHERE id=$1", [group.id])).rows[0].chat_id, chatId);
      await processAccountMembership(owner, factory);
      assert.equal(leaves, 1);
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE id=$1", [job.id])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM advertising_groups WHERE id=$1", [group.id])).rowCount, 0);
    });
    await t.test("known pre-RPC failures recover once without retrying uncertain or mismatched jobs", async () => {
      const seedFailure = async (note: string) => {
        await pool.query(`INSERT INTO advertising_groups(id,owner_id,target,kind,title,status,enabled)
          VALUES($1,$2,$3,'chat_id','TEST_ONLY','removed',false)`, [group.id, owner, chatId]);
        await pool.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,action,request_key,payload_hash,status,note)
          VALUES($1,$2,1,$3,$4,'leave',$5,'automatic','failed',$6)`, [owner, accountId, group.id, chatId, randomUUID(), note]);
      };
      await seedFailure(MISSING_LEAVE_IDENTITY);
      await processAccountMembership(owner, factory);
      assert.equal(leaves, 2);
      await processAccountMembership(owner, factory);
      assert.equal(leaves, 2);
      await seedFailure("TEST_ONLY unrelated RPC failure");
      await processAccountMembership(owner, factory);
      assert.equal(leaves, 2);
      await pool.query(`UPDATE advertising_membership_jobs SET chat_id='-10099999',status='failed',note=$2 WHERE owner_id=$1`,
        [owner, MISSING_LEAVE_IDENTITY]);
      await withAdvertisingLock(owner, client => repairMissingLeaveIdentities(owner, client, { account_id: accountId, generation: 1 }));
      assert.equal((await pool.query("SELECT status FROM advertising_membership_jobs WHERE owner_id=$1", [owner])).rows[0].status, "failed");
    });
    await pool.query("DELETE FROM advertising_membership_jobs WHERE owner_id=$1", [owner]);
    await pool.query("UPDATE advertising_groups SET status='ready',enabled=true WHERE id=$1", [group.id]);
    permissionDenied = false;
    await t.test("live self-kicks remove the destination without another leave RPC and stale accounts cannot modify it", async () => {
      await applyAccountGroupUpdate(owner, "other-account", 1, { chatId, left: true }, factory);
      assert.equal((await pool.query("SELECT status FROM advertising_groups WHERE id=$1", [group.id])).rows[0].status, "ready");
      await applyAccountGroupUpdate(owner, accountId, 1, { chatId, left: true }, factory);
      assert.equal((await pool.query("SELECT 1 FROM advertising_groups WHERE id=$1", [group.id])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE owner_id=$1", [owner])).rowCount, 0);
      assert.equal(leaves, 2);
      await applyAccountGroupUpdate(owner, accountId, 1, { chatId }, factory);
      assert.equal((await pool.query("SELECT 1 FROM advertising_groups WHERE id=$1", [group.id])).rowCount, 0);
    });
    await t.test("authenticated streaming pushes new groups, changed counts and removal immediately; logout closes it", async () => {
      assert.equal((await fetch(`${base}/api/shop/advertising/events`)).status, 401);
      const token = await issueAdminSession();
      const initialListeners = databaseChanges.listenerCount("advertising");
      const response = await fetch(`${base}/api/shop/advertising/events`, {
        headers: { Cookie: `${adminCookieName()}=${token}` }, signal: abort.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /text\/event-stream/);
      reader = response.body!.getReader();
      let buffered = "";
      const nextWorkspace = async () => {
        const deadline = setTimeout(() => abort.abort(), 2500);
        try {
          for (;;) {
            const end = buffered.indexOf("\n\n");
            if (end >= 0) {
              const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
              if (event.startsWith("event: workspace\n")) return JSON.parse(event.split("\ndata: ")[1]);
              continue;
            }
            const result = await reader!.read();
            if (result.done) return null;
            buffered += new TextDecoder().decode(result.value);
          }
        } finally { clearTimeout(deadline); }
      };
      assert.equal((await nextWorkspace()).groups.length, 0);
      await pool.query(`INSERT INTO advertising_groups(id,owner_id,target,chat_id,kind,title,status,enabled,account_generation)
        VALUES($1,$2,$3,$3,'chat_id','TEST_ONLY','ready',true,1)`, [group.id, owner, chatId]);
      const added = await nextWorkspace();
      assert.equal(added.groups.length, 1); assert.equal(added.groups[0].status, "ready");
      // Another shop's write should not produce any snapshot or timing signal.
      await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,title) VALUES('TEST_ONLY_OTHER','-10022222','chat_id','TEST_ONLY private')`);
      await new Promise(resolve => setTimeout(resolve, 150));
      await pool.query("UPDATE advertising_groups SET title='TEST_ONLY latest',enabled=false WHERE id=$1", [group.id]);
      const updated = await nextWorkspace();
      assert.equal(updated.groups.length, 1); assert.equal(updated.groups[0].title, "TEST_ONLY latest");
      assert.equal(updated.groups[0].enabled, false);
      await pool.query("UPDATE advertising_groups SET status='removed' WHERE id=$1", [group.id]);
      assert.equal((await nextWorkspace()).groups.length, 0);
      await revokeAdminSession(token);
      // Any subsequent change revalidates the session before sending data.
      await pool.query("UPDATE advertising_groups SET title='TEST_ONLY revoked' WHERE id=$1", [group.id]);
      assert.equal(await nextWorkspace(), null);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(databaseChanges.listenerCount("advertising"), initialListeners);
    });
    await t.test("a 211-group snapshot drains its send buffer without closing or reconnecting the live stream", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let i = 0; i < 211; i++) await client.query(`INSERT INTO advertising_groups(owner_id,target,kind,title,note,enabled)
          VALUES($1,$2,'chat_id',$3,$4,false)`,
        [owner, `-1009000${String(i).padStart(4, "0")}`, `TEST_ONLY large ${i} ${"x".repeat(180)}`, "TEST_ONLY ".repeat(80)]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      const stop = new AbortController();
      const token = await issueAdminSession();
      let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(`${base}/api/shop/advertising/events`, {
          headers: { Cookie: `${adminCookieName()}=${token}` }, signal: stop.signal,
        });
        body = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        const next = async () => {
          const timeout = setTimeout(() => stop.abort(), 2500);
          try {
            for (;;) {
              const end = buffered.indexOf("\n\n");
              if (end >= 0) {
                const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
                if (event.startsWith("event: workspace\n")) return JSON.parse(event.split("\ndata: ")[1]);
                continue;
              }
              const chunk = await body!.read();
              if (chunk.done) return null;
              buffered += decoder.decode(chunk.value, { stream: true });
            }
          } finally { clearTimeout(timeout); }
        };
        const initial = await next();
        assert.equal(initial.groups.length, 211);
        assert.ok(Buffer.byteLength(JSON.stringify(initial)) > 128 * 1024, "exercise real stream backpressure");
        const firstId = initial.groups[0].id;
        await pool.query("UPDATE advertising_groups SET title='TEST_ONLY pushed without reconnect' WHERE id=$1", [firstId]);
        const updated = await next();
        assert.ok(updated, "large initial snapshots must not terminate the connection");
        assert.equal(updated.groups.find((group: { id: string }) => group.id === firstId).title, "TEST_ONLY pushed without reconnect");
        await pool.query("UPDATE advertising_groups SET status='removed' WHERE id=$1", [firstId]);
        assert.equal((await next()).groups.length, 210);
      } finally {
        stop.abort(); await body?.cancel().catch(() => {});
        await revokeAdminSession(token);
      }
    });
    await t.test("public destinations are pinned before posting denial so their leave job has a safe identity", async () => {
      permissionDenied = true;
      const group = (await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,title,status,enabled)
        VALUES($1,'@test_only_public','public','TEST_ONLY public','pending',true) RETURNING *`, [owner])).rows[0];
      await checkAccountGroups(owner, [group.id], factory);
      const job = (await pool.query("SELECT * FROM advertising_membership_jobs WHERE owner_id=$1 AND group_id=$2", [owner, group.id])).rows[0];
      assert.equal(job.chat_id, "-10023456");
      const before = leaves;
      await processAccountMembership(owner, factory);
      assert.equal(leaves, before + 1);
    });
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => {});
    server.closeAllConnections(); server.close();
    await closeAccountSession(owner);
    TelegramClient.prototype.connect = originalConnect;
    await pool.end();
  }
});
