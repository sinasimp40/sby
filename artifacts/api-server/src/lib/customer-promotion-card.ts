import { productNameHtml, productDescription } from "./product-name";
import { customerMessageText } from "./telegram-copy";
import { escapeHtml } from "./payment-message";

export interface PromotedProduct {
  id: number; name: string; description: string; groupDescription: string | null;
  priceCents: number; stock: number; imageUrl: string | null;
  buttonEmoji: string; buttonCustomEmojiId: string | null;
}
/** This is intentionally separate from first-stock/restock announcements. */
export function customerPromotionCard(product: PromotedProduct) {
  const description = customerMessageText(productDescription(product)).slice(0, 400);
  return {
    heading: productNameHtml(product),
    fallbackHeading: productNameHtml(product, false),
    body: [
      ...(description ? [escapeHtml(description), ""] : []),
      `💵 <b>$${(product.priceCents / 100).toFixed(2)}</b>`,
      `📦 <b>${product.stock} in stock</b>`, "",
      "<i>Tap Buy now, then type your quantity in chat.</i>",
    ].join("\n"),
    imageUrl: product.imageUrl,
    reply_markup: { inline_keyboard: [
      [{ text: "🛒 Buy now", callback_data: `buy:${product.id}` }],
      [{ text: "Stop product promotions", callback_data: "promotions:off" }],
    ] },
  };
}
