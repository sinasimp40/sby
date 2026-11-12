// Manual development HTTP verification. Only a temporary, stock-free draft is changed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { productCatalogMenu } from "../src/lib/telegram-catalog";

async function main() {
  assert.notEqual(process.env.NODE_ENV, "production");
  const domain = process.env.REPLIT_DEV_DOMAIN;
  const origin = process.env.TELECART_ADMIN_ORIGIN || process.env.TELECART_PUBLIC_URL;
  assert.ok(domain && origin && process.env.TELECART_ADMIN_EMAIL && process.env.TELECART_ADMIN_INITIAL_PASSWORD);
  const base = `https://${domain}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.TELECART_ADMIN_EMAIL, password: process.env.TELECART_ADMIN_INITIAL_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
  const input = {
    name: `TEST ONLY · Emoji verification ${randomUUID()}`, description: "Temporary stock-free draft; removed after verification.",
    category: "Verification", price: 0.1, status: "draft", deliveryFormat: "email:pass",
  };
  let id: number | undefined;
  try {
    const create = await fetch(`${base}/api/shop/products`, { method: "POST", headers, body: JSON.stringify({ ...input, buttonEmoji: "🎮" }) });
    assert.equal(create.status, 201);
    const product = await create.json();
    id = product.id;
    assert.equal(product.buttonEmoji, "🎮");
    const patch = async (body: object) => fetch(`${base}/api/shop/products/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
    const edited = await patch({ ...input, buttonEmoji: "🔑" });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).buttonEmoji, "🔑");
    const legacy = await patch(input);
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).buttonEmoji, "🔑", "Older clients must not reset the saved emoji.");
    const invalid = await patch({ ...input, buttonEmoji: "https://example.invalid/photo.png" });
    assert.equal(invalid.status, 400);
    const reload = await fetch(`${base}/api/shop/products`, { headers });
    assert.equal(reload.status, 200);
    const saved = (await reload.json()).find((row: { id: number }) => row.id === id);
    assert.equal(saved.buttonEmoji, "🔑");
    assert.equal(saved.name, input.name);
    assert.equal(saved.stock, 0);
    assert.equal(saved.status, "draft");
    const menu = productCatalogMenu([{ ...saved, status: "active", stock: 1 }]);
    assert.ok(menu.reply_markup.inline_keyboard.flat().find(button => button.callback_data === `buy:${id}`)?.text.startsWith("🔑 "));
    console.log("PASS: product emoji create, edit, reload, validation, legacy-update preservation and Telegram button rendering. Existing products and balances unchanged.");
  } finally {
    if (id !== undefined) {
      const removed = await fetch(`${base}/api/shop/products/${id}`, { method: "DELETE", headers });
      assert.equal(removed.status, 204, "Temporary draft must be removed.");
    }
    await fetch(`${base}/api/admin/logout`, { method: "POST", headers });
  }
}
main().catch(() => {
  console.error("Product emoji HTTP verification failed; private response bodies were not logged.");
  process.exitCode = 1;
});
