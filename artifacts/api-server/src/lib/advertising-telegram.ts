import { CommerceError } from "./commerce-providers";
import { validProductMediaUrl } from "./product-media";
import type { AdvertisingDraft } from "@workspace/api-zod";
import { validateAdEntities } from "./advertising-formatting";
import { validateForwardSnapshot } from "./advertising-saved-messages";

export class AdvertisingTelegramError extends CommerceError {
  constructor(public providerCode: number, public retryAfter = 0) {
    super(providerCode === 401 ? "Advertising bot token was rejected or revoked. Reconnect it." :
      providerCode === 403 ? "Bot was removed, blocked, or is not allowed to post here." :
      providerCode === 429 ? "Telegram rate limit; sending will wait before trying again." :
      providerCode === 400 ? "Telegram could not use this chat, media or message. Check the group and message." :
      "Telegram could not confirm the request. Check the connection before trying again.", providerCode === 400 || providerCode === 403 ? 400 : 502);
  }
}
export async function advertisingTelegram<T = Record<string, unknown>>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json() as { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
    if (!response.ok || !result.ok) throw new AdvertisingTelegramError(result.error_code ?? response.status,
      Math.min(86400, Math.max(1, Number(result.parameters?.retry_after) || 30)));
    return result.result!;
  } catch (error) {
    if (error instanceof AdvertisingTelegramError) throw error;
    // Never surface provider bodies, token-bearing URLs, or raw network errors.
    throw new AdvertisingTelegramError(0);
  }
}
export type AdvertisingCaller = typeof advertisingTelegram;

export function validateAdvertisingDraft(draft: AdvertisingDraft, sending = false) {
  const entities = validateAdEntities(draft.text, draft.entities);
  const clean = { text: entities.length ? draft.text : draft.text.trim(), imageUrl: draft.imageUrl?.trim() || null,
    buttonText: draft.buttonText.trim(), buttonUrl: draft.buttonUrl?.trim() || null };
  if (sending && !clean.text.trim()) throw new CommerceError("Write and save the advertisement before sending.");
  if (clean.text.length > (clean.imageUrl ? 1024 : 4096)) throw new CommerceError(clean.imageUrl ? "Image/GIF captions must be at most 1,024 characters. Nothing will be split or truncated." : "Message must be at most 4,096 characters.");
  if (clean.imageUrl && !validProductMediaUrl(clean.imageUrl)) throw new CommerceError("Use a public HTTPS JPG, JPEG, PNG, WEBP or GIF image link.");
  if (clean.buttonUrl) {
    try { const url = new URL(clean.buttonUrl); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); }
    catch { throw new CommerceError("The shop button needs a valid HTTPS link."); }
    if (!clean.buttonText || clean.buttonText.length > 64) throw new CommerceError("Give the shop button a label of 1–64 characters.");
  }
  return { ...clean, ...(entities.length ? { entities } : {}),
    ...(draft.forward ? { forward: validateForwardSnapshot(draft.forward) } : {}) };
}
export async function sendAdvertisingMessage(token: string, chatId: string, draft: AdvertisingDraft, call: AdvertisingCaller = advertisingTelegram) {
  const message = validateAdvertisingDraft(draft, true);
  if (message.forward) throw new CommerceError("Saved Messages must be forwarded by the connected personal account, not rebuilt or sent by a bot.");
  const entities = message.entities?.map(({ documentId, ...e }) => ({ ...e, ...(documentId ? { custom_emoji_id: documentId } : {}) }));
  const body = {
    chat_id: chatId,
    ...(message.buttonUrl ? { reply_markup: { inline_keyboard: [[{ text: message.buttonText, url: message.buttonUrl }]] } } : {}),
  };
  // One message only; no resend on ambiguous media or network failure.
  if (message.imageUrl) {
    const gif = new URL(message.imageUrl).pathname.toLowerCase().endsWith(".gif");
    return call<{ message_id: number }>(token, gif ? "sendAnimation" : "sendPhoto",
      { ...body, [gif ? "animation" : "photo"]: message.imageUrl, caption: message.text, ...(entities?.length ? { caption_entities: entities } : {}) });
  }
  return call<{ message_id: number }>(token, "sendMessage", { ...body, text: message.text, ...(entities?.length ? { entities } : {}) });
}

export async function inspectAdvertisingGroup(token: string, botId: string, target: string, call: AdvertisingCaller = advertisingTelegram) {
  const chat = await call<{ id: number; type: string; title?: string; permissions?: { can_send_messages?: boolean; can_send_photos?: boolean; can_send_other_messages?: boolean } }>(token, "getChat", { chat_id: target });
  if (!["group", "supergroup", "channel"].includes(chat.type) || !Number.isSafeInteger(chat.id) || chat.id >= 0)
    throw new CommerceError("Only groups and channels are allowed—not private users or bots.");
  const member = await call<{ status: string; is_member?: boolean; can_send_messages?: boolean; can_post_messages?: boolean; can_send_photos?: boolean; can_send_other_messages?: boolean }>(token, "getChatMember", { chat_id: String(chat.id), user_id: Number(botId) });
  const admin = ["administrator", "creator"].includes(member.status);
  const allowed = chat.type === "channel" ? member.status === "creator" || (admin && member.can_post_messages === true)
    : admin || (member.status === "member" && chat.permissions?.can_send_messages !== false) ||
      (member.status === "restricted" && member.is_member !== false && member.can_send_messages === true);
  if (!allowed) throw new CommerceError("Add the advertising bot to this group and grant it permission to post.");
  return { chatId: String(chat.id), title: chat.title ?? target };
}
