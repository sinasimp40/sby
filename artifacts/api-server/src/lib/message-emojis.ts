import { parseMessageEmojis } from "@workspace/api-zod";
import { withCustomEmojiFallback } from "./custom-emoji-delivery";
import { telegram } from "./commerce-providers";

type Send = (method: string, body: Record<string, unknown>) => Promise<unknown>;
export function messageEmojiBody(source: string, caption = false, custom = true) {
  const parsed = parseMessageEmojis(source);
  return { [caption ? "caption" : "text"]: parsed.text,
    ...(custom && parsed.entities.length ? { [caption ? "caption_entities" : "entities"]: parsed.entities } : {}) };
}
export function sendMessageWithEmojis(chatId: string, source: string, send: Send = telegram) {
  return withCustomEmojiFallback(
    () => send("sendMessage", { chat_id: chatId, ...messageEmojiBody(source) }),
    () => send("sendMessage", { chat_id: chatId, ...messageEmojiBody(source, false, false) }),
  );
}
