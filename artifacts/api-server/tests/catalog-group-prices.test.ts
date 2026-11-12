import test from "node:test";
import assert from "node:assert/strict";
import { productCatalogMenu, productOptionsMenu } from "../src/lib/telegram-catalog";

test("groups never show a price, even with one stocked option; options keep their individual prices", () => {
  const groupId = "00000000-0000-4000-8000-000000000001";
  const basic = { id: 1, name: "Replit — Basic", optionName: "Basic", groupId, groupName: "Replit",
    status: "active", stock: 3, price: 1, buttonEmoji: "", buttonCustomEmojiId: "123456789" };
  const plus = { ...basic, id: 2, name: "Replit — Plus", optionName: "Plus", price: 5 };
  for (const options of [[basic], [basic, plus], [basic, { ...plus, stock: 0 }]]) {
    const button = productCatalogMenu(options).reply_markup.inline_keyboard[0]![0]!;
    assert.equal(button.text, "Replit");
    assert.equal(button.callback_data, `group:${groupId}`);
    assert.equal(button.icon_custom_emoji_id, "123456789");
    const fallback = productCatalogMenu(options, 0, false).reply_markup.inline_keyboard[0]![0]!;
    assert.equal(fallback.text, "Replit");
  }
  const options = productOptionsMenu([basic, plus], groupId)!.reply_markup.inline_keyboard;
  assert.equal(options[0]![0]!.text, "Basic · $1.00");
  assert.equal(options[1]![0]!.text, "Plus · $5.00");
  const single = productCatalogMenu([{ id: 3, name: "Standalone", price: 2, stock: 1, status: "active", buttonEmoji: "" }]);
  assert.equal(single.reply_markup.inline_keyboard[0]![0]!.text, "Standalone · $2.00");
});
