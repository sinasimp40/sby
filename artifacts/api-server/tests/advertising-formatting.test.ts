import test from "node:test";
import assert from "node:assert/strict";
import { Api, TelegramClient } from "telegram";
import bigInt from "big-integer";
import { validateAdEntities, telegramAdEntities } from "../src/lib/advertising-formatting";
import { accountMessage, createAccountDriver } from "../src/lib/advertising-account-driver";
import { emojiPackName, loadAccountEmojiSet, verifyAccountEmoji } from "../src/lib/advertising-account-emoji";
import { AccountError } from "../src/lib/advertising-account-errors";
import { normalize, adjustForEdit, toggleStyle, setLink, insertEmoji, snapSelection, entitiesProblem, segments } from "../../telecart/src/lib/ad-entities";
import type { AdvertisingTextEntity as Entity } from "@workspace/api-zod";

const emoji = "👩‍💻", documentId = "123456789";
const custom: Entity = { type: "custom_emoji", offset: 2, length: emoji.length, documentId };
const draft = { text: `  ${emoji} Offer`, imageUrl: null, buttonText: "Visit", buttonUrl: "https://t.me/TEST_ONLY",
  entities: [{ type: "bold", offset: 2, length: emoji.length + 6 }, custom] as Entity[] };
const doc = (free = false) => new Api.Document({ id: bigInt(documentId), accessHash: bigInt.zero, fileReference: Buffer.alloc(0),
  date: 0, mimeType: "application/x-tgsticker", size: bigInt.one, dcId: 2,
  attributes: [new Api.DocumentAttributeCustomEmoji({ alt: emoji, free, stickerset: new Api.InputStickerSetEmpty() })] });
function fakeClient(paid: boolean, documents = [doc()]) {
  const requests: unknown[] = [];
  const client = {
    getMe: async () => new Api.User({ id: bigInt(99), firstName: "TEST_ONLY", premium: paid }),
    invoke: async (request: unknown) => {
      requests.push(request);
      if (request instanceof Api.messages.GetCustomEmojiDocuments) return documents;
      assert.ok(request instanceof Api.messages.GetStickerSet);
      return new Api.messages.StickerSet({ set: { title: "TEST_ONLY pack" } as Api.StickerSet, packs: [], keywords: [], documents });
    },
  } as unknown as Pick<TelegramClient, "invoke" | "getMe">;
  return { client, requests };
}

test("formatting preserves UTF-16 positions, leading whitespace and the appended shop link", () => {
  const clean = accountMessage(draft);
  assert.equal(clean.text, `${draft.text}\n\nVisit: https://t.me/TEST_ONLY`);
  assert.deepEqual(clean.entities, validateAdEntities(draft.text, draft.entities));
  const wire = telegramAdEntities(clean.entities!);
  assert.ok(wire[0] instanceof Api.MessageEntityBold);
  assert.ok(wire[1] instanceof Api.MessageEntityCustomEmoji);
  assert.equal(wire[1].offset, 2);
  assert.equal(wire[1].length, 5);
  assert.equal(wire[1].documentId.toString(), documentId);
  const plain = accountMessage({ ...draft, text: " Plain ", entities: [] });
  assert.equal(plain.text, "Plain\n\nVisit: https://t.me/TEST_ONLY");
  assert.equal(plain.entities, undefined, "old plain drafts retain their previous shape");
});

test("malformed, crossing, unsafe and unsupported formatting is rejected before any Telegram request", () => {
  const text = `A${emoji}BCDEF`;
  for (const entities of [
    [{ type: "bold", offset: -1, length: 1 }], [{ type: "bold", offset: 0.5, length: 1 }],
    [{ type: "bold", offset: 0, length: 500 }], [{ type: "bold", offset: 1, length: 1 }],
    [{ type: "bold", offset: 0, length: 7 }, { type: "italic", offset: 6, length: 3 }],
    [{ type: "text_link", offset: 0, length: 1, url: "javascript:alert(1)" }],
    [{ type: "text_link", offset: 0, length: 1, url: "https://user:password@example.invalid" }],
    [{ type: "custom_emoji", offset: 0, length: 1, documentId }],
    [{ type: "custom_emoji", offset: 1, length: emoji.length, documentId: "9999999999999999999" }],
    [{ type: "table", offset: 0, length: 1 }],
    Array.from({ length: 101 }, () => ({ type: "bold", offset: 0, length: 1 })),
  ]) assert.throws(() => validateAdEntities(text, entities), /Invalid advertisement formatting/);
});

test("the editor preserves formatting through Unicode edits, selections and overlapping styles", () => {
  const initial: Entity[] = [{ type: "bold", offset: 0, length: 6 }, { type: "italic", offset: 3, length: 6 }];
  const normalized = normalize("123456789", initial);
  assert.deepEqual(validateAdEntities("123456789", normalized), normalized);
  assert.ok(segments("123456789", normalized).some(s => s.bold && s.italic && s.text === "456"));
  assert.deepEqual(normalize("123456789", normalized), normalized, "normalization is stable across save/reload");
  let entities = toggleStyle("abcdef", [], "bold", 0, 6);
  entities = toggleStyle("abcdef", entities, "italic", 2, 5);
  entities = setLink("abcdef", entities, 1, 4, "https://example.invalid");
  assert.deepEqual(validateAdEntities("abcdef", entities), entities);
  assert.deepEqual(validateAdEntities(`X${draft.text}`, adjustForEdit(draft.text, `X${draft.text}`, draft.entities)), normalize(`X${draft.text}`, [
    ...draft.entities.map(e => ({ ...e, offset: e.offset + 1 })),
  ]));
  assert.ok(!adjustForEdit(draft.text, draft.text.replace(emoji, "⭐"), draft.entities).some(e => e.type === "custom_emoji"));
  assert.deepEqual(snapSelection(emoji, 1, 4), [0, emoji.length]);
  const inserted = insertEmoji("ABC", [], 1, 2, emoji, documentId);
  assert.equal(inserted.text, `A${emoji}C`);
  assert.deepEqual(validateAdEntities(inserted.text, inserted.entities), inserted.entities);
  const tooMany = Array.from({ length: 101 }, (_, i): Entity => ({ type: "custom_emoji", offset: i, length: 1, documentId }));
  assert.equal(normalize("⭐".repeat(101), tooMany).length, 101, "never silently drop the final emoji");
  assert.match(entitiesProblem("⭐".repeat(101), tooMany), /limit is 100/);
});

