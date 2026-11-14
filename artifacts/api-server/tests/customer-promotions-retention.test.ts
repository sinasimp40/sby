import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedTransferFixture, cleanTransferFixture } from "./helpers/shop-transfer-fixture";
import { processCustomerPromotions } from "../src/lib/customer-promotions-worker";
import { promotionTransaction, saveCustomerPromotionSettings, setPromotedProductFlags, setCustomerPromotionPreference } from "../src/lib/customer-promotions-store";
import { prunePromotionHistory } from "../src/lib/customer-promotions-retention";
import { readShopTransferData } from "../src/lib/shop-transfer-store";
import { MAX_TRANSFER_ROWS } from "../src/lib/shop-transfer-tables";
import { exportShopTransfer, importShopTransfer, previewShopTransfer } from "../src/lib/shop-transfer";
import { decodeShopArchive } from "../src/lib/shop-transfer-archive";
import { validateShopRelationships } from "../src/lib/shop-transfer-validation";

test("sustained promotions retain recent audits without exhausting portable shop backups", async t => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Real Telegram/provider requests are prohibited."); };
  const owner = `transfer-test-promotion-retention-${randomUUID()}`;
  try {
    const fixture = await seedTransferFixture(owner);
    await pool.query("UPDATE bot_runtime_settings SET enabled=1 WHERE owner_id=$1", [owner]);
    await pool.query(`INSERT INTO bot_connections(id,owner_id,bot_id,bot_username,public_url,active)
      VALUES('primary',$1,'900000001','TEST_ONLY_BOT','','yes')`, [owner]);
    await setPromotedProductFlags(owner, { productIds: [fixture.productId], enabled: true });
    let clock = new Date(Date.now() + 600000), sends = 0;
    await saveCustomerPromotionSettings(owner, { enabled: true, intervalMinutes: 1 }, clock);
    clock = new Date(clock.getTime() + 60001);
    await t.test("repeated real worker rounds retain only ten recent round summaries", async () => {
      for (let round = 0; round < 13; round++) {
        for (let tick = 0; tick < 3; tick++) {
          await processCustomerPromotions(owner, { now: () => clock, random: () => 0, send: async () => ({ message_id: ++sends }) });
          clock = new Date(clock.getTime() + 1001);
        }
        clock = new Date(clock.getTime() + 60001);
      }
      assert.equal(sends, 26);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM customer_promotion_rounds WHERE owner_id=$1", [owner])).rows[0].count, 10);
    });
    const additionalCustomers = Array.from({ length: 300 }, () => randomUUID());
    await pool.query(`INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username) VALUES
      ${additionalCustomers.map((_, index) => `($${index + 2},$1,$${index + 2},$${index + 2},'TEST_ONLY')`).join(",")}`, [owner, ...additionalCustomers]);
    const rounds = (await pool.query("SELECT id FROM customer_promotion_rounds WHERE owner_id=$1", [owner])).rows;
    for (const round of rounds) {
      await pool.query(`INSERT INTO customer_promotion_deliveries(id,owner_id,round_id,customer_id,status,message_id) VALUES
        ${additionalCustomers.map((_, index) => `($${index * 2 + 3},$1,$2,$${index * 2 + 4},'sent',1)`).join(",")}`,
        [owner, round.id, ...additionalCustomers.flatMap(customer => [`${round.id}:${customer}`, customer])]);
      await pool.query("UPDATE customer_promotion_rounds SET sent=sent+300 WHERE id=$1", [round.id]);
    }
    const activeRound = randomUUID(), lease = randomUUID();
    await pool.query(`INSERT INTO customer_promotion_rounds(id,owner_id,product_id,product_name,cursor,highwater,created_at)
      VALUES($1,$2,$3,'TEST_ONLY protected active round',$4,$4,'2020-01-01T00:00:00Z')`,
      [activeRound, owner, fixture.productId, fixture.customers[1]]);
    await pool.query(`UPDATE customer_promotion_settings SET active_round_id=$1,lease_token=$2,lease_until=$3,next_at=NULL WHERE owner_id=$4`,
      [activeRound, lease, new Date(clock.getTime() + 60000), owner]);
    for (const [index, status] of ["sending", "retry"].entries())
      await pool.query("INSERT INTO customer_promotion_deliveries(id,owner_id,round_id,customer_id,status) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), owner, activeRound, fixture.customers[index], status]);
    await setCustomerPromotionPreference(owner, fixture.customers[1], true);
    await t.test("detail trimming preserves totals, active cursor, in-flight attempts and pending retries", async () => {
      await promotionTransaction(client => prunePromotionHistory(client, owner));
      const counts = (await pool.query(`SELECT status,count(*)::integer AS count FROM customer_promotion_deliveries WHERE owner_id=$1 GROUP BY status`, [owner])).rows;
      assert.equal(counts.find(row => row.status === "sent").count, 2000);
      assert.equal(counts.find(row => row.status === "sending").count, 1);
      assert.equal(counts.find(row => row.status === "retry").count, 1);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM customer_promotion_rounds WHERE owner_id=$1 AND sent=302", [owner])).rows[0].count, 10);
      const settings = (await pool.query("SELECT active_round_id,lease_token FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0];
      assert.equal(settings.active_round_id, activeRound); assert.equal(settings.lease_token, lease);
    });
    const client = await pool.connect();
    let essentialCount: number;
    try {
      const baseline = await readShopTransferData(client, owner);
      essentialCount = Object.entries(baseline).filter(([key]) => !["promotionRounds", "promotionDeliveries"].includes(key))
        .reduce((total, [, rows]) => total + rows.length, 0);
    } finally { client.release(); }
    const padding = MAX_TRANSFER_ROWS - essentialCount - 12;
    const pad = async (count: number) => {
      for (let start = 0; start < count; start += 500) {
        const batch = Math.min(500, count - start);
        await pool.query(`INSERT INTO shop_activity(owner_id,title,description,type) VALUES
          ${Array.from({ length: batch }, () => "($1,'TEST_ONLY capacity','TEST_ONLY backup capacity fixture','test')").join(",")}`, [owner]);
      }
    };
    await pad(padding);
    let archive: Awaited<ReturnType<typeof exportShopTransfer>>;
    await t.test("a near-limit ZIP keeps all shop state and prioritizes active audit details", async () => {
      archive = await exportShopTransfer(owner);
      const data = decodeShopArchive(archive.zip).data;
      validateShopRelationships(data, owner);
      assert.equal(Object.values(data).reduce((total, rows) => total + rows.length, 0), MAX_TRANSFER_ROWS);
      assert.equal(data.activity.length, padding + 1);
      assert.equal(data.promotionRounds.length, 10); assert.equal(data.promotionDeliveries.length, 2);
      assert.deepEqual(data.promotionDeliveries.map(row => row.status).sort(), ["retry", "sending"]);
      assert.equal(data.promotionRounds.find(row => row.id !== activeRound)!.sent, 302);
      assert.equal(data.promotionPreferences[0].optedOut, true);
      assert.equal(data.customers.length, 302); assert.equal(data.manualCredits.length, 1);
    });
    await t.test("no-detail and no-history budgets still export; source state is untouched", async () => {
      await pad(10);
      const data = decodeShopArchive((await exportShopTransfer(owner)).zip).data;
      validateShopRelationships(data, owner);
      assert.equal(data.promotionDeliveries.length, 0); assert.equal(data.promotionRounds.length, 2);
      assert.equal(data.promotionRounds.find(row => row.id === activeRound)!.uncertain, 1);
      assert.equal(data.promotionRounds.find(row => row.id === activeRound)!.skipped, 1);
      await pad(2);
      const full = decodeShopArchive((await exportShopTransfer(owner)).zip).data;
      validateShopRelationships(full, owner);
      assert.equal(full.promotionRounds.length, 0); assert.equal(full.promotionDeliveries.length, 0);
      assert.equal(full.promotionSettings[0].activeRoundId, null); assert.equal(full.promotionSettings[0].leaseToken, null);
      assert.equal(full.promotionPreferences[0].optedOut, true);
      const source = (await pool.query("SELECT active_round_id,lease_token FROM customer_promotion_settings WHERE owner_id=$1", [owner])).rows[0];
      assert.equal(source.active_round_id, activeRound); assert.equal(source.lease_token, lease);
    });
    await t.test("bounded-history import preserves aggregate totals and safely closes pending attempts", async () => {
      await cleanTransferFixture(owner);
      await pool.query("DELETE FROM bot_connections WHERE owner_id=$1", [owner]);
      const destination = `TEST_ONLY_RETENTION_IMPORT_${randomUUID()}`;
      const preview = await previewShopTransfer(destination, archive!.zip);
      assert.equal(preview.canImport, true, JSON.stringify(preview));
      await importShopTransfer(destination, archive!.zip, preview.confirmationToken);
      const restored = (await pool.query("SELECT * FROM customer_promotion_rounds WHERE owner_id=$1", [destination])).rows;
      assert.ok(restored.filter(row => row.id !== activeRound).every(row => row.sent === 302));
      const stopped = restored.find(row => row.id === activeRound)!;
      assert.equal(stopped.status, "stopped"); assert.equal(stopped.uncertain, 1); assert.equal(stopped.skipped, 1);
      const config = (await pool.query("SELECT * FROM customer_promotion_settings WHERE owner_id=$1", [destination])).rows[0];
      assert.equal(config.enabled, false); assert.equal(config.active_round_id, null); assert.equal(config.lease_token, null);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM manual_wallet_credits WHERE owner_id=$1", [destination])).rows[0].count, 1);
      assert.equal((await pool.query("SELECT count(*)::integer AS count FROM shop_inventory WHERE owner_id=$1", [destination])).rows[0].count, 5);
    });
  } finally { globalThis.fetch = realFetch; await pool.end(); }
});
