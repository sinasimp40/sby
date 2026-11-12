import { telegram, TelegramRequestError, CommerceError } from "./commerce-providers";
import { validProductMediaUrl, productMediaMethod } from "./product-media";

export const WELCOME_CAPTION_LIMIT = 1024;
type Welcome = { welcomeMessage: string; welcomeImageUrl?: string | null };
type Send = (method: string, body: Record<string, unknown>) => Promise<unknown>;

export async function sendWelcomeMessage(chatId: string, settings: Welcome, keyboard: object, note = "", send: Send = telegram) {
  const image = settings.welcomeImageUrl;
  if (image && (!validProductMediaUrl(image) || settings.welcomeMessage.length > WELCOME_CAPTION_LIMIT)) {
    throw new CommerceError("Check the welcome image link and shorten its text to 1,024 characters.");
  }
  const limit = image ? WELCOME_CAPTION_LIMIT : 4096;
  const withNote = [settings.welcomeMessage, note].filter(Boolean).join("\n\n");
  // Never split or truncate the merchant's welcome text to make room for an
  // optional home-navigation explanation.
  const text = withNote.length <= limit ? withNote : settings.welcomeMessage;
  const common = { chat_id: chatId, reply_markup: keyboard, protect_content: true };
  if (!image) return send("sendMessage", { ...common, text });
  const method = productMediaMethod(image);
  try {
    return await send(method, {
      ...common, [method === "sendAnimation" ? "animation" : "photo"]: image, caption: text,
    });
  } catch (error) {
    // Only a definite rejection proves the media message was not delivered.
    // Timeouts must not cause duplicate welcome messages.
    if (!(error instanceof TelegramRequestError && error.providerStatus === 400)) throw error;
    return send("sendMessage", { ...common, text: `Welcome image unavailable. Check its public image link.\n\n${text}` });
  }
}
