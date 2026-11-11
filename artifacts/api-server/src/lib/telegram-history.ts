import type { Payment } from "./commerce-payments";
import { coinNames, escapeHtml } from "./payment-message";
import { customerMessageText } from "./telegram-copy";

type HistoryPayment = Pick<Payment, "id" | "kind" | "productName" | "amountCents" | "coin" | "status" | "fulfillment" | "cancelledAt" | "expiresAt" | "createdAt">;
export type TopupCategory = "w" | "c" | "e" | "s" | "p" | "f" | "r" | "v";
export type HistoryScope = "o" | TopupCategory;
export interface HistoryPage {
  payments: HistoryPayment[];
  page: number;
  total: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
export interface HistoryView {
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}
export const topupCategories: Record<TopupCategory, string> = {
  w: "⏳ Waiting", c: "❌ Cancelled", e: "⌛ Expired", s: "✅ Successful",
  p: "🔄 Processing", f: "❌ Failed", r: "↩️ Refunded", v: "⚠️ Needs review",
};
export const isHistoryScope = (value: string): value is HistoryScope => value === "o" || Object.hasOwn(topupCategories, value);

function pageButtons(list: HistoryPage, scope: HistoryScope) {
  return [
    ...(list.hasPrevious ? [{ text: "⬅️ Previous", callback_data: `hist:${scope}:${list.page - 1}` }] : []),
    ...(list.hasNext ? [{ text: "Next ➡️", callback_data: `hist:${scope}:${list.page + 1}` }] : []),
  ];
}

function orderButton(p: HistoryPayment, scope: HistoryScope, page: number, now: number) {
  const status = historyStatus(p, now);
  const icon = status.split(" ")[0];
  const shortStatus = status.replace(/^\S+\s/, "").split(" · ")[0];
  const name = p.kind === "deposit" ? `${p.coin.toUpperCase()} · ${p.id.slice(0, 8)}` : Array.from(customerMessageText(p.productName)).slice(0, 28).join("");
  return {
    text: `${icon} ${name} · $${(p.amountCents / 100).toFixed(2)} · ${shortStatus}`,
    callback_data: `ho:${p.id}:0:${scope}:${page}`,
  };
}

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

export function historyMenu(list: HistoryPage, topupCount: number, now = Date.now()): HistoryView {
  const navigation = pageButtons(list, "o");
  return {
    text: `🧾 <b>Order history</b>\n\nTap a product to view its delivered inventory.\nOpen Top-ups to browse deposits by status.\n\n<i>Purchases · page ${list.page + 1}/${Math.max(1, Math.ceil(list.total / 10))} · ${list.total} total</i>${list.total ? "" : "\nNo purchases yet."}`,
    reply_markup: { inline_keyboard: [
      [{ text: `👛 Top-ups (${topupCount})`, callback_data: "hist:t" }],
      ...list.payments.slice(0, 10).map(p => [orderButton(p, "o", list.page, now)]),
      ...(navigation.length ? [navigation] : []),
      [{ text: "🔄 Refresh history", callback_data: `hist:o:${list.page}` }],
      [{ text: "⏳ Pending payments", callback_data: "pending" }, { text: "🏠 Home", callback_data: "history_home" }],
    ] },
  };
}

export function topupCategoryMenu(counts: Record<TopupCategory, number>): HistoryView {
  return {
    text: "👛 <b>Top-ups</b>\n\nChoose a status to view your deposits.",
    reply_markup: { inline_keyboard: [
      ...(["w", "c", "e", "s", "p", "f", "r", "v"] as TopupCategory[])
        .filter(category => ["w", "c", "e", "s"].includes(category) || counts[category] > 0)
        .map(category => [{ text: `${topupCategories[category]} (${counts[category]})`, callback_data: `hist:${category}:0` }]),
      [{ text: "⬅️ Order history", callback_data: "hist:o:0" }, { text: "🏠 Home", callback_data: "history_home" }],
    ] },
  };
}

export function topupListMenu(list: HistoryPage, category: TopupCategory, now = Date.now()): HistoryView {
  const navigation = pageButtons(list, category);
  return {
    text: `${topupCategories[category]} <b>top-ups</b>\n\n${list.total ? "Tap a deposit for details." : "No top-ups in this category."}\n\n<i>Page ${list.page + 1}/${Math.max(1, Math.ceil(list.total / 10))} · ${list.total} total</i>`,
    reply_markup: { inline_keyboard: [
      ...list.payments.slice(0, 10).map(p => [orderButton(p, category, list.page, now)]),
      ...(navigation.length ? [navigation] : []),
      [{ text: "🔄 Refresh", callback_data: `hist:${category}:${list.page}` }],
      [{ text: "⬅️ Top-ups", callback_data: "hist:t" }, { text: "🏠 Home", callback_data: "history_home" }],
    ] },
  };
}

export function historyOrderView(p: HistoryPayment, credential?: string, page = 0, now = Date.now(), scope: HistoryScope = "o", listPage = 0): HistoryView {
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
    ...(currentPage > 0 ? [{ text: "⬅️ Previous part", callback_data: `ho:${p.id}:${currentPage - 1}:${scope}:${listPage}` }] : []),
    ...(currentPage < parts.length - 1 ? [{ text: "Next part ➡️", callback_data: `ho:${p.id}:${currentPage + 1}:${scope}:${listPage}` }] : []),
  ];
  return {
    text: `${card}${inventory}`,
    reply_markup: { inline_keyboard: [
      ...(pages.length ? [pages] : []),
      [{ text: "⬅️ Back to list", callback_data: `hist:${scope}:${listPage}` }, { text: "🏠 Home", callback_data: "history_home" }],
    ] },
  };
}
