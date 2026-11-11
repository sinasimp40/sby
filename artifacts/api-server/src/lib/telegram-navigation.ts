import { and, eq } from "drizzle-orm";
import { botCustomers, db, pool, shopPayments } from "@workspace/db";
import { cancelCustomerInvoice } from "./commerce-payments";
import { CommerceError, telegram, TelegramRequestError } from "./commerce-providers";

/** Remove only the clicked message; never delete the financial record. */
export async function dismissCustomerMessage(ownerId: string, customerId: string, messageId: number) {
  const [customer] = await db.select().from(botCustomers).where(and(
    eq(botCustomers.id, customerId), eq(botCustomers.ownerId, ownerId),
  ));
  if (!customer || !Number.isSafeInteger(messageId)) throw new CommerceError("Message not found.");
  const [payment] = await db.select().from(shopPayments).where(and(
    eq(shopPayments.ownerId, ownerId), eq(shopPayments.customerId, customerId),
    eq(shopPayments.invoiceMessageId, messageId),
  ));
  if (payment) await cancelCustomerInvoice(ownerId, customerId, messageId);
  const client = await pool.connect();
  let locked = false;
  try {
    // Serialize against caption updates, so deleted messages are not edited again.
    if (payment) {
      const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 5)) AS locked", [payment.id]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) throw new CommerceError("Payment message is updating. Retry shortly.", 503);
    }
    try {
      await telegram("deleteMessage", { chat_id: customer.chatId, message_id: messageId });
    } catch (error) {
      if (!(error instanceof TelegramRequestError)) throw error;
      if (error.reason === "cannot_delete") {
        // Telegram restricts deletion of older messages. Disable the old controls.
        await telegram("editMessageReplyMarkup", {
          chat_id: customer.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
        }).catch(e => { if (!(e instanceof TelegramRequestError && e.reason === "not_modified")) throw e; });
        return false;
      }
      if (error.reason !== "message_missing") throw error;
    }
    if (payment) {
      await db.update(shopPayments).set({
        invoiceMessageId: null, invoiceCaptionHash: null, invoiceNeedsUpdate: false,
      }).where(and(eq(shopPayments.id, payment.id), eq(shopPayments.invoiceMessageId, messageId)));
    }
    return true;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 5))", [payment!.id]).catch(() => undefined);
    client.release();
  }
}
