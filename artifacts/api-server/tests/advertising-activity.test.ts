import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { advertisingActivity, advertisingActivityPage, pruneAdvertisingActivity } from "../src/lib/advertising-activity";

test("activity has bounded pages, stable cursors, date/owner isolation and safe five-day retention", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `activity-test-${randomUUID()}`, other = `${owner}-other`;
  const group = randomUUID();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86400000);
  const old = new Date(now.getTime() - 6 * 86400000);
  const insert = async (who: string, at: Date, status = "sent", revision = 0, scheduledFor = at) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO advertising_account_runs(id,owner_id,group_id,target,chat_id,account_generation,
      revision,scheduled_for,started_at,draft,random_id,status)
      VALUES($1,$2,$3,'TEST_ONLY','-100123456789',1,$4,$5,$6,'{}',$7,$8)`,
    [id, who, group, revision, scheduledFor, at, id, status]);
    return id;
  };
  try {
    const dailyIds: string[] = [];
    for (let i = 0; i < 15; i++) dailyIds.push(await insert(owner, new Date(yesterday.getTime() + i * 60000)));
    const boundary = await insert(owner, today);
    const overnight = await insert(owner, new Date(today.getTime() - 1000));
    await pool.query("UPDATE advertising_account_runs SET sent_at=$2 WHERE id=$1",
      [overnight, new Date(today.getTime() + 1000)]);
    const expired = await insert(owner, old);
    const foreign = await insert(other, old);
    const sending = await insert(owner, old, "sending", 90);
    const protectedOccurrence = await insert(owner, old, "sent", 91);
    await pool.query(`INSERT INTO advertising_schedules(group_id,owner_id,revision,next_send_at,running)
      VALUES($1,$2,91,$3,true)`, [group, owner, old]);

    const latest = await advertisingActivity(owner);
    assert.equal(latest.length, 10);
    assert.equal(latest[0]!.id, overnight);
    assert.ok(latest.every((r, i) => i === 0 || (r.sentAt ?? r.startedAt) <= (latest[i - 1]!.sentAt ?? latest[i - 1]!.startedAt)));
    assert.ok(!latest.some(r => [expired, foreign, sending, protectedOccurrence].includes(r.id)));
    const filtered = await advertisingActivity(owner, yesterday, today);
    assert.equal(filtered.length, 10);
    assert.ok(filtered.every(r => r.startedAt >= yesterday.toISOString() && r.startedAt < today.toISOString()));
    assert.ok(!filtered.some(r => r.id === boundary), "next midnight is exclusive");
    assert.ok(!filtered.some(r => r.id === overnight), "date filters match the displayed sent date");
    assert.ok((await advertisingActivity(owner, today, new Date(today.getTime() + 86400000))).some(r => r.id === overnight));
    assert.deepEqual(await advertisingActivity(owner, old, new Date(old.getTime() + 86400000)), []);
    await assert.rejects(advertisingActivity(owner, yesterday), /calendar date/);
    await assert.rejects(advertisingActivity(owner, today, yesterday), /calendar date/);
    await assert.rejects(advertisingActivity(owner, old, today), /calendar date/);
    assert.equal((await advertisingActivity(other)).length, 0);

    const first = await advertisingActivityPage(owner, yesterday, today);
    assert.equal(first.items.length, 10);
    assert.ok(first.nextCursor);
    const second = await advertisingActivityPage(owner, yesterday, today, first.nextCursor!);
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(new Set([...first.items, ...second.items].map(r => r.id)), new Set(dailyIds));
    await assert.rejects(advertisingActivityPage(other, yesterday, today, first.nextCursor!), /cursor/);
    await assert.rejects(advertisingActivityPage(owner, today, new Date(today.getTime() + 86400000), first.nextCursor!), /cursor/);
    await assert.rejects(advertisingActivityPage(owner, yesterday, today, "not-a-valid-cursor"), /cursor/);
    await assert.rejects(advertisingActivityPage(owner, yesterday, today, "a".repeat(513)), /cursor/);
    const invalidCalendar = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
    invalidCalendar.at = "2026-02-31T12:00:00.000000Z";
    await assert.rejects(advertisingActivityPage(owner, yesterday, today,
      Buffer.from(JSON.stringify(invalidCalendar)).toString("base64url")), /cursor/);

    const ties: string[] = [], micros: string[] = [];
    const tieAt = new Date(yesterday.getTime() + 10 * 3600000);
    const microAt = new Date(yesterday.getTime() + 12 * 3600000);
    for (let i = 0; i < 13; i++) {
      const tied = await insert(owner, tieAt, "sent", 100 + i);
      const micro = await insert(owner, microAt, "sent", 200 + i);
      await pool.query("UPDATE advertising_account_runs SET started_at=$2::timestamptz+$3*interval '1 microsecond' WHERE id=$1", [micro, microAt, i]);
      ties.push(tied); micros.push(micro);
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await advertisingActivityPage(owner, yesterday, today, cursor);
      assert.ok(page.items.length <= 10);
      collected.push(...page.items.map(r => r.id));
      cursor = page.nextCursor ?? undefined;
      assert.ok(++pages < 10, "pagination must reach the end");
    } while (cursor);
    assert.deepEqual(collected, [...micros.reverse(), ...ties.sort().reverse(), ...dailyIds.reverse()],
      "equal timestamps and PostgreSQL microseconds must not skip or duplicate records");
    assert.equal(new Set(collected).size, 41);
    const snapshot = await advertisingActivityPage(owner, yesterday, today);
    const newPost = await insert(owner, new Date(today.getTime() - 1), "sent", 300);
    const continuation = await advertisingActivityPage(owner, yesterday, today, snapshot.nextCursor!);
    assert.ok(!continuation.items.some(r => r.id === newPost), "newer insertions cannot shift an existing cursor");
    assert.equal((await advertisingActivityPage(owner, yesterday, today)).items[0]!.id, newPost);

    assert.equal(await pruneAdvertisingActivity(owner), 1);
    const retained = (await pool.query("SELECT id FROM advertising_account_runs WHERE id=ANY($1::uuid[])",
      [[expired, foreign, sending, protectedOccurrence]])).rows.map(r => r.id);
    assert.ok(!retained.includes(expired), "old posting logs are physically deleted");
    assert.ok(retained.includes(foreign), "another owner's logs are untouched");
    assert.ok(retained.includes(sending), "unconfirmed in-flight posts cannot lose their evidence");
    assert.ok(retained.includes(protectedOccurrence), "current occurrence receipts prevent replay after downtime");

    await pool.query("UPDATE advertising_schedules SET revision=92 WHERE group_id=$1", [group]);
    assert.equal(await pruneAdvertisingActivity(owner), 1, "reconciled occurrence receipts can expire normally");
    assert.equal((await advertisingActivity(owner)).length, 10);
  } finally {
    await pool.query("DELETE FROM advertising_account_runs WHERE owner_id=ANY($1::text[])", [[owner, other]]);
    await pool.query("DELETE FROM advertising_schedules WHERE owner_id=$1", [owner]);
    await pool.end();
  }
});
