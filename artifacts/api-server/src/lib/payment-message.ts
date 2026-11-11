export interface InvoiceMessage {
  id: string;
  address: string;
  payAmount: string;
  coin: string;
  network: string;
  extraId: string | null;
  expiresAt: Date;
  title?: string;
  amountUSD?: string;
  status?: string;
  receivedAmount?: string | null;
  fulfillment?: string;
}
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function paymentKeyboard(p: InvoiceMessage) {
  const complete = ["delivered", "credited"].includes(p.fulfillment ?? "");
  return { inline_keyboard: [[{
    text: complete ? "🏠 Home" : "✖️ Cancel",
    callback_data: "cancel_home",
  }]] };
}
export const coinNames: Record<string, { symbol: string; network: string }> = {
  btc: { symbol: "BTC", network: "Bitcoin" },
  eth: { symbol: "ETH", network: "Ethereum" },
  ltc: { symbol: "LTC", network: "Litecoin" },
  usdterc20: { symbol: "USDT", network: "Ethereum · ERC20" },
  usdttrc20: { symbol: "USDT", network: "TRON · TRC20" },
  bnbbsc: { symbol: "BNB", network: "BNB Smart Chain · BEP20" },
  sol: { symbol: "SOL", network: "Solana" },
};
export function paymentStatusLabel(p: InvoiceMessage, now = Date.now()) {
  const status = p.status ?? "waiting";
  const fulfilled = ["delivered", "credited"].includes(p.fulfillment ?? "");
  const quoteExpired = p.expiresAt.getTime() <= now;
  const labels: Record<string, string> = {
    creating: "Preparing payment",
    waiting: quoteExpired ? "Quote expired — do not send funds" : "Awaiting payment",
    confirming: "Payment detected · confirming",
    confirmed: "Blockchain confirmed · processing",
    sending: "Settlement in progress",
    partially_paid: "Partial payment received",
    finished: fulfilled ? (p.fulfillment === "credited" ? "Complete · wallet credited" : "Complete · order delivered") :
      p.fulfillment === "review" ? "Payment received · support review required" : "Payment received · finalizing",
    expired: "Expired — do not send funds", failed: "Payment failed", refunded: "Refunded", rejected: "Invoice rejected",
  };
  return labels[status] ?? "Payment processing";
}
export function paymentCaption(p: InvoiceMessage, now = Date.now()) {
  const coin = coinNames[p.coin.toLowerCase()] ?? { symbol: p.coin.toUpperCase(), network: p.network };
  const status = p.status ?? "waiting";
  const fulfilled = ["delivered", "credited"].includes(p.fulfillment ?? "");
  const closed = ["failed", "expired", "refunded", "rejected"].includes(status);
  const quoteExpired = p.expiresAt.getTime() <= now;
  const canPay = !closed && !fulfilled && p.fulfillment !== "review" && !quoteExpired && status === "waiting";
  const statusIcon = fulfilled ? "✅" :
    p.fulfillment === "review" || status === "partially_paid" ? "⚠️" :
    closed ? (status === "refunded" ? "↩️" : "❌") :
    quoteExpired && status === "waiting" ? "⌛" :
    status === "waiting" ? "⏳" : "🔄";
  const stamp = p.expiresAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    `💳 <b>${escapeHtml((p.title ?? "Payment").replace(/nowpayments/gi, "Payment").slice(0, 60))}</b>`,
    ...(p.amountUSD ? [`Total: <b>$${escapeHtml(p.amountUSD)}</b>`] : []),
    "",
    `${statusIcon} <b>${escapeHtml(paymentStatusLabel(p, now))}</b>`,
    "",
    `🪙 <b>${canPay ? "Send exactly" : "Invoice amount"}</b>`,
    `<code>${escapeHtml(p.payAmount)} ${escapeHtml(coin.symbol)}</code>`,
    `Network: <b>${escapeHtml(coin.network)}</b>`,
    ...(canPay ? ["", "📋 <b>Payment address</b>", `<code>${escapeHtml(p.address)}</code>`] : []),
    ...(p.extraId && canPay ? ["", "⚠️ <b>Required memo / tag</b>", `<code>${escapeHtml(p.extraId)}</code>`] : []),
    "",
    `💰 Received: <b>${escapeHtml(p.receivedAmount ?? "0")} ${escapeHtml(coin.symbol)}</b>`,
    ...(canPay ? [`🕒 Pay before: <b>${stamp}</b>`] : []),
    "",
    fulfilled ? "🎉 Complete. Do not send another payment." :
      closed || quoteExpired && ["waiting", "partially_paid"].includes(status) ? "⚠️ Do not send funds to this invoice.\nAlready paid? Automatic checking continues." :
      p.fulfillment === "review" ? "💬 Contact support with your reference.\nDo not pay again." :
      status === "partially_paid" ? "💬 Contact support before sending more." :
      "🔄 <i>Status updates here automatically.</i>\nCredit follows final payment verification.",
    ...(canPay ? ["", "<i>QR contains the address only.\nEnter the exact amount shown above.</i>"] : []),
    "",
    `🧾 <i>Reference: ${escapeHtml(p.id.slice(0, 8))}</i>`,
  ];
  const caption = lines.join("\n");
  if (caption.length > 1024) throw new Error("Invoice caption exceeds Telegram limit.");
  return caption;
}
