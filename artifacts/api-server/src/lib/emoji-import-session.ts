import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, emojiImportSessions } from "@workspace/db";
import { CommerceError, telegram, telegramControl } from "./commerce-providers";
import { requireEmojiConnection, customEmojiIdValid, saveEmojiStickers, type EmojiSticker } from "./custom-emoji-library";
import { getBotRuntime } from "./bot-runtime";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export async function startEmojiImportSession(owner: string | null) {
  const connection = await requireEmojiConnection(owner);
  if (connection.active !== "yes" || !(await getBotRuntime()).enabled) throw new CommerceError("Enable Telegram processing in the dashboard before opening an import session.", 503);
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60000);
  await db.insert(emojiImportSessions).values({ ownerId: owner!, tokenHash: tokenHash(token), expiresAt })
    .onConflictDoUpdate({ target: emojiImportSessions.ownerId, set: { tokenHash: tokenHash(token), expiresAt, chatId: null } });
  return { url: `https://t.me/${connection.botUsername}?start=emoji_${token}`, expiresAt: expiresAt.toISOString() };
}
export async function stopEmojiImportSession(owner: string | null) {
  if (!owner) throw new CommerceError("Sign in first.", 401);
  await db.delete(emojiImportSessions).where(eq(emojiImportSessions.ownerId, owner));
}
export async function claimEmojiImportSession(owner: string, token: string, chatId: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return false;
  const [claimed] = await db.update(emojiImportSessions).set({ chatId }).where(and(
    eq(emojiImportSessions.ownerId, owner), eq(emojiImportSessions.tokenHash, tokenHash(token)),
    gt(emojiImportSessions.expiresAt, now), or(isNull(emojiImportSessions.chatId), eq(emojiImportSessions.chatId, chatId)),
  )).returning({ ownerId: emojiImportSessions.ownerId });
  return Boolean(claimed);
}
export interface EmojiImportMessage {
  text?: string;
  entities?: { type: string; custom_emoji_id?: string }[];
  caption_entities?: { type: string; custom_emoji_id?: string }[];
  sticker?: EmojiSticker;
}
export function messageCustomEmojiIds(message: EmojiImportMessage) {
  return [...new Set([
    ...(message.entities ?? []).filter(entity => entity.type === "custom_emoji").map(entity => entity.custom_emoji_id),
    ...(message.caption_entities ?? []).filter(entity => entity.type === "custom_emoji").map(entity => entity.custom_emoji_id),
    ...(message.sticker?.type === "custom_emoji" ? [message.sticker.custom_emoji_id] : []),
  ].filter(customEmojiIdValid))].slice(0, 200);
}
export async function handleEmojiImportMessage(owner: string, chatId: string, message: EmojiImportMessage) {
  const text = message.text?.trim() ?? "";
  if (/^\/start(?:@\w+)? emoji_/.test(text)) {
    const token = text.split("emoji_")[1] ?? "";
    const claimed = await claimEmojiImportSession(owner, token, chatId);
    await telegram("sendMessage", { chat_id: chatId, text: claimed
      ? "Custom emoji import is ready.\n\nSend your custom Telegram emojis here, or send a custom emoji sticker. They will appear in your dashboard library.\n\nNormal stickers and plain emojis cannot be imported as custom icons. Send /done to finish. This private session expires in 10 minutes."
      : "This private emoji import link expired or was already paired with another chat. Create a new link from your dashboard." });
    return true;
  }
  const [session] = await db.select().from(emojiImportSessions).where(and(
    eq(emojiImportSessions.ownerId, owner), eq(emojiImportSessions.chatId, chatId), gt(emojiImportSessions.expiresAt, new Date())));
  if (!session) return false;
  if (["/done", "/cancel", "/start"].includes(text)) {
    await stopEmojiImportSession(owner);
    if (text === "/start") return false;
    await telegram("sendMessage", { chat_id: chatId, text: "Emoji import finished. Choose an imported emoji in the dashboard and save your product. Use /start to return to the shop." });
    return true;
  }
  const ids = messageCustomEmojiIds(message);
  if (!ids.length) {
    await telegram("sendMessage", { chat_id: chatId, text: "Send actual custom Telegram emojis using Telegram's custom emoji picker, not copied plain text, images or ordinary stickers. Or send /done to finish." });
    return true;
  }
  const stickers = await telegramControl<EmojiSticker[]>("getCustomEmojiStickers", { custom_emoji_ids: ids });
  const verified = stickers.filter(sticker => ids.includes(sticker.custom_emoji_id ?? ""));
  const result = await saveEmojiStickers(owner, verified, { tokenHash: session.tokenHash, chatId });
  await telegram("sendMessage", { chat_id: chatId, text: `${result.imported} custom emojis added; ${result.updated} already in your library.\nChoose them in the dashboard, or send more. Send /done when finished.` });
  return true;
}
