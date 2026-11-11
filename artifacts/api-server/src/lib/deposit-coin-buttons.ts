import { TelegramRequestError } from "./commerce-providers";
import { logger } from "./logger";

// Public animated custom emoji from https://t.me/addemoji/Cryptocoins_kotletovv.
// IDs and animation flags were verified with getStickerSet; logos were visually checked.
export const coinEmojiIds: Record<string, string> = {
  btc: "5242625806655570503",
  eth: "5246838478083211008",
  ltc: "5242585966538932843",
  sol: "5240212838194104761",
};

export function depositCoinKeyboard(coins: string[], token: string, animated = true) {
  return { inline_keyboard: [
    ...coins.map(coin => [{
      text: coin.toUpperCase(),
      callback_data: `pay:${token}:${coin.toLowerCase()}`,
      ...(animated && coinEmojiIds[coin.toLowerCase()] ? { icon_custom_emoji_id: coinEmojiIds[coin.toLowerCase()] } : {}),
    }]),
    [{ text: "✖️ Cancel", callback_data: "cancel_home" }],
  ] };
}

export async function sendDepositCoinMenu(
  send: (keyboard: ReturnType<typeof depositCoinKeyboard>) => Promise<unknown>,
  coins: string[], token: string,
) {
  try {
    return await send(depositCoinKeyboard(coins, token));
  } catch (error) {
    // Only retry a definite Telegram rejection, never an ambiguous timeout:
    // the first message may already have arrived in that case.
    if (!(error instanceof TelegramRequestError && error.operation === "sendMessage" && error.providerStatus === 400)) throw error;
    logger.warn("Telegram declined the coin menu with custom icons; retrying with plain payment buttons.");
    return send(depositCoinKeyboard(coins, token, false));
  }
}
