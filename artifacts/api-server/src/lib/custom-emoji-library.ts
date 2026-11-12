import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, shopCustomEmojis, shopProducts, shopSettings, emojiImportSessions } from "@workspace/db";
import type { CoinButtonIcon } from "@workspace/api-zod";
import { activeConnection, requireOperator } from "./commerce-connection";
import { CommerceError, telegramControl, TelegramRequestError } from "./commerce-providers";
import { isProductEmoji } from "./product-emoji";
import { readProviderCredentials } from "./provider-credentials";
import { readEmojiThumbnail } from "./emoji-thumbnail";

export const MAX_CUSTOM_EMOJIS = 2000;
export const customEmojiIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,30}$/.test(value);
export interface EmojiSticker {
  type: string;
  custom_emoji_id?: string;
  emoji?: string;
  set_name?: string;
  is_animated?: boolean;
  is_video?: boolean;
  thumbnail?: { file_id?: string };
}

export function emojiPackName(input: string) {
  let name = input.trim();
  if (/^(?:https?:\/\/|t\.me\/|telegram\.me\/)/i.test(name)) {
    try {
      const url = new URL(/^https?:\/\//i.test(name) ? name : `https://${name}`);
      if (url.protocol !== "https:" || !["t.me", "telegram.me"].includes(url.hostname) || url.username || url.password ||
        url.port || url.search || url.hash) throw new Error();
      const match = /^\/addemoji\/([A-Za-z0-9_]{1,64})\/?$/.exec(url.pathname);
      if (!match) throw new Error();
      name = match[1]!;
    } catch { throw new CommerceError("Enter a custom emoji pack link, such as https://t.me/addemoji/PackName. Ordinary sticker packs are not supported."); }
  }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new CommerceError("Enter a valid custom emoji pack name or t.me/addemoji link.");
  return name;
}

export async function requireEmojiConnection(owner: string | null) {
  requireOperator(owner);
  const connection = await activeConnection();
  if (!connection || connection.ownerId !== owner || !connection.botUsername) {
    throw new CommerceError("Connect and verify your Telegram bot in the dashboard first.", 503);
  }
  return connection;
}

export async function customEmojiLibrary(owner: string | null) {
  if (!owner) throw new CommerceError("Sign in to manage your emoji library.", 401);
  const rows = await db.select().from(shopCustomEmojis).where(eq(shopCustomEmojis.ownerId, owner))
    .orderBy(asc(shopCustomEmojis.createdAt), asc(shopCustomEmojis.customEmojiId));
  return { maxItems: MAX_CUSTOM_EMOJIS, items: rows.map(row => ({
    id: row.customEmojiId, emoji: row.emoji, setName: row.setName, format: row.format,
    previewUrl: `/api/shop/custom-emojis/${row.customEmojiId}/preview`,
  })) };
}

export async function saveEmojiStickers(owner: string, stickers: EmojiSticker[], session?: { tokenHash: string; chatId: string }) {
  if (!stickers.length || stickers.length > MAX_CUSTOM_EMOJIS ||
    stickers.some(sticker => sticker.type !== "custom_emoji" || !customEmojiIdValid(sticker.custom_emoji_id))) {
    throw new CommerceError("Only actual Telegram custom emojis can be imported, not ordinary stickers.");
  }
  const unique = [...new Map(stickers.map(sticker => [sticker.custom_emoji_id!, sticker])).values()];
  return db.transaction(async tx => {
    if (session) {
      const [active] = await tx.select().from(emojiImportSessions).where(and(
        eq(emojiImportSessions.ownerId, owner), eq(emojiImportSessions.tokenHash, session.tokenHash),
        eq(emojiImportSessions.chatId, session.chatId), gt(emojiImportSessions.expiresAt, new Date()),
      )).for("update");
      if (!active) throw new CommerceError("This import session expired or was stopped. Start a new session from the dashboard.", 403);
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 71))`);
    const previous = await tx.select({ id: shopCustomEmojis.customEmojiId }).from(shopCustomEmojis).where(eq(shopCustomEmojis.ownerId, owner));
    const existing = new Set(previous.map(row => row.id));
    const imported = unique.filter(sticker => !existing.has(sticker.custom_emoji_id!)).length;
    if (previous.length + imported > MAX_CUSTOM_EMOJIS) throw new CommerceError(`Your library supports ${MAX_CUSTOM_EMOJIS} emojis. Remove unused entries before importing more.`);
    for (const sticker of unique) {
      const values = {
        ownerId: owner, customEmojiId: sticker.custom_emoji_id!,
        emoji: isProductEmoji(sticker.emoji) ? sticker.emoji : "🛍",
        setName: sticker.set_name?.slice(0, 64) || null,
        format: sticker.is_video ? "video" as const : sticker.is_animated ? "animated" as const : "static" as const,
        thumbnailFileId: sticker.thumbnail?.file_id?.slice(0, 500) || null,
      };
      await tx.insert(shopCustomEmojis).values(values).onConflictDoUpdate({
        target: [shopCustomEmojis.ownerId, shopCustomEmojis.customEmojiId], set: values,
      });
    }
    return { imported, updated: unique.length - imported, total: previous.length + imported };
  });
}

export async function importEmojiPack(owner: string | null, input: string) {
  await requireEmojiConnection(owner);
  return saveEmojiStickers(owner!, await loadEmojiPack(input));
}

export async function loadEmojiPack(input: string) {
  const name = emojiPackName(input);
  let set: { sticker_type: string; stickers: EmojiSticker[] };
  try { set = await telegramControl("getStickerSet", { name }); }
  catch (error) {
    if (error instanceof TelegramRequestError && error.providerStatus === 400) throw new CommerceError("Telegram could not find that custom emoji pack. Check the addemoji link.");
    throw error;
  }
  if (set.sticker_type !== "custom_emoji" || !Array.isArray(set.stickers)) throw new CommerceError("That is an ordinary sticker pack. Choose a Telegram custom emoji pack with an addemoji link.");
  return set.stickers;
}

export async function assertOwnedCustomEmoji(owner: string, id: string | null | undefined) {
  if (id == null) return;
  if (!customEmojiIdValid(id)) throw new CommerceError("Choose a valid custom emoji from your library.");
  const [row] = await db.select({ id: shopCustomEmojis.customEmojiId }).from(shopCustomEmojis)
    .where(and(eq(shopCustomEmojis.ownerId, owner), eq(shopCustomEmojis.customEmojiId, id)));
  if (!row) throw new CommerceError("Import this custom emoji into your own library before selecting it.");
}

export async function removeCustomEmoji(owner: string | null, id: string) {
  if (!owner) throw new CommerceError("Sign in first.", 401);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}, 71))`);
    await tx.update(shopProducts).set({ buttonCustomEmojiId: null }).where(and(
      eq(shopProducts.ownerId, owner), eq(shopProducts.buttonCustomEmojiId, id)));
    const [settings] = await tx.select().from(shopSettings).where(eq(shopSettings.ownerId, owner)).for("update");
    const icons = settings?.preferences.coinButtonIcons as Record<string, CoinButtonIcon> | undefined;
    if (settings && icons && Object.values(icons).some(icon => icon.customEmojiId === id)) {
      const coinButtonIcons = Object.fromEntries(Object.entries(icons).map(([coin, icon]) =>
        [coin, icon.customEmojiId === id ? { ...icon, customEmojiId: null } : icon]));
      await tx.update(shopSettings).set({ preferences: { ...settings.preferences, coinButtonIcons }, updatedAt: new Date() })
        .where(eq(shopSettings.ownerId, owner));
    }
    const [row] = await tx.delete(shopCustomEmojis).where(and(eq(shopCustomEmojis.ownerId, owner),
      eq(shopCustomEmojis.customEmojiId, id))).returning();
    if (!row) throw new CommerceError("Emoji not found in your library.", 404);
  });
}

