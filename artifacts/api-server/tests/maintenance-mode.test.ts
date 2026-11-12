import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { handleTelegramUpdate, type TelegramUpdate } from "../src/lib/telegram-shop";
import { defaultSettings } from "../src/lib/shop-defaults";
import { MAINTENANCE_NOTICE } from "../src/lib/maintenance-notice";

test("maintenance intercepts commands, typed quantities and old purchase/deposit buttons without financial side effects", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `maintenance-test-${randomUUID()}`, botId = `TEST_ONLY-${randomUUID()}`, customerId = randomUUID();
  const chatId = 9000000000000 + Math.floor(Math.random() * 1000000);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let paused = true;
  const services = {
    activeConnection: async () => ({ ownerId: owner, botId, active: "yes" }),
    getBotRuntime: async () => ({ enabled: true }),
    settingsForOwner: async () => ({ ...defaultSettings, maintenanceMode: paused }),
    telegram: async (method: string, body: Record<string, unknown>) => { sent.push({ method, body }); return { message_id: 1 }; },
  } as unknown as NonNullable<Parameters<typeof handleTelegramUpdate>[1]>;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected external call during isolated maintenance test."); };
  try {
    await pool.query("INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username,balance_cents) VALUES($1,$2,$3,$3,'TEST_ONLY',5000)", [customerId, owner, String(chatId)]);
    const commands = ["/start", "/cancel", "Products", "/wallet", "1", "callback:buy:123", `callback:wal:${randomUUID()}`, `callback:pay:${randomUUID()}:btc`, "callback:history_home"];
    for (const [index, command] of commands.entries()) {
      sent.length = 0;
      await pool.query("UPDATE bot_customers SET state=$1::jsonb WHERE id=$2", [JSON.stringify({ type: "purchase", token: "TEST_ONLY", productId: 123, quantity: 1, amountCents: 100 }), customerId]);
      const message = { message_id: index + 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "TEST_ONLY" }, text: command };
      const update = (command.startsWith("callback:")
        ? { update_id: index, callback_query: { id: `TEST_ONLY-${index}`, from: message.from, message, data: command.slice(9) } }
        : { update_id: index, message }) as TelegramUpdate;
      await handleTelegramUpdate(update, services);
      const notices = sent.filter(call => call.method === "sendMessage");
      assert.equal(notices.length, 1, command);
      assert.equal(notices[0]!.body.text, MAINTENANCE_NOTICE, command);
      assert.deepEqual(notices[0]!.body.reply_markup, { remove_keyboard: true });
      assert.ok(sent.every(call => ["sendMessage", "answerCallbackQuery"].includes(call.method)));
      const customer = (await pool.query("SELECT state,balance_cents FROM bot_customers WHERE id=$1", [customerId])).rows[0];
      assert.deepEqual(customer.state, {});
      assert.equal(customer.balance_cents, 5000);
      await handleTelegramUpdate(update, services);
      assert.equal(sent.filter(call => call.method === "sendMessage").length, 1, "duplicate update cannot resend notice");
    }
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM shop_payments WHERE owner_id=$1", [owner])).rows[0].n, 0);
    paused = false;
    sent.length = 0;
    await handleTelegramUpdate({ update_id: 100, message: { chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "TEST_ONLY" }, text: "/wallet" } }, services);
    assert.equal(sent.filter(call => call.method === "sendMessage").length, 1);
    assert.match(String(sent[0]!.body.text), /Your wallet/);
    assert.notEqual(sent[0]!.body.text, MAINTENANCE_NOTICE);
  } finally {
    globalThis.fetch = originalFetch;
    await pool.query("DELETE FROM bot_updates WHERE id LIKE $1", [`${botId}:%`]);
    await pool.query("DELETE FROM bot_customers WHERE owner_id=$1", [owner]);
    await pool.end();
  }
});
