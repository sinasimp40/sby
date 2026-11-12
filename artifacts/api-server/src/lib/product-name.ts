import { isProductEmoji } from "./product-emoji";
import { escapeHtml } from "./payment-message";
import { customerMessageText } from "./telegram-copy";

export interface ProductName {
  name: string;
  buttonEmoji?: string;
  buttonCustomEmojiId?: string | null;
}

export function productNameHtml(product: ProductName, customIcons = true) {
  const normal = product.buttonEmoji === "" ? "" : isProductEmoji(product.buttonEmoji) ? product.buttonEmoji : "🛍";
  const customId = customIcons && /^[0-9]{1,30}$/.test(product.buttonCustomEmojiId ?? "") ? product.buttonCustomEmojiId : null;
  const icon = customId
    ? `<tg-emoji emoji-id="${customId}">${escapeHtml(normal || "🛍")}</tg-emoji>`
    : escapeHtml(normal);
  const name = escapeHtml(customerMessageText(product.name).slice(0, 120));
  return `${icon ? `${icon} ` : ""}<b>${name}</b>`;
}
