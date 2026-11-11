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
export const coinNames: Record<string, { symbol: string; network: string }> = {
  btc: { symbol: "BTC", network: "Bitcoin" },
  eth: { symbol: "ETH", network: "Ethereum" },
  ltc: { symbol: "LTC", network: "Litecoin" },
  usdterc20: { symbol: "USDT", network: "Ethereum · ERC20" },
  usdttrc20: { symbol: "USDT", network: "TRON · TRC20" },
  bnbbsc: { symbol: "BNB", network: "BNB Smart Chain · BEP20" },
  sol: { symbol: "SOL", network: "Solana" },
};
export function paymentCaption(p: InvoiceMessage, now = Date.now()) {
  const coin = coinNames[p.coin.toLowerCase()] ?? { symbol: p.coin.toUpperCase(), network: p.network };
  const status = p.status ?? "waiting";
  const fulfilled = ["delivered", "credited"].includes(p.fulfillment ?? "");
  const closed = ["failed", "expired", "refunded", "rejected"].includes(status);
  const quoteExpired = p.expiresAt.getTime() <= now;
  const labels: Record<string, string> = {
    waiting: quoteExpired ? "Quote expired — do not send funds" : "Awaiting payment",
    confirming: "Payment detected · confirming",
    confirmed: "Blockchain confirmed · processing",
    sending: "Settlement in progress",
    partially_paid: "Partial payment received",
    finished: fulfilled ? (p.fulfillment === "credited" ? "Complete · wallet credited" : "Complete · order delivered") :
      p.fulfillment === "review" ? "Payment received · support review required" : "Payment received · preparing delivery",
    expired: "Expired — do not send funds", failed: "Payment failed", refunded: "Refunded", rejected: "Invoice rejected",
  };
  const stamp = p.expiresAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = [
    `<b>${escapeHtml((p.title ?? "Payment").slice(0, 60))}</b>${p.amountUSD ? ` · $${escapeHtml(p.amountUSD)}` : ""}`,
    `<b>${escapeHtml(labels[status] ?? status)}</b>`,
    "",
    `Amount: <code>${escapeHtml(p.payAmount)} ${escapeHtml(coin.symbol)}</code>`,
    `Network: <b>${escapeHtml(coin.network)}</b>`,
    ...(!closed && status !== "finished" ? ["", "<b>Payment address</b>", `<code>${escapeHtml(p.address)}</code>`] : []),
    ...(p.extraId && !closed && status !== "finished" ? [`Memo / tag: <code>${escapeHtml(p.extraId)}</code>`] : []),
    "",
    `Received: <b>${escapeHtml(p.receivedAmount ?? "0")} ${escapeHtml(coin.symbol)}</b>`,
    ...(status === "waiting" || status === "partially_paid" ? [`Quote expires: ${stamp}`] : []),
    fulfilled ? "Payment complete. Do not pay this invoice again." :
      closed || quoteExpired && status === "waiting" ? "Already paid? Detection continues automatically." :
      "Updates automatically · credit/delivery after finished",
    `<i>Ref ${escapeHtml(p.id.slice(0, 8))} · NOWPayments</i>`,
    ...(!closed && status === "waiting" && !quoteExpired ? ["<i>QR = address only. Enter the exact amount above.</i>"] : []),
  ];
  const caption = lines.join("\n");
  if (caption.length > 1024) throw new Error("Invoice caption exceeds Telegram limit.");
  return caption;
}
