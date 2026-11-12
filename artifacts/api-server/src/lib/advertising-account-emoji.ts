import { Api, type TelegramClient } from "telegram";
import bigInt from "big-integer";
import type { AdvertisingEmojiSet, AdvertisingTextEntity } from "@workspace/api-zod";
import { AccountError } from "./advertising-account-errors";

type Client = Pick<TelegramClient, "invoke" | "getMe">;
export function emojiPackName(value: string) {
  const input = value.trim();
  if (/^[A-Za-z0-9_]{1,64}$/.test(input)) return input;
  try {
    const url = new URL(/^(?:www\.)?(?:t\.me|telegram\.me)\//i.test(input) ? `https://${input}` : input);
    const match = /^\/addemoji\/([A-Za-z0-9_]{1,64})\/?$/.exec(url.pathname);
    if (url.protocol === "https:" && ["t.me", "www.t.me", "telegram.me"].includes(url.hostname) &&
      !url.username && !url.password && match) return match[1]!;
  } catch { /* Never fetch the supplied URL; only its validated pack name is used. */ }
  throw new AccountError("Paste a Telegram https://t.me/addemoji/PACK link or the emoji pack's short name.");
}
function custom(document: Api.TypeDocument) {
  return document instanceof Api.Document ? document.attributes.find(
    (a): a is Api.DocumentAttributeCustomEmoji => a instanceof Api.DocumentAttributeCustomEmoji) : undefined;
}
async function premium(client: Client) {
  const me = await client.getMe();
  if (!(me instanceof Api.User) || me.bot) throw new AccountError("A personal Telegram account is required.", "auth", 0, "ACCOUNT_IDENTITY_UNVERIFIED");
  return me.premium === true;
}
export async function loadAccountEmojiSet(client: Client, name: string): Promise<AdvertisingEmojiSet> {
  const pack = await client.invoke(new Api.messages.GetStickerSet({ stickerset: new Api.InputStickerSetShortName({ shortName: name }), hash: 0 }));
  const paid = await premium(client);
  if (!(pack instanceof Api.messages.StickerSet)) throw new AccountError("Telegram did not return a usable custom emoji pack.");
  const emojis = pack.documents.flatMap(doc => {
    const attribute = custom(doc);
    return attribute ? [{ documentId: doc.id.toString(), emoji: attribute.alt, available: paid || attribute.free === true }] : [];
  });
  if (!emojis.length) throw new AccountError("This is not a custom emoji pack, or its emoji are unavailable.");
  return { title: pack.set.title, emojis };
}
export async function verifyAccountEmoji(client: Client, text: string, entities: AdvertisingTextEntity[]) {
  const requested = entities.filter(e => e.type === "custom_emoji");
  if (!requested.length) return;
  const ids = [...new Set(requested.map(e => e.documentId!))];
  const docs = await client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: ids.map(id => bigInt(id)) }));
  const paid = await premium(client);
  for (const e of requested) {
    const doc = docs.find(d => d.id.toString() === e.documentId), attr = doc && custom(doc);
    if (!attr || attr.alt !== text.slice(e.offset, e.offset + e.length))
      throw new AccountError("A custom emoji is missing or its ordinary-emoji fallback does not match. Choose it again from its pack.", "validation", 0, "CUSTOM_EMOJI_INVALID");
    if (!paid && !attr.free)
      throw new AccountError("This custom emoji requires Telegram Premium on the sending account. Choose a free emoji or remove it; nothing was posted.",
        "validation", 0, "PREMIUM_ACCOUNT_REQUIRED");
  }
}
