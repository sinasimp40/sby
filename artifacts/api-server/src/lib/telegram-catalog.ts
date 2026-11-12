import { customerMessageText } from "./telegram-copy";
import { isProductEmoji } from "./product-emoji";

interface CatalogProduct {
  id: number;
  name: string;
  price: number;
  stock: number;
  status: string;
  buttonEmoji?: string;
  buttonCustomEmojiId?: string | null;
}

export const CATALOG_PAGE_SIZE = 10;

export function productCatalogMenu(input: CatalogProduct[], requestedPage = 0, customIcons = true) {
  const products = input.filter(product => product.status === "active" && product.stock > 0)
    .sort((a, b) => a.id - b.id);
  const pages = Math.max(1, Math.ceil(products.length / CATALOG_PAGE_SIZE));
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(0, Math.min(requestedPage, pages - 1)) : 0;
  const start = page * CATALOG_PAGE_SIZE;
  const entries = products.slice(start, start + CATALOG_PAGE_SIZE);
  const buttons = entries.map(product => {
    const customId = customIcons && typeof product.buttonCustomEmojiId === "string" &&
      /^[0-9]{1,30}$/.test(product.buttonCustomEmojiId) ? product.buttonCustomEmojiId : null;
    const productName = Array.from(customerMessageText(product.name)).slice(0, 20).join("");
    const normalEmoji = product.buttonEmoji === "" ? "" : isProductEmoji(product.buttonEmoji) ? product.buttonEmoji : "🛍";
    return {
    ...(customId ? { icon_custom_emoji_id: customId } : {}),
    text: `${!customId && normalEmoji ? `${normalEmoji} ` : ""}${productName} · $${product.price.toFixed(2)}`,
    callback_data: `buy:${product.id}`,
  }; });
  const inline_keyboard = Array.from({ length: Math.ceil(buttons.length / 2) },
    (_, index) => buttons.slice(index * 2, index * 2 + 2));
  const navigation = [
    ...(page > 0 ? [{ text: "⬅️ Previous", callback_data: `products:${page - 1}` }] : []),
    ...(page < pages - 1 ? [{ text: "Next ➡️", callback_data: `products:${page + 1}` }] : []),
  ];
  if (navigation.length) inline_keyboard.push(navigation);
  inline_keyboard.push([
    { text: "🔄 Refresh", callback_data: `products:${page}` },
    { text: "🏠 Home", callback_data: "cancel_home" },
  ]);
  return {
    text: products.length
      ? `🛍 <b>Browse products</b>\n\n📖 Page <b>${page + 1} of ${pages}</b> · Products ${start + 1}–${start + entries.length} of ${products.length}\n\n💵 Unit prices\nTap a product, then type your quantity in chat.`
      : "📦 <b>No stock available</b>\n\nPlease check back soon.",
    reply_markup: { inline_keyboard },
  };
}
