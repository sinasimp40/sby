import assert from "node:assert/strict";
import test from "node:test";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { confirmAccountPost } from "../src/lib/advertising-account-receipt";
import { AccountError } from "../src/lib/advertising-account-errors";
import { createAccountDriver } from "../src/lib/advertising-account-driver";

const channel = new Api.Channel({ id: bigInt(123), accessHash: bigInt(456), title: "TEST_ONLY", photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true });
const chat = new Api.Chat({ id: bigInt(321), title: "TEST_ONLY", photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 0, version: 1 });
const randomId = bigInt("987654321");
const sent = (id = 42) => new Api.UpdateShortSentMessage({ id, pts: 1, ptsCount: 1, date: 0, out: true });
const message = (peerId: Api.TypePeer = new Api.PeerChannel({ channelId: channel.id }), id = 42) =>
  new Api.Message({ id, peerId, date: 0, message: "TEST_ONLY", out: true });
const updates = (mapping: Api.UpdateMessageID[]) => new Api.Updates({ updates: mapping, users: [], chats: [], date: 0, seq: 0 });
const unconfirmed = (error: unknown) => error instanceof AccountError && error.telegramCode === "POST_NOT_CONFIRMED" && error.kind === "network";
function reader(messages: Api.TypeMessage[], requests: unknown[] = []) {
  return { invoke: async (request: unknown) => { requests.push(request); return new Api.messages.Messages({ messages, chats: [], users: [] }); } } as unknown as Pick<TelegramClient, "invoke">;
}

test("short acknowledgements require an exact channel message read-back", async () => {
  const requests: unknown[] = [];
  assert.deepEqual(await confirmAccountPost(reader([message()], requests), channel, randomId, sent()), { chatId: "-100123", messageId: 42 });
  assert.equal(requests.length, 1);
  assert.ok(requests[0] instanceof Api.channels.GetMessages);
  assert.equal(requests[0].channel, channel);
  assert.equal((requests[0].id[0] as Api.InputMessageID).id, 42);
});

test("basic groups use their own message lookup and validate peer identity", async () => {
  const requests: unknown[] = [];
  assert.deepEqual(await confirmAccountPost(reader([message(new Api.PeerChat({ chatId: chat.id }))], requests), chat, randomId, sent()), { chatId: "-321", messageId: 42 });
  assert.ok(requests[0] instanceof Api.messages.GetMessages);
});

test("media/combined receipts match the request random ID, not unrelated updates", async () => {
  const mappings = [
    new Api.UpdateMessageID({ randomId: bigInt(111), id: 7 }),
    new Api.UpdateMessageID({ randomId, id: 42 }),
  ];
  const result = new Api.UpdatesCombined({ updates: mappings, users: [], chats: [], date: 0, seq: 1, seqStart: 1 });
  assert.equal((await confirmAccountPost(reader([message()]), channel, randomId, result)).messageId, 42);
});

test("empty, too-long, uncorrelated and conflicting acknowledgements never count as sent", async () => {
  for (const result of [
    {} as Api.TypeUpdates,
    new Api.UpdatesTooLong(),
    updates([]),
    updates([new Api.UpdateMessageID({ randomId: bigInt(222), id: 42 })]),
    updates([new Api.UpdateMessageID({ randomId, id: 42 }), new Api.UpdateMessageID({ randomId, id: 43 })]),
    sent(0),
  ]) {
    const requests: unknown[] = [];
    await assert.rejects(confirmAccountPost(reader([message()], requests), channel, randomId, result), unconfirmed);
    assert.equal(requests.length, 0, "no read or second send can substitute for a missing receipt");
  }
});

test("missing, removed, wrong-ID and wrong-group messages cannot produce success", async () => {
  for (const messages of [
    [],
    [new Api.MessageEmpty({ id: 42 })],
    [message(undefined, 43)],
    [message(new Api.PeerChannel({ channelId: bigInt(999) }))],
  ]) {
    const requests: unknown[] = [];
    await assert.rejects(confirmAccountPost(reader(messages, requests), channel, randomId, sent()), unconfirmed);
    assert.equal(requests.length, 1);
  }
});

test("a failed read-back is never retried or replaced with another send", async () => {
  let requests = 0;
  const client = { invoke: async () => { requests++; throw { errorMessage: "SESSION_REVOKED" }; } } as unknown as Pick<TelegramClient, "invoke">;
  await assert.rejects(confirmAccountPost(client, channel, randomId, sent()), error => (error as { errorMessage: string }).errorMessage === "SESSION_REVOKED");
  assert.equal(requests, 1);
});

test("the real driver verifies text, photo and GIF sends, and rejects an empty RPC result", async () => {
  const original = { getEntity: TelegramClient.prototype.getEntity, invoke: TelegramClient.prototype.invoke };
  const requests: unknown[] = [];
  let emptyAck = false;
  TelegramClient.prototype.getEntity = async () => channel;
  TelegramClient.prototype.invoke = (async (request: unknown) => {
    requests.push(request);
    if (request instanceof Api.channels.GetParticipant)
      return { participant: new Api.ChannelParticipant({ userId: bigInt(99), date: 0 }) };
    if (request instanceof Api.channels.GetMessages) return { messages: [message()] };
    assert.ok(request instanceof Api.messages.SendMessage || request instanceof Api.messages.SendMedia);
    return emptyAck ? {} : sent();
  }) as typeof TelegramClient.prototype.invoke;
  try {
    for (const imageUrl of [null, "https://example.com/test.png", "https://example.com/test.gif"]) {
      const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
      try {
        await driver.inspect("@TEST_ONLY");
        assert.deepEqual(await driver.send("-100123", { text: "TEST_ONLY", imageUrl, buttonUrl: null, buttonText: "Visit" }, "987654321"),
          { chatId: "-100123", messageId: 42 });
      } finally { await driver.disconnect(); }
    }
    assert.equal(requests.filter(r => r instanceof Api.messages.SendMessage).length, 1);
    assert.equal(requests.filter(r => r instanceof Api.messages.SendMedia).length, 2);
    assert.equal(requests.filter(r => r instanceof Api.channels.GetMessages).length, 3);
    emptyAck = true;
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    try {
      await driver.inspect("@TEST_ONLY");
      await assert.rejects(driver.send("-100123", { text: "TEST_ONLY", imageUrl: null, buttonUrl: null, buttonText: "Visit" }, "987654321"), unconfirmed);
      assert.equal(requests.filter(r => r instanceof Api.channels.GetMessages).length, 3);
      assert.equal(requests.filter(r => r instanceof Api.messages.SendMessage).length, 2, "no retry");
    } finally { await driver.disconnect(); }
  } finally {
    TelegramClient.prototype.getEntity = original.getEntity;
    TelegramClient.prototype.invoke = original.invoke;
  }
});
