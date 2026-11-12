import test from "node:test";
import assert from "node:assert/strict";
import { sendWelcomeMessage } from "../src/lib/welcome-message";
import { TelegramRequestError } from "../src/lib/commerce-providers";

const keyboard = { keyboard: [[{ text: "Products" }, { text: "Wallet" }]], resize_keyboard: true };
const text = "Welcome to our store!\nChoose an option below.";

test("welcome photo and GIF each contain the complete welcome and menu in exactly one message", async () => {
  for (const [extension, method, field] of [["jpg", "sendPhoto", "photo"], ["gif", "sendAnimation", "animation"]]) {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const url = `https://cdn.example.com/welcome.${extension}`;
    await sendWelcomeMessage("TEST_ONLY", { welcomeMessage: text, welcomeImageUrl: url }, keyboard, "", async (method, body) => {
      calls.push({ method, body }); return { message_id: 1 };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, method);
    assert.equal(calls[0]!.body[field!], url);
    assert.equal(calls[0]!.body.caption, text);
    assert.deepEqual(calls[0]!.body.reply_markup, keyboard);
    assert.ok(!("text" in calls[0]!.body));
  }
});

test("no-image welcome remains one text message and long captions are never split or truncated", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const send = async (method: string, body: Record<string, unknown>) => { calls.push({ method, body }); };
  await sendWelcomeMessage("TEST_ONLY", { welcomeMessage: text }, keyboard, "", send);
  assert.equal(calls[0]!.method, "sendMessage");
  assert.equal(calls[0]!.body.text, text);
  calls.length = 0;
  const maximum = "a".repeat(1024);
  await sendWelcomeMessage("TEST_ONLY", { welcomeMessage: maximum, welcomeImageUrl: "https://cdn.example.com/welcome.png" }, keyboard, "Returned to Home.", send);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.caption, maximum);
  calls.length = 0;
  await assert.rejects(sendWelcomeMessage("TEST_ONLY", { welcomeMessage: "a".repeat(1025), welcomeImageUrl: "https://cdn.example.com/welcome.png" }, keyboard, "", send), /1,024/);
  assert.equal(calls.length, 0);
});

test("a rejected image yields one visible text fallback; an uncertain send never duplicates the welcome", async () => {
  const calls: string[] = [];
  await sendWelcomeMessage("TEST_ONLY", { welcomeMessage: text, welcomeImageUrl: "https://cdn.example.com/welcome.png" }, keyboard, "", async (method, body) => {
    calls.push(method);
    if (method === "sendPhoto") throw new TelegramRequestError(method, 400);
    assert.match(String(body.text), /Welcome image unavailable/);
    assert.ok(String(body.text).includes(text));
    assert.deepEqual(body.reply_markup, keyboard);
  });
  assert.deepEqual(calls, ["sendPhoto", "sendMessage"]);
  let attempts = 0;
  await assert.rejects(sendWelcomeMessage("TEST_ONLY", { welcomeMessage: text, welcomeImageUrl: "https://cdn.example.com/welcome.png" }, keyboard, "", async method => {
    attempts++; throw new TelegramRequestError(method, 0);
  }));
  assert.equal(attempts, 1);
});
