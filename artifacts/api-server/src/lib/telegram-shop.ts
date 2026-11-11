import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, pool, botCustomers, botUpdates, shopPayments } from "@workspace/db";
import { activeConnection } from "./commerce-connection";
import { CommerceError, moneyCents, telegram } from "./commerce-providers";
import { cancelCustomerPayment, createCheckout, checkPayment, invoiceDetails, sendCheckout } from "./commerce-payments";
import { dismissCustomerMessage } from "./telegram-navigation";
import { productsForOwner, settingsForOwner } from "./shop-store";
import { getBotRuntime } from "./bot-runtime";
import { customerMessageText, depositCoinPrompt, depositPrompt, walletSummary } from "./telegram-copy";
import { telegramCustomerName, type TelegramCustomerProfile } from "./telegram-customer-name";
import { customerPendingPayments, pendingPaymentsMenu, PendingPaymentsError } from "./pending-payments";
import { paymentCaption } from "./payment-message";

interface TelegramMessage {
  message_id?: number;
  photo?: Array<{ file_id?: string }>;
  chat: { id: number; type: string };
  from?: TelegramCustomerProfile & { id: number; is_bot?: boolean };
  text?: string;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramCustomerProfile & { id: number }; message?: TelegramMessage; data?: string };
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new CommerceError("Invalid Telegram update.");
  const connection = await activeConnection();
  if (!connection || connection.active !== "yes" || !(await getBotRuntime()).enabled) throw new CommerceError("Bot is not active.", 503);
  const message = update.callback_query?.message ?? update.message;
  const from = update.callback_query?.from ?? message?.from;
  if (!message || message.chat?.type !== "private" || !from || !Number.isSafeInteger(from.id) ||
    String(message.chat.id) !== String(from.id)) return;
  const client = await pool.connect();
  const eventId = `${connection.botId}:${update.update_id}`;
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 2)) AS locked", [eventId]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new CommerceError("Update is being processed. Retry shortly.", 503);
    const [seen] = await db.select().from(botUpdates).where(eq(botUpdates.id, eventId));
    if (seen) return;
    const username = telegramCustomerName(from);
    const [customer] = await db.insert(botCustomers).values({
      id: randomUUID(), ownerId: connection.ownerId, telegramId: String(from.id),
      chatId: String(message.chat.id), username,
    }).onConflictDoUpdate({
      target: [botCustomers.ownerId, botCustomers.telegramId], set: { username, chatId: String(message.chat.id) },
    }).returning();
    const settings = await settingsForOwner(connection.ownerId);
    const send = (text: string, reply_markup?: object, parse_mode?: "HTML") => telegram("sendMessage", {
      chat_id: customer!.chatId, text: customerMessageText(text), ...(reply_markup ? { reply_markup } : {}),
      ...(parse_mode ? { parse_mode } : {}),
    });
    const labels = [
      [`🛍 ${settings.productsLabel}`, `💬 ${settings.supportLabel}`],
      [`👛 ${settings.walletLabel}`, `🧿 ${settings.ordersLabel}`],
    ];
    const text = message.text?.trim() ?? "";
    const data = update.callback_query?.data ?? "";
    const showPending = async () => {
      const menu = pendingPaymentsMenu(await customerPendingPayments(connection.ownerId, customer!.id));
      await send(menu.text, menu.reply_markup, "HTML");
    };
    try {
      if (update.callback_query) {
        // Acknowledge promptly; this has no financial side effects.
        // Telegram can expire the spinner acknowledgment before retrying a webhook.
        // Its failure must not block idempotent checkout/delivery recovery.
        await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => undefined);
      }
      if (data === "cancel_home") {
        const removed = Number.isSafeInteger(message.message_id)
          ? await dismissCustomerMessage(connection.ownerId, customer!.id, message.message_id!) : true;
        await db.update(botCustomers).set({ state: {} }).where(eq(botCustomers.id, customer!.id));
        await send(`${settings.welcomeMessage}${message.photo?.length ? "\n\n🏠 Returned to the home menu.\nAny payment already sent will still be checked automatically." : ""}${removed ? "" : "\n\nTelegram no longer allows deleting this older message. Its buttons have been disabled."}`, {
          keyboard: labels.map(row => row.map(label => ({ text: label }))), resize_keyboard: true, is_persistent: true,
        });
      } else if (data === "pending" || text === "/pending") {
        await showPending();
      } else if (data.startsWith("pending_view:") || data.startsWith("pending_cancel:")) {
        const id = data.slice(data.indexOf(":") + 1);
        const [payment] = await db.select().from(shopPayments).where(and(
          eq(shopPayments.id, id), eq(shopPayments.ownerId, connection.ownerId), eq(shopPayments.customerId, customer!.id),
        ));
        if (!payment || payment.kind === "wallet") throw new CommerceError("Payment not found.");
        if (data.startsWith("pending_cancel:")) {
          const complete = Boolean(payment.deliveredAt) || ["allocated", "credited", "delivered"].includes(payment.fulfillment);
          if (!complete) {
            await cancelCustomerPayment(connection.ownerId, customer!.id, payment.id);
            if (payment.invoiceMessageId) await dismissCustomerMessage(connection.ownerId, customer!.id, payment.invoiceMessageId);
          }
          if (Number.isSafeInteger(message.message_id) && message.message_id !== payment.invoiceMessageId) {
            await dismissCustomerMessage(connection.ownerId, customer!.id, message.message_id!);
          }
          await send(complete ? "✅ This payment is already complete. Nothing was cancelled." : "✅ Payment selection cancelled. Transfers already sent will still be checked.");
          await showPending();
        } else if (payment.address && payment.payAmount && payment.expiresAt) {
          await send(paymentCaption(invoiceDetails(payment)), { inline_keyboard: [
            [{ text: "✖️ Cancel invoice", callback_data: `pending_cancel:${payment.id}` }],
            [{ text: "⬅️ Pending payments", callback_data: "pending" }],
          ] }, "HTML");
        } else {
          await send("⏳ Payment details are not available yet. Do not create a replacement if you already sent funds.", {
            inline_keyboard: [[{ text: "✖️ Cancel selection", callback_data: `pending_cancel:${payment.id}` }, { text: "⬅️ Back", callback_data: "pending" }]],
          });
        }
      } else if (data.startsWith("check:")) {
        const id = data.slice(6);
        const [payment] = await db.select().from(shopPayments).where(and(eq(shopPayments.id, id), eq(shopPayments.customerId, customer!.id)));
        if (!payment) throw new CommerceError("Payment not found.");
        if (!payment.invoiceMessageId && message.photo?.length && Number.isSafeInteger(message.message_id)) {
          await db.update(shopPayments).set({ invoiceMessageId: message.message_id!, invoiceNeedsUpdate: true }).where(eq(shopPayments.id, payment.id));
        }
        const checked = await checkPayment(payment.id);
        // Backward compatibility for old invoices: the first callback registers
        // their message reference, refreshes the caption and removes the button.
      } else if (/^buy:\d+$/.test(data)) {
        const products = await productsForOwner(connection.ownerId);
        const product = products.find(p => p.id === Number(data.slice(4)) && p.status === "active" && p.stock > 0);
        if (!product) throw new CommerceError("This product is out of stock or no longer available.");
        const token = randomUUID();
        await db.update(botCustomers).set({ state: {
          type: "purchase", token, productId: product.id, amountCents: Math.round(product.price * 100), expires: Date.now() + 10 * 60000,
        } }).where(eq(botCustomers.id, customer!.id));
        await send(`${product.name}\n${product.description}\nPrice: $${product.price.toFixed(2)}\nWallet balance: $${(customer!.balanceCents / 100).toFixed(2)}\nProducts are paid with wallet balance only. Deposit first if needed. One account per purchase.`, {
          inline_keyboard: [
            [{ text: "Pay with wallet balance", callback_data: `wal:${token}` }],
            [{ text: "Add funds to wallet", callback_data: "deposit" }],
          ],
        });
      } else if (data === "deposit" || data === "deposit_new") {
        const pending = await customerPendingPayments(connection.ownerId, customer!.id);
        if (pending.length && data === "deposit") {
          await showPending();
        } else {
          if (pending.length >= 3) throw new PendingPaymentsError();
          await db.update(botCustomers).set({ state: { type: "deposit-amount" } }).where(eq(botCustomers.id, customer!.id));
          await send(depositPrompt(settings.minDeposit), {
            inline_keyboard: [[{ text: "✖️ Cancel", callback_data: "cancel_home" }]],
          }, "HTML");
        }
      } else if (data.startsWith("pay:") || data.startsWith("wal:")) {
        const parts = data.split(":");
        const state = customer!.state;
        if (parts[1] !== state.token || !["purchase", "deposit"].includes(String(state.type)) || Number(state.expires) < Date.now()) {
          throw new CommerceError("This selection expired. Select the product or deposit amount again.");
        }
        const wallet = parts[0] === "wal";
        if (wallet && state.type !== "purchase") throw new CommerceError("Invalid payment method.");
        if (!wallet && state.type === "purchase") throw new CommerceError("Products now use wallet balance only. Open Wallet → Deposit to add funds, then select the product again.");
        const productId = state.type === "purchase" ? Number(state.productId) : undefined;
        if (productId) {
          const product = (await productsForOwner(connection.ownerId)).find(p => p.id === productId);
          if (!product || Math.round(product.price * 100) !== state.amountCents) throw new CommerceError("The price changed. Select this product again.");
        }
        const payment = await createCheckout({
          ownerId: connection.ownerId, customerId: customer!.id, token: String(state.token),
          coin: wallet ? "usd" : parts[2] ?? "", productId,
          depositCents: state.type === "deposit" ? Number(state.amountCents) : undefined, wallet,
          expectedAmountCents: Number(state.amountCents),
        });
        await sendCheckout(payment);
      } else if (text === "/cancel" || text === "/start" || text.startsWith("/start ")) {
        await db.update(botCustomers).set({ state: {} }).where(eq(botCustomers.id, customer!.id));
        await send(text === "/cancel" ? "Cancelled. Choose an option below." : settings.welcomeMessage, {
          keyboard: labels.map(row => row.map(label => ({ text: label }))), resize_keyboard: true, is_persistent: true,
        });
      } else if ([settings.productsLabel, labels[0]![0], "/products"].includes(text)) {
        const products = (await productsForOwner(connection.ownerId)).filter(p => p.status === "active" && p.stock > 0).slice(0, 25);
        await send(products.length ? "Choose a product:" : "No products are available right now.", products.length ? {
          inline_keyboard: products.map(p => [{ text: `${p.name.slice(0, 35)} · $${p.price.toFixed(2)} · ${p.stock} left`, callback_data: `buy:${p.id}` }]),
        } : undefined);
      } else if ([settings.supportLabel, labels[0]![1], "/support"].includes(text)) {
        await send(`${settings.supportMessage}${settings.supportUsername ? `\n@${settings.supportUsername.replace(/^@/, "")}` : ""}`);
      } else if ([settings.walletLabel, labels[1]![0], "/wallet"].includes(text)) {
        await send(walletSummary(customer!.balanceCents, settings.minDeposit), {
          inline_keyboard: [
            [{ text: "💳 Deposit", callback_data: "deposit" }],
            [{ text: "⏳ Pending payments", callback_data: "pending" }],
          ],
        }, "HTML");
      } else if ([settings.ordersLabel, labels[1]![1], "/orders"].includes(text)) {
        const orders = await db.select().from(shopPayments).where(eq(shopPayments.customerId, customer!.id)).orderBy(desc(shopPayments.createdAt)).limit(10);
        await send(orders.length ? orders.map(p => `${p.productName} · $${(p.amountCents / 100).toFixed(2)}\n${p.id}\n${p.cancelledAt && p.fulfillment !== "credited" && p.status === "waiting" ? "Cancelled" : p.status} · ${p.fulfillment}`).join("\n\n") : "You have no orders or deposits yet.", orders.length ? {
          inline_keyboard: [],
        } : undefined);
      } else if (customer!.state.type === "deposit-amount") {
        const amountCents = moneyCents(text);
        if (amountCents < Math.round(settings.minDeposit * 100)) throw new CommerceError(`Minimum deposit is $${settings.minDeposit.toFixed(2)}.`);
        const token = randomUUID();
        await db.update(botCustomers).set({ state: { type: "deposit", token, amountCents, expires: Date.now() + 10 * 60000 } }).where(eq(botCustomers.id, customer!.id));
        await send(depositCoinPrompt(amountCents), {
          inline_keyboard: [
            ...settings.acceptedCoins.map(coin => [{ text: coin, callback_data: `pay:${token}:${coin.toLowerCase()}` }]),
            [{ text: "✖️ Cancel", callback_data: "cancel_home" }],
          ],
        }, "HTML");
      } else {
        await send("Use /start to open the menu, or /cancel to cancel a deposit.");
      }
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      if (error.status === 502 || error.status === 503) throw error; // Telegram retries; requestKey prevents duplicate financial writes.
      if (error instanceof PendingPaymentsError) await showPending();
      else await send(error.message);
    }
    await db.insert(botUpdates).values({ id: eventId }).onConflictDoNothing();
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 2))", [eventId]);
    client.release();
  }
}
