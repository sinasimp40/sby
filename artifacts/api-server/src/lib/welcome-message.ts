import { telegram, TelegramRequestError, CommerceError } from "./commerce-providers";
import { validProductMediaUrl, productMediaMethod } from "./product-media";
import { parseMessageEmojis } from "@workspace/api-zod";
import { messageEmojiBody } from "./message-emojis";
import { withCustomEmojiFallback } from "./custom-emoji-delivery";

export const WELCOME_CAPTION_LIMIT = 1024;
type Welcome = { welcomeMessage: string; welcomeImageUrl?: string | null };
type Send = (method: string, body: Record<string, unknown>) => Promise<unknown>;

export async function sendWelcomeMessage(chatId: string, settings: Welcome, keyboard: object, note = "", send: Send = telegram) {
  const image = settings.welcomeImageUrl;
  if (image && (!validProductMediaUrl(image) || parseMessageEmojis(settings.welcomeMessage).text.length > WELCOME_CAPTION_LIMIT)) {
    throw new CommerceError("Check the welcome image link and shorten its text to 1,024 characters.");
  }
  const limit = image ? WELCOME_CAPTION_LIMIT : 4096;
  const withNote = [settings.welcomeMessage, note].filter(Boolean).join("\n\n");
  // Never split or truncate the merchant's welcome text to make room for an
  // optional home-navigation explanation.
  const text = parseMessageEmojis(withNote).text.length <= limit ? withNote : settings.welcomeMessage;
  const common = { chat_id: chatId, reply_markup: keyboard, protect_content: true };
  const deliver = (method: string, caption: boolean, extra: object = {}) => withCustomEmojiFallback(
    () => send(method, { ...common, ...extra, ...messageEmojiBody(text, caption) }),
    () => send(method, { ...common, ...extra, ...messageEmojiBody(text, caption, false) }),
  );
  if (!image) return deliver("sendMessage", false);
  const method = productMediaMethod(image);
  try {
    return await deliver(method, true, { [method === "sendAnimation" ? "animation" : "photo"]: image });
  } catch (error) {
    // Only a definite rejection proves the media message was not delivered.
    // Timeouts must not cause duplicate welcome messages.
    if (!(error instanceof TelegramRequestError && error.providerStatus === 400)) throw error;
    // A repeated custom-emoji rejection is not an image failure.
    if (error.reason === "custom_emoji_unavailable") throw error;
    return withCustomEmojiFallback(
      () => send("sendMessage", { ...common, ...messageEmojiBody(`Welcome image unavailable. Check its public image link.\n\n${text}`) }),
      () => send("sendMessage", { ...common, ...messageEmojiBody(`Welcome image unavailable. Check its public image link.\n\n${text}`, false, false) }),
    );
  }
}
