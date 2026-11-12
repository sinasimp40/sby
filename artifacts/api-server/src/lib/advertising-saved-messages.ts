import { createHash } from "node:crypto";
import { Api, type TelegramClient } from "telegram";
import {
  GetAdvertisingWorkspaceResponse,
  type AdvertisingForwardSnapshot, type AdvertisingSavedMessage, type AdvertisingSavedMessagesPage,
} from "@workspace/api-zod";
import { AccountError } from "./advertising-account-errors";

export function validateForwardSnapshot(value: unknown): AdvertisingForwardSnapshot {
  const parsed = GetAdvertisingWorkspaceResponse.shape.draft.shape.forward.unwrap().safeParse(value);
  if (!parsed.success || !parsed.data.source.canForward)
    throw new AccountError("The saved-message selection is invalid. Load Saved Messages and choose it again.");
  return parsed.data;
}
function mediaKind(message: Api.Message): AdvertisingSavedMessage["mediaKind"] {
  const media = message.media;
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) return "text";
  if (media instanceof Api.MessageMediaPhoto) return "photo";
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const attrs = media.document.attributes;
    if (attrs.some(a => a instanceof Api.DocumentAttributeAnimated)) return "animation";
    if (attrs.some(a => a instanceof Api.DocumentAttributeSticker)) return "sticker";
    const audio = attrs.find(a => a instanceof Api.DocumentAttributeAudio);
    if (audio instanceof Api.DocumentAttributeAudio) return audio.voice ? "voice" : "audio";
    if (attrs.some(a => a instanceof Api.DocumentAttributeVideo)) return "video";
    return "document";
  }
  return "other";
}
/** Check the peer even for GetMessages(ids): non-channel message IDs alone do
 * not establish that a message belongs to Saved Messages rather than another chat.
 */
export function savedMessagePreview(message: Api.TypeMessage, accountId: string): AdvertisingSavedMessage | null {
  if (!(message instanceof Api.Message) || !(message.peerId instanceof Api.PeerUser) ||
    message.peerId.userId.toString() !== accountId) return null;
  const media = message.media;
  const file = media && ("photo" in media ? media.photo : "document" in media ? media.document : undefined);
  const ttl = media && "ttlSeconds" in media ? media.ttlSeconds : undefined;
  const protectedContent = Boolean(message.noforwards || message.ttlPeriod || ttl);
  const empty = !message.message?.trim() && (!media || media instanceof Api.MessageMediaEmpty);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    accountId, id: message.id, date: message.date, editDate: message.editDate ?? null,
    text: message.message ?? "", entities: message.entities?.map(e => e.toJSON()) ?? [],
    mediaType: media?.className ?? null, mediaId: file && "id" in file ? file.id.toString() : null,
    protectedContent,
  })).digest("hex");
  let text = (message.message ?? "").slice(0, 4096);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { id: message.id, accountId, date: new Date(message.date * 1000), text,
    mediaKind: mediaKind(message), canForward: !protectedContent && !empty,
    reason: protectedContent ? "Telegram protects this message from forwarding." : empty ? "This message has no forwardable content." : null,
    fingerprint };
}
type Reader = Pick<TelegramClient, "getMe" | "getMessages">;
async function identity(client: Reader) {
  const me = await client.getMe();
  if (!(me instanceof Api.User) || me.bot) throw new AccountError("Connect your personal Telegram account first.");
  return me.id.toString();
}
export async function readSavedMessages(client: Reader, offsetId = 0): Promise<AdvertisingSavedMessagesPage> {
  const accountId = await identity(client);
  const raw = await client.getMessages(new Api.InputPeerSelf(), { limit: 31, offsetId });
  const page = raw.slice(0, 30);
  return { accountId, messages: page.flatMap(m => savedMessagePreview(m, accountId) ?? []),
    nextOffsetId: raw.length > 30 ? page.at(-1)!.id : null };
}
export async function readSavedMessage(client: Reader, id: number): Promise<AdvertisingSavedMessage> {
  const accountId = await identity(client);
  const raw = await client.getMessages(new Api.InputPeerSelf(), { ids: [id] });
  const source = raw.find(m => m.id === id);
  const preview = source && savedMessagePreview(source, accountId);
  if (!preview) throw new AccountError("The selected message is no longer in this account's Saved Messages. Choose it again.", "validation", 0, "SAVED_MESSAGE_MISSING");
  if (!preview.canForward) throw new AccountError(preview.reason!, "validation", 0, "CHAT_FORWARDS_RESTRICTED");
  return preview;
}
