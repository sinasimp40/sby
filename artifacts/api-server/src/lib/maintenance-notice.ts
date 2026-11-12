import { telegram } from "./commerce-providers";

export const MAINTENANCE_NOTICE = "The shop is temporarily paused for maintenance. Please try again later.\n\nPayments already sent will still be checked automatically.";

export async function sendMaintenanceNotice(chatId: string, send: typeof telegram = telegram) {
  return send("sendMessage", {
    chat_id: chatId, text: MAINTENANCE_NOTICE,
    reply_markup: { remove_keyboard: true },
  });
}
