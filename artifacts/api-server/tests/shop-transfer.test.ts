import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { pool } from "@workspace/db";
import * as database from "@workspace/db";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { exportShopTransfer, importShopTransfer, previewShopTransfer, shopTransferStatus, reviewShopTransfer } from "../src/lib/shop-transfer";
import { decodeShopArchive, encodeShopArchive, previewToken, verifyPreviewToken } from "../src/lib/shop-transfer-archive";
import { tableKeys, transferTables, singleItemTransferSchemaHash, quantityTransferSchemaHash, productEmojiTransferSchemaHash, customEmojiTransferSchemaHash, stockAnnouncementTransferSchemaHash } from "../src/lib/shop-transfer-tables";
import { assignedInventoryIds } from "../src/lib/payment-inventory";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";
import { decryptCredential } from "../src/lib/inventory-encryption";
import { decryptProviderSecret } from "../src/lib/provider-credentials";
import { assertTransferReviewed } from "../src/lib/shop-transfer-safety";
import { createCheckout, checkPayment, deliverPayment } from "../src/lib/commerce-payments";
import { reconcilePaymentBatch } from "../src/lib/payment-reconciliation";
import { getBotRuntime } from "../src/lib/bot-runtime";
import { seedTransferFixture, cleanTransferFixture, syntheticInventory } from "./helpers/shop-transfer-fixture";

