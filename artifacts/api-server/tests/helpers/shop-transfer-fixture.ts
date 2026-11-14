import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { encryptCredential, credentialFingerprint } from "../../src/lib/inventory-encryption";
import { encryptProviderSecret } from "../../src/lib/provider-credentials";

export const syntheticInventory = ["TEST_ONLY:available", "TEST_ONLY:reserved", "TEST_ONLY:delivered", "TEST_ONLY:allocated", "TEST_ONLY:allocated-second"];
export async function seedTransferFixture(owner: string) {
  const c1 = randomUUID(), c2 = randomUUID();
  const customer = await pool.query(`INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username,balance_cents,state)
    VALUES($1,$3,$1,'TEST_ONLY','TEST_ONLY customer',490,'{"type":"deposit-amount"}'),
    ($2,$3,$2,'TEST_ONLY','TEST_ONLY second',1234,'{}') RETURNING id`, [c1, c2, owner]);
  const products = await pool.query(`INSERT INTO shop_products(owner_id,name,category,price_cents,delivery_format,status)
    VALUES($1,'TEST_ONLY product','test',10,'user:pass','active'),($1,'TEST_ONLY draft','test',50,'email:pass','draft') RETURNING id`, [owner]);
  const productId = products.rows[0].id as number;
  const inventory: number[] = [];
  for (const [index, value] of syntheticInventory.entries()) {
    const result = await pool.query(`INSERT INTO shop_inventory(owner_id,product_id,encrypted_credential,fingerprint,status)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [owner, productId, encryptCredential(value, owner, productId),
      credentialFingerprint(value, owner, productId), ["available", "reserved", "delivered", "delivered", "delivered"][index]]);
    inventory.push(result.rows[0].id);
  }
  const payments = Array.from({ length: 6 }, () => randomUUID());
  const rows = [
    { id: payments[0], customer: c1, kind: "deposit", amount: 500, status: "finished", fulfillment: "credited", delivered: new Date(), inventory: null, product: null, cancelled: null },
    { id: payments[1], customer: c1, kind: "wallet", amount: 10, status: "finished", fulfillment: "delivered", delivered: new Date(), inventory: inventory[2], product: productId, cancelled: null },
    { id: payments[2], customer: c1, kind: "deposit", amount: 500, status: "waiting", fulfillment: "pending", delivered: null, inventory: null, product: null, cancelled: null },
    { id: payments[3], customer: c1, kind: "deposit", amount: 500, status: "expired", fulfillment: "pending", delivered: null, inventory: null, product: null, cancelled: new Date() },
    { id: payments[4], customer: c2, kind: "wallet", amount: 20, status: "finished", fulfillment: "allocated", delivered: null, inventory: inventory[3], product: productId, cancelled: null },
    { id: payments[5], customer: c2, kind: "purchase", amount: 50, status: "creating", fulfillment: "pending", delivered: null, inventory: inventory[1], product: productId, cancelled: null },
  ];
  for (const p of rows) await pool.query(`INSERT INTO shop_payments(id,owner_id,customer_id,kind,request_key,amount_cents,coin,status,fulfillment,delivered_at,inventory_id,product_id,cancelled_at,product_name,rate_mode,quantity,inventory_ids)
    VALUES($1,$2,$3,$4,$5,$6,'ltc',$7,$8,$9,$10,$11,$12,'TEST_ONLY product','floating',$13,$14)`,
  [p.id, owner, p.customer, p.kind, `${p.customer}:${randomUUID()}`, p.amount, p.status, p.fulfillment, p.delivered, p.inventory, p.product, p.cancelled,
    p.id === payments[4] ? 2 : 1, p.id === payments[4] ? JSON.stringify([inventory[3],inventory[4]]) : null]);
  await pool.query(`INSERT INTO wallet_entries(id,customer_id,payment_id,amount_cents) VALUES($1,$2,$3,500)`, [randomUUID(), c1, payments[0]]);
  await pool.query(`INSERT INTO wallet_entries(id,customer_id,payment_id,amount_cents) VALUES($1,$2,$3,-10),($4,$5,$6,-20)`,
    [randomUUID(), c1, payments[1], randomUUID(), c2, payments[4]]);
  await pool.query(`INSERT INTO manual_wallet_credits
    (id,owner_id,customer_id,request_key,actor_id,amount_cents,balance_before_cents,balance_after_cents,reason)
    VALUES($1,$2,$3,$4,$2,10,1224,1234,'TEST_ONLY manual credit')`, [randomUUID(), owner, c2, randomUUID()]);
  await pool.query(`INSERT INTO shop_records(owner_id,kind,external_id,payload) VALUES($1,'order','TEST_ONLY_LEGACY','{"id":"TEST_ONLY_LEGACY","status":"delivered","amount":1}')`, [owner]);
  await pool.query(`INSERT INTO shop_settings(owner_id,preferences) VALUES($1,'{"shopName":"TEST_ONLY shop","minDeposit":5,"precisionProof":9007199254740993,"acceptedCoins":["BTC","ETH","LTC","SOL"]}')`, [owner]);
  await pool.query(`INSERT INTO shop_activity(owner_id,title,description,type) VALUES($1,'TEST_ONLY history','Synthetic credit adjustment','test')`, [owner]);
  await pool.query(`INSERT INTO provider_credentials(owner_id,telegram_token_encrypted,telegram_bot_username,nowpayments_api_key_encrypted,nowpayments_ipn_secret_encrypted,telegram_verified_at,nowpayments_verified_at)
    VALUES($1,$2,'TEST_ONLY_BOT',$3,$4,now(),now())`, [owner,
    encryptProviderSecret("TEST_ONLY_TELEGRAM", owner, "telegram"),
    encryptProviderSecret("TEST_ONLY_API", owner, "nowpayments-api-key"),
    encryptProviderSecret("TEST_ONLY_IPN", owner, "nowpayments-ipn-secret")]);
  await pool.query(`INSERT INTO bot_runtime_settings(owner_id,enabled,transport,public_url) VALUES($1,false,'webhook','https://example.invalid')`, [owner]);
  await pool.query("UPDATE shop_records SET created_at='2026-11-11T10:00:00.123456Z' WHERE owner_id=$1", [owner]);
  return { customers: customer.rows.map(r => r.id as string), payments, productId };
}

export async function cleanTransferFixture(owner: string) {
  if (!owner.startsWith("transfer-test-")) throw new Error("Refusing non-test cleanup.");
  await pool.query("DELETE FROM wallet_entries WHERE customer_id IN (SELECT id FROM bot_customers WHERE owner_id=$1)", [owner]);
  await pool.query("DELETE FROM manual_wallet_credits WHERE owner_id=$1", [owner]);
  for (const table of ["shop_payments", "shop_inventory", "shop_products", "shop_custom_emojis", "emoji_import_sessions", "bot_customers", "shop_records", "shop_settings", "shop_activity", "provider_credentials", "bot_runtime_settings"]) {
    await pool.query(`DELETE FROM "${table}" WHERE owner_id=$1`, [owner]);
  }
}
