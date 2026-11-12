import { escapeHtml } from "./payment-message";
import { customerMessageText } from "./telegram-copy";
import { MAX_PURCHASE_QUANTITY } from "./checkout-allocation";
import { productNameHtml, type ProductName } from "./product-name";

interface ProductView extends ProductName { description: string; stock: number; price: number }
const name = (product: { name: string }) => escapeHtml(customerMessageText(product.name).slice(0, 120));
export function quantityPrompt(product: ProductView, balanceCents: number, customIcons = true) {
  return [
    productNameHtml(product, customIcons),
    ...(product.description ? ["", escapeHtml(customerMessageText(product.description).slice(0, 500))] : []),
    "", `💵 Unit price: <b>$${product.price.toFixed(2)}</b>`,
    `📦 Stock left: <b>${product.stock}</b>`,
    `👛 Wallet balance: <b>$${(balanceCents / 100).toFixed(2)}</b>`,
    "", "🔢 <b>Enter quantity</b>",
    `Type a whole number from <b>1 to ${Math.min(product.stock, MAX_PURCHASE_QUANTITY)}</b> in the chat and send it.`,
    "", "<i>Stock is checked again before payment. Nothing is charged yet.</i>",
  ].join("\n");
}
export function quantityKeyboard() {
  return { inline_keyboard: [
    [{ text: "🏠 Cancel", callback_data: "cancel_home" }],
  ] };
}
export function purchaseConfirmation(product: ProductView, quantity: number, balanceCents: number, customIcons = true) {
  const total = Math.round(product.price * 100) * quantity;
  const shortfall = Math.max(0, total - balanceCents);
  return [
    "🧾 <b>Confirm your purchase</b>", "", productNameHtml(product, customIcons),
    `📦 Stock left: <b>${product.stock}</b>`,
    `🔢 Quantity: <b>${quantity}</b>`,
    `💵 Unit price: <b>$${product.price.toFixed(2)}</b>`,
    "", `💰 <b>Total: $${(total / 100).toFixed(2)}</b>`,
    `👛 Wallet balance: <b>$${(balanceCents / 100).toFixed(2)}</b>`,
    shortfall ? `⚠️ Add <b>$${(shortfall / 100).toFixed(2)}</b> to cover this purchase.`
      : `After purchase: <b>$${((balanceCents - total) / 100).toFixed(2)}</b>`,
    "", "<i>Your wallet is charged only when you confirm. All selected accounts are delivered together.</i>",
  ].join("\n");
}
export function purchaseDeliveryHeader(payment: { productName: string; quantity?: number; amountCents: number; id: string }, balanceCents: number) {
  return [
    "✅ <b>Purchase complete</b>", "", `🛍 <b>${name({ name: payment.productName })}</b>`,
    `🔢 Quantity: <b>${payment.quantity ?? 1}</b>`,
    `💵 Paid: <b>$${(payment.amountCents / 100).toFixed(2)}</b>`,
    `👛 Wallet balance: <b>$${(balanceCents / 100).toFixed(2)}</b>`,
    "", `🧾 Order: <code>${escapeHtml(payment.id)}</code>`,
  ].join("\n");
}
