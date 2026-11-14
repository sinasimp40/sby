import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { pool } from "@workspace/db";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { AccountError, type AccountFactory } from "../src/lib/advertising-account-driver";
import { closeAccountSession } from "../src/lib/advertising-account-session";
import { withAdvertisingLock, advertisingWorkspace } from "../src/lib/advertising-store";
import { previewMembership, startMembership, stopMembership, queueGroupRemoval, membershipJobs, definiteDestinationFailure } from "../src/lib/advertising-membership-store";
import { processAccountMembership } from "../src/lib/advertising-membership-worker";
import { recoverAccountConnection } from "../src/lib/advertising-account-recovery";
import { checkAccountGroups, discoverAccountGroups } from "../src/lib/advertising-account-groups";
import { safeAccountError } from "../src/lib/advertising-account-errors";
import { inspectMembership, joinMembership, leaveMembership } from "../src/lib/advertising-membership-telegram";
import { exportShopTransfer, previewShopTransfer, importShopTransfer } from "../src/lib/shop-transfer";
import app from "../src/app";
import { issueAdminSession, adminCookieName } from "../src/lib/admin-auth";

test("native membership RPCs only target groups and never turn approval requests into joined status", async () => {
  const channel = new Api.Channel({ id: bigInt(123456789), accessHash: bigInt(123), title: "TEST_ONLY", date: 0,
    photo: new Api.ChatPhotoEmpty(), megagroup: true, left: true });
  const calls: unknown[] = [];
  const client = {
    getEntity: async () => channel,
    invoke: async (request: unknown) => {
      calls.push(request);
      if (request instanceof Api.messages.CheckChatInvite) return new Api.ChatInvite({
        title: "TEST_ONLY approval", photo: new Api.PhotoEmpty({ id: bigInt(1) }), participantsCount: 1, requestNeeded: true });
      if (request instanceof Api.messages.ImportChatInvite) throw { errorMessage: "INVITE_REQUEST_SENT" };
      if (request instanceof Api.channels.JoinChannel) { channel.left = false; return {}; }
      if (request instanceof Api.channels.GetParticipant) return { participant: new Api.ChannelParticipant({ userId: bigInt(1), date: 0 }) };
      if (request instanceof Api.channels.LeaveChannel) { channel.left = true; return {}; }
      throw new Error("Unexpected TEST_ONLY RPC.");
    },
  } as unknown as TelegramClient;
  const approval = await joinMembership(client, "https://t.me/+TEST_ONLY", null);
  assert.equal(approval.outcome, "awaiting_approval");
  assert.equal((await joinMembership(client, "@TEST_ONLY", "-100123456789")).outcome, "joined");
  const joinedCalls = calls.length;
  assert.equal((await joinMembership(client, "@TEST_ONLY", "-100123456789")).outcome, "already_joined");
  assert.equal(calls.slice(joinedCalls).filter(c => c instanceof Api.channels.JoinChannel).length, 0);
  assert.equal(await leaveMembership(client, "@reassigned_name", "-100123456789"), "left");
  assert.equal(await leaveMembership(client, "@reassigned_name", "-100123456789"), "already_absent");
  await assert.rejects(joinMembership(client, "@TEST_ONLY", "-100999999999"), /identity changed/);
  channel.left = false;
  client.getEntity = async () => { throw new Error("Could not find the input entity for TEST_ONLY"); };
  client.getDialogs = (async () => [{ entity: channel }]) as typeof client.getDialogs;
  assert.equal(await leaveMembership(client, "@reassigned_name", "-100123456789"), "left", "restarted sessions can recover group hashes from joined dialogs");
  client.getEntity = async () => { throw Object.assign(new Error("TEST_ONLY timeout"), { code: "ETIMEDOUT" }); };
  client.getDialogs = async () => { throw new Error("Network failures must not trigger a second read."); };
  await assert.rejects(leaveMembership(client, "@TEST_ONLY", "-100123456789"), /TEST_ONLY timeout/);
  const basic = new Api.Chat({ id: bigInt(123456789), title: "TEST_ONLY basic", photo: new Api.ChatPhotoEmpty(), participantsCount: 1, date: 0, version: 1 });
  client.getEntity = async () => basic;
  client.invoke = (async (request: unknown) => {
    assert.ok(request instanceof Api.messages.DeleteChatUser);
    assert.ok(request.userId instanceof Api.InputUserSelf);
    assert.equal(request.revokeHistory, false); return {};
  }) as typeof client.invoke;
  assert.equal(await leaveMembership(client, "-123456789", "-123456789"), "left");
  client.getEntity = async () => new Api.User({ id: bigInt(123), firstName: "TEST_ONLY" });
  await assert.rejects(inspectMembership(client, "@not_a_group"), /not a group/);
});

