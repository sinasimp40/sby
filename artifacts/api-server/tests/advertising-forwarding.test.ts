import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { pool } from "@workspace/db";
import app from "../src/app";
import { adminCookieName, issueAdminSession } from "../src/lib/admin-auth";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { createAccountDriver, type AccountFactory } from "../src/lib/advertising-account-driver";
import { AccountError, safeAccountError } from "../src/lib/advertising-account-errors";
import { savedMessagePreview, readSavedMessages, readSavedMessage } from "../src/lib/advertising-saved-messages";
import { loadOwnerSavedMessages, startForwardLoop } from "../src/lib/advertising-forward-loop";
import { processAccountSchedules, stopSelectedAccountSchedules } from "../src/lib/advertising-account-schedules";
import { closeAccountSession } from "../src/lib/advertising-account-session";
import { queueNetworkRecovery, recoverAccountConnection } from "../src/lib/advertising-account-recovery";
import { exportShopTransfer, previewShopTransfer, importShopTransfer } from "../src/lib/shop-transfer";
import { withAdvertisingLock } from "../src/lib/advertising-store";
import { parseAdvertisingTarget } from "../src/lib/advertising-targets";
import { resumeForwardCampaign } from "../src/lib/advertising-resume";
import { readCheckpoint, resumeSummary } from "../src/lib/advertising-checkpoint-store";

const accountId = "900000009";
const saved = (id = 42, text = "TEST_ONLY original ⭐", protectedContent = false) => new Api.Message({
  id, peerId: new Api.PeerUser({ userId: bigInt(accountId) }), out: true, date: 1234567890, message: text,
  noforwards: protectedContent, entities: [new Api.MessageEntityBold({ offset: 0, length: 9 }),
    new Api.MessageEntityCustomEmoji({ offset: text.length - 1, length: 1, documentId: bigInt("123456789") })],
});
const source = () => savedMessagePreview(saved(), accountId)!;

test("group access failures are distinct from temporary waits and account-wide restrictions", () => {
  for (const code of ["USER_NOT_PARTICIPANT", "USER_KICKED", "USER_BANNED_IN_CHANNEL",
    "CHAT_WRITE_FORBIDDEN", "CHANNEL_PRIVATE", "CHAT_SEND_PHOTOS_FORBIDDEN", "CHAT_SEND_STICKERS_FORBIDDEN"]) {
    const error = safeAccountError({ errorMessage: code });
    assert.equal(error.kind, "permission");
    assert.equal(error.telegramCode, code);
  }
  assert.equal(safeAccountError({ errorMessage: "FLOOD_WAIT", seconds: 120 }).kind, "rate_limit");
  assert.equal(safeAccountError({ errorMessage: "USER_RESTRICTED" }).kind, "restricted");
  assert.equal(safeAccountError({ code: "ETIMEDOUT" }).kind, "network");
});

test("Saved Messages reads are bounded, self-only, paginated and mark protected content", async () => {
  const calls: unknown[] = [];
  const client = {
    getMe: async () => new Api.User({ id: bigInt(accountId), firstName: "TEST_ONLY" }),
    getMessages: async (peer: unknown, options: unknown) => {
      assert.ok(peer instanceof Api.InputPeerSelf); calls.push(options);
      return Array.from({ length: 31 }, (_, i) => saved(100 - i));
    },
  } as unknown as Pick<TelegramClient, "getMe" | "getMessages">;
  const page = await readSavedMessages(client, 101);
  assert.equal(page.messages.length, 30);
  assert.equal(page.nextOffsetId, 71);
  assert.deepEqual(calls[0], { limit: 31, offsetId: 101 });
  assert.equal(savedMessagePreview(saved(42, "TEST_ONLY protected", true), accountId)!.canForward, false);
  const privateChat = saved();
  privateChat.peerId = new Api.PeerUser({ userId: bigInt(999) });
  assert.equal(savedMessagePreview(privateChat, accountId), null, "other private chats must never leak through ID lookups");
  client.getMessages = (async () => [privateChat]) as typeof client.getMessages;
  await assert.rejects(readSavedMessage(client, 42), /no longer in this account/);
  assert.notEqual(savedMessagePreview(saved(42, "TEST_ONLY edited ⭐"), accountId)!.fingerprint, source().fingerprint);
});

