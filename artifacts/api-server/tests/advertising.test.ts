import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../src/app";
import { adminCookieName, issueAdminSession } from "../src/lib/admin-auth";
import { parseAdvertisingTarget, segregateAdvertisingTargets } from "../src/lib/advertising-targets";
import { encryptProviderSecret } from "../src/lib/provider-credentials";
import { inspectAdvertisingGroup, sendAdvertisingMessage, validateAdvertisingDraft, AdvertisingTelegramError, type AdvertisingCaller } from "../src/lib/advertising-telegram";
import { processAdvertisingOwner } from "../src/lib/advertising-campaigns";
import { saveTelegramCredential } from "../src/lib/provider-credentials";
import { exportShopTransfer } from "../src/lib/shop-transfer";
import { decodeShopArchive } from "../src/lib/shop-transfer-archive";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";

test("group imports segregate aliases, duplicates, private invites and invalid/non-Telegram links", () => {
  const preview = segregateAdvertisingTargets("https://t.me/My_Group\n@my_group; telegram.me/Other_Group\nhttps://t.me/joinchat/AbCdEf\nhttps://evil.invalid/group\nnot-a-link\n-100123456789", ["@other_group"]);
  assert.deepEqual(preview.rows.map(row => row.status), ["new", "duplicate", "duplicate", "needs_setup", "invalid", "invalid", "new"]);
  assert.equal(preview.rows[3]!.target, "https://t.me/+AbCdEf");
  assert.equal(parseAdvertisingTarget("https://t.me/My_Group/123").target, "@my_group");
  assert.equal(parseAdvertisingTarget("hello").status, "invalid");
  assert.equal(parseAdvertisingTarget("https://t.me.evil.invalid/My_Group").status, "invalid");
  assert.throws(() => segregateAdvertisingTargets("@valid_group ".repeat(501)), /500/);
});

test("plain/photo/GIF ads use exactly one Telegram message and validate caption limits", async () => {
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const call = (async (_token: string, method: string, body: Record<string, unknown>) => { requests.push({ method, body }); return { message_id: 1 }; }) as AdvertisingCaller;
  const draft = { text: "TEST_ONLY advertisement", imageUrl: null as string | null, buttonText: "Visit shop", buttonUrl: "https://t.me/test_shop_bot" };
  for (const [image, method] of [[null, "sendMessage"], ["https://example.com/ad.png", "sendPhoto"], ["https://example.com/ad.GIF?v=1", "sendAnimation"]] as const) {
    requests.length = 0;
    await sendAdvertisingMessage("TEST_ONLY", "-100123456789", { ...draft, imageUrl: image }, call);
    assert.equal(requests.length, 1); assert.equal(requests[0]!.method, method);
    assert.deepEqual(requests[0]!.body.reply_markup, { inline_keyboard: [[{ text: "Visit shop", url: draft.buttonUrl }]] });
  }
  assert.throws(() => validateAdvertisingDraft({ ...draft, text: "x".repeat(1025), imageUrl: "https://example.invalid/ad.gif" }), /1,024/);
  assert.throws(() => validateAdvertisingDraft({ ...draft, buttonUrl: "javascript:alert(1)" }), /HTTPS/);
  requests.length = 0;
  await assert.rejects(sendAdvertisingMessage("TEST_ONLY", "-100123456789", draft,
    (async () => { requests.push({ method: "attempt", body: {} }); throw new AdvertisingTelegramError(0); }) as AdvertisingCaller));
  assert.equal(requests.length, 1, "uncertain send must not fall back or resend");
  const noPermission = (async (_token: string, method: string) => method === "getChat"
    ? { id: -100123456789, type: "channel" } : { status: "administrator", can_post_messages: false }) as AdvertisingCaller;
  await assert.rejects(inspectAdvertisingGroup("TEST_ONLY", "12345", "@group", noPermission), /permission/);
});