// Telegram thumbnails are proxied in memory. Never return a URL containing the bot token.
export async function customEmojiPreview(owner: string | null, id: string) {
  await requireEmojiConnection(owner);
  const [row] = await db.select().from(shopCustomEmojis).where(and(eq(shopCustomEmojis.ownerId, owner!),
    eq(shopCustomEmojis.customEmojiId, id)));
  if (!row) throw new CommerceError("Emoji not found.", 404);
  let fileId = row.thumbnailFileId;
  if (!fileId) {
    const stickers = await telegramControl<EmojiSticker[]>("getCustomEmojiStickers", { custom_emoji_ids: [id] });
    fileId = stickers[0]?.thumbnail?.file_id ?? null;
  }
  if (!fileId) throw new CommerceError("This emoji has no static thumbnail.", 404);
  let file: { file_path?: string; file_size?: number };
  try { file = await telegramControl("getFile", { file_id: fileId }); }
  catch (error) {
    if (!(error instanceof TelegramRequestError && error.providerStatus === 400)) throw error;
    const stickers = await telegramControl<EmojiSticker[]>("getCustomEmojiStickers", { custom_emoji_ids: [id] });
    const refreshed = stickers[0]?.thumbnail?.file_id;
    if (!refreshed) throw new CommerceError("Preview unavailable.", 404);
    file = await telegramControl("getFile", { file_id: refreshed });
  }
  if (!file.file_path || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.includes("..") ||
    (file.file_size ?? 0) > 512000) throw new CommerceError("Preview unavailable.", 404);
  const token = (await readProviderCredentials()).telegramToken;
  if (!token) throw new CommerceError("Telegram connection required.", 503);
  try {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(12000) });
    return await readEmojiThumbnail(response);
  } catch { throw new CommerceError("Emoji preview is unavailable. You can still select it by its ID.", 404); }
}
