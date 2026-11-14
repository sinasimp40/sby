import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TelegramClient } from "telegram";
import { pool } from "@workspace/db";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { removeAdvertisingGroups } from "../src/lib/advertising-group-removal";
import { purgeAdvertisingGroup } from "../src/lib/advertising-group-purge";
import { withAdvertisingLock } from "../src/lib/advertising-store";
import { processAccountMembership } from "../src/lib/advertising-membership-worker";
import { startMembership } from "../src/lib/advertising-membership-store";
import { checkAccountGroups } from "../src/lib/advertising-account-groups";
import { applyAccountGroupUpdate } from "../src/lib/advertising-group-updates";
import { closeAccountSession } from "../src/lib/advertising-account-session";
import { AccountError, type AccountFactory } from "../src/lib/advertising-account-driver";

test("leave-first erasure requires proof, clears related records and never leaves duplicate originals", async t => {
  const owner = process.env.TELECART_OWNER_ID!;
  const identity = { id: "900000009", username: "TEST_ONLY", displayName: "TEST_ONLY" };
  const seal = (value: string) => encryptProviderSecret(value, owner, "advertising-account");
  let mode = "ok", left = 0, joins = 0;
  const memberships = new Map<string, string>();
  const realConnect = TelegramClient.prototype.connect;
  TelegramClient.prototype.connect = async () => { throw new Error("Real Telegram is forbidden."); };
  const factory: AccountFactory = () => ({
    connect: async () => {}, disconnect: async () => {}, logout: async () => {}, session: () => "TEST_ONLY_SESSION",
    me: async () => identity, sendCode: async () => "", code: async () => {}, password: async () => {},
    qr: async () => ({ authorized: true }), groups: async () => [],
    inspect: async target => ({ target, chatId: memberships.get(target) ?? target, title: "TEST_ONLY" }),
    membership: async target => ({ chatId: memberships.get(target) ?? target, title: "TEST_ONLY", joined: mode !== "absent", approval: false }),
    join: async target => { joins++; return { chatId: target, title: "TEST_ONLY", joined: true, approval: false, outcome: "joined" }; },
    leave: async () => {
      left++;
      if (mode === "failed") throw new AccountError("TEST_ONLY leave refused");
      if (mode === "uncertain") throw new AccountError("TEST_ONLY missing acknowledgement", "network", 0, "POST_NOT_CONFIRMED");
      return mode === "absent" ? "already_absent" : "left";
    },
    send: async () => { throw new Error("No advertisement may be sent."); },
  });
  const save = async (target: string, status = "ready", tenant = owner) => (await pool.query(
    `INSERT INTO advertising_groups(owner_id,target,kind,chat_id,title,status,account_generation)
      VALUES($1,$2,'chat_id',$2,'TEST_ONLY',$3,1) RETURNING *`, [tenant, target, status])).rows[0];
  const get = async (id: string) => (await pool.query("SELECT * FROM advertising_groups WHERE id=$1", [id])).rows[0];
  try {
    await pool.query(`INSERT INTO advertising_accounts(owner_id,account_id,generation,api_id,api_hash_encrypted,session_encrypted,checked_at)
      VALUES($1,$2,1,12345,$3,$4,now())`, [owner, identity.id, seal("a".repeat(32)), seal("TEST_ONLY_SESSION")]);
    await t.test("records remain until confirmation, then the group, schedules, history and jobs are erased", async () => {
      const group = await save("-10090001");
      const other = await save("-10090002", "ready", "TEST_ONLY_OTHER_OWNER");
      await pool.query("INSERT INTO advertising_schedules(owner_id,group_id,running) VALUES($1,$2,true)", [owner, group.id]);
      await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,status)
        VALUES($1,$2,$3,$3,1,1,now(),'{}','42','sent')`, [owner, group.id, group.target]);
      const key = randomUUID();
      await pool.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,chat_id,action,request_key,payload_hash,status)
        VALUES($1,$2,1,$3,$4,$4,'join',$5,'TEST_ONLY_HASH','joined')`, [owner, identity.id, group.id, group.target, key]);
      await removeAdvertisingGroups(owner, [group.id]);
      assert.equal((await get(group.id)).status, "removed");
      assert.equal(await withAdvertisingLock(owner, client => purgeAdvertisingGroup(owner, client, group.id)), false);
      await processAccountMembership(owner, factory);
      assert.equal(await get(group.id), undefined);
      for (const table of ["advertising_schedules", "advertising_account_runs", "advertising_membership_jobs"])
        assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE owner_id=$1 AND group_id=$2`, [owner, group.id])).rowCount, 0);
      assert.ok(await get(other.id));
      assert.equal((await pool.query("SELECT 1 FROM advertising_account_commands WHERE request_key=$1", [`membership:${key}`])).rowCount, 1);
      assert.equal(left, 1);
    });
    await t.test("failed and ambiguous leaves keep disabled records and never pretend departure succeeded", async () => {
      const group = await save("-10090003");
      await removeAdvertisingGroups(owner, [group.id]);
      mode = "failed"; await processAccountMembership(owner, factory);
      assert.equal((await get(group.id)).enabled, false);
      assert.equal((await pool.query("SELECT status FROM advertising_membership_jobs WHERE group_id=$1", [group.id])).rows[0].status, "failed");
      await removeAdvertisingGroups(owner, [group.id]);
      mode = "uncertain"; await processAccountMembership(owner, factory);
      assert.ok(await get(group.id));
      assert.equal((await pool.query("SELECT status FROM advertising_membership_jobs WHERE group_id=$1 AND status='uncertain'", [group.id])).rowCount, 1);
      const before = left;
      await pool.query("UPDATE advertising_membership_jobs SET updated_at=now()-interval '31 seconds' WHERE group_id=$1", [group.id]);
      mode = "absent"; await processAccountMembership(owner, factory);
      assert.equal(left, before, "absence reconciliation is read-only, never a blind leave retry");
      assert.equal(await get(group.id), undefined);
      mode = "ok";
    });
    await t.test("duplicate aliases disappear without a leave, and the original group is untouched", async () => {
      const original = await save("-10090004");
      const alias = (await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,status)
        VALUES($1,'@test_only_alias','public','pending') RETURNING *`, [owner])).rows[0];
      memberships.set(alias.target, original.chat_id);
      const before = left;
      await checkAccountGroups(owner, [alias.id], factory);
      assert.equal(await get(alias.id), undefined);
      assert.equal((await get(original.id)).enabled, true);
      assert.equal(left, before);
      await pool.query("UPDATE advertising_groups SET target='@test_only_original',kind='public' WHERE owner_id=$1 AND id=$2", [owner, original.id]);
      const numericAlias = (await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,status)
        VALUES($1,$2,'chat_id','pending') RETURNING *`, [owner, original.chat_id])).rows[0];
      await removeAdvertisingGroups(owner, [numericAlias.id]);
      assert.equal(await get(numericAlias.id), undefined);
      assert.equal((await get(original.id)).enabled, true);
      assert.equal(left, before, "unchecked numeric aliases also cannot leave the valid original");
      const legacy = await save("-10090005", "duplicate");
      await removeAdvertisingGroups(owner, [legacy.id]);
      assert.equal(await get(legacy.id), undefined);
      assert.equal(left, before);
    });
    await t.test("unverified public targets are pinned before leaving; already-absent and kick events are erased", async () => {
      const group = (await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,status)
        VALUES($1,'@test_only_unchecked','public','pending') RETURNING *`, [owner])).rows[0];
      memberships.set(group.target, "-10090006");
      await removeAdvertisingGroups(owner, [group.id]);
      await processAccountMembership(owner, factory);
      assert.equal(await get(group.id), undefined);
      const absent = await save("-10090007");
      mode = "absent"; await removeAdvertisingGroups(owner, [absent.id]); await processAccountMembership(owner, factory);
      assert.equal(await get(absent.id), undefined);
      const kicked = await save("-10090008");
      const before = left;
      await applyAccountGroupUpdate(owner, identity.id, 1, { chatId: kicked.chat_id, left: true }, factory);
      assert.equal(await get(kicked.id), undefined);
      assert.equal(left, before);
      mode = "ok";
    });
    await t.test("a retry of an erased join confirmation cannot join again", async () => {
      const key = randomUUID(), target = "@test_only_replay";
      const input = { confirmed: true, accountId: identity.id, idempotencyKey: key, restoreTargets: [], targets: [{ target, chatId: "-10090009" }] };
      await startMembership(owner, input);
      const job = (await pool.query("SELECT * FROM advertising_membership_jobs WHERE request_key=$1", [key])).rows[0];
      const group = await save("-10090009");
      await pool.query("UPDATE advertising_membership_jobs SET group_id=$2,target=$3,status='joined' WHERE id=$1", [job.id, group.id, target]);
      await pool.query("UPDATE advertising_groups SET target=$3,kind='public' WHERE owner_id=$1 AND id=$2", [owner, group.id, target]);
      await removeAdvertisingGroups(owner, [group.id]); await processAccountMembership(owner, factory);
      assert.equal(await get(group.id), undefined);
      await startMembership(owner, input);
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE request_key=$1", [key])).rowCount, 0);
      assert.equal(joins, 0);
    });
    await t.test("in-flight actions and another account's proof cannot authorize erasure; checkpoints lose only the erased entry", async () => {
      const group = await save("-10090010"), other = await save("-10090011");
      await removeAdvertisingGroups(owner, [group.id]);
      await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,status)
        VALUES($1,$2,$3,$3,1,1,now(),'{}','43','sending')`, [owner, group.id, group.target]);
      await pool.query("UPDATE advertising_membership_jobs SET status='left' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      assert.equal(await withAdvertisingLock(owner, client => purgeAdvertisingGroup(owner, client, group.id)), false);
      await pool.query("UPDATE advertising_account_runs SET status='uncertain' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      await pool.query("UPDATE advertising_membership_jobs SET account_id='TEST_ONLY_OTHER_ACCOUNT' WHERE owner_id=$1 AND group_id=$2", [owner, group.id]);
      assert.equal(await withAdvertisingLock(owner, client => purgeAdvertisingGroup(owner, client, group.id)), false);
      await pool.query("UPDATE advertising_membership_jobs SET account_id=$3 WHERE owner_id=$1 AND group_id=$2", [owner, group.id, identity.id]);
      const data = { queue: [{ groupId: group.id, order: 0 }, { groupId: other.id, order: 1 }], forward: { source: "TEST_ONLY_SOURCE" }, groupsSentInInterval: 1 };
      await pool.query(`INSERT INTO advertising_checkpoints(owner_id,plan_id,account_id,state,data)
        VALUES($1,$2,$3,'paused',$4::jsonb)`, [owner, randomUUID(), identity.id, JSON.stringify(data)]);
      assert.equal(await withAdvertisingLock(owner, client => purgeAdvertisingGroup(owner, client, group.id)), true);
      const raw = (await pool.query("SELECT data AS checkpoint_data FROM advertising_checkpoints WHERE owner_id=$1", [owner])).rows[0].checkpoint_data;
      const checkpoint = typeof raw === "string" ? JSON.parse(raw) : raw;
      assert.deepEqual(checkpoint.queue, [{ groupId: other.id, order: 1 }]);
      assert.deepEqual(checkpoint.forward, data.forward);
      assert.ok(await get(other.id));
      await pool.query("DELETE FROM advertising_checkpoints WHERE owner_id=$1", [owner]);
    });
    await t.test("known earlier local removals are upgraded, but imported removals never authorize automatic leaving", async () => {
      const local = await save("-10090012", "removed"), imported = await save("-10090013", "removed");
      await pool.query("UPDATE advertising_groups SET note='Removed from advertising by the merchant. Telegram membership was not changed.' WHERE id=$1", [local.id]);
      await pool.query("UPDATE advertising_groups SET note='Removed destination preserved by import. No membership action was imported. Explicit restoration is required.' WHERE id=$1", [imported.id]);
      const before = left;
      await processAccountMembership(owner, factory);
      assert.equal(left, before + 1);
      assert.equal(await get(local.id), undefined);
      assert.ok(await get(imported.id));
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE group_id=$1", [imported.id])).rowCount, 0);
    });
  } finally {
    await closeAccountSession(owner);
    TelegramClient.prototype.connect = realConnect;
    await pool.end();
  }
});
