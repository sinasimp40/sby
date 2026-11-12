import test from "node:test";
import assert from "node:assert/strict";
import { validProductMediaUrl, productMediaMethod, sendProductCard, editProductQuote } from "../src/lib/product-media";
import { TelegramRequestError } from "../src/lib/commerce-providers";
import { newStockAnnouncement } from "../src/lib/product-announcements";
import { quantityPrompt, quantityKeyboard } from "../src/lib/purchase-copy";

const photo = "https://cdn.example.com/product.png";
const gif = "https://cdn.example.com/product.GIF?v=1";
const product = { id: 1, name: "<Product>", description: "A & B", price: 1, priceCents: 100, stock: 4, buttonEmoji: "🛍", status: "active" };
const markup = quantityKeyboard();
const card = { heading: "🛍 <b>Product</b>", body: "Description", reply_markup: markup };
function recorder() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  return { calls, send: async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body }); return { message_id: calls.length };
  } };
}

test("only public HTTPS direct images and GIFs are accepted, including query strings", () => {
  for (const url of [photo, gif, "https://images.example.com/file.jpeg?token=synthetic", "https://images.example.com/file.webp"]) {
    assert.equal(validProductMediaUrl(url), true);
  }
  for (const url of ["javascript:alert(1)", "data:image/png;base64,test", "http://cdn.example.com/a.gif",
    "https://localhost/a.png", "https://127.0.0.1/a.gif", "https://[::1]/a.png", "https://10.0.0.1/a.png",
    "https://host.local/a.png", "https://user:pass@images.example.com/a.gif", "https://images.example.com/a.svg",
    "https://images.example.com/gallery", "https://images.example.com/a.png#fragment"]) {
    assert.equal(validProductMediaUrl(url), false, url);
  }
  assert.equal(productMediaMethod(gif), "sendAnimation");
  assert.equal(productMediaMethod(photo), "sendPhoto");
});

test("stock alerts place escaped name before photo and description under photo, retaining Buy now", async () => {
  const message = newStockAnnouncement({ ...product, imageUrl: photo }, 2, true);
  const { send, calls } = recorder();
  await sendProductCard("TEST_ONLY", message, send);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "sendPhoto"]);
  assert.match(String(calls[0]!.body.text), /NEW PRODUCT.*\n\n.*&lt;Product&gt;/);
  assert.doesNotMatch(String(calls[0]!.body.text), /A &amp; B/);
  assert.match(String(calls[1]!.body.caption), /^A &amp; B/);
  assert.equal(calls[1]!.body.photo, photo);
  assert.deepEqual(calls[1]!.body.reply_markup, message.reply_markup);
  assert.equal(calls[1]!.body.protect_content, true);
});

test("GIF purchase prompts retain typed entry and only Cancel; confirmation edits the animation caption", async () => {
  const [heading, ...body] = quantityPrompt(product, 1000).split("\n");
  const { send, calls } = recorder();
  const prompt = await sendProductCard("TEST_ONLY", {
    heading: heading!, body: body.join("\n").trimStart(), imageUrl: gif, reply_markup: markup,
  }, send);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "sendAnimation"]);
  assert.equal(calls[1]!.body.animation, gif);
  assert.match(String(calls[1]!.body.caption), /Type a whole number/);
  assert.deepEqual(calls[1]!.body.reply_markup, { inline_keyboard: [[{ text: "🏠 Cancel", callback_data: "cancel_home" }]] });
  assert.equal(prompt.mediaPrompt, true);
  assert.equal(await editProductQuote("TEST_ONLY", prompt.message_id!, "<b>Confirm</b>", markup, true, send), true);
  assert.equal(calls[2]!.method, "editMessageCaption");
  assert.equal(calls[2]!.body.caption, "<b>Confirm</b>");
});

test("products without images remain a single text message and text confirmation", async () => {
  const { send, calls } = recorder();
  const result = await sendProductCard("TEST_ONLY", card, send);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "sendMessage");
  assert.equal(calls[0]!.body.text, `${card.heading}\n\n${card.body}`);
  assert.equal(result.mediaPrompt, undefined);
  await editProductQuote("TEST_ONLY", 1, "Confirm", markup, false, send);
  assert.equal(calls[1]!.method, "editMessageText");
});

test("long descriptions and confirmations respect caption limits without losing text or controls", async () => {
  const { send, calls } = recorder();
  const body = "&amp;".repeat(500);
  const result = await sendProductCard("TEST_ONLY", { ...card, imageUrl: photo, body }, send);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "sendPhoto", "sendMessage"]);
  assert.equal(calls[1]!.body.caption, undefined);
  assert.equal(calls[2]!.body.text, body);
  assert.deepEqual(calls[2]!.body.reply_markup, markup);
  assert.equal(result.mediaPrompt, undefined);
  assert.equal(await editProductQuote("TEST_ONLY", 2, body, markup, true, send), false);
  assert.equal(calls[3]!.method, "editMessageReplyMarkup");
});

test("rejected image links produce a visible warning; uncertain delivery never blindly retries", async () => {
  const { send, calls } = recorder();
  const rejectPhoto = async (method: string, body: Record<string, unknown>) => {
    if (method === "sendPhoto") throw new TelegramRequestError(method, 400, "provider_error");
    return send(method, body);
  };
  const result = await sendProductCard("TEST_ONLY", { ...card, imageUrl: photo }, rejectPhoto);
  assert.equal(result.mediaPrompt, undefined);
  assert.match(String(calls[1]!.body.text), /Product image unavailable/);
  assert.deepEqual(calls[1]!.body.reply_markup, markup);
  let attempts = 0;
  await assert.rejects(sendProductCard("TEST_ONLY", { ...card, imageUrl: gif }, async (method) => {
    attempts++;
    if (method === "sendAnimation") throw new Error("TEST_ONLY timeout");
    return { message_id: 1 };
  }), /timeout/);
  assert.equal(attempts, 2);
});
