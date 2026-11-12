import { customerMessageText } from "./telegram-copy";
import { isProductEmoji } from "./product-emoji";

interface CatalogProduct {
  id: number;
  name: string;
  price: number;
  stock: number;
  status: string;
  buttonEmoji?: string;
}

export const CATALOG_PAGE_SIZE = 10;

export function productCatalogMenu(input: CatalogProduct[], requestedPage = 0) {
  const products = input.filter(product => product.status === "active" && product.stock > 0)
    .sort((a, b) => a.id - b.id);
  const pages = Math.max(1, Math.ceil(products.length / CATALOG_PAGE_SIZE));
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(0, Math.min(requestedPage, pages - 1)) : 0;
  const start = page * CATALOG_PAGE_SIZE;
  const entries = products.slice(start, start + CATALOG_PAGE_SIZE);
  const buttons = entries.map(product => ({
    text: `${isProductEmoji(product.buttonEmoji) ? product.buttonEmoji : "🛍"} ${Array.from(customerMessageText(product.name)).slice(0, 30).join("")} · $${product.price.toFixed(2)} · 📦 ${product.stock}`,
    callback_data: `buy:${product.id}`,
  }));
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
      ? `🛍 <b>Browse products</b>\n\n📖 Page <b>${page + 1} of ${pages}</b> · Products ${start + 1}–${start + entries.length} of ${products.length}\n\n💵 Unit prices · 📦 Available stock\nTap a product, then choose how many you want.`
      : "📦 <b>No stock available</b>\n\nPlease check back soon.",
    reply_markup: { inline_keyboard },
  };
}
