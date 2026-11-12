import type { CoinButtonIcon } from "@workspace/api-zod";
import { withCustomEmojiFallback } from "./custom-emoji-delivery";

export const coinNames: Record<string, string> = {
  BTC: "Bitcoin · BTC", ETH: "Ethereum · ETH", LTC: "Litecoin · LTC", SOL: "Solana · SOL",
  USDTTRC20: "USDT · TRON (TRC20)", USDTERC20: "USDT · Ethereum (ERC20)", BNBBSC: "BNB · Smart Chain (BSC)",
};
export const coinSymbols: Record<string, string> = { BTC: "₿", ETH: "Ξ", LTC: "Ł", SOL: "◎", USDTTRC20: "₮", USDTERC20: "₮", BNBBSC: "◆" };
export const staticCoinLabels = Object.fromEntries(Object.entries(coinNames).map(([coin, name]) => [coin.toLowerCase(), `${coinSymbols[coin]}  ${name}`]));

export function depositCoinKeyboard(coins: string[], token: string, icons: Record<string, CoinButtonIcon> = {}, customIcons = true) {
  return { inline_keyboard: [
    ...coins.map(coin => {
      const key = coin.toUpperCase(), icon = icons[key];
      const customId = customIcons && /^\d{1,32}$/.test(icon?.customEmojiId ?? "") ? icon!.customEmojiId : null;
      const normal = icon?.emoji ?? coinSymbols[key] ?? "🪙";
      const label = coinNames[key] ?? key;
      return [{
        text: `${!customId && normal ? `${normal}  ` : ""}${label}`,
        callback_data: `pay:${token}:${coin.toLowerCase()}`,
        ...(customId ? { icon_custom_emoji_id: customId } : {}),
      }];
    }),
    [{ text: "✖️ Cancel", callback_data: "cancel_home" }],
  ] };
}
export async function sendDepositCoinMenu(
  send: (keyboard: ReturnType<typeof depositCoinKeyboard>) => Promise<unknown>, coins: string[], token: string,
  icons: Record<string, CoinButtonIcon> = {},
) {
  const keyboard = depositCoinKeyboard(coins, token, icons);
  if (!keyboard.inline_keyboard.some(row => row.some(button => "icon_custom_emoji_id" in button))) return send(keyboard);
  return withCustomEmojiFallback(
    () => send(keyboard),
    () => send(depositCoinKeyboard(coins, token, icons, false)),
  );
}
