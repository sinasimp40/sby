import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, botCustomers, botConnections, shopInventory, shopProducts } from "@workspace/db";
import { logger } from "./logger";
import { getBotRuntime } from "./bot-runtime";
import { sendProductCard } from "./product-media";
import { customerMessageText } from "./telegram-copy";
import { escapeHtml } from "./payment-message";
import { productNameHtml, productDescription } from "./product-name";
import { settingsForOwner } from "./shop-store";

const PAGE_SIZE = 500;
const SEND_INTERVAL_MS = 45;

interface AnnouncementProduct {
  id: number;
  name: string;
  description: string;
  groupDescription?: string | null;
  priceCents: number;
  buttonEmoji: string;
  buttonCustomEmojiId?: string | null;
  status: string;
  stock: number;
  imageUrl?: string | null;
}

export function newStockAnnouncement(product: AnnouncementProduct, newlyAdded: number, isNewProduct = false) {
  const description = customerMessageText(productDescription(product)).slice(0, 400);
  const heading = [
    isNewProduct ? "✨ <b>NEW PRODUCT</b>" : "📦 <b>ADDED STOCK</b>",
    "",
    productNameHtml(product),
  ].join("\n");
  const body = [
    ...(description ? [escapeHtml(description), ""] : []),
    `💵 <b>$${(product.priceCents / 100).toFixed(2)}</b>`,
    `📦 <b>${product.stock} in stock</b>`,
    ...(newlyAdded > 0 ? [`➕ ${newlyAdded} ${newlyAdded === 1 ? "account" : "accounts"} just added`] : []),
    "",
    "<i>Tap Buy now, then type your quantity in chat.</i>",
  ].join("\n");
  return {
    text: `${heading}\n\n${body}`,
    heading, body, imageUrl: product.imageUrl,
    fallbackHeading: `${isNewProduct ? "✨ <b>NEW PRODUCT</b>" : "📦 <b>ADDED STOCK</b>"}\n\n${productNameHtml(product, false)}`,
    reply_markup: {
      inline_keyboard: [[{ text: "🛒 Buy now", callback_data: `buy:${product.id}` }]],
    },
  };
}

const pause = (messages = 1) => new Promise<void>(resolve => setTimeout(resolve, SEND_INTERVAL_MS * messages));

export async function claimProductAnnouncement(ownerId: string, productId: number) {
  return db.transaction(async tx => {
    // Serialize the first announcement, including concurrent stock imports.
    const [product] = await tx.select().from(shopProducts)
      .where(and(eq(shopProducts.id, productId), eq(shopProducts.ownerId, ownerId)));
    if (!product || product.status !== "active") return null;
    const [inventory] = await tx.select({ stock: sql<number>`count(*)` }).from(shopInventory)
      .where(and(eq(shopInventory.productId, productId), eq(shopInventory.ownerId, ownerId), eq(shopInventory.status, "available")));
    const stock = inventory?.stock ?? 0;
    if (stock < 1) return null;
    const isNewProduct = !product.stockAnnouncedAt;
    if (isNewProduct) await tx.update(shopProducts).set({ stockAnnouncedAt: new Date() })
      .where(eq(shopProducts.id, productId));
    return { product: { ...product, stock }, isNewProduct };
  });
}

/**
 * Announces newly available stock to customers who have already messaged this bot.
 * Each page is read just before sending, and each customer is attempted independently.
 */
export async function announceProductAvailability(ownerId: string, productId: number, newlyAdded: number) {
  const [connection] = await db.select({ ownerId: botConnections.ownerId })
    .from(botConnections).where(eq(botConnections.id, "primary"));
  if (connection?.ownerId !== ownerId || !(await getBotRuntime(ownerId)).enabled) return;
  if ((await settingsForOwner(ownerId)).maintenanceMode) return;

  const announcement = await claimProductAnnouncement(ownerId, productId);
  if (!announcement) return;
  const message = newStockAnnouncement(announcement.product, newlyAdded, announcement.isNewProduct);
  let after: string | undefined;
  let sent = 0;
  let failed = 0;

  while (true) {
    if (!(await getBotRuntime(ownerId)).enabled || (await settingsForOwner(ownerId)).maintenanceMode) break;
    const recipients = await db.select({ id: botCustomers.id, chatId: botCustomers.chatId })
      .from(botCustomers)
      .where(and(
        eq(botCustomers.ownerId, ownerId),
        ...(after ? [gt(botCustomers.id, after)] : []),
      ))
      .orderBy(asc(botCustomers.id))
      .limit(PAGE_SIZE);
    if (!recipients.length) break;

    for (const recipient of recipients) {
      try {
        await sendProductCard(recipient.chatId, message);
        sent++;
      } catch {
        failed++;
        if (!(await getBotRuntime(ownerId)).enabled) break;
      }
      after = recipient.id;
      await pause();
    }
  }

  logger.info({ ownerId, productId, sent, failed }, "New-stock Telegram announcement finished.");
}