test("portable ZIP round trip preserves business data and refuses unsafe imports", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const source = `transfer-test-source-${randomUUID()}`;
  const destination = `transfer-test-destination-${randomUUID()}`;
  const foreign = `transfer-test-foreign-${randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const originalOwner = process.env.TELECART_OWNER_ID;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("External calls are blocked for portable transfer tests."); };
  try {
    const fixture = await seedTransferFixture(source);
    await pool.query("UPDATE shop_products SET image_url=$1, stock_announced_at=CASE WHEN status='active' THEN created_at ELSE NULL END WHERE owner_id=$2", ["https://cdn.example.com/portable-product.gif", source]);
    await pool.query("UPDATE shop_products SET button_emoji=$1 WHERE owner_id=$2", ["🔑", source]);
    await pool.query("INSERT INTO shop_custom_emojis(owner_id,custom_emoji_id,emoji,set_name,format) VALUES($1,'900000000000000001','🔑','TEST_ONLY','animated')", [source]);
    await pool.query("UPDATE shop_products SET button_custom_emoji_id='900000000000000001' WHERE owner_id=$1", [source]);
    const exported = await exportShopTransfer(source);
    const decoded = decodeShopArchive(exported.zip);
    await t.test("ZIP is actual complete shop data, with no credentials key or sessions included", async () => {
      const exportedTables = Object.values(database).filter(value => is(value, PgTable)).map(table => getTableConfig(table as PgTable).name);
      const included = Object.values(transferTables).map(table => getTableConfig(table).name);
      // New persistent tables must be explicitly covered or deliberately excluded.
      assert.deepEqual(new Set(exportedTables), new Set([...included, "admin_sessions", "admin_login_limits", "emoji_import_sessions"]));
      assert.deepEqual(Object.keys(unzipSync(exported.zip)).sort(), ["README.txt", "manifest.json", "shop-data.json"]);
      assert.equal(Object.keys(decoded.data).length, 13);
      for (const key of tableKeys) assert.equal(decoded.manifest.counts[key], decoded.data[key].length);
      assert.equal(decoded.data.customers.length, 2);
      assert.equal(decoded.data.inventory.length, 5);
      assert.equal(decoded.data.payments.length, 6);
      assert.equal(decoded.data.walletEntries.length, 3);
      assert.ok(decoded.data.products.every(product => product.buttonEmoji === "🔑"));
      assert.equal(decoded.data.customEmojis.length, 1);
      const raw = strFromU8(unzipSync(exported.zip)["shop-data.json"]!);
      assert.doesNotMatch(raw, /TEST_ONLY_TELEGRAM|TEST_ONLY_API|TEST_ONLY_IPN|TEST_ONLY:delivered|admin_sessions/);
      const allTables = structuredClone(decoded.data);
      allTables.connection = [{ id: "primary", ownerId: source, botId: "999999999999", botUsername: "TEST_ONLY_BOT", publicUrl: "https://example.invalid", active: "no", verifiedAt: new Date() }];
      allTables.updates = [{ id: "999999999999:123", createdAt: new Date() }];
      const complete = decodeShopArchive(encodeShopArchive(source, allTables).zip);
      validateShopRelationships(complete.data, source);
      assert.ok(tableKeys.every(key => complete.data[key].length > 0), "format covers every dataset, including bot identity and deduplication");
      const bound = await pool.query("SELECT owner_id FROM bot_connections WHERE id='primary'");
      if (bound.rows[0]?.owner_id && bound.rows[0].owner_id !== destination) {
        const preview = await previewShopTransfer(destination, encodeShopArchive(source, allTables).zip);
        assert.equal(preview.canImport, false, "never take over another shop's live bot connection");
        assert.deepEqual((await pool.query("SELECT owner_id FROM bot_connections WHERE id='primary'")).rows, bound.rows);
      }
      await assert.rejects(exportShopTransfer(null), e => (e as { status: number }).status === 401);
      const other = decodeShopArchive((await exportShopTransfer(foreign)).zip);
      assert.ok(tableKeys.every(key => other.data[key].length === 0));
    });
    await t.test("authenticated ZIPs from before quantity support upgrade single-item orders safely",()=>{
      const legacyData = structuredClone(decoded.data);
      legacyData.products = legacyData.products.map(product => {
        const row = { ...product }; delete row.buttonEmoji; delete row.buttonCustomEmojiId; delete row.stockAnnouncedAt; delete row.imageUrl; return row;
      });
      legacyData.payments = legacyData.payments.filter(p=>p.quantity===1).map(p=>{
        const row = {...p}; delete row.quantity; delete row.inventoryIds; return row;
      });
      legacyData.walletEntries = legacyData.walletEntries.filter(e=>legacyData.payments.some(p=>p.id===e.paymentId));
      delete (legacyData as Partial<typeof legacyData>).customEmojis;
      const bytes = strToU8(JSON.stringify(legacyData));
      const {signature:_,...core} = decoded.manifest;
      core.schemaHash = singleItemTransferSchemaHash;
      core.dataSha256 = createHash("sha256").update(bytes).digest("hex");
      core.counts = Object.fromEntries(tableKeys.filter(key=>key!=="customEmojis").map(key=>[key,legacyData[key].length]));
      const signature = createHmac("sha256",process.env.SESSION_SECRET!).update(JSON.stringify(core)).digest("hex");
      const files = unzipSync(exported.zip);
      files["shop-data.json"] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify({...core,signature}));
      const upgraded = decodeShopArchive(Buffer.from(zipSync(files)));
      assert.ok(upgraded.data.payments.every(p=>p.quantity===1 && p.inventoryIds===null));
      assert.ok(upgraded.data.products.every(product => product.buttonEmoji === "🛍"));
      validateShopRelationships(upgraded.data,source);
    });
    await t.test("authenticated quantity-order ZIPs from before product emojis retain all orders", () => {
      const legacyData = structuredClone(decoded.data);
      legacyData.products = legacyData.products.map(product => {
        const row = { ...product }; delete row.buttonEmoji; delete row.buttonCustomEmojiId; delete row.stockAnnouncedAt; delete row.imageUrl; return row;
      });
      delete (legacyData as Partial<typeof legacyData>).customEmojis;
      const bytes = strToU8(JSON.stringify(legacyData));
      const { signature: _, ...core } = decoded.manifest;
      core.schemaHash = quantityTransferSchemaHash;
      core.counts = Object.fromEntries(tableKeys.filter(key=>key!=="customEmojis").map(key=>[key,legacyData[key].length]));
      core.dataSha256 = createHash("sha256").update(bytes).digest("hex");
      const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(core)).digest("hex");
      const files = unzipSync(exported.zip);
      files["shop-data.json"] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify({ ...core, signature }));
      const upgraded = decodeShopArchive(Buffer.from(zipSync(files)));
      assert.deepEqual(upgraded.data.payments, decoded.data.payments);
      assert.ok(upgraded.data.products.every(product => product.buttonEmoji === "🛍"));
      validateShopRelationships(upgraded.data, source);
    });
    await t.test("authenticated plain-emoji ZIPs upgrade without inventing custom icons", () => {
      const legacyData = structuredClone(decoded.data);
      legacyData.products = legacyData.products.map(product => {
        const row = { ...product }; delete row.buttonCustomEmojiId; delete row.stockAnnouncedAt; delete row.imageUrl; return row;
      });
      delete (legacyData as Partial<typeof legacyData>).customEmojis;
      const bytes = strToU8(JSON.stringify(legacyData));
      const { signature: _, ...core } = decoded.manifest;
      core.schemaHash = productEmojiTransferSchemaHash;
      core.counts = Object.fromEntries(tableKeys.filter(key=>key!=="customEmojis").map(key=>[key,legacyData[key].length]));
      core.dataSha256 = createHash("sha256").update(bytes).digest("hex");
      const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(core)).digest("hex");
      const files = unzipSync(exported.zip);
      files["shop-data.json"] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify({ ...core, signature }));
      const upgraded = decodeShopArchive(Buffer.from(zipSync(files)));
      assert.ok(upgraded.data.products.every(product => product.buttonEmoji === "🔑" && product.buttonCustomEmojiId === null));
      assert.deepEqual(upgraded.data.customEmojis, []);
      validateShopRelationships(upgraded.data, source);
    });
    await t.test("authenticated existing-shop ZIPs retain the new-versus-restock distinction", () => {
      const oldData = structuredClone(decoded.data);
      oldData.products = oldData.products.map(product => {
        const row = { ...product }; delete row.stockAnnouncedAt; delete row.imageUrl; return row;
      });
      const bytes = strToU8(JSON.stringify(oldData));
      const { signature: _, ...core } = decoded.manifest;
      core.schemaHash = customEmojiTransferSchemaHash;
      core.dataSha256 = createHash("sha256").update(bytes).digest("hex");
      const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(core)).digest("hex");
      const files = unzipSync(exported.zip);
      files["shop-data.json"] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify({ ...core, signature }));
      const upgraded = decodeShopArchive(Buffer.from(zipSync(files)));
      for (const product of upgraded.data.products) {
        const stocked = upgraded.data.inventory.some(item => item.productId === product.id);
        assert.equal(product.stockAnnouncedAt, stocked ? product.createdAt : null);
      }
      assert.deepEqual(upgraded.data.payments, decoded.data.payments);
      validateShopRelationships(upgraded.data, source);
    });
    await t.test("pre-image ZIPs preserve announcement markers and default images to null", () => {
      const oldData = structuredClone(decoded.data);
      oldData.products = oldData.products.map(product => {
        const row = { ...product }; delete row.imageUrl; return row;
      });
      const bytes = strToU8(JSON.stringify(oldData));
      const { signature: _, ...core } = decoded.manifest;
      core.schemaHash = stockAnnouncementTransferSchemaHash;
      core.dataSha256 = createHash("sha256").update(bytes).digest("hex");
      const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(JSON.stringify(core)).digest("hex");
      const files = unzipSync(exported.zip);
      files["shop-data.json"] = bytes;
      files["manifest.json"] = strToU8(JSON.stringify({ ...core, signature }));
      const upgraded = decodeShopArchive(Buffer.from(zipSync(files)));
      assert.ok(upgraded.data.products.every(product => product.imageUrl === null));
      assert.deepEqual(upgraded.data.products.map(product => product.stockAnnouncedAt), decoded.data.products.map(product => product.stockAnnouncedAt));
    });
    await t.test("corruption, unsafe ZIP paths, modification and incompatible encryption keys fail before writes", () => {
      assert.throws(() => decodeShopArchive(Buffer.from("not a ZIP")));
      const files = unzipSync(exported.zip);
      assert.throws(() => decodeShopArchive(Buffer.from(zipSync({ ...files, "../outside.json": strToU8("{}") }))));
      assert.throws(() => decodeShopArchive(Buffer.alloc(20 * 1024 * 1024 + 1)));
      assert.throws(() => decodeShopArchive(Buffer.from(zipSync({ ...files, "shop-data.json": new Uint8Array(30 * 1024 * 1024 + 1) }))));
      const tooMany = structuredClone(decoded.data);
      tooMany.products = Array.from({ length: 50001 }, () => decoded.data.products[0]!);
      assert.throws(() => encodeShopArchive(source, tooMany));
      const data = JSON.parse(strFromU8(files["shop-data.json"]!));
      data.customers[0].balanceCents += 100;
      files["shop-data.json"] = strToU8(JSON.stringify(data));
      assert.throws(() => decodeShopArchive(Buffer.from(zipSync(files))), /checksum/);
      const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
      manifest.dataSha256 = createHash("sha256").update(files["shop-data.json"]).digest("hex");
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
      assert.throws(() => decodeShopArchive(Buffer.from(zipSync(files))), /Cannot authenticate/);
      const saved = process.env.SESSION_SECRET;
      try {
        process.env.SESSION_SECRET = "TEST_ONLY_WRONG_KEY";
        assert.throws(() => decodeShopArchive(exported.zip), /matching original SESSION_SECRET/);
      } finally { process.env.SESSION_SECRET = saved; }
      const badRelationships = structuredClone(decoded.data);
      badRelationships.payments[0]!.customerId = "MISSING_CUSTOMER";
      assert.throws(() => validateShopRelationships(badRelationships, source), /relationships/);
    });
    await t.test("preview is read-only, destination-bound and refuses nonempty shops", async () => {
      const preview = await previewShopTransfer(source, exported.zip);
      assert.equal(preview.canImport, false);
      assert.match(preview.blockers.join(" "), /empty shop/);
      await assert.rejects(importShopTransfer(source, exported.zip, preview.confirmationToken), e => (e as { status: number }).status === 409);
      const ready = await previewShopTransfer(destination, exported.zip);
      assert.equal(ready.canImport, true);
      assert.throws(() => verifyPreviewToken(ready.confirmationToken, foreign, ready.archiveHash));
      assert.throws(() => verifyPreviewToken(previewToken(destination, ready.archiveHash, Date.now() - 1), destination, ready.archiveHash));
      assert.throws(() => verifyPreviewToken(`${ready.confirmationToken}.extra`, destination, ready.archiveHash));
    });
    await t.test("a stale preview cannot overwrite data added afterwards", async () => {
      const preview = await previewShopTransfer(destination, exported.zip);
      await pool.query(`INSERT INTO shop_products(owner_id,name,category,price_cents,delivery_format)
        VALUES($1,'TEST_ONLY blocker','test',10,'user:pass')`, [destination]);
      await assert.rejects(importShopTransfer(destination, exported.zip, preview.confirmationToken), e => (e as { status: number }).status === 409);
      assert.equal((await shopTransferStatus(destination)).counts.products, 1);
      await cleanTransferFixture(destination);
    });
    await t.test("a mid-import primary-key conflict rolls back all inserted rows", async () => {
      // Source UUIDs still exist, so this fails AFTER numeric products/stock were inserted.
      const preview = await previewShopTransfer(destination, exported.zip);
      await assert.rejects(importShopTransfer(destination, exported.zip, preview.confirmationToken), /rolled back/);
      const state = await shopTransferStatus(destination);
      assert.equal(state.empty, true);
      assert.equal(state.counts.products, 0);
      assert.equal(state.counts.inventory, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_credentials WHERE owner_id=$1", [destination])).rows[0].n, 0);
    });
    await cleanTransferFixture(source); // Only synthetic source rows are removed.
    await t.test("concurrent imports commit exactly once and preserve ciphertext, links, balances and history", async () => {
      const preview = await previewShopTransfer(destination, exported.zip);
      const results = await Promise.allSettled([
        importShopTransfer(destination, exported.zip, preview.confirmationToken),
        importShopTransfer(destination, exported.zip, preview.confirmationToken),
      ]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.filter(r => r.status === "rejected").length, 1);
      const status = await shopTransferStatus(destination);
      assert.equal(status.empty, false);
      assert.equal(status.reviewRequired, true);
      assert.equal(status.counts.payments, 6);
      const restored = decodeShopArchive((await exportShopTransfer(destination)).zip);
      for (const key of tableKeys) {
        assert.equal(restored.data[key].length, decoded.data[key].length + (key === "activity" ? 1 : 0), key);
      }
      assert.deepEqual(restored.data.customers.map(c => Number(c.balanceCents)).sort((a,b)=>a-b), [490,1234]);
      assert.ok(restored.data.customers.every(c => c.state === "{}"));
      assert.deepEqual(restored.data.walletEntries, decoded.data.walletEntries);
      assert.deepEqual(restored.data.walletEntries.map(e => Number(e.amountCents)).sort((a,b)=>a-b), [-20,-10,500]);
      const productIds = new Map(decoded.data.products.map(p => [p.id, restored.data.products.find(row => row.name === p.name)!.id]));
      const inventoryIds = new Map(decoded.data.inventory.map(s => {
        const plaintext = decryptCredential(String(s.encryptedCredential), source, Number(s.productId));
        return [s.id, restored.data.inventory.find(row => decryptCredential(String(row.encryptedCredential), destination, Number(row.productId)) === plaintext)!.id];
      }));
      for (const row of decoded.data.products) {
        assert.notEqual(productIds.get(row.id), row.id);
        assert.deepEqual(restored.data.products.find(p => p.id === productIds.get(row.id)), { ...row, id: productIds.get(row.id), ownerId: destination });
      }
      for (const row of decoded.data.customers) assert.deepEqual(restored.data.customers.find(c => c.id === row.id), { ...row, ownerId: destination, state: "{}" });
      for (const p of decoded.data.payments) {
        const actual = restored.data.payments.find(row => row.id === p.id)!;
        assert.deepEqual({...actual,inventoryIds:null}, { ...p,inventoryIds:null, ownerId: destination, productId: p.productId === null ? null : productIds.get(p.productId), inventoryId: p.inventoryId === null ? null : inventoryIds.get(p.inventoryId) });
        assert.deepEqual(actual.inventoryIds===null?null:JSON.parse(String(actual.inventoryIds)),p.inventoryIds===null?null:assignedInventoryIds(p).map(id=>inventoryIds.get(id)));
        assert.equal(actual.fulfillment, p.fulfillment);
        assert.equal(actual.status, p.status);
        assert.equal(actual.requestKey, p.requestKey);
        assert.equal(actual.customerId, p.customerId);
        assert.equal(String(actual.cancelledAt), String(p.cancelledAt));
        assert.equal(String(actual.deliveredAt), String(p.deliveredAt));
        if (actual.inventoryId !== null) assert.equal(restored.data.inventory.find(row => row.id === actual.inventoryId)!.productId, actual.productId);
      }
      const inventory = restored.data.inventory.map(s => decryptCredential(String(s.encryptedCredential), destination, Number(s.productId)));
      assert.deepEqual(inventory.sort(), [...syntheticInventory].sort());
      const credentials = restored.data.providerCredentials[0]!;
      assert.equal(decryptProviderSecret(String(credentials.telegramTokenEncrypted), destination, "telegram"), "TEST_ONLY_TELEGRAM");
      assert.equal(decryptProviderSecret(String(credentials.nowpaymentsApiKeyEncrypted), destination, "nowpayments-api-key"), "TEST_ONLY_API");
      assert.equal(decryptProviderSecret(String(credentials.nowpaymentsIpnSecretEncrypted), destination, "nowpayments-ipn-secret"), "TEST_ONLY_IPN");
      assert.deepEqual(restored.data.settings[0]!.preferences, decoded.data.settings[0]!.preferences);
      assert.deepEqual(restored.data.records[0]!.payload, decoded.data.records[0]!.payload);
      assert.equal(restored.data.records[0]!.createdAt, "2026-11-11T10:00:00.123456Z");
      assert.equal((await pool.query("SELECT preferences->>'precisionProof' AS n FROM shop_settings WHERE owner_id=$1", [destination])).rows[0].n, "9007199254740993");
      assert.equal(restored.data.runtime[0]!.enabled, false);
      assert.equal(restored.data.runtime[0]!.transport, "polling");
      assert.equal(restored.data.runtime[0]!.publicUrl, "");
      assert.equal(restored.data.runtime[0]!.transferReviewRequired, true);
    });
    await t.test("imported payment verification, allocation and delivery remain held until explicit review", async () => {
      process.env.TELECART_OWNER_ID = destination;
      assert.equal((await getBotRuntime(destination)).enabled, false);
      await assert.rejects(assertTransferReviewed(destination), e => (e as { status: number }).status === 503);
      await assert.rejects(checkPayment(fixture.payments[2]!), e => (e as { status: number }).status === 503);
      await assert.rejects(deliverPayment(fixture.payments[4]!), e => (e as { status: number }).status === 503);
      await assert.rejects(createCheckout({ ownerId: destination, customerId: fixture.customers[0]!, token: "TEST", coin: "usd", productId: 1, wallet: true }), e => (e as { status: number }).status === 503);
      await reconcilePaymentBatch();
      assert.equal(networkCalls, 0);
      await reviewShopTransfer(destination);
      await assertTransferReviewed(destination);
      assert.equal((await getBotRuntime(destination)).enabled, false);
      const before = (await pool.query("SELECT count(*)::int AS n FROM shop_activity WHERE owner_id=$1", [destination])).rows[0].n;
      await reviewShopTransfer(destination);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM shop_activity WHERE owner_id=$1", [destination])).rows[0].n, before);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOwner === undefined) delete process.env.TELECART_OWNER_ID; else process.env.TELECART_OWNER_ID = originalOwner;
    await cleanTransferFixture(source);
    await cleanTransferFixture(destination);
    await cleanTransferFixture(foreign);
    await pool.end();
  }
});