test("emoji pack inputs stay read-only and never fetch arbitrary links", async () => {
  for (const link of ["TEST_ONLY", "https://t.me/addemoji/TEST_ONLY", "t.me/addemoji/TEST_ONLY"])
    assert.equal(emojiPackName(link), "TEST_ONLY");
  for (const link of ["https://example.invalid/addemoji/TEST_ONLY", "https://t.me/joinchat/TEST_ONLY", "https://user:pass@t.me/addemoji/TEST_ONLY"])
    assert.throws(() => emojiPackName(link), /Paste a Telegram/);
  const unpaid = fakeClient(false);
  assert.equal((await loadAccountEmojiSet(unpaid.client, "TEST_ONLY")).emojis[0]!.available, false);
  assert.ok(unpaid.requests.every(r => r instanceof Api.messages.GetStickerSet));
  const paid = fakeClient(true);
  assert.equal((await loadAccountEmojiSet(paid.client, "TEST_ONLY")).emojis[0]!.available, true);
});

test("custom emoji checks distinguish Premium, free emoji, missing documents and mismatched fallback", async () => {
  await verifyAccountEmoji(fakeClient(true).client, draft.text, [custom]);
  await verifyAccountEmoji(fakeClient(false, [doc(true)]).client, draft.text, [custom]);
  await assert.rejects(verifyAccountEmoji(fakeClient(false).client, draft.text, [custom]),
    e => e instanceof AccountError && e.telegramCode === "PREMIUM_ACCOUNT_REQUIRED");
  await assert.rejects(verifyAccountEmoji(fakeClient(true, []).client, draft.text, [custom]),
    e => e instanceof AccountError && e.telegramCode === "CUSTOM_EMOJI_INVALID");
  await assert.rejects(verifyAccountEmoji(fakeClient(true).client, "  ⭐ Offer", [{ ...custom, length: 1 }]),
    e => e instanceof AccountError && e.telegramCode === "CUSTOM_EMOJI_INVALID");
  const untouched = fakeClient(false);
  await verifyAccountEmoji(untouched.client, "Plain", []);
  assert.equal(untouched.requests.length, 0, "plain messages make no new emoji API calls");
});

test("the real account driver sends formatting on text, photo and GIF RPCs without any live Telegram calls", async () => {
  const original = { invoke: TelegramClient.prototype.invoke, getMe: TelegramClient.prototype.getMe, getEntity: TelegramClient.prototype.getEntity };
  const requests: unknown[] = [];
  let paid = true;
  const channel = new Api.Channel({ id: bigInt(123), accessHash: bigInt(456), title: "TEST_ONLY", photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true });
  TelegramClient.prototype.getEntity = async () => channel;
  TelegramClient.prototype.getMe = async () => new Api.User({ id: bigInt(99), firstName: "TEST_ONLY", premium: paid });
  TelegramClient.prototype.invoke = (async (request: unknown) => {
    requests.push(request);
    if (request instanceof Api.channels.GetParticipant) return { participant: new Api.ChannelParticipant({ userId: bigInt(99), date: 0 }) };
    if (request instanceof Api.messages.GetCustomEmojiDocuments) return [doc()];
    if (request instanceof Api.channels.GetMessages) return { messages: [new Api.Message({
      id: 42, peerId: new Api.PeerChannel({ channelId: channel.id }), out: true, date: 0, message: accountMessage(draft).text,
    })] };
    assert.ok(request instanceof Api.messages.SendMessage || request instanceof Api.messages.SendMedia);
    assert.equal(request.message, accountMessage(draft).text);
    assert.deepEqual(request.entities, telegramAdEntities(validateAdEntities(draft.text, draft.entities)));
    return new Api.UpdateShortSentMessage({ id: 42, pts: 1, ptsCount: 1, date: 0, out: true });
  }) as typeof TelegramClient.prototype.invoke;
  try {
    for (const imageUrl of [null, "https://example.com/ad.png", "https://example.com/ad.gif"]) {
      const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
      try {
        await driver.inspect("@TEST_ONLY");
        assert.equal((await driver.send("-100123", { ...draft, imageUrl }, "987654321")).messageId, 42);
      } finally { await driver.disconnect(); }
    }
    const count = () => requests.filter(r => r instanceof Api.messages.SendMessage || r instanceof Api.messages.SendMedia).length;
    assert.equal(count(), 3);
    paid = false;
    const driver = createAccountDriver({ apiId: 12345, apiHash: "a".repeat(32) });
    try {
      await driver.inspect("@TEST_ONLY");
      await assert.rejects(driver.send("-100123", draft, "987654322"), /requires Telegram Premium/);
      assert.equal(count(), 3, "eligibility failure must not post or silently fall back");
    } finally { await driver.disconnect(); }
  } finally { Object.assign(TelegramClient.prototype, original); }
});
