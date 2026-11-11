// Ordinary Unicode symbols: no custom emoji, Premium or bot-owner eligibility.
export const staticCoinLabels: Record<string, string> = {
  btc: "₿  Bitcoin · BTC", eth: "Ξ  Ethereum · ETH",
  ltc: "Ł  Litecoin · LTC", sol: "◎  Solana · SOL",
};
export function depositCoinKeyboard(coins: string[], token: string) {
  return { inline_keyboard: [
    ...coins.map(coin => [{
      text: staticCoinLabels[coin.toLowerCase()] ?? `🪙 ${coin.toUpperCase()}`,
      callback_data: `pay:${token}:${coin.toLowerCase()}`,
    }]),
    [{ text: "✖️ Cancel", callback_data: "cancel_home" }],
  ] };
}
export async function sendDepositCoinMenu(
  send: (keyboard: ReturnType<typeof depositCoinKeyboard>) => Promise<unknown>, coins: string[], token: string,
) {
  return send(depositCoinKeyboard(coins, token));
}
