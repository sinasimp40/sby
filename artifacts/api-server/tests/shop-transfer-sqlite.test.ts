import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { pool } from "@workspace/db";
import { decodeShopArchive, encodeShopArchive } from "../src/lib/shop-transfer-archive";
import { encodeSqliteShopArchive } from "../src/lib/shop-transfer-sqlite";
import { exportShopTransfer, previewShopTransfer, importShopTransfer, shopTransferStatus } from "../src/lib/shop-transfer";
import { decryptCredential } from "../src/lib/inventory-encryption";
import { encryptProviderSecret, decryptProviderSecret } from "../src/lib/provider-credentials";
import { readShopTransferData } from "../src/lib/shop-transfer-store";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";
import { tableKeys } from "../src/lib/shop-transfer-tables";
import { seedTransferFixture, cleanTransferFixture, syntheticInventory } from "./helpers/shop-transfer-fixture";

function changeDb(zip: Buffer, change: (db: DatabaseSync) => void) {
  const files = unzipSync(zip);
  const dir = mkdtempSync(join(tmpdir(), "telecart-test-"));
  const path = join(dir, "test.db");
  try {
    writeFileSync(path, files["shop.db"], { mode: 0o600 });
    const db = new DatabaseSync(path);
    try { change(db); } finally { db.close(); }
    return Buffer.from(zipSync({ ...files, "shop.db": readFileSync(path) }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("SQLite ZIPs transfer complete shop data across different installation keys", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const source = `transfer-test-sqlite-source-${randomUUID()}`;
  const destination = `transfer-test-sqlite-destination-${randomUUID()}`;
  const originalSecret = process.env.SESSION_SECRET;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External calls are forbidden in SQLite transfer tests."); };
  process.env.SESSION_SECRET = `TEST_ONLY_SOURCE_KEY_${randomUUID()}`;
  try {
    await seedTransferFixture(source);
    const client = await pool.connect();
    let data;
    try { data = await readShopTransferData(client, source); } finally { client.release(); }
    const legacy = encodeShopArchive(source, data);
    const exported = await exportShopTransfer(source);
    assert.equal(exported.manifest.version, 2);
    assert.deepEqual(Object.keys(unzipSync(exported.zip)).sort(), ["README.txt", "shop.db"]);
    assert.equal(Buffer.from(unzipSync(exported.zip)["shop.db"]).subarray(0, 16).toString(), "SQLite format 3\0");
    assert.ok(!Buffer.from(unzipSync(exported.zip)["shop.db"]).includes(Buffer.from(process.env.SESSION_SECRET)));

    await t.test("SQLite has real tables and browsable logs, not a JSON document", () => {
      changeDb(exported.zip, db => {
        const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name);
        assert.deepEqual(new Set(names), new Set(["transfer_meta", "transfer_counts", ...tableKeys]));
        assert.equal(db.prepare("SELECT count(*) AS count FROM inventory").get()!.count, 5);
        assert.equal(typeof db.prepare("SELECT title FROM activity LIMIT 1").get()!.title, "string");
        assert.equal(db.prepare("SELECT credential FROM inventory ORDER BY _ordinal LIMIT 1").get()!.credential, syntheticInventory[0]);
        assert.equal(db.prepare("SELECT telegramToken FROM providerCredentials LIMIT 1").get()!.telegramToken, "TEST_ONLY_TELEGRAM");
      });
    });

    await t.test("source keys are not needed; legacy archives still require their original key", () => {
      process.env.SESSION_SECRET = `TEST_ONLY_DESTINATION_KEY_${randomUUID()}`;
      assert.throws(() => decodeShopArchive(legacy.zip), /matching original SESSION_SECRET/);
      const archive = decodeShopArchive(exported.zip);
      validateShopRelationships(archive.data, source);
      assert.deepEqual(archive.data.inventory.map(row => decryptCredential(String(row.encryptedCredential), source, Number(row.productId))).sort(), [...syntheticInventory].sort());
      assert.equal(decryptProviderSecret(String(archive.data.providerCredentials[0]!.nowpaymentsApiKeyEncrypted), source, "nowpayments-api-key"), "TEST_ONLY_API");
      assert.deepEqual(archive.data.payments, data.payments);
      assert.deepEqual(archive.data.walletEntries, data.walletEntries);
      assert.deepEqual(archive.data.customers, data.customers);
      assert.match(String(archive.data.settings[0]!.preferences), /9007199254740993/);
      assert.match(String(archive.data.records[0]!.createdAt), /\.123456Z$/);
    });

    await t.test("saved advertising bot credentials also survive different keys", () => {
      const archive = decodeShopArchive(exported.zip);
      archive.data.advertisingBots = [{
        ownerId: source, tokenEncrypted: encryptProviderSecret("987654321:TEST_ONLY", source, "advertising"),
        botId: "987654321", username: "TEST_ONLY_AD", checkedAt: null,
        draft: JSON.stringify({ text: "TEST_ONLY ad", imageUrl: null, buttonText: "Visit shop", buttonUrl: null }),
        nextSendAt: new Date().toISOString(), lastError: null, updateOffset: 0,
      }];
      const adZip = encodeSqliteShopArchive(source, archive.data).zip;
      process.env.SESSION_SECRET = `TEST_ONLY_SECOND_DESTINATION_KEY_${randomUUID()}`;
      const restored = decodeShopArchive(adZip);
      assert.equal(decryptProviderSecret(String(restored.data.advertisingBots[0]!.tokenEncrypted), source, "advertising"), "987654321:TEST_ONLY");
    });

    await t.test("damaged data, forged counts, SQL views and extra ZIP entries are rejected", () => {
      assert.throws(() => decodeShopArchive(changeDb(exported.zip, db => db.exec("UPDATE customers SET balanceCents=999999"))), /SQLite shop ZIP/);
      assert.throws(() => decodeShopArchive(changeDb(exported.zip, db => db.exec("UPDATE transfer_counts SET row_count=50001"))), /SQLite shop ZIP/);
      assert.throws(() => decodeShopArchive(changeDb(exported.zip, db => db.exec("CREATE VIEW extra AS SELECT 1"))), /SQLite shop ZIP/);
      const unsafe = Buffer.from(zipSync({ ...unzipSync(exported.zip), "../outside.db": strToU8("bad") }));
      const damaged = Buffer.from(zipSync({ ...unzipSync(exported.zip), "shop.db": strToU8("not SQLite") }));
      assert.throws(() => decodeShopArchive(unsafe));
      assert.throws(() => decodeShopArchive(damaged), /SQLite shop ZIP/);
    });

    await t.test("cross-key preview and atomic import retain money, stock and the processing hold", async () => {
      // A different installation does not contain the source's globally unique
      // customer/payment IDs. Remove only this suite's synthetic source rows.
      await cleanTransferFixture(source);
      const preview = await previewShopTransfer(destination, exported.zip);
      assert.equal(preview.canImport, true);
      await importShopTransfer(destination, exported.zip, preview.confirmationToken);
      const state = await shopTransferStatus(destination);
      assert.equal(state.reviewRequired, true);
      assert.equal(state.counts.inventory, 5);
      const restored = decodeShopArchive((await exportShopTransfer(destination)).zip);
      assert.deepEqual(restored.data.inventory.map(row => decryptCredential(String(row.encryptedCredential), destination, Number(row.productId))).sort(), [...syntheticInventory].sort());
      assert.deepEqual(restored.data.customers.map(row => row.balanceCents).sort(), data.customers.map(row => row.balanceCents).sort());
      assert.equal(restored.data.payments.length, data.payments.length);
      assert.equal(restored.data.walletEntries.length, data.walletEntries.length);
      assert.equal(decryptProviderSecret(String(restored.data.providerCredentials[0]!.telegramTokenEncrypted), destination, "telegram"), "TEST_ONLY_TELEGRAM");
      assert.equal((await previewShopTransfer(destination, exported.zip)).canImport, false);
    });
  } finally {
    await cleanTransferFixture(destination);
    await cleanTransferFixture(source);
    if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
    globalThis.fetch = originalFetch;
    await pool.end();
  }
});
