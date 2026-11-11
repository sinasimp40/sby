import test from "node:test";
import assert from "node:assert/strict";
import { telegramCustomerName } from "../src/lib/telegram-customer-name";

test("prefers a real Telegram username and does not double prefix it", () => {
  assert.equal(telegramCustomerName({ username: "alice_shop", first_name: "Alice" }), "@alice_shop");
  assert.equal(telegramCustomerName({ username: "@alice_shop" }), "@alice_shop");
});

test("falls back to the Telegram display name without pretending it is a username", () => {
  assert.equal(telegramCustomerName({ first_name: " Alice ", last_name: " Lee " }), "Alice Lee");
  assert.equal(telegramCustomerName({ first_name: "小明" }), "小明");
  assert.equal(telegramCustomerName({ username: "", first_name: "Alice" }), "Alice");
  assert.equal(telegramCustomerName({}), "Telegram customer");
});