test("advertising API and durable sender isolate credentials, require approval, preserve exact drafts and avoid duplicate/uncertain sends", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `advertising-test-${randomUUID()}`, foreign = `${owner}-foreign`, botId = `8${Date.now()}`;
  const token = `${botId}:${"TEST_ONLY_".repeat(4)}`, shopToken = `7${Date.now()}:${"TEST_ONLY_".repeat(4)}`;
  const keys = ["TELECART_ADMIN_EMAIL", "TELECART_ADMIN_INITIAL_PASSWORD", "TELECART_OWNER_ID", "TELECART_PUBLIC_URL", "TELECART_ADMIN_ORIGIN"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { TELECART_ADMIN_EMAIL: "test-admin@example.invalid", TELECART_ADMIN_INITIAL_PASSWORD: `TEST_ONLY-${randomUUID()}`,
    TELECART_OWNER_ID: owner, TELECART_PUBLIC_URL: "https://test-only.invalid", TELECART_ADMIN_ORIGIN: "https://test-only.invalid" });
  const originalFetch = globalThis.fetch;
  const attempts: { method: string; body: Record<string, unknown> }[] = [];
  let sendMode = "ok", botRejected = false, webhook = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "127.0.0.1") return originalFetch(input, init);
    if (url.hostname !== "api.telegram.org") throw new Error("Unexpected external call blocked.");
    const method = url.pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (method === "getMe") return Response.json(botRejected ? { ok: false, error_code: 401 } :
      { ok: true, result: { id: Number(url.pathname.includes(`bot${shopToken}`) ? shopToken.split(":")[0] : botId), is_bot: true,
        username: url.pathname.includes(`bot${shopToken}`) ? "TEST_ONLY_shop_bot" : "TEST_ONLY_ad_bot" } });
    if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: webhook ? "https://other-app.invalid/webhook" : "" } });
    if (method === "getUpdates") return Response.json({ ok: true, result: [{ update_id: 1, my_chat_member: { chat: { id: -100333333333, type: "supergroup", title: "TEST_ONLY discovered" }, new_chat_member: { status: "administrator" } } }] });
    if (method === "getChat") return Response.json({ ok: true, result: { id: ["@test_only_group", "@test_only_alias"].includes(body.chat_id) ? -100111111111 : Number(body.chat_id), type: "supergroup", title: "TEST_ONLY group" } });
    if (method === "getChatMember") return Response.json({ ok: true, result: { status: "administrator" } });
    if (["sendMessage", "sendPhoto", "sendAnimation"].includes(method)) {
      assert.ok(url.pathname.includes(`bot${token}`), "only the separate advertising token may send");
      attempts.push({ method, body });
      if (sendMode === "timeout") throw new Error("TEST_ONLY ambiguous response");
      if (sendMode === "429") return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 30 } });
      return Response.json({ ok: true, result: { message_id: attempts.length } });
    }
    throw new Error("Unexpected Telegram operation blocked.");
  };
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const cookie = `${adminCookieName()}=${await issueAdminSession()}`;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/shop/advertising`;
  const request = async (path = "", method = "GET", data?: unknown, origin = "https://test-only.invalid", auth = cookie) => {
    const response = await fetch(`${base}${path}`, { method, headers: { cookie: auth, origin, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await request("", "GET", undefined, undefined, "")).status, 401);
    assert.equal((await request("/draft", "PUT", {}, "https://wrong.invalid")).status, 403);
    await pool.query("INSERT INTO provider_credentials(owner_id,telegram_bot_username,telegram_token_encrypted) VALUES($1,'TEST_ONLY_shop_bot',$2)",
      [owner, encryptProviderSecret(shopToken, owner, "telegram")]);
    assert.equal((await request("/connection", "POST", { botLink: "@TEST_ONLY_shop_bot", token: shopToken })).status, 400);
    assert.equal((await request("/connection", "POST", { botLink: "@wrong_bot", token })).status, 400);
    const connected = await request("/connection", "POST", { botLink: "https://t.me/TEST_ONLY_ad_bot", token });
    assert.equal(connected.status, 200); assert.equal(connected.data.bot.connected, true);
    assert.ok(!JSON.stringify(connected.data).includes(token));
    await assert.rejects(saveTelegramCredential(owner, token, "TEST_ONLY_ad_bot"), /assigned to advertising/);
    botRejected = true;
    assert.equal((await request("/connection/check", "POST")).data.bot.connected, false);
    assert.equal((await request("/connection", "POST", { botLink: "@TEST_ONLY_ad_bot", token })).status, 502);
    botRejected = false;
    assert.equal((await request("/connection/check", "POST")).data.bot.connected, true);
    const text = "https://t.me/test_only_group\n@test_only_group\n-100222222222\nhttps://t.me/+TestOnlyInvite";
    const preview = await request("/groups/preview", "POST", { text });
    assert.deepEqual(preview.data.rows.map((row: { status: string }) => row.status), ["new", "duplicate", "new", "needs_setup"]);
    const targets = preview.data.rows.filter((row: { status: string }) => ["new", "needs_setup"].includes(row.status)).map((row: { target: string }) => row.target);
    assert.equal((await request("/groups", "POST", { targets, permissionConfirmed: false })).status, 400);
    const added = await request("/groups", "POST", { targets, permissionConfirmed: true });
    assert.equal(added.data.groups.length, 3);
    const checked = await request("/groups/check", "POST", { groupIds: added.data.groups.map((group: { id: string }) => group.id) });
    const ready = checked.data.groups.filter((group: { status: string }) => group.status === "ready");
    assert.equal(ready.length, 2); assert.equal(checked.data.groups.find((group: { kind: string }) => group.kind === "private_invite").status, "needs_setup");
    const invite = checked.data.groups.find((group: { kind: string }) => group.kind === "private_invite");
    const edited = await request(`/groups/${invite.id}`, "PATCH", { target: "-100444444444" });
    assert.equal(edited.data.groups.find((group: { id: string }) => group.id === invite.id).status, "pending");
    assert.equal((await request("/groups/check", "POST", { groupIds: [invite.id] })).data.groups.find((group: { id: string }) => group.id === invite.id).status, "ready");
    const aliases = await request("/groups", "POST", { targets: ["@test_only_alias"], permissionConfirmed: true });
    const alias = aliases.data.groups.find((group: { target: string }) => group.target === "@test_only_alias");
    assert.equal((await request("/groups/check", "POST", { groupIds: [alias.id] })).data.groups.find((group: { id: string }) => group.id === alias.id).status, "duplicate");
    assert.equal((await request(`/groups/${alias.id}`, "DELETE")).status, 200);
    const foreignId = randomUUID();
    await pool.query("INSERT INTO advertising_groups(id,owner_id,target,kind) VALUES($1,$2,'@foreign_test_group','public')", [foreignId, foreign]);
    assert.equal((await request(`/groups/${foreignId}`, "PATCH", { enabled: false })).status, 404);
    webhook = true;
    assert.equal((await request("/groups/discover", "POST")).status, 409);
    webhook = false;
    assert.equal((await request("/groups/discover", "POST")).status, 200);
    const draft = { text: "TEST_ONLY confirmed advertisement", imageUrl: null, buttonText: "Visit shop", buttonUrl: "https://t.me/TEST_ONLY_shop_bot" };
    assert.equal((await request("/draft", "PUT", draft)).status, 200);
    assert.equal((await request()).data.draft.text, draft.text);
    const input = { groupIds: ready.map((group: { id: string }) => group.id), permissionConfirmed: true, idempotencyKey: randomUUID(), draft };
    assert.equal((await request("/campaigns", "POST", { ...input, permissionConfirmed: false })).status, 400);
    assert.equal((await request("/campaigns", "POST", { ...input, groupIds: [foreignId] })).status, 400);
    const campaign = await request("/campaigns", "POST", input);
    assert.equal(campaign.status, 201); assert.equal(attempts.length, 0, "enqueueing must not send inline");
    assert.equal((await request("/campaigns", "POST", input)).data.id, campaign.data.id);
    assert.equal((await request("/campaigns", "POST", { ...input, idempotencyKey: randomUUID() })).status, 409);
    await request("/draft", "PUT", { ...draft, text: "TEST_ONLY different later draft" });
    await processAdvertisingOwner(owner);
    await pool.query("UPDATE advertising_bots SET next_send_at=now() WHERE owner_id=$1", [owner]);
    await processAdvertisingOwner(owner);
    assert.equal(attempts.length, 2); assert.ok(attempts.every(attempt => attempt.body.text === draft.text));
    const result = await request(`/campaigns/${campaign.data.id}`);
    assert.equal(result.data.campaign.sent, 2); assert.equal(result.data.campaign.status, "completed");
    const start = async () => (await request("/campaigns", "POST", { ...input, groupIds: [ready[0].id], idempotencyKey: randomUUID() })).data;
    const resetPacing = async () => {
      await pool.query("UPDATE advertising_bots SET next_send_at=now() WHERE owner_id=$1", [owner]);
      await pool.query("UPDATE advertising_groups SET last_sent_at=NULL WHERE owner_id=$1", [owner]);
    };
    const cancelled = await start();
    assert.equal((await request(`/campaigns/${cancelled.id}/cancel`, "POST")).status, 200);
    await resetPacing(); await processAdvertisingOwner(owner); assert.equal(attempts.length, 2);
    const uncertain = await start();
    sendMode = "timeout";
    await resetPacing(); await processAdvertisingOwner(owner); await processAdvertisingOwner(owner);
    assert.equal((await request(`/campaigns/${uncertain.id}`)).data.campaign.uncertain, 1);
    assert.equal(attempts.length, 3, "ambiguous sends are never retried");
    sendMode = "429";
    const limited = await start();
    await resetPacing(); await processAdvertisingOwner(owner); await processAdvertisingOwner(owner);
    assert.equal(attempts.length, 4, "rate limit must pause sending");
    assert.equal((await request(`/campaigns/${limited.id}`)).data.campaign.pending, 1);
    sendMode = "ok"; await resetPacing(); await processAdvertisingOwner(owner);
    assert.equal((await request(`/campaigns/${limited.id}`)).data.campaign.sent, 1);
    const crash = await start();
    await pool.query("UPDATE advertising_deliveries SET status='sending',started_at=now()-interval '2 minutes' WHERE campaign_id=$1", [crash.id]);
    await processAdvertisingOwner(owner);
    assert.equal((await request(`/campaigns/${crash.id}`)).data.campaign.uncertain, 1);
    assert.equal(attempts.length, 5);
    const exported = await exportShopTransfer(owner);
    const decoded = decodeShopArchive(exported.zip);
    assert.equal(decoded.data.advertisingBots.length, 1); assert.equal(decoded.data.advertisingGroups.length, 4);
    assert.ok(decoded.data.advertisingCampaigns.length > 0 && decoded.data.advertisingDeliveries.length > 0);
    assert.ok(!JSON.stringify(decoded.data).includes(token)); validateShopRelationships(decoded.data, owner);
    const disabledCampaign = await start();
    await request(`/groups/${ready[0].id}`, "PATCH", { enabled: false });
    await resetPacing(); await processAdvertisingOwner(owner);
    assert.equal((await request(`/campaigns/${disabledCampaign.id}`)).data.campaign.cancelled, 1);
    assert.equal(attempts.length, 5);
    await request(`/groups/${ready[0].id}`, "PATCH", { enabled: true });
    const removedCampaign = await start();
    await request(`/groups/${ready[0].id}`, "DELETE");
    await processAdvertisingOwner(owner);
    assert.equal((await request(`/campaigns/${removedCampaign.id}`)).data.campaign.cancelled, 1);
    assert.equal(attempts.length, 5);
    await request("/campaigns", "POST", { ...input, groupIds: [ready[1].id], idempotencyKey: randomUUID() });
    assert.equal((await request("/connection", "DELETE")).data.bot.configured, false);
    await processAdvertisingOwner(owner); assert.equal(attempts.length, 5);
    assert.equal((await request("/campaigns", "POST", { ...input, idempotencyKey: randomUUID() })).status, 409);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const table of ["advertising_deliveries", "advertising_campaigns", "advertising_groups", "advertising_bots", "provider_credentials", "shop_activity", "shop_settings", "bot_runtime_settings"])
      await pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [[owner, foreign]]);
    await pool.query("DELETE FROM admin_sessions WHERE owner_id=$1", [owner]);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    await pool.end();
  }
});
