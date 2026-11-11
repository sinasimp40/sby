import type { Payment } from "./commerce-payments";
import { coinNames, escapeHtml } from "./payment-message";
import { customerMessageText } from "./telegram-copy";

type HistoryPayment = Pick<Payment, "id" | "kind" | "productName" | "amountCents" | "coin" | "status" | "fulfillment" | "cancelledAt" | "expiresAt" | "createdAt">;

export function historyStatus(p: HistoryPayment, now = Date.now()) {
  if (p.status === "refunded") return "↩️ Refunded";
  if (p.fulfillment === "credited") return "✅ Successful · wallet credited";
  if (p.fulfillment === "delivered") return "✅ Successful · delivered";
  if (p.fulfillment === "review") return "⚠️ Needs support review";
  if (p.cancelledAt && ["creating", "waiting", "expired", "failed", "rejected"].includes(p.status)) return "❌ Cancelled";
  if (p.status === "expired" || (["waiting", "creating"].includes(p.status) && p.expiresAt && p.expiresAt.getTime() <= now)) return "⌛ Expired";
  if (["failed", "rejected"].includes(p.status)) return "❌ Failed";
  if (p.status === "partially_paid") return "⚠️ Partial payment";
  if (p.status === "confirming") return "🔄 Confirming";
  if (["confirmed", "sending", "finished"].includes(p.status)) {
    return p.kind === "deposit" ? "🔄 Processing · not credited yet" : "📦 Preparing delivery";
  }
  return p.status === "creating" ? "🕒 Preparing payment" : p.status === "waiting" ? "⏳ Waiting for payment" : "🔄 Processing";
}

export function historyCard(p: HistoryPayment, now = Date.now()) {
  const topup = p.kind === "deposit";
  const title = topup ? "Wallet top-up" : customerMessageText(p.productName);
  const safeTitle = escapeHtml(Array.from(title).slice(0, 100).join(""));
  const coin = coinNames[p.coin.toLowerCase()];
  const method = p.kind === "wallet" ? "Wallet balance" : coin ? `${coin.symbol} · ${coin.network}` : p.coin.toUpperCase();
  const date = p.createdAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return [
    "<blockquote>",
    `${topup ? "👛" : "🛍"} <b>${safeTitle}</b>`,
    `<i>${topup ? "Crypto deposit" : "Product purchase"}</i>`,
    "",
    `💵 Amount: <b>$${(p.amountCents / 100).toFixed(2)}</b>`,
    `💳 Payment: ${escapeHtml(method)}`,
    `<b>${historyStatus(p, now)}</b>`,
    ...(p.cancelledAt && ["confirming", "confirmed", "sending", "partially_paid"].includes(p.status) ? ["<i>Previously cancelled · payment checking continues</i>"] : []),
    `🗓 ${date}`,
    "",
    "🧾 Reference",
    `<code>${escapeHtml(p.id)}</code>`,
    "</blockquote>",
  ].join("\n");
}

export function historyMenu(payments: HistoryPayment[], now = Date.now()) {
  return {
    text: "🧾 <b>Orders &amp; top-ups</b>\n\n" + (payments.length
      ? "Tap a product to view its order and delivered inventory.\nTap a top-up to view its payment status.\n\n<i>Your latest 10 purchases and top-ups</i>"
      : "No purchases or wallet top-ups yet."),
    reply_markup: { inline_keyboard: [
      ...payments.slice(0, 10).map(p => {
        const status = historyStatus(p, now);
        const icon = status.split(" ")[0];
        const shortStatus = status.replace(/^\S+\s/, "").split(" · ")[0];
        const name = p.kind === "deposit" ? "Top-up" : Array.from(customerMessageText(p.productName)).slice(0, 28).join("");
        return [{ text: `${icon} ${name} · $${(p.amountCents / 100).toFixed(2)} · ${shortStatus}`, callback_data: `history_order:${p.id}:0` }];
      }),
      [{ text: "🔄 Refresh history", callback_data: "history" }],
      [{ text: "⏳ Pending payments", callback_data: "pending" }, { text: "🏠 Home", callback_data: "history_home" }],
    ] },
  };
}

export function historyOrderView(p: HistoryPayment, credential?: string, page = 0, now = Date.now()) {
  const card = historyCard(p, now);
  const parts: string[] = [];
  let part = "";
  // Split escaped content only between complete Unicode characters/entities.
  // Never substitute provider branding inside a delivered credential.
  if (credential !== undefined) {
    for (const character of credential) {
      const escaped = escapeHtml(character);
      if (part.length + escaped.length > 2400) { parts.push(part); part = ""; }
      part += escaped;
    }
    parts.push(part);
  }
  const currentPage = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, Math.max(parts.length - 1, 0)));
  const inventory = credential !== undefined
    ? `\n\n📦 <b>Delivered inventory${parts.length > 1 ? ` · part ${currentPage + 1}/${parts.length}` : ""}</b>\n<pre>${parts[currentPage]}</pre>\n<i>Keep these details private.</i>`
    : p.kind !== "deposit" ? "\n\n<i>No inventory has been delivered for this order yet.</i>" : "";
  const pages = [
    ...(currentPage > 0 ? [{ text: "⬅️ Previous part", callback_data: `history_order:${p.id}:${currentPage - 1}` }] : []),
    ...(currentPage < parts.length - 1 ? [{ text: "Next part ➡️", callback_data: `history_order:${p.id}:${currentPage + 1}` }] : []),
  ];
  return {
    text: `${card}${inventory}`,
    reply_markup: { inline_keyboard: [
      ...(pages.length ? [pages] : []),
      [{ text: "⬅️ Order history", callback_data: "history" }, { text: "🏠 Home", callback_data: "history_home" }],
    ] },
  };
}
