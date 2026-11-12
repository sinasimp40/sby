import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { createAccountDriver } from "../src/lib/advertising-account-driver";

test("discovery retains supergroups and channels through the real GramJS dialog iterator", async () => {
  const original = TelegramClient.prototype.invoke;
  const group = new Api.Channel({
    id: bigInt(12345), accessHash: bigInt(67890), title: "TEST_ONLY supergroup",
    photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true,
  });
  const channel = new Api.Channel({
    id: bigInt(54321), accessHash: bigInt(98760), title: "TEST_ONLY channel",
    photo: new Api.ChatPhotoEmpty(), date: 0, broadcast: true,
  });
  const old = new Api.Chat({
    id: bigInt(111), title: "TEST_ONLY migrated", photo: new Api.ChatPhotoEmpty(),
    participantsCount: 1, date: 0, version: 1,
    migratedTo: new Api.InputChannel({ channelId: group.id, accessHash: group.accessHash! }),
  });
  const left = new Api.Channel({
    id: bigInt(222), accessHash: bigInt(333), title: "TEST_ONLY left",
    photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true, left: true,
  });
  const basic = new Api.Chat({
    id: bigInt(444444), title: "TEST_ONLY basic group", photo: new Api.ChatPhotoEmpty(),
    participantsCount: 2, date: 0, version: 1,
  });
  const chats = [group, channel, basic, old, left];
  let requests = 0;
  TelegramClient.prototype.invoke = async function (request: any): Promise<any> {
    assert.ok(request instanceof Api.messages.GetDialogs, "discovery may only fetch dialogs, never join or send");
    requests++;
    return new Api.messages.Dialogs({
      dialogs: chats.map(entity => new Api.Dialog({
        peer: entity instanceof Api.Chat ? new Api.PeerChat({ chatId: entity.id }) : new Api.PeerChannel({ channelId: entity.id }),
        topMessage: 1, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings({}),
      })),
      chats, users: [],
      messages: chats.map(entity => new Api.MessageEmpty({
        id: 1,
        peerId: entity instanceof Api.Chat ? new Api.PeerChat({ chatId: entity.id }) : new Api.PeerChannel({ channelId: entity.id }),
      })),
    });
  };
  try {
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    const groups = await driver.groups();
    assert.deepEqual(Array.from(groups, row => row.chatId).sort(), ["-10012345", "-10054321", "-444444"].sort());
    assert.deepEqual(Array.from(groups, row => row.title).sort(), ["TEST_ONLY channel", "TEST_ONLY supergroup", "TEST_ONLY basic group"].sort());
    assert.equal(requests, 1);
  } finally { TelegramClient.prototype.invoke = original; }
});

test("public groups absent from dialogs are verified directly before checking or sending", async () => {
  const original = {
    getDialogs: TelegramClient.prototype.getDialogs,
    getEntity: TelegramClient.prototype.getEntity,
    invoke: TelegramClient.prototype.invoke,
  };
  const channel = new Api.Channel({
    id: bigInt(12345), accessHash: bigInt(67890), title: "TEST_ONLY group",
    photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true,
  });
  let mode = "member", checks = 0, sends = 0;
  TelegramClient.prototype.getDialogs = async () => [] as any;
  TelegramClient.prototype.getEntity = async target => {
    assert.equal(target, "@TEST_ONLY_group");
    return channel;
  };
  TelegramClient.prototype.invoke = async request => {
    if (request instanceof Api.channels.GetParticipant) {
      checks++;
      assert.ok(request.participant instanceof Api.InputPeerSelf);
      if (mode === "outsider") throw { errorMessage: "USER_NOT_PARTICIPANT" };
      return { participant: new Api.ChannelParticipant({ userId: bigInt(99), date: 0 }) } as any;
    }
    assert.ok(request instanceof Api.messages.SendMessage);
    assert.ok(request.peer instanceof Api.InputPeerChannel);
    assert.equal(request.peer.channelId.toString(), "12345");
    sends++;
    return {} as any;
  };
  const factory = () => createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
  const draft = { text: "TEST_ONLY ad", imageUrl: null, buttonText: "Visit shop", buttonUrl: null };
  try {
    const driver = factory();
    const group = await driver.inspect("@TEST_ONLY_group");
    assert.equal(group.chatId, "-10012345");
    assert.equal(group.title, "TEST_ONLY group");
    await driver.send(group.chatId, draft, "123");
    assert.equal(sends, 1);
    assert.equal(checks, 2, "membership is rechecked before posting");
    mode = "outsider";
    await assert.rejects(factory().inspect("@TEST_ONLY_group"), /same account you used to join/);
    await assert.rejects(driver.send(group.chatId, draft, "124"), /not a member/);
    assert.equal(sends, 1, "membership failure prevents sending");
    mode = "member";
    channel.defaultBannedRights = new Api.ChatBannedRights({ untilDate: 0, sendPlain: true });
    await assert.rejects(factory().inspect("@TEST_ONLY_group"), /lacks permission/);
    assert.equal(sends, 1);
    channel.defaultBannedRights = undefined;
    channel.left = true;
    await assert.rejects(factory().inspect("@TEST_ONLY_group"), /no longer a member/);
  } finally {
    Object.assign(TelegramClient.prototype, original);
  }
});