test("the real client natively forwards one original, verifies its receipt, and never rebuilds text or media", async () => {
  const original = { getMe: TelegramClient.prototype.getMe, getMessages: TelegramClient.prototype.getMessages,
    getEntity: TelegramClient.prototype.getEntity, invoke: TelegramClient.prototype.invoke };
  const requests: unknown[] = [];
  let current = saved(), emptyReceipt = false;
  const channel = new Api.Channel({ id: bigInt(123456789), accessHash: bigInt(123), title: "TEST_ONLY", date: 0,
    photo: new Api.ChatPhotoEmpty(), megagroup: true });
  TelegramClient.prototype.getMe = async () => new Api.User({ id: bigInt(accountId), firstName: "TEST_ONLY" });
  TelegramClient.prototype.getMessages = (async (peer: unknown) => {
    assert.ok(peer instanceof Api.InputPeerSelf); return [current];
  }) as typeof TelegramClient.prototype.getMessages;
  TelegramClient.prototype.getEntity = async () => channel;
  TelegramClient.prototype.invoke = (async (request: unknown) => {
    requests.push(request);
    if (request instanceof Api.channels.GetParticipant) return { participant: new Api.ChannelParticipant({ userId: bigInt(accountId), date: 0 }) };
    if (request instanceof Api.channels.GetMessages) return { messages: [new Api.Message({
      id: 501, date: 0, out: true, peerId: new Api.PeerChannel({ channelId: channel.id }), message: current.message,
    })] };
    assert.ok(request instanceof Api.messages.ForwardMessages, "no SendMessage, SendMedia or custom-emoji recreation");
    assert.ok(request.fromPeer instanceof Api.InputPeerSelf);
    assert.deepEqual(request.id, [42]); assert.equal(request.randomId.length, 1);
    assert.equal(request.randomId[0]!.toString(), "987654321");
    assert.ok(!request.dropAuthor && !request.dropMediaCaptions, "preserve native attribution and captions");
    return emptyReceipt ? {} : new Api.Updates({ updates: [
      new Api.UpdateMessageID({ id: 501, randomId: request.randomId[0]! }),
    ], users: [], chats: [], date: 0, seq: 0 });
  }) as typeof TelegramClient.prototype.invoke;
  const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
  const snapshot = { source: source(), intervalSeconds: 60, planId: randomUUID(), order: 0 };
  try {
    await driver.inspect("@TEST_ONLY");
    assert.deepEqual(await driver.forward!("-100123456789", snapshot, "987654321"), { chatId: "-100123456789", messageId: 501 });
    assert.equal(requests.filter(r => r instanceof Api.messages.ForwardMessages).length, 1);
    current = saved(42, "TEST_ONLY changed ⭐");
    await assert.rejects(driver.forward!("-100123456789", snapshot, "987654321"), /saved message changed/);
    current = saved(42, "TEST_ONLY protected", true);
    await assert.rejects(driver.forward!("-100123456789", snapshot, "987654321"), /protects this message/);
    assert.equal(requests.filter(r => r instanceof Api.messages.ForwardMessages).length, 1);
    current = saved(); emptyReceipt = true;
    await assert.rejects(driver.forward!("-100123456789", snapshot, "987654321"),
      e => e instanceof AccountError && e.telegramCode === "POST_NOT_CONFIRMED");
    assert.equal(requests.filter(r => r instanceof Api.messages.ForwardMessages).length, 2, "never retry an uncertain forward");
  } finally { await driver.disconnect(); Object.assign(TelegramClient.prototype, original); }
});

