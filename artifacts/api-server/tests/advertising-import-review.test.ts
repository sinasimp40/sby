import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "telegram";
import { pool } from "@workspace/db";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { addAdvertisingTargets } from "../src/lib/advertising-management";
import { reviewAdvertisingRows, advertisingPreviewRows } from "../src/lib/advertising-import-review";
import { withAdvertisingLock } from "../src/lib/advertising-store";
import { AccountError, type AccountFactory } from "../src/lib/advertising-account-driver";
import { closeAccountSession } from "../src/lib/advertising-account-session";

test("duplicate identity checks happen before insertion, repeat at commit and never join or send", async t => {
  const owner = process.env.TELECART_OWNER_ID!;
  const accountId = "900000009";
  const seal = (text: string) => encryptProviderSecret(text, owner, "advertising-account");
  const identities = new Map<string, string | null>([
    ["@test_only_saved", "-10011111"], ["@test_only_alias", "-10011111"],
    ["@test_only_new", "-10022222"], ["@test_only_second_alias", "-10022222"],
    ["@test_only_foreign", "-10033333"], ["@test_only_fail", null], ["@test_only_network", "-10044444"],
    ["@test_only_unpinned", "-10055555"],
  ]);
  let reads = 0;
  const realConnect = TelegramClient.prototype.connect;
  TelegramClient.prototype.connect = async () => { throw new Error("Real Telegram is forbidden."); };
  const factory: AccountFactory = () => ({
    connect: async () => {}, disconnect: async () => {}, logout: async () => {}, session: () => "TEST_ONLY_SESSION",
    me: async () => ({ id: accountId, username: "TEST_ONLY", displayName: "TEST_ONLY" }),
    sendCode: async () => "", code: async () => {}, password: async () => {}, qr: async () => ({ authorized: true }),
    groups: async () => [], inspect: async () => { throw new Error("Posting permission checks are separate."); },
    membership: async target => {
      reads++;
      if (target === "@test_only_network") throw new AccountError("TEST_ONLY network failure", "network");
      return { chatId: identities.has(target) ? identities.get(target)! : target, title: "TEST_ONLY", joined: true, approval: false };
    },
    join: async () => { throw new Error("Joining is forbidden."); }, leave: async () => { throw new Error("Leaving is forbidden."); },
    send: async () => { throw new Error("Sending is forbidden."); },
  });
  const review = (text: string) => withAdvertisingLock(owner, client =>
    reviewAdvertisingRows(owner, client, advertisingPreviewRows(text), factory));
  const all = () => pool.query("SELECT * FROM advertising_groups WHERE owner_id=$1", [owner]);
  try {
    await pool.query(`INSERT INTO advertising_accounts(owner_id,account_id,generation,api_id,api_hash_encrypted,session_encrypted,checked_at)
      VALUES($1,$2,1,12345,$3,$4,now())`, [owner, accountId, seal("a".repeat(32)), seal("TEST_ONLY_SESSION")]);
    await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,chat_id,status) VALUES($1,'@test_only_saved','public','-10011111','ready')`, [owner]);
    await t.test("same normalized target, numeric alias and public alias are skipped without new rows", async () => {
      const result = await review("https://t.me/test_only_saved\n-10011111\n@test_only_alias\n@TEST_ONLY_ALIAS");
      assert.deepEqual(result.rows.map(row => row.status), ["duplicate", "duplicate", "duplicate", "duplicate"]);
      assert.equal((await all()).rowCount, 1, "review cannot insert placeholders");
      const counts = await addAdvertisingTargets(owner, result.rows.map(row => row.target!), true, factory);
      assert.deepEqual(counts, { addedCount: 0, duplicateCount: 4 });
      assert.equal((await all()).rowCount, 1, "direct add cannot bypass identity rejection");
    });
    await t.test("two new aliases in the same batch create only one pending destination", async () => {
      const text = "@test_only_new\n@test_only_second_alias";
      const result = await review(text);
      assert.deepEqual(result.rows.map(row => row.status), ["new", "duplicate"]);
      assert.equal((await all()).rowCount, 1);
      assert.deepEqual(await addAdvertisingTargets(owner, result.rows.map(row => row.target!), true, factory),
        { addedCount: 1, duplicateCount: 1 });
      const rows = (await all()).rows;
      assert.equal(rows.length, 2);
      const added = rows.find(row => row.target === "@test_only_new")!;
      assert.equal(added.chat_id, "-10022222");
      assert.equal(added.status, "pending", "identity verification does not grant posting rights");
      assert.equal(rows.some(row => row.target === "@test_only_second_alias"), false);
      assert.equal((await pool.query("SELECT 1 FROM advertising_schedules")).rowCount, 0);
    });
    await t.test("existing public records lacking a numeric ID cannot be bypassed by another alias", async () => {
      await pool.query("INSERT INTO advertising_groups(owner_id,target,kind,status) VALUES($1,'@test_only_unpinned','public','pending')", [owner]);
      assert.equal((await review("-10055555")).rows[0].status, "duplicate");
      const before = (await all()).rowCount;
      await addAdvertisingTargets(owner, ["-10055555"], true, factory);
      assert.equal((await all()).rowCount, before);
    });
    await t.test("another owner's saved group is not considered this owner's duplicate", async () => {
      await pool.query(`INSERT INTO advertising_groups(owner_id,target,kind,chat_id,status)
        VALUES('TEST_ONLY_OTHER','@test_only_foreign','public','-10033333','ready')`);
      assert.equal((await review("@test_only_foreign")).rows[0].status, "new");
      await addAdvertisingTargets(owner, ["@test_only_foreign"], true, factory);
      assert.equal((await pool.query("SELECT 1 FROM advertising_groups WHERE chat_id='-10033333'")).rowCount, 2);
    });
    await t.test("unverifiable identities are rejected atomically, and waits perform no identity RPCs", async () => {
      const before = (await all()).rowCount;
      assert.equal((await review("@test_only_fail")).rows[0].status, "invalid");
      await assert.rejects(addAdvertisingTargets(owner, ["@test_only_fail", "-10066666"], true, factory), /identity/);
      assert.equal((await all()).rowCount, before);
      await pool.query("UPDATE advertising_accounts SET telegram_wait_until=now()+interval '60 seconds' WHERE owner_id=$1", [owner]);
      const readsBefore = reads;
      await assert.rejects(review("-10066666"), /wait/);
      assert.equal(reads, readsBefore);
      await pool.query("UPDATE advertising_accounts SET telegram_wait_until=now()-interval '1 second' WHERE owner_id=$1", [owner]);
      await assert.rejects(addAdvertisingTargets(owner, ["@test_only_network", "-10066666"], true, factory), /network/);
      assert.equal((await all()).rowCount, before);
    });
  } finally {
    await closeAccountSession(owner);
    TelegramClient.prototype.connect = realConnect;
    await pool.end();
  }
});
