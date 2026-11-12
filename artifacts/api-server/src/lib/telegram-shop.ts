import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool, botCustomers, botUpdates, shopPayments } from "@workspace/db";
import { activeConnection } from "./commerce-connection";
import { CommerceError, moneyCents, telegram, TelegramRequestError } from "./commerce-providers";
import { cancelCustomerPayment, createCheckout, checkPayment, invoiceDetails, sendCheckout } from "./commerce-payments";
import { dismissCustomerMessage } from "./telegram-navigation";
import { productsForOwner, settingsForOwner } from "./shop-store";
import { getBotRuntime } from "./bot-runtime";
import { customerMessageText, depositCoinPrompt, depositPrompt, walletSummary } from "./telegram-copy";
import { telegramCustomerName, type TelegramCustomerProfile } from "./telegram-customer-name";
import { customerPendingPayments, pendingPaymentsMenu, PendingPaymentsError } from "./pending-payments";
import { paymentCaption } from "./payment-message";
import { historyMenu, historyOrderView, isHistoryScope, topupCategoryMenu, topupListMenu, type HistoryView } from "./telegram-history";
import { customerHistoryPage, customerHistorySummary } from "./telegram-history-store";
import { sendDepositCoinMenu } from "./deposit-coin-buttons";
import { customerDeliveredInventory } from "./order-delivery";
import { quantityPrompt, quantityKeyboard, purchaseConfirmation } from "./purchase-copy";
import { sendProductCard, editProductQuote } from "./product-media";
import { MAX_PURCHASE_QUANTITY } from "./checkout-allocation";
import { productCatalogMenu, productOptionsMenu } from "./telegram-catalog";
import { handleEmojiImportMessage, type EmojiImportMessage } from "./emoji-import-session";
import { withCustomEmojiFallback } from "./custom-emoji-delivery";

