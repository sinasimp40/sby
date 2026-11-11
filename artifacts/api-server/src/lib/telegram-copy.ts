import { escapeHtml } from "./payment-message";

// Customer messages use shop-neutral wording; provider names stay in admin tools.
export const customerMessageText = (text: string) => text.replace(/nowpayments/gi, "the payment service");

export function depositPrompt(minimum: number) {
  return [
    "💳 <b>Add funds to your wallet</b>",
    "",
    "Enter the amount you want to deposit in USD.",
    `💵 Minimum deposit: <b>$${minimum.toFixed(2)}</b>`,
    "",
    "✍️ Example: <code>10.00</code>",
    "<i>Some coins may require a higher minimum.</i>",
    "",
    "↩️ Send /cancel to go back.",
  ].join("\n");
}

export function walletSummary(balanceCents: number, minimum: number) {
  return [
    "👛 <b>Your wallet</b>",
    "",
    `Available balance: <b>$${(balanceCents / 100).toFixed(2)}</b>`,
    "",
    "🛍 Use your balance to purchase products.",
    `Minimum deposit: <b>$${minimum.toFixed(2)}</b>`,
    "",
    "🔄 <i>Deposits are credited automatically after final payment verification.</i>",
  ].join("\n");
}

export function depositCoinPrompt(amountCents: number) {
  return [
    "🪙 <b>Choose your deposit coin</b>",
    "",
    `Deposit amount: <b>$${(amountCents / 100).toFixed(2)}</b>`,
    "",
    "Choose a coin below to get your QR code",
    "and payment details.",
    "",
    "⚠️ <i>Use only the network shown on your invoice.</i>",
  ].join("\n");
}

export function depositReceipt(amountCents: number, id: string) {
  return `✅ <b>Deposit complete</b>\n\n💵 <b>$${(amountCents / 100).toFixed(2)}</b> added to your wallet.\n\n🛍 You're ready to shop!\nOpen Products and pay with your wallet balance.\n\n🧾 <b>Reference</b>\n<code>${escapeHtml(id)}</code>`;
}
