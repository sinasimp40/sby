import { isIP } from "node:net";
import { telegram, TelegramRequestError } from "./commerce-providers";
import { logger } from "./logger";
import { withCustomEmojiFallback } from "./custom-emoji-delivery";

export const PRODUCT_MEDIA_ERROR = "Use a public HTTPS image link ending in .jpg, .jpeg, .png, .webp or .gif (not a webpage).";

// Telegram retrieves the URL itself. Never fetch arbitrary image links on our server.
export function validProductMediaUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !url.hash && !isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
      url.hostname.includes(".") && !/\.(localhost|local|internal|invalid|test)$/.test(url.hostname) &&
      /\.(jpe?g|png|webp|gif)$/i.test(url.pathname);
  } catch { return false; }
}

export function productMediaMethod(url: string) {
  return /\.gif$/i.test(new URL(url).pathname) ? "sendAnimation" as const : "sendPhoto" as const;
}

interface ProductCard {
  heading: string;
  fallbackHeading?: string;
  body: string;
  imageUrl?: string | null;
  reply_markup: object;
}
export interface ProductCardMessage {
  message_id?: number;
  mediaPrompt?: boolean;
}
type Send = (method: string, body: Record<string, unknown>) => Promise<{ message_id?: number }>;
const captionLength = (html: string) => html.replace(/<\/?(?:b|i|code|tg-emoji)(?:\s[^>]*)?>/g, "")
  .replace(/&(?:amp|lt|gt|quot|#39);/g, "x").length;

export async function sendProductCard(chatId: string, card: ProductCard, send: Send = telegram): Promise<ProductCardMessage> {
  const common = { chat_id: chatId, parse_mode: "HTML", protect_content: true };
  const text = [card.heading, card.body].filter(Boolean).join("\n\n");
  const fallbackText = [card.fallbackHeading ?? card.heading, card.body].filter(Boolean).join("\n\n");
  const deliver = (method: string, body: Record<string, unknown>) => withCustomEmojiFallback(
    () => send(method, body),
    () => send(method, { ...body, ...(method === "sendMessage" ? { text: fallbackText } : { caption: fallbackText }) }),
  );
  if (!card.imageUrl || !validProductMediaUrl(card.imageUrl)) {
    return deliver("sendMessage", { ...common, text, reply_markup: card.reply_markup });
  }
  const method = productMediaMethod(card.imageUrl);
  try {
    const message = await deliver(method, {
      ...common, [method === "sendAnimation" ? "animation" : "photo"]: card.imageUrl,
      caption: text, reply_markup: card.reply_markup,
    });
    return { ...message, mediaPrompt: true };
  } catch (error) {
    // Only a definitive media rejection is safe to recover from automatically.
    // A timeout may already have sent the photo, so do not blindly retry it.
    if (!(error instanceof TelegramRequestError && error.providerStatus === 400)) throw error;
    logger.warn({ method }, "Telegram rejected a product image link; sent an explicit image-unavailable notice.");
    return send("sendMessage", {
      ...common, text: `⚠️ Product image unavailable. The image link may be broken or not public.\n\n${fallbackText}`,
      reply_markup: card.reply_markup,
    });
  }
}

export async function editProductQuote(
  chatId: string, messageId: number, quote: string, keyboard: object, mediaPrompt: boolean, send: Send = telegram, fallbackQuote = quote,
): Promise<boolean> {
  try {
    if (mediaPrompt && captionLength(quote) > 1024) {
      await send("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      return false;
    }
    const method = mediaPrompt ? "editMessageCaption" : "editMessageText";
    const body = {
      chat_id: chatId, message_id: messageId,
      [mediaPrompt ? "caption" : "text"]: quote, reply_markup: keyboard, parse_mode: "HTML",
    };
    await withCustomEmojiFallback(
      () => send(method, body),
      () => send(method, { ...body, [mediaPrompt ? "caption" : "text"]: fallbackQuote }),
    );
    return true;
  } catch (error) {
    if (error instanceof TelegramRequestError && error.reason === "not_modified") return true;
    if (error instanceof TelegramRequestError && error.providerStatus === 400) return false;
    throw error;
  }
}
