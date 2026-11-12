import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api, TelegramClient } from "telegram";
import { createAccountDriver } from "../src/lib/advertising-account-driver";

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
