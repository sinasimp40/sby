import { and, eq, inArray } from "drizzle-orm";
import { db, shopCustomEmojis } from "@workspace/db";
import type { CoinButtonIcon } from "@workspace/api-zod";
import { customEmojiIdValid } from "./custom-emoji-library";
import { isProductEmoji } from "./product-emoji";
import { CommerceError } from "./commerce-providers";
import { coinNames, coinSymbols } from "./deposit-coin-buttons";

export function validCoinNormalIcon(emoji: unknown): boolean {
  return emoji === undefined || emoji === "" || Object.values(coinSymbols).includes(emoji as string) || isProductEmoji(emoji);
}

export async function validateCoinButtonIcons(ownerId: string, icons: Record<string, CoinButtonIcon>, query: Pick<typeof db, "select"> = db) {
  if (Object.keys(icons).length > 7 || Object.keys(icons).some(key => !Object.hasOwn(coinNames, key))) {
    throw new CommerceError("Choose icons only for supported deposit coins.");
  }
  for (const icon of Object.values(icons)) {
    if (!validCoinNormalIcon(icon.emoji)) throw new CommerceError("Choose one normal emoji, a coin symbol, or clear the fallback.");
    if (icon.customEmojiId != null && !customEmojiIdValid(icon.customEmojiId)) throw new CommerceError("Choose a valid custom emoji from your library.");
  }
  const ids = [...new Set(Object.values(icons).flatMap(icon => icon.customEmojiId ? [icon.customEmojiId] : []))];
  if (ids.length) {
    const owned = await query.select({ id: shopCustomEmojis.customEmojiId }).from(shopCustomEmojis)
      .where(and(eq(shopCustomEmojis.ownerId, ownerId), inArray(shopCustomEmojis.customEmojiId, ids)));
    if (owned.length !== ids.length) throw new CommerceError("Import this custom emoji into your own library before selecting it.");
  }
}

// JSON preferences have no foreign key to the library. Removed icons must not
// break deposit buttons or prevent unrelated settings from being saved.
export async function availableCoinButtonIcons(ownerId: string | null, icons: Record<string, CoinButtonIcon>) {
  if (!ownerId || !Object.values(icons).some(icon => icon.customEmojiId)) return icons;
  const rows = await db.select({ id: shopCustomEmojis.customEmojiId }).from(shopCustomEmojis).where(eq(shopCustomEmojis.ownerId, ownerId));
  const owned = new Set(rows.map(row => row.id));
  return Object.fromEntries(Object.entries(icons).map(([coin, icon]) =>
    [coin, icon.customEmojiId && !owned.has(icon.customEmojiId) ? { ...icon, customEmojiId: null } : icon]));
}