test("a single persisted queue spaces groups and cycles, stops safely, and transfers without resuming", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `forward-test-${randomUUID()}`, destination = `${owner}-destination`;
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { TELECART_ADMIN_EMAIL: "test-admin@example.invalid", TELECART_ADMIN_INITIAL_PASSWORD: `TEST_ONLY-${randomUUID()}`,
    TELECART_OWNER_ID: owner, TELECART_PUBLIC_URL: "https://test-only.invalid", TELECART_ADMIN_ORIGIN: "https://test-only.invalid" });
  const originalFetch = globalThis.fetch, originalConnect = TelegramClient.prototype.connect;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).hostname !== "127.0.0.1") throw new Error("External calls forbidden.");
    return originalFetch(input, init);
  };
  TelegramClient.prototype.connect = async () => { throw new Error("Real Telegram connections forbidden."); };
  const groups = Array.from({ length: 3 }, (_, i) => ({ id: randomUUID(),
    target: parseAdvertisingTarget(`@TEST_ONLY_${i}`).target, chatId: `-10012345678${i}` }));
  const identity = { id: accountId, username: "TEST_ONLY", displayName: "TEST_ONLY" };
  const posts: string[] = [];
  let current = source(), mode = "ok", pageReads = 0, permissionCode = "", permissionTarget = groups[0]!.target;
  const factory: AccountFactory = () => ({
    connect: async () => {}, disconnect: async () => {}, logout: async () => {}, session: () => "TEST_ONLY_SESSION",
    me: async () => identity, sendCode: async () => "TEST_ONLY", code: async () => {}, password: async () => {},
    qr: async () => ({ authorized: true }), groups: async () => [],
    inspect: async target => {
      if (mode === "permission-inspect" && target === permissionTarget) throw { errorMessage: permissionCode };
      const group = groups.find(g => g.target === target || g.chatId === target)!;
      if (!group) throw new AccountError("TEST_ONLY missing group");
      return { chatId: group.chatId, target: group.target, title: group.target };
    },
    send: async () => { throw new Error("A saved-message loop must not send reconstructed text."); },
    savedMessages: async () => { pageReads++; return { accountId, messages: [current], nextOffsetId: null }; },
    savedMessage: async () => current,
    forward: async (chatId, snapshot) => {
      if (mode === "permission-forward" && chatId === groups[0]!.chatId) throw { errorMessage: permissionCode };
      assert.equal(snapshot.source.id, 42);
      if (mode === "uncertain") throw new AccountError("TEST_ONLY unconfirmed forward", "network", 0, "POST_NOT_CONFIRMED");
      if (mode === "flood") throw new AccountError("TEST_ONLY Telegram wait", "rate_limit", 120, "FLOOD_WAIT");
      if (mode === "changed") throw new AccountError("TEST_ONLY source changed", "validation", 0, "SAVED_MESSAGE_CHANGED");
      posts.push(chatId); return { chatId, messageId: posts.length + 100 };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/advertising`;
  const request = async (path = "", method = "GET", body?: unknown, auth = cookie) => {
    const response = await fetch(`${base}${path}`, { method, headers: { cookie: auth, origin: "https://test-only.invalid", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const input = (ids = groups.map(g => g.id)) => ({ accountId, messageId: 42, sourceFingerprint: current.fingerprint, groupIds: ids,
    expectedGroups: ids.map(id => ({ id, chatId: groups.find(g => g.id === id)?.chatId ?? "-100999999999" })), intervalSeconds: 60, groupsPerInterval: 1,
    permissionConfirmed: true, idempotencyKey: randomUUID() });
  // Advance both clocks explicitly; normal Start must never clear Telegram's clock.
  const due = () => pool.query("UPDATE advertising_accounts SET next_send_at=now()-interval '1 second',telegram_wait_until=now()-interval '1 second' WHERE owner_id=$1", [owner]);
  try {
    await pool.query(`INSERT INTO advertising_accounts(owner_id,api_id,api_hash_encrypted,session_encrypted,account_id,generation,checked_at)
      VALUES($1,12345,$2,$3,$4,1,now())`, [owner, encryptProviderSecret("a".repeat(32), owner, "advertising-account"),
      encryptProviderSecret("TEST_ONLY_SESSION", owner, "advertising-account"), accountId]);
    for (const group of groups) await pool.query(`INSERT INTO advertising_groups(id,owner_id,target,kind,title,chat_id,status,account_generation)
      VALUES($1,$2,$3,$5,$3,$4,'ready',1)`, [group.id, owner, group.target, group.chatId, parseAdvertisingTarget(group.target).kind]);
    await t.test("explicit Saved Messages loading is authenticated and read-only; workspace polls do not read Telegram", async () => {
      await loadOwnerSavedMessages(owner, {}, factory);
      assert.equal(pageReads, 1);
      assert.equal((await request("/account/saved-messages", "POST", {}, "")).status, 401);
      assert.equal((await loadOwnerSavedMessages(owner, {}, factory)).messages[0]!.id, 42);
      assert.equal(pageReads, 2);
      await request(); await request();
      assert.equal(pageReads, 2); assert.equal(posts.length, 0);
    });
    await t.test("confirmation rejects changed sources, foreign groups, bad intervals and missing permission", async () => {
      await assert.rejects(startForwardLoop(owner, { ...input(), permissionConfirmed: false }, factory), /permission/);
      await assert.rejects(startForwardLoop(owner, { ...input(), intervalSeconds: 1 }, factory));
      await assert.rejects(startForwardLoop(owner, { ...input(), sourceFingerprint: "0".repeat(64) }, factory), /saved message changed/);
      await assert.rejects(startForwardLoop(owner, input([randomUUID()]), factory));
      assert.equal((await request("/forwarding/start", "POST", input(), "")).status, 401);
      assert.equal((await request("/forwarding/start", "POST", { ...input(), intervalSeconds: 1 })).status, 400);
      assert.equal(posts.length, 0);
    });
    await t.test("start snapshots one source and ordered groups, preserves waits and deduplicates retries", async () => {
      const body = input();
      await startForwardLoop(owner, body, factory);
      const before = (await pool.query("SELECT revision FROM advertising_schedules WHERE owner_id=$1 ORDER BY group_id", [owner])).rows;
      await startForwardLoop(owner, body, factory);
      assert.deepEqual((await pool.query("SELECT revision FROM advertising_schedules WHERE owner_id=$1 ORDER BY group_id", [owner])).rows, before);
      const ws = (await request()).data;
      assert.deepEqual(ws.forwarding.groupIds, groups.map(g => g.id));
      assert.equal(ws.forwarding.source.id, 42); assert.equal(ws.forwarding.intervalSeconds, 60);
      assert.equal((await request("/draft", "PUT", { text: "Do not rebuild", imageUrl: null, buttonText: "", buttonUrl: null })).status, 410);
    });
    await t.test("the shared gap applies between every group and after the final group before repeating", async () => {
      await due(); await processAccountSchedules(owner, factory);
      assert.deepEqual(posts, [groups[0]!.chatId]);
      await processAccountSchedules(owner, factory); assert.equal(posts.length, 1, "no immediate second group");
      const wait = (await pool.query("SELECT extract(epoch FROM next_send_at-now()) AS seconds FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      assert.ok(Number(wait.seconds) > 55);
      for (const expected of [groups[1]!, groups[2]!, groups[0]!]) {
        await due(); await processAccountSchedules(owner, factory);
        assert.equal(posts.at(-1), expected.chatId);
        const count = posts.length; await processAccountSchedules(owner, factory);
        assert.equal(posts.length, count);
      }
    });
    await t.test("queue order survives client disposal and long downtime without catch-up bursts", async () => {
      await closeAccountSession(owner);
      await pool.query("UPDATE advertising_schedules SET next_send_at=next_send_at-interval '2 days' WHERE owner_id=$1", [owner]);
      await due(); const count = posts.length;
      await processAccountSchedules(owner, factory); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, count + 1); assert.equal(posts.at(-1), groups[1]!.chatId);
    });
    await t.test("stopping one group does not add old per-group waits; Stop all never auto-resumes", async () => {
      await stopSelectedAccountSchedules(owner, [groups[2]!.id]);
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1), groups[0]!.chatId);
      await stopSelectedAccountSchedules(owner); const count = posts.length;
      await due(); await processAccountSchedules(owner, factory); assert.equal(posts.length, count);
      assert.equal((await request()).data.forwarding.running, false);
    });
    await t.test("bounded recovery preserves queue order and enforces the shared wait", async () => {
      await startForwardLoop(owner, input(), factory); await due(); await processAccountSchedules(owner, factory);
      const before = (await pool.query("SELECT group_id,next_send_at FROM advertising_schedules WHERE owner_id=$1 ORDER BY next_send_at", [owner])).rows;
      await closeAccountSession(owner);
      await withAdvertisingLock(owner, client => queueNetworkRecovery(owner, client, 1, new AccountError("TEST_ONLY network drop", "network", 0, "CONNECTION_LOST")));
      await withAdvertisingLock(owner, client => recoverAccountConnection(owner, client, factory, Date.now() + 6000));
      const after = (await pool.query("SELECT group_id,next_send_at FROM advertising_schedules WHERE owner_id=$1 ORDER BY next_send_at", [owner])).rows;
      assert.deepEqual(after, before);
      const count = posts.length; await processAccountSchedules(owner, factory); assert.equal(posts.length, count);
      await due(); await processAccountSchedules(owner, factory); assert.equal(posts.at(-1), groups[1]!.chatId);
    });
    await t.test("confirmed restart clears the old campaign interval, but replaying Start does not reset it", async () => {
      mode = "ok";
      await startForwardLoop(owner, input(), factory);
      const before = posts.length;
      await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 1, "a fresh confirmed start is immediately due");
      await stopSelectedAccountSchedules(owner);
      const confirmation = input();
      await startForwardLoop(owner, confirmation, factory);
      await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 2, "Stop then Start must not inherit the prior interval");
      await startForwardLoop(owner, confirmation, factory);
      await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 2, "a retried HTTP request must not create an immediate duplicate");
    });
    await t.test("group batch sizes are bounded and included in start deduplication", async () => {
      for (const groupsPerInterval of [0, 501, -1, 1.5]) {
        await assert.rejects(startForwardLoop(owner, { ...input(), groupsPerInterval }, factory));
        assert.equal((await request("/forwarding/start", "POST", { ...input(), groupsPerInterval })).status, 400);
      }
      const { groupsPerInterval: _removed, ...legacy } = input();
      assert.equal((await request("/forwarding/start", "POST", { ...legacy, messagesPerGroup: 2 })).status, 400,
        "an outdated repeat-copy form must refresh instead of silently starting a different campaign");
      const confirmation = { ...input(), groupsPerInterval: 2 };
      await startForwardLoop(owner, confirmation, factory);
      await assert.rejects(startForwardLoop(owner, { ...confirmation, groupsPerInterval: 3 }, factory), /different selection/);
    });
    await t.test("two groups per interval sends once each and waits after full and final partial batches", async () => {
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 2 }, factory);
      const before = posts.length;
      for (let i = 0; i < 7; i++) {
        await due(); await processAccountSchedules(owner, factory);
        const status = (await request()).data.forwarding;
        assert.equal(status.groupsPerInterval, 2);
        assert.equal(status.groupsSentInInterval, i % 3 === 0 ? 1 : 0);
        const wait = new Date(status.nextSendAt).getTime() - Date.now();
        if (i % 3 === 0) assert.ok(wait > 0 && wait <= 4000, "groups in the same batch use a short pause");
        else assert.ok(wait >= 59000, "full and final partial batches wait the whole shared interval");
        const count = posts.length;
        await processAccountSchedules(owner, factory);
        assert.equal(posts.length, count, "a second worker check cannot skip the pause");
        if (i === 0) await closeAccountSession(owner); // Progress survives client disposal/recreation.
      }
      assert.deepEqual(posts.slice(before), [groups[0]!.chatId, groups[1]!.chatId, groups[2]!.chatId,
        groups[0]!.chatId, groups[1]!.chatId, groups[2]!.chatId, groups[0]!.chatId]);
      const runs = (await pool.query(`SELECT random_id FROM advertising_account_runs WHERE owner_id=$1 AND
        draft->'forward'->>'planId'=$2 AND status='sent'`, [owner,
        (await pool.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [owner])).rows[0].draft.forward.planId])).rows;
      assert.equal(runs.length, 7);
      assert.equal(new Set(runs.map(run => run.random_id)).size, 7, "each group visit has a distinct deduplication identity");
      await stopSelectedAccountSchedules(owner);
      const stopped = posts.length;
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, stopped, "stopping midway prevents the remaining group sends");
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 2 }, factory);
      assert.equal((await request()).data.forwarding.groupsSentInInterval, 0, "a confirmed restart begins a fresh batch");
    });
    await t.test("a batch larger than the selection never fills itself by repeating groups", async () => {
      await startForwardLoop(owner, { ...input([groups[0]!.id, groups[1]!.id]), groupsPerInterval: 500 }, factory);
      const before = posts.length;
      for (let i = 0; i < 2; i++) { await due(); await processAccountSchedules(owner, factory); }
      assert.deepEqual(posts.slice(before), [groups[0]!.chatId, groups[1]!.chatId]);
      const status = (await request()).data.forwarding;
      assert.equal(status.nextGroupId, groups[0]!.id);
      assert.equal(status.groupsSentInInterval, 0);
      assert.ok(new Date(status.nextSendAt).getTime() - Date.now() >= 59000);
      await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 2, "the next cycle must wait");
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1), groups[0]!.chatId);
    });
    await t.test("losing the final group still ends a partial batch before any group can repeat", async () => {
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 5 }, factory);
      const before = posts.length;
      await due(); await processAccountSchedules(owner, factory);
      await due(); await processAccountSchedules(owner, factory);
      permissionTarget = groups[2]!.target; permissionCode = "CHAT_WRITE_FORBIDDEN"; mode = "permission-inspect";
      await due(); await processAccountSchedules(owner, factory);
      assert.deepEqual(posts.slice(before), [groups[0]!.chatId, groups[1]!.chatId]);
      mode = "ok";
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 2, "wrapping the queue must not refill the batch using group A again");
      const status = (await request()).data.forwarding;
      assert.equal(status.groupsSentInInterval, 0);
      assert.ok(new Date(status.nextSendAt).getTime() - Date.now() >= 59000);
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1), groups[0]!.chatId);
      permissionTarget = groups[0]!.target; permissionCode = "";
      await pool.query("UPDATE advertising_groups SET enabled=true,status='ready',account_generation=1 WHERE owner_id=$1", [owner]);
    });
    await t.test("permission failures disable only the affected group and skip it on following cycles", async () => {
      for (const [code, stage] of [
        ["USER_NOT_PARTICIPANT", "permission-inspect"], ["USER_KICKED", "permission-inspect"],
        ["USER_BANNED_IN_CHANNEL", "permission-inspect"], ["CHAT_WRITE_FORBIDDEN", "permission-inspect"],
        ["CHAT_SEND_MEDIA_FORBIDDEN", "permission-inspect"], ["CHAT_ADMIN_REQUIRED", "permission-inspect"],
        ["CHANNEL_PRIVATE", "permission-inspect"], ["CHAT_WRITE_FORBIDDEN", "permission-forward"],
      ]) {
        await pool.query("UPDATE advertising_groups SET enabled=true,status='ready',account_generation=1 WHERE owner_id=$1", [owner]);
        await startForwardLoop(owner, input([groups[0]!.id, groups[1]!.id]), factory);
        await due(); mode = stage!; permissionCode = code!;
        const before = posts.length;
        await processAccountSchedules(owner, factory);
        assert.equal(posts.length, before);
        const bad = (await pool.query("SELECT enabled,status,note FROM advertising_groups WHERE id=$1", [groups[0]!.id])).rows[0];
        assert.equal(bad.enabled, false, code);
        assert.equal(bad.status, "removed");
        assert.match(bad.note, /Removed after definite failure/);
        assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [groups[0]!.id])).rows[0].running, false);
        await due(); await processAccountSchedules(owner, factory);
        await due(); await processAccountSchedules(owner, factory);
        assert.equal(posts.length, before + 2, "the remaining group must continue through later loops");
        assert.deepEqual(posts.slice(before), [groups[1]!.chatId, groups[1]!.chatId]);
      }
      mode = "ok"; permissionCode = "";
      await pool.query("UPDATE advertising_groups SET enabled=true,status='ready',account_generation=1 WHERE owner_id=$1", [owner]);
    });
    await t.test("Telegram flood waits survive Stop/Start and uncertain forwards are not replayed", async () => {
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 2 }, factory);
      await due(); await processAccountSchedules(owner, factory);
      await due(); mode = "flood";
      const count = posts.length; await processAccountSchedules(owner, factory);
      assert.equal(posts.length, count);
      assert.equal((await request()).data.forwarding.nextGroupId, groups[1]!.id);
      const wait = (await pool.query("SELECT telegram_wait_until FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0].telegram_wait_until;
      await stopSelectedAccountSchedules(owner);
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 2 }, factory);
      const retained = (await pool.query("SELECT next_send_at FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0].next_send_at;
      assert.ok(new Date(retained).getTime() >= new Date(wait).getTime());
      mode = "ok"; await processAccountSchedules(owner, factory); assert.equal(posts.length, count);
      await due(); await processAccountSchedules(owner, factory); assert.equal(posts.at(-1), groups[0]!.chatId);
      await due(); mode = "uncertain"; await processAccountSchedules(owner, factory);
      mode = "ok"; const after = posts.length; await processAccountSchedules(owner, factory); assert.equal(posts.length, after);
      const stopped = (await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [groups[1]!.id])).rows[0];
      assert.equal(stopped.running, false);
      assert.equal((await pool.query("SELECT groups_sent_in_interval FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0].groups_sent_in_interval, 1,
        "an uncertain send to the second group never advances batch progress or gets replayed");
      assert.equal((await pool.query("SELECT status,enabled FROM advertising_groups WHERE id=$1", [groups[1]!.id])).rows[0].status, "removed");
      assert.equal((await pool.query("SELECT count(*)::int n FROM advertising_membership_jobs WHERE owner_id=$1 AND group_id=$2 AND action='leave'", [owner, groups[1]!.id])).rows[0].n, 1,
        "uncertain post queues one leave, never a second post");
    });
    await t.test("changed or missing source stops the whole loop instead of forwarding different content", async () => {
      assert.equal((await request()).data.account.connected, true,
        "an unconfirmed delivery alone must not log out a healthy account");
      // Model an explicitly reviewed, freshly authorized synthetic connection.
      await closeAccountSession(owner);
      await pool.query("UPDATE advertising_accounts SET last_error=NULL,generation=generation+1,checked_at=now() WHERE owner_id=$1", [owner]);
      await pool.query(`UPDATE advertising_groups SET account_generation=(SELECT generation FROM advertising_accounts WHERE owner_id=$1)
        WHERE owner_id=$1`, [owner]);
      // Reset a synthetic removed fixture for this independent source-change test.
      await pool.query("UPDATE advertising_groups SET status='ready',enabled=true WHERE owner_id=$1", [owner]);
      await startForwardLoop(owner, input(), factory); await due(); mode = "changed";
      await processAccountSchedules(owner, factory); mode = "ok";
      assert.equal((await request()).data.forwarding.running, false);
    });
    await t.test("Resume preserves queue position, partial batches and Telegram waits without duplicate requests", async () => {
      await pool.query(`UPDATE advertising_groups SET enabled=true,status='ready',account_generation=(SELECT generation FROM advertising_accounts WHERE owner_id=$1) WHERE owner_id=$1`, [owner]);
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 3 }, factory);
      const before = posts.length;
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1), groups[0]!.chatId);
      await stopSelectedAccountSchedules(owner);
      const checkpoint = await readCheckpoint(owner);
      assert.equal(checkpoint!.data.groupsSentInInterval, 1);
      const summary = await resumeSummary(owner);
      assert.equal(summary.nextGroupId, groups[1]!.id);
      assert.equal(summary.available, true);
      const command = { planId: summary.planId!, revision: summary.revision, accountId, confirmed: true, idempotencyKey: randomUUID() };
      await assert.rejects(resumeForwardCampaign(owner, { ...command, confirmed: false }, factory), /Confirm/);
      await assert.rejects(resumeForwardCampaign(owner, { ...command, revision: command.revision + 1 }, factory), /progress changed/);
      await pool.query("UPDATE advertising_accounts SET telegram_wait_until=now()+interval '120 seconds' WHERE owner_id=$1", [owner]);
      await resumeForwardCampaign(owner, command, factory);
      const revision = (await readCheckpoint(owner))!.revision;
      assert.match((await resumeSummary(owner)).reason, /already running/);
      await resumeForwardCampaign(owner, command, factory);
      assert.equal((await readCheckpoint(owner))!.revision, revision, "replaying Resume does not reset priorities or waits");
      await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 1, "Telegram-required wait still prevents posting");
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1), groups[1]!.chatId, "B resumes next, not A");
      assert.equal((await readCheckpoint(owner))!.data.groupsSentInInterval, 2);
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.at(-1), groups[2]!.chatId);
      assert.equal((await readCheckpoint(owner))!.data.groupsSentInInterval, 0);
      assert.deepEqual(posts.slice(before), groups.map(group => group.chatId));
    });
    await t.test("UNCERTAIN groups are removed and remain excluded across Resume and history pruning without logging out", async () => {
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 3 }, factory);
      await due(); await processAccountSchedules(owner, factory);
      await due(); mode = "uncertain"; await processAccountSchedules(owner, factory); mode = "ok";
      assert.equal((await request()).data.account.connected, true);
      assert.ok((await readCheckpoint(owner))!.data.queue.find(entry => entry.groupId === groups[1]!.id)?.held);
      await stopSelectedAccountSchedules(owner);
      await pool.query("DELETE FROM advertising_account_runs WHERE owner_id=$1", [owner]);
      const summary = await resumeSummary(owner);
      assert.deepEqual(summary.heldGroupIds, [groups[1]!.id]);
      assert.equal(summary.nextGroupId, groups[2]!.id);
      const before = posts.length;
      await resumeForwardCampaign(owner, { planId: summary.planId!, revision: summary.revision, accountId, confirmed: true, idempotencyKey: randomUUID() }, factory);
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [groups[1]!.id])).rows[0].running, false);
      await due(); await processAccountSchedules(owner, factory);
      assert.deepEqual(posts.slice(before), [groups[2]!.chatId]);
      assert.equal((await readCheckpoint(owner))!.data.groupsSentInInterval, 0, "a held final destination must not refill a partial batch");
      assert.equal((await pool.query("SELECT status FROM advertising_groups WHERE id=$1", [groups[1]!.id])).rows[0].status, "removed");
      assert.equal((await request()).data.groups.some((group: { id: string }) => group.id === groups[1]!.id), false, "removed group disappears from the dashboard list");
    });
    await t.test("same-account sign-in can Resume, but a different account or changed source cannot", async () => {
      await stopSelectedAccountSchedules(owner);
      const original = await resumeSummary(owner);
      const before = posts.length;
      await pool.query("UPDATE advertising_accounts SET account_id='999999999' WHERE owner_id=$1", [owner]);
      await assert.rejects(resumeForwardCampaign(owner, { planId: original.planId!, revision: original.revision, accountId, confirmed: true, idempotencyKey: randomUUID() }, factory), /original Telegram account/);
      await closeAccountSession(owner);
      await pool.query("UPDATE advertising_accounts SET account_id=$2,generation=generation+1,last_error=NULL,checked_at=now() WHERE owner_id=$1", [owner, accountId]);
      await pool.query("UPDATE advertising_groups SET status='pending',account_generation=NULL WHERE owner_id=$1", [owner]);
      const summary = await resumeSummary(owner);
      const savedSource = current;
      current = savedMessagePreview(saved(42, "TEST_ONLY changed after pause"), accountId)!;
      await assert.rejects(resumeForwardCampaign(owner, { planId: summary.planId!, revision: summary.revision, accountId, confirmed: true, idempotencyKey: randomUUID() }, factory), /original Saved Message changed/);
      current = savedSource;
      await resumeForwardCampaign(owner, { planId: summary.planId!, revision: summary.revision, accountId, confirmed: true, idempotencyKey: randomUUID() }, factory);
      await due(); await processAccountSchedules(owner, factory);
      assert.equal(posts.length, before + 1);
      const next = groups.find(group => group.id === summary.nextGroupId)!;
      assert.equal(posts.at(-1), next.chatId);
      const state = (await pool.query("SELECT status,account_generation FROM advertising_groups WHERE id=$1", [next.id])).rows[0];
      const account = (await pool.query("SELECT generation FROM advertising_accounts WHERE owner_id=$1", [owner])).rows[0];
      assert.equal(state.status, "ready"); assert.equal(state.account_generation, account.generation);
      assert.equal((await pool.query("SELECT running FROM advertising_schedules WHERE group_id=$1", [groups[1]!.id])).rows[0].running, false);
      await stopSelectedAccountSchedules(owner);
      const paused = await resumeSummary(owner);
      await pool.query("UPDATE advertising_groups SET enabled=false WHERE owner_id=$1 AND id=ANY($2::uuid[])", [owner, paused.groupIds]);
      assert.equal((await resumeSummary(owner)).available, false, "disabled groups never resume");
      await pool.query(`UPDATE advertising_groups SET enabled=true,status='ready',account_generation=(SELECT generation FROM advertising_accounts WHERE owner_id=$1) WHERE owner_id=$1`, [owner]);
    });
    await t.test("Resume endpoint is authenticated and rejects unconfirmed or stale requests", async () => {
      assert.equal((await request("/forwarding/resume", "POST", {}, "")).status, 401);
      assert.equal((await request("/forwarding/resume", "POST", {})).status, 400);
    });
    await t.test("portable ZIPs preserve the selected source and shared interval but never resume jobs or export account keys", async () => {
      const photo = saved(42, "   ");
      photo.entities = [];
      photo.media = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(123) }) });
      current = savedMessagePreview(photo, accountId)!;
      await startForwardLoop(owner, { ...input(), groupsPerInterval: 3 }, factory);
      await due(); await processAccountSchedules(owner, factory);
      const exported = await exportShopTransfer(owner);
      const preview = await previewShopTransfer(destination, exported.zip);
      assert.equal(preview.canImport, true);
      await importShopTransfer(destination, exported.zip, preview.confirmationToken);
      const master = (await pool.query("SELECT draft FROM advertising_bots WHERE owner_id=$1", [destination])).rows[0].draft;
      assert.equal(master.forward.source.id, 42); assert.equal(master.forward.intervalSeconds, 60);
      assert.equal(master.forward.groupsPerInterval, 3);
      assert.equal(master.forward.source.mediaKind, "photo");
      assert.equal(master.forward.source.text, "   ", "caption-less media keeps its original source, not reconstructed placeholder text");
      assert.equal((await pool.query("SELECT count(*)::int n FROM advertising_schedules WHERE owner_id=$1 AND running", [destination])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int n FROM advertising_accounts WHERE owner_id=$1", [destination])).rows[0].n, 0);
      assert.equal((await resumeSummary(destination)).available, false);
      assert.equal(await readCheckpoint(destination), null, "portable import does not transfer executable resume checkpoints");
      assert.equal((await pool.query("SELECT max(batch_sent_count) n FROM advertising_schedules WHERE owner_id=$1", [destination])).rows[0].n, 0,
        "portable import preserves the configured count, never resumes live batch progress");
    });
  } finally {
    await closeAccountSession(owner).catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const table of ["advertising_account_runs", "advertising_account_commands", "advertising_schedules", "advertising_accounts",
      "advertising_deliveries", "advertising_campaigns", "advertising_groups", "advertising_bots", "shop_activity", "shop_settings", "bot_runtime_settings", "provider_credentials"])
      await pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [[owner, destination]]);
    await pool.query("DELETE FROM admin_sessions WHERE owner_id=$1", [owner]);
    globalThis.fetch = originalFetch; TelegramClient.prototype.connect = originalConnect;
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    await pool.end();
  }
});
