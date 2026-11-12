import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, botCustomers, botConnections, shopInventory, shopProducts } from "@workspace/db";
import { logger } from "./logger";
import { getBotRuntime } from "./bot-runtime";
import { telegram } from "./commerce-providers";
import { customerMessageText } from "./telegram-copy";
import { escapeHtml } from "./payment-message";

const PAGE_SIZE = 500;
const SEND_INTERVAL_MS = 45;

interface AnnouncementProduct {
  id: number;
  name: string;
  description: string;
  priceCents: number;
  buttonEmoji: string;
  status: string;
  stock: number;
}

export function newStockAnnouncement(product: AnnouncementProduct, newlyAdded: number) {
  const name = escapeHtml(customerMessageText(product.name).slice(0, 120));
  const description = customerMessageText(product.description).slice(0, 400);
  const text = [
    "✨ <b>NEW IN STOCK</b>",
    "",
    `${escapeHtml(product.buttonEmoji)} <b>${name}</b>`,
    ...(description ? ["", escapeHtml(description)] : []),
    "",
    `💵 <b>$${(product.priceCents / 100).toFixed(2)}</b>`,
    `📦 <b>${product.stock} in stock</b>`,
    ...(newlyAdded > 0 ? [`🆕 ${newlyAdded} ${newlyAdded === 1 ? "account" : "accounts"} just added`] : []),
    "",
    "<i>Tap below to choose your quantity.</i>",
  ].join("\n");
  return {
    text,
    reply_markup: {
      inline_keyboard: [[{ text: "🛒 Buy now", callback_data: `buy:${product.id}` }]],
    },
  };
}

const pause = () => new Promise<void>(resolve => setTimeout(resolve, SEND_INTERVAL_MS));

/**
 * Announces newly available stock to customers who have already messaged this bot.
 * Each page is read just before sending, and each customer is attempted independently.
 */
export async function announceProductAvailability(ownerId: string, productId: number, newlyAdded: number) {
  const [connection] = await db.select({ ownerId: botConnections.ownerId })
    .from(botConnections).where(eq(botConnections.id, "primary"));
  if (connection?.ownerId !== ownerId || !(await getBotRuntime(ownerId)).enabled) return;

  const [product] = await db.select({
    id: shopProducts.id,
    name: shopProducts.name,
    description: shopProducts.description,
    priceCents: shopProducts.priceCents,
    buttonEmoji: shopProducts.buttonEmoji,
    status: shopProducts.status,
    stock: sql<number>`count(${shopInventory.id}) filter (where ${shopInventory.status} = 'available')::integer`,
  }).from(shopProducts)
    .leftJoin(shopInventory, eq(shopInventory.productId, shopProducts.id))
    .where(and(eq(shopProducts.id, productId), eq(shopProducts.ownerId, ownerId)))
    .groupBy(shopProducts.id);
  if (!product || product.status !== "active" || product.stock < 1) return;

  const message = newStockAnnouncement(product, newlyAdded);
  let after: string | undefined;
  let sent = 0;
  let failed = 0;

  while (true) {
    if (!(await getBotRuntime(ownerId)).enabled) break;
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
        await telegram("sendMessage", {
          chat_id: recipient.chatId,
          text: message.text,
          parse_mode: "HTML",
          reply_markup: message.reply_markup,
          protect_content: true,
        });
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