test("membership jobs are confirmed, durable, account-bound, and fail closed without real Telegram", async t => {
  const owner = process.env.TELECART_OWNER_ID!;
  const identity = { id: "900000009", username: "TEST_ONLY", displayName: "TEST_ONLY" };
  const sessionSecret = encryptProviderSecret("TEST_ONLY_SESSION", owner, "advertising-account");
  let membership = new Map<string, { chatId: string; title: string; joined: boolean; approval: boolean }>();
  let joinMode = "ok", permissionMode = "ok", leaveMode = "ok", joins = 0, leaves = 0, reads = 0;
  const originalConnect = TelegramClient.prototype.connect, originalFetch = globalThis.fetch;
  TelegramClient.prototype.connect = async () => { throw new Error("Real Telegram forbidden."); };
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).hostname !== "127.0.0.1") throw new Error("External HTTP forbidden.");
    return originalFetch(url, init);
  };
  const probe = (target: string) => {
    reads++;
    const result = membership.get(target) ?? [...membership.values()].find(item => item.chatId === target);
    if (!result) throw new AccountError("TEST_ONLY invitation missing");
    return { ...result };
  };
  const factory: AccountFactory = () => ({
    connect: async () => {}, disconnect: async () => {}, logout: async () => {}, session: () => "TEST_ONLY_SESSION",
    me: async () => identity, sendCode: async () => "TEST_ONLY", code: async () => {}, password: async () => {},
    qr: async () => ({ authorized: true }), groups: async () => [...membership.entries()].filter(([, row]) => row.joined).map(([target, row]) => ({ target, chatId: row.chatId, title: row.title })),
    inspect: async target => {
      if (permissionMode === "denied") throw { errorMessage: "CHAT_WRITE_FORBIDDEN" };
      if (permissionMode === "network") throw new AccountError("TEST_ONLY preflight network", "network", 0, "POST_NOT_CONFIRMED");
      const result = probe(target); return { ...result, target };
    },
    membership: async target => probe(target),
    join: async (target, expected) => {
      joins++; const row = membership.get(target)!;
      assert.ok(!expected || row.chatId === expected);
      if (joinMode === "flood") throw { errorMessage: "FLOOD_WAIT", seconds: 120 };
      if (joinMode === "uncertain") throw new AccountError("TEST_ONLY join unconfirmed", "network", 0, "POST_NOT_CONFIRMED");
      if (joinMode === "approval") return { ...row, outcome: "awaiting_approval" };
      row.joined = true; return { ...row, outcome: "joined" };
    },
    leave: async (_target, expected) => {
      leaves++;
      if (leaveMode === "uncertain") throw new AccountError("TEST_ONLY leave timed out", "network", 0, "REQUEST_TIMEOUT");
      const row = [...membership.values()].find(item => item.chatId === expected)!;
      if (row) row.joined = false; return row ? "left" : "already_absent";
    },
    send: async () => { throw new Error("Membership tests must never send an advertisement."); },
  });
  const seed = async (target: string, index: number, joined = false) => {
    const row = { chatId: `-1003456789${String(index).padStart(2, "0")}`, title: target, joined, approval: false };
    membership.set(target, row); return row;
  };
  const clearJobs = () => pool.query("DELETE FROM advertising_membership_jobs WHERE owner_id=$1", [owner]);
  const input = (target: string, chatId: string | null, restoreTargets: string[] = []) => ({
    accountId: identity.id, targets: [{ target, chatId }], restoreTargets, confirmed: true, idempotencyKey: randomUUID(),
  });
  const queryGroup = async (target: string) => (await pool.query("SELECT * FROM advertising_groups WHERE owner_id=$1 AND target=$2", [owner, target])).rows[0];
  const save = async (target: string, row: { chatId: string; title: string }) => (await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,title,chat_id,status,account_generation)
    VALUES($1,$2,'public',$2,$3,'ready',1) RETURNING *`, [owner, target, row.chatId])).rows[0];
  try {
    await pool.query(`INSERT INTO advertising_accounts(owner_id,api_id,api_hash_encrypted,session_encrypted,account_id,generation,checked_at)
      VALUES($1,12345,$2,$3,$4,1,now())`, [owner, encryptProviderSecret("a".repeat(32), owner, "advertising-account"), sessionSecret, identity.id]);
    await t.test("preview detects duplicates, nonjoinable IDs and existing memberships without joining", async () => {
      await seed("@test_only_alpha", 1);
      await seed("@test_only_joined", 2, true);
      const result = await previewMembership(owner, "@test_only_alpha\n@test_only_alpha\n-100123456789\n@test_only_joined", factory);
      assert.deepEqual(result.rows.map(row => row.state), ["ready", "duplicate", "not_joinable", "already_joined"]);
      assert.equal(joins, 0); assert.equal(leaves, 0);
      await assert.rejects(previewMembership(owner, Array.from({ length: 51 }, (_, i) => `@test_only_${i}`).join("\n"), factory), /50/);
      membership.set("@test_only_alias", membership.get("@test_only_alpha")!);
      assert.deepEqual((await previewMembership(owner, "@test_only_alpha\n@test_only_alias", factory)).rows.map(row => row.state), ["ready", "duplicate"]);
    });
    await t.test("confirmation is required, deduplicated, and joining never starts or selects advertising", async () => {
      const row = membership.get("@test_only_alpha")!;
      const command = input("@test_only_alpha", row.chatId);
      await assert.rejects(startMembership(owner, { ...command, confirmed: false }), /Confirm/);
      await startMembership(owner, command); await startMembership(owner, command);
      assert.equal((await membershipJobs(owner)).length, 1);
      await assert.rejects(startMembership(owner, { ...command, targets: [{ target: "@test_only_joined", chatId: null }] }), /different selection/);
      await processAccountMembership(owner, factory);
      assert.equal(joins, 1);
      const group = await queryGroup("@test_only_alpha");
      assert.equal(group.status, "ready"); assert.equal(group.enabled, false);
      assert.equal((await pool.query("SELECT * FROM advertising_schedules WHERE owner_id=$1", [owner])).rowCount, 0);
      assert.equal((await membershipJobs(owner))[0].status, "joined");
      await processAccountMembership(owner, factory); assert.equal(joins, 1);
    });
    await t.test("uploading an already-joined successful destination leaves its saved settings untouched", async () => {
      await clearJobs();
      const row = await seed("@test_only_existing_success", 13, true);
      await save("@test_only_existing_success", row);
      await pool.query("UPDATE advertising_groups SET last_sent_at=now() WHERE owner_id=$1 AND target=$2", [owner, "@test_only_existing_success"]);
      const before = await queryGroup("@test_only_existing_success");
      const count = joins;
      await startMembership(owner, input("@test_only_existing_success", row.chatId));
      await processAccountMembership(owner, factory);
      assert.equal(joins, count);
      assert.deepEqual(await queryGroup("@test_only_existing_success"), before);
      assert.equal((await membershipJobs(owner))[0].status, "already_joined");
    });
    await t.test("definite failures queue leaving, then erase only that group and require explicit rejoining", async () => {
      await clearJobs();
      const failed = await save("@test_only_failed", await seed("@test_only_failed", 3, true));
      const good = await save("@test_only_good", await seed("@test_only_good", 4, true));
      permissionMode = "denied";
      await checkAccountGroups(owner, [failed.id], factory);
      permissionMode = "ok";
      assert.equal((await queryGroup(failed.target)).status, "removed");
      assert.equal((await queryGroup(good.target)).status, "ready");
      assert.equal((await membershipJobs(owner))[0].status, "pending");
      const before = leaves;
      await processAccountMembership(owner, factory);
      assert.equal(leaves, before + 1);
      assert.equal(await queryGroup(failed.target), undefined);
      assert.equal((await membershipJobs(owner)).length, 0);
      await discoverAccountGroups(owner, factory);
      const workspace = await advertisingWorkspace(owner);
      assert.ok(!workspace.groups.some(group => group.id === failed.id));
      assert.ok(workspace.groups.some(group => group.id === good.id));
      await assert.rejects(checkAccountGroups(owner, [failed.id], factory), /not found/);
      const preview = await previewMembership(owner, failed.target, factory);
      assert.equal(preview.rows[0].state, "ready");
      await startMembership(owner, input(failed.target, failed.chat_id));
      await processAccountMembership(owner, factory);
      assert.equal((await queryGroup(failed.target)).status, "ready");
      assert.equal((await queryGroup(failed.target)).enabled, false);
    });
    await t.test("network, account-wide, source and UNCERTAIN errors are not definite permission failures", async () => {
      for (const error of [
        new AccountError("TEST_ONLY uncertain", "network", 0, "POST_NOT_CONFIRMED"),
        { errorMessage: "PEER_FLOOD" }, { errorMessage: "AUTH_KEY_UNREGISTERED" },
        { errorMessage: "FLOOD_WAIT", seconds: 5 }, { errorMessage: "SAVED_MESSAGE_CHANGED" },
        { errorMessage: "MESSAGE_ID_INVALID" },
      ]) assert.equal(definiteDestinationFailure(safeAccountError(error)), false);
      assert.equal(definiteDestinationFailure(safeAccountError({ errorMessage: "CHAT_WRITE_FORBIDDEN" })), true);
      assert.equal(definiteDestinationFailure(safeAccountError({ errorMessage: "UNKNOWN_GROUP_REJECTION" })), false,
        "unclassified RPC errors cannot safely be attributed to a destination");
      assert.equal(definiteDestinationFailure(safeAccountError({ errorMessage: "CHAT_ID_INVALID" })), true);
    });
    await t.test("approval requests are never replayed and only become joined after membership is verified", async () => {
      await clearJobs(); const row = await seed("https://t.me/+TEST_ONLY", 5);
      row.approval = true; joinMode = "approval";
      await startMembership(owner, input("https://t.me/+TEST_ONLY", null));
      const before = joins; await processAccountMembership(owner, factory);
      assert.equal((await membershipJobs(owner))[0].status, "awaiting_approval");
      await pool.query("UPDATE advertising_membership_jobs SET updated_at=now()-interval '31 seconds' WHERE owner_id=$1", [owner]);
      await processAccountMembership(owner, factory);
      assert.equal(joins, before + 1);
      row.joined = true;
      await pool.query("UPDATE advertising_membership_jobs SET updated_at=now()-interval '31 seconds' WHERE owner_id=$1", [owner]);
      await processAccountMembership(owner, factory);
      assert.equal((await membershipJobs(owner))[0].status, "already_joined");
      assert.equal(joins, before + 1); joinMode = "ok";
    });
    await t.test("waits persist, Stop prevents queued joins, and changed accounts cannot execute old work", async () => {
      await clearJobs(); const row = await seed("@test_only_wait", 6);
      await startMembership(owner, input("@test_only_wait", row.chatId));
      joinMode = "flood"; await processAccountMembership(owner, factory);
      const before = joins, readBefore = reads;
      await processAccountMembership(owner, factory);
      assert.equal(joins, before); assert.equal(reads, readBefore);
      assert.equal((await membershipJobs(owner))[0].status, "pending");
      await stopMembership(owner);
      await pool.query("UPDATE advertising_accounts SET telegram_wait_until=now()-interval '1 second' WHERE owner_id=$1", [owner]);
      await processAccountMembership(owner, factory);
      assert.equal(joins, before);
      await startMembership(owner, input("@test_only_wait", row.chatId));
      await pool.query("UPDATE advertising_accounts SET generation=generation+1 WHERE owner_id=$1", [owner]);
      await processAccountMembership(owner, factory);
      assert.equal(joins, before);
      assert.ok((await membershipJobs(owner)).every(job => job.status === "stopped"));
      await pool.query("UPDATE advertising_accounts SET generation=1 WHERE owner_id=$1", [owner]); joinMode = "ok";
      await closeAccountSession(owner);
    });
    await t.test("removed status survives portable transfer while RPC work and account sessions do not travel", async () => {
      await clearJobs();
      const removed = await save("@test_only_portable", await seed("@test_only_portable", 8, true));
      await withAdvertisingLock(owner, async client => {
        const account = (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
        await queueGroupRemoval(owner, client, removed, account, "TEST_ONLY definite permission failure");
      });
      const archive = await exportShopTransfer(owner);
      const destination = `TEST_ONLY_DEST_${randomUUID()}`;
      const preview = await previewShopTransfer(destination, archive.zip);
      await importShopTransfer(destination, archive.zip, preview.confirmationToken);
      const imported = (await pool.query("SELECT status,enabled FROM advertising_groups WHERE owner_id=$1 AND target=$2", [destination, removed.target])).rows[0];
      assert.equal(imported.status, "removed"); assert.equal(imported.enabled, false);
      assert.equal((await membershipJobs(destination)).length, 0);
      assert.equal((await pool.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [destination])).rowCount, 0);
    });
    await t.test("an uncertain leave requires a verified connection and read-only reconciliation before retry", async () => {
      await clearJobs();
      await closeAccountSession(owner);
      await pool.query("UPDATE advertising_accounts SET last_error=NULL WHERE owner_id=$1", [owner]);
      const group = await save("@test_only_leave_reconcile", await seed("@test_only_leave_reconcile", 9, true));
      await withAdvertisingLock(owner, async client => queueGroupRemoval(owner, client, group,
        (await client.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0], "TEST_ONLY permission denied"));
      leaveMode = "uncertain";
      const before = leaves;
      await processAccountMembership(owner, factory);
      assert.equal((await membershipJobs(owner))[0].status, "uncertain");
      await processAccountMembership(owner, factory); assert.equal(leaves, before + 1);
      await withAdvertisingLock(owner, client => recoverAccountConnection(owner, client, factory, Date.now() + 60_000));
      await pool.query("UPDATE advertising_membership_jobs SET updated_at=now()-interval '31 seconds' WHERE owner_id=$1", [owner]);
      await processAccountMembership(owner, factory);
      assert.equal((await membershipJobs(owner))[0].status, "pending");
      assert.equal(leaves, before + 1, "reconciliation itself is strictly read-only");
      leaveMode = "ok";
      await processAccountMembership(owner, factory);
      assert.equal(await queryGroup(group.target), undefined);
      assert.equal((await membershipJobs(owner)).length, 0);
      assert.equal(leaves, before + 2);
    });
    await t.test("historical cleanup removes UNCERTAIN destinations but protects newer successes", async () => {
      await clearJobs();
      const failed = await save("@test_only_old_failure", await seed("@test_only_old_failure", 10, true));
      const successful = await save("@test_only_later_success", await seed("@test_only_later_success", 11, true));
      const uncertain = await save("@test_only_old_uncertain", await seed("@test_only_old_uncertain", 12, true));
      for (const [group, status] of [[failed, "failed"], [successful, "failed"], [uncertain, "uncertain"]] as const) {
        await pool.query("UPDATE advertising_groups SET status='error',enabled=false,account_generation=NULL WHERE id=$1", [group.id]);
        await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,status,note,started_at)
          VALUES($1,$2,$3,$4,1,1,now(),'{}','1',$5,'This account lacks permission to send this message/media in the group.',now()-interval '20 seconds')`,
        [owner, group.id, group.target, group.chat_id, status]);
      }
      await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,status,note)
        VALUES($1,$2,$3,$4,1,2,now(),'{}','2','sent','TEST_ONLY verified later success')`, [owner, successful.id, successful.target, successful.chat_id]);
      const before = leaves;
      await processAccountMembership(owner, factory);
      assert.equal(leaves, before + 1);
      assert.ok(["removed", "erased"].includes((await queryGroup(failed.target))?.status ?? "erased"));
      assert.equal((await queryGroup(successful.target)).status, "error", "newer success must prevent historical removal");
      assert.ok(["removed", "erased"].includes((await queryGroup(uncertain.target))?.status ?? "erased"));
      await processAccountMembership(owner, factory);
      await processAccountMembership(owner, factory);
      const job = (await pool.query("SELECT status FROM advertising_membership_jobs WHERE owner_id=$1 AND group_id=$2 AND action='leave'", [owner, uncertain.id])).rows;
      assert.equal(job.length, 0, "confirmed departures erase their jobs");
      assert.equal(await queryGroup(uncertain.target), undefined);
      assert.equal((await pool.query("SELECT 1 FROM advertising_account_runs WHERE owner_id=$1 AND group_id=$2", [owner, uncertain.id])).rowCount, 0);
      assert.equal(leaves, before + 2, "cleanup never creates duplicate leaves");
    });
    await t.test("historical UNCERTAIN cleanup binds the original account and protects success and explicit restoration", async () => {
      await clearJobs();
      const account = (await pool.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      const bound = await save("@test_only_bound_uncertain", await seed("@test_only_bound_uncertain", 14, true));
      const foreign = await save("@test_only_foreign_uncertain", await seed("@test_only_foreign_uncertain", 15, true));
      const success = await save("@test_only_uncertain_then_sent", await seed("@test_only_uncertain_then_sent", 16, true));
      const restored = await save("@test_only_uncertain_restored", await seed("@test_only_uncertain_restored", 17, true));
      for (const group of [bound, foreign, success, restored]) {
        const sourceAccount = group.id === foreign.id ? "999999999999" : account.account_id;
        await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,status,started_at)
          VALUES($1,$2,$3,$4,$5,1,now(),$6::jsonb,'1','uncertain',now()-interval '20 seconds')`,
        [owner, group.id, group.target, group.chat_id, group.id === foreign.id ? account.generation : account.generation - 1,
          JSON.stringify({ forward: { source: { accountId: sourceAccount } } })]);
      }
      await pool.query(`INSERT INTO advertising_account_runs(owner_id,group_id,target,chat_id,account_generation,revision,scheduled_for,draft,random_id,status)
        VALUES($1,$2,$3,$4,$5,1,now(),'{}','2','sent')`, [owner, success.id, success.target, success.chat_id, account.generation]);
      await pool.query(`INSERT INTO advertising_membership_jobs(owner_id,account_id,generation,group_id,target,chat_id,action,request_key,payload_hash,restore_allowed,status)
        VALUES($1,$2,$3,$4,$5,$6,'join',$7,'TEST_ONLY',true,'joined')`,
        [owner, account.account_id, account.generation, restored.id, restored.target, restored.chat_id, randomUUID()]);
      await processAccountMembership(owner, factory);
      assert.equal(await queryGroup(bound.target), undefined);
      assert.notEqual((await queryGroup(foreign.target)).status, "removed", "another account's uncertainty must not change this account's memberships");
      assert.notEqual((await queryGroup(success.target)).status, "removed", "a newer verified success protects the group");
      assert.notEqual((await queryGroup(restored.target)).status, "removed", "explicit restoration must not be undone by old activity");
      assert.equal((await pool.query("SELECT 1 FROM advertising_membership_jobs WHERE owner_id=$1 AND group_id=$2 AND action='leave'", [owner, bound.id])).rowCount, 0);
    });
    await t.test("automatic leaves survive same-account sign-in without reviving manually stopped work", async () => {
      await clearJobs();
      const account = (await pool.query("SELECT * FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      const original = await save("@test_only_leave_reauthorized", await seed("@test_only_leave_reauthorized", 18, true));
      const manual = await save("@test_only_leave_manual_stop", await seed("@test_only_leave_manual_stop", 19, true));
      const other = await save("@test_only_leave_other_account", await seed("@test_only_leave_other_account", 20, true));
      await withAdvertisingLock(owner, async client => {
        for (const group of [original, manual, other])
          await queueGroupRemoval(owner, client, group, { ...account, generation: account.generation - 1,
            account_id: group.id === other.id ? "999999999999" : account.account_id }, "TEST_ONLY uncertain post", "uncertain");
      });
      await pool.query("UPDATE advertising_membership_jobs SET status='stopped',note='Stopped by merchant.' WHERE owner_id=$1 AND group_id=$2", [owner, manual.id]);
      await processAccountMembership(owner, factory);
      const jobs = (await pool.query("SELECT group_id,status,generation FROM advertising_membership_jobs WHERE owner_id=$1", [owner])).rows;
      assert.equal(jobs.find(row => row.group_id === original.id), undefined);
      assert.equal(await queryGroup(original.target), undefined);
      assert.equal(jobs.find(row => row.group_id === manual.id).status, "stopped");
      assert.equal(jobs.find(row => row.group_id === other.id).status, "stopped");
    });
    await t.test("uncertain membership actions and interrupted work are never replayed", async () => {
      await clearJobs(); const row = await seed("@test_only_uncertain", 7);
      joinMode = "uncertain";
      await startMembership(owner, input("@test_only_uncertain", row.chatId));
      const before = joins; await processAccountMembership(owner, factory); await processAccountMembership(owner, factory);
      assert.equal(joins, before + 1);
      assert.equal((await membershipJobs(owner))[0].status, "uncertain");
      await pool.query("UPDATE advertising_membership_jobs SET status='working',updated_at=now()-interval '61 seconds' WHERE owner_id=$1", [owner]);
      await processAccountMembership(owner, factory); assert.equal(joins, before + 1);
      assert.equal((await membershipJobs(owner))[0].status, "uncertain"); joinMode = "ok";
    });
    await t.test("join mutations require dashboard authentication and authenticated confirmation validation", async () => {
      Object.assign(process.env, { TELECART_ADMIN_EMAIL: "test-admin@example.invalid", TELECART_ADMIN_INITIAL_PASSWORD: `TEST_ONLY_${randomUUID()}` });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/advertising/membership`;
      try {
        for (const suffix of ["start", "stop", "preview"]) {
          const result = await fetch(`${url}/${suffix}`, { method: "POST", headers: { origin: "https://test-only.invalid", "content-type": "application/json" }, body: "{}" });
          assert.equal(result.status, 401);
        }
        const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
        const result = await fetch(`${url}/start`, { method: "POST", headers: { cookie, origin: "https://test-only.invalid", "content-type": "application/json" }, body: "{}" });
        assert.equal(result.status, 400);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  } finally {
    await closeAccountSession(owner);
    TelegramClient.prototype.connect = originalConnect; globalThis.fetch = originalFetch;
    await pool.end();
  }
});
