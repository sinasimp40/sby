import { customerMessageText } from "./telegram-copy";
import { isProductEmoji } from "./product-emoji";
import { productNameHtml } from "./product-name";
import { escapeHtml } from "./payment-message";

interface CatalogProduct {
  id: number;
  name: string;
  price: number;
  stock: number;
  status: string;
  buttonEmoji?: string;
  buttonCustomEmojiId?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  groupDescription?: string | null;
  optionName?: string | null;
  imageUrl?: string | null;
}

export const CATALOG_PAGE_SIZE = 10;

export function productCatalogMenu(input: CatalogProduct[], requestedPage = 0, customIcons = true) {
  const available = input.filter(product => product.status === "active" && product.stock > 0)
    .sort((a, b) => a.id - b.id);
  const grouped = new Map<string, CatalogProduct[]>();
  for (const product of available) {
    const key = product.groupId ?? `single:${product.id}`;
    const options = grouped.get(key) ?? [];
    options.push(product); grouped.set(key, options);
  }
  const products = [...grouped.values()].map(options => ({
    ...options[0]!,
    name: options[0]!.groupId ? options[0]!.groupName ?? options[0]!.name : options[0]!.name,
    options,
  }));
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
    const prices = product.options.map(option => option.price);
    const low = Math.min(...prices), high = Math.max(...prices);
    const price = low === high ? `$${low.toFixed(2)}` : `$${low.toFixed(2)}–$${high.toFixed(2)}`;
    return {
    ...(customId ? { icon_custom_emoji_id: customId } : {}),
    text: `${!customId && normalEmoji ? `${normalEmoji} ` : ""}${productName} · ${price}`,
    callback_data: product.groupId ? `group:${product.groupId}` : `buy:${product.id}`,
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
      ? `🛍 <b>Browse products</b>\n\n📖 Page <b>${page + 1} of ${pages}</b> · Products ${start + 1}–${start + entries.length} of ${products.length}\n\n💵 Unit prices\nTap a product to choose an option or enter a quantity.`
      : "📦 <b>No stock available</b>\n\nPlease check back soon.",
    reply_markup: { inline_keyboard },
  };
}

export function productOptionsMenu(input: CatalogProduct[], groupId: string) {
  const options = input.filter(product => product.groupId === groupId && product.status === "active" && product.stock > 0)
    .sort((a, b) => a.id - b.id);
  const first = options[0];
  if (!first) return null;
  const parent = { ...first, name: first.groupName ?? first.name };
  const body = [
    ...(first.groupDescription ? [escapeHtml(customerMessageText(first.groupDescription).slice(0, 400)), ""] : []),
    "<b>Choose an option</b>",
    "Each option has its own price and stock. Then type your quantity in chat.",
  ].join("\n");
  const buttons = options.map(option => [{
    text: `${customerMessageText(option.optionName ?? option.name).slice(0, 36)} · $${option.price.toFixed(2)}`,
    callback_data: `buy:${option.id}`,
  }]);
  return {
    heading: productNameHtml(parent), fallbackHeading: productNameHtml(parent, false),
    body, imageUrl: first.imageUrl,
    reply_markup: { inline_keyboard: [
      ...buttons,
      [{ text: "⬅️ Products", callback_data: "products:0" }, { text: "🏠 Home", callback_data: "cancel_home" }],
    ] },
  };
}