interface TelegramMessage extends EmojiImportMessage {
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
    // A dashboard-authorized import never becomes a shop customer or purchase selection.
    if (!update.callback_query) {
      try {
        if (await handleEmojiImportMessage(connection.ownerId, String(message.chat.id), message)) {
          await db.insert(botUpdates).values({ id: eventId }).onConflictDoNothing();
          return;
        }
      } catch (error) {
        if (!(error instanceof CommerceError) || error.status >= 500) throw error;
        await telegram("sendMessage", { chat_id: String(message.chat.id), text: error.message });
        await db.insert(botUpdates).values({ id: eventId }).onConflictDoNothing();
        return;
      }
    }
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
    const showPurchaseQuote = async (rawQuantity: string, selectionToken?: string) => {
      const state = customer!.state;
      if (state.type !== "purchase-quantity" || (selectionToken !== undefined && selectionToken !== state.token) ||
        !Number.isFinite(Number(state.expires)) || Number(state.expires) < Date.now()) {
        throw new CommerceError("This quantity selection expired. Open the product again.");
      }
      if (!/^\d{1,3}$/.test(rawQuantity)) throw new CommerceError("🔢 Please send a whole-number quantity, such as 1, 2 or 3.");
      const quantity = Number(rawQuantity);
      const product = (await productsForOwner(connection.ownerId)).find(p => p.id === Number(state.productId) && p.status === "active");
      if (!product || !product.stock) throw new CommerceError("📦 This product is out of stock. Please choose another product.");
      if (quantity < 1 || quantity > Math.min(product.stock, MAX_PURCHASE_QUANTITY)) {
        throw new CommerceError(`🔢 Choose a quantity from 1 to ${Math.min(product.stock, MAX_PURCHASE_QUANTITY)}. 📦 Stock left: ${product.stock}.`);
      }
      const token = randomUUID();
      const amountCents = Math.round(product.price * 100);
      await db.update(botCustomers).set({ state: {
        type: "purchase", token, productId: product.id, quantity, amountCents, expires: Date.now() + 10 * 60000,
      } }).where(eq(botCustomers.id, customer!.id));
      const keyboard = { inline_keyboard: [
        ...(customer!.balanceCents >= amountCents * quantity
          ? [[{ text: `✅ Pay $${(amountCents * quantity / 100).toFixed(2)} with wallet`, callback_data: `wal:${token}` }]] : []),
        [{ text: "👛 Add funds", callback_data: "deposit" }, { text: "🔢 Change quantity", callback_data: `buy:${product.id}` }],
        [{ text: "🏠 Cancel", callback_data: "cancel_home" }],
      ] };
      const quote = purchaseConfirmation(product, quantity, customer!.balanceCents);
      const normalQuote = purchaseConfirmation(product, quantity, customer!.balanceCents, false);
      const messageId = update.callback_query ? message.message_id : Number(state.promptMessageId);
      if (Number.isSafeInteger(messageId) && messageId! > 0) {
        if (await editProductQuote(customer!.chatId, messageId!, quote, keyboard, state.promptIsMedia === true, telegram, normalQuote)) return;
      }
      await withCustomEmojiFallback(() => send(quote, keyboard, "HTML"), () => send(normalQuote, keyboard, "HTML"));
    };
    const showPending = async () => {
      const menu = pendingPaymentsMenu(await customerPendingPayments(connection.ownerId, customer!.id));
      await send(menu.text, menu.reply_markup, "HTML");
    };
    const showMenuView = async (view: HistoryView) => {
      const body = { chat_id: customer!.chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup };
      if (update.callback_query && Number.isSafeInteger(message.message_id) && !message.photo?.length) {
        await telegram("editMessageText", { ...body, message_id: message.message_id }).catch(error => {
          if (!(error instanceof TelegramRequestError && error.reason === "not_modified")) throw error;
        });
      } else {
        await telegram("sendMessage", { ...body, protect_content: true });
      }
    };
    try {
      if (update.callback_query) {
        // Acknowledge promptly; this has no financial side effects.
        // Telegram can expire the spinner acknowledgment before retrying a webhook.
        // Its failure must not block idempotent checkout/delivery recovery.
        await telegram("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => undefined);
      }
      if (data === "cancel_home" || data === "history_home") {
        const removed = Number.isSafeInteger(message.message_id)
          ? await dismissCustomerMessage(connection.ownerId, customer!.id, message.message_id!) : true;
        await db.update(botCustomers).set({ state: {} }).where(eq(botCustomers.id, customer!.id));
        await send(`${settings.welcomeMessage}${message.photo?.length ? "\n\n🏠 Returned to the home menu.\nAny payment already sent will still be checked automatically." : ""}${removed ? "" : "\n\nTelegram no longer allows deleting this older message. Its buttons have been disabled."}`, {
          keyboard: labels.map(row => row.map(label => ({ text: label }))), resize_keyboard: true, is_persistent: true,
        });
      } else if (data.startsWith("hist:") || data === "history" || [settings.ordersLabel, labels[1]![1], "/orders"].includes(text)) {
        const [, scope = "o", rawPage = "0"] = data.startsWith("hist:") ? data.split(":") : [];
        const now = new Date();
        const summary = await customerHistorySummary(connection.ownerId, customer!.id, now);
        if (scope === "t") {
          await showMenuView(topupCategoryMenu(summary.topups));
        } else {
          if (!isHistoryScope(scope)) throw new CommerceError("This history selection is no longer available. Open Order History again.");
          const total = scope === "o" ? summary.orders : summary.topups[scope];
          const list = await customerHistoryPage(connection.ownerId, customer!.id, scope, Number(rawPage), total, now);
          await showMenuView(scope === "o"
            ? historyMenu(list, Object.values(summary.topups).reduce((sum, count) => sum + count, 0), now.getTime())
            : topupListMenu(list, scope, now.getTime()));
        }
      } else if (data.startsWith("history_order:") || data.startsWith("ho:")) {
        const [, id, rawPage, rawScope = "o", rawListPage = "0"] = data.split(":");
        const [order] = await db.select().from(shopPayments).where(and(
          eq(shopPayments.id, id ?? ""), eq(shopPayments.ownerId, connection.ownerId),
          eq(shopPayments.customerId, customer!.id),
        ));
        if (!order) throw new CommerceError("Order not found.");
        const delivered = order.kind !== "deposit" && order.fulfillment === "delivered" && order.deliveredAt;
        const inventory = delivered ? await customerDeliveredInventory(connection.ownerId, customer!.id, order.id) : undefined;
        const scope = isHistoryScope(rawScope) ? rawScope : "o";
        const listPage = /^\d{1,6}$/.test(rawListPage) ? Number(rawListPage) : 0;
        await showMenuView(historyOrderView(order, inventory?.credential, Number(rawPage ?? 0), Date.now(), scope, listPage));
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
      } else if (/^group:[a-f0-9-]{36}$/i.test(data)) {
        const menu = productOptionsMenu(await productsForOwner(connection.ownerId), data.slice(6));
        if (!menu) throw new CommerceError("No options are currently in stock for this product.");
        await db.update(botCustomers).set({ state: {} }).where(eq(botCustomers.id, customer!.id));
        await sendProductCard(customer!.chatId, menu);
      } else if (/^buy:\d+$/.test(data)) {
        const products = await productsForOwner(connection.ownerId);
        const product = products.find(p => p.id === Number(data.slice(4)) && p.status === "active" && p.stock > 0);
        if (!product) throw new CommerceError("This product is out of stock or no longer available.");
        const token = randomUUID();
        const state = { type: "purchase-quantity", token, productId: product.id, expires: Date.now() + 10 * 60000 };
        await db.update(botCustomers).set({ state }).where(eq(botCustomers.id, customer!.id));
        const [heading, ...lines] = quantityPrompt(product, customer!.balanceCents).split("\n");
        const prompt = await sendProductCard(customer!.chatId, {
          heading: heading!, body: lines.join("\n").trimStart(), imageUrl: product.imageUrl,
          fallbackHeading: quantityPrompt(product, customer!.balanceCents, false).split("\n")[0],
          reply_markup: quantityKeyboard(),
        });
        if (Number.isSafeInteger(prompt.message_id)) await db.update(botCustomers).set({
          state: { ...state, promptMessageId: Number(prompt.message_id), promptIsMedia: prompt.mediaPrompt === true },
        }).where(eq(botCustomers.id, customer!.id));
      } else if (data.startsWith("qty:")) {
        const [, token, quantity] = data.split(":");
        await showPurchaseQuote(quantity ?? "", token ?? "");
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
        if (wallet && (!Number.isSafeInteger(state.quantity) || Number(state.quantity) < 1 || Number(state.quantity) > MAX_PURCHASE_QUANTITY)) {
          throw new CommerceError("🔢 Please open the product and choose your quantity first.");
        }
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
          quantity: wallet ? Number(state.quantity) : undefined,
        });
        await sendCheckout(payment);
      } else if (text === "/cancel" || text === "/start" || text.startsWith("/start ")) {
        await db.update(botCustomers).set({ state: {} }).where(eq(botCustomers.id, customer!.id));
        await send(text === "/cancel" ? "Cancelled. Choose an option below." : settings.welcomeMessage, {
          keyboard: labels.map(row => row.map(label => ({ text: label }))), resize_keyboard: true, is_persistent: true,
        });
        if (text !== "/cancel") {
          const catalog = productCatalogMenu(await productsForOwner(connection.ownerId), 0);
          if (catalog.text !== "📦 <b>No stock available</b>\n\nPlease check back soon.") {
            await send(catalog.text, catalog.reply_markup, "HTML");
          }
        }
      } else if (data === "products" || data.startsWith("products:") || [settings.productsLabel, labels[0]![0], "/products"].includes(text)) {
        const page = data.startsWith("products:") && /^products:\d{1,9}$/.test(data)
          ? Number(data.split(":")[1]) : 0;
        const products = await productsForOwner(connection.ownerId);
        await withCustomEmojiFallback(
          () => showMenuView(productCatalogMenu(products, page)),
          () => showMenuView(productCatalogMenu(products, page, false)),
        );
      } else if ([settings.supportLabel, labels[0]![1], "/support"].includes(text)) {
        await send(`${settings.supportMessage}${settings.supportUsername ? `\n@${settings.supportUsername.replace(/^@/, "")}` : ""}`);
      } else if ([settings.walletLabel, labels[1]![0], "/wallet"].includes(text)) {
        await send(walletSummary(customer!.balanceCents, settings.minDeposit), {
          inline_keyboard: [
            [{ text: "💳 Deposit", callback_data: "deposit" }],
            [{ text: "⏳ Pending payments", callback_data: "pending" }],
          ],
        }, "HTML");
      } else if (customer!.state.type === "purchase-quantity" && !data) {
        await showPurchaseQuote(text);
      } else if (customer!.state.type === "deposit-amount") {
        const amountCents = moneyCents(text);
        if (amountCents < Math.round(settings.minDeposit * 100)) throw new CommerceError(`Minimum deposit is $${settings.minDeposit.toFixed(2)}.`);
        const token = randomUUID();
        await db.update(botCustomers).set({ state: { type: "deposit", token, amountCents, expires: Date.now() + 10 * 60000 } }).where(eq(botCustomers.id, customer!.id));
        await sendDepositCoinMenu(
          keyboard => send(depositCoinPrompt(amountCents), keyboard, "HTML"),
          settings.acceptedCoins, token, settings.coinButtonIcons,
        );
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
