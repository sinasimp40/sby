import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { allocateCheckout, checkoutQuantity, type CheckoutInput } from "../src/lib/checkout-allocation";
import { encryptCredential, credentialFingerprint } from "../src/lib/inventory-encryption";
import { assignedInventoryIds } from "../src/lib/payment-inventory";
import { deliverPayment, getPayment } from "../src/lib/commerce-payments";
import { customerDeliveredInventory } from "../src/lib/order-delivery";
import { quantityPrompt, quantityKeyboard, purchaseConfirmation } from "../src/lib/purchase-copy";

test("quantity copies show live stock, unit/total prices and escaped product text", () => {
  const product = { name: "<unsafe>", description: "Example & details", price: 1.25, stock: 7 };
  assert.match(quantityPrompt(product,1000), /Stock left: <b>7<\/b>/);
  assert.match(quantityPrompt(product,1000), /&lt;unsafe&gt;/);
  assert.match(purchaseConfirmation(product,3,1000), /Total: \$3.75/);
  assert.match(purchaseConfirmation(product,3,1000), /\$6.25/);
  assert.match(purchaseConfirmation(product,3,50), /Add <b>\$3.25/);
  for (const row of quantityKeyboard(2,randomUUID()).inline_keyboard) for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  assert.equal(quantityKeyboard(2,"TOKEN").inline_keyboard[0]!.length,2);
  assert.deepEqual(assignedInventoryIds({inventoryId:3,inventoryIds:null}),[3]);
  assert.throws(()=>assignedInventoryIds({inventoryId:3,inventoryIds:[3,3]}));
});
test("bulk wallet purchase is atomic, idempotent, stock-safe and delivers every assigned account", async t => {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const owner = `quantity-test-${randomUUID()}`;
  const customers = [randomUUID(),randomUUID(),randomUUID()];
  const oldOwner = process.env.TELECART_OWNER_ID;
  const oldFetch = globalThis.fetch;
  process.env.TELECART_OWNER_ID = owner;
  const sent: Array<{ method: string; body: Record<string,unknown> | FormData }> = [];
  let failDelivery = false;
  globalThis.fetch = async (url,init) => {
    if (!String(url).startsWith("https://api.telegram.org/")) throw new Error("External calls blocked.");
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body));
    if (failDelivery) return new Response(JSON.stringify({ok:false,error_code:503}),{status:503});
    sent.push({method:String(url).split("/").at(-1)!,body});
    return new Response(JSON.stringify({ok:true,result:{message_id:123}}));
  };
  const settings = { minDeposit:5,rateMode:"floating" as const };
  try {
    await pool.query(`INSERT INTO bot_runtime_settings(owner_id,enabled,transport,public_url) VALUES($1,true,'polling','')`,[owner]);
    for (const [index,id] of customers.entries()) await pool.query(`INSERT INTO bot_customers(id,owner_id,telegram_id,chat_id,username,balance_cents)
      VALUES($1,$2,$1,'TEST_ONLY_CHAT','TEST_ONLY customer',$3)`,[id,owner,index===1?50:1000]);
    const product = (await pool.query(`INSERT INTO shop_products(owner_id,name,category,price_cents,delivery_format,status)
      VALUES($1,'TEST_ONLY quantity','test',125,'user:pass','active') RETURNING id`,[owner])).rows[0].id as number;
    const credentials = Array.from({length:5},(_,i)=>`TEST_ONLY:<account${i}>&password`);
    const seedStock = async (productId:number,credential:string) => {
      await pool.query(`INSERT INTO shop_inventory(owner_id,product_id,encrypted_credential,fingerprint,status) VALUES($1,$2,$3,$4,'available')`,
        [owner,productId,encryptCredential(credential,owner,productId),credentialFingerprint(credential,owner,productId)]);
    };
    for (const value of credentials) await seedStock(product,value);
    const input: CheckoutInput = {ownerId:owner,customerId:customers[0]!,productId:product,token:randomUUID(),coin:"usd",wallet:true,quantity:2,expectedAmountCents:125};
    const available = async () => (await pool.query("SELECT count(*)::integer AS n FROM shop_inventory WHERE owner_id=$1 AND status='available'",[owner])).rows[0].n as number;
    await t.test("invalid quantities, insufficient funds and stale price/stock never partially debit",async()=>{
      for(const q of [0,-1,1.5,101,NaN]) await assert.rejects(allocateCheckout({...input,quantity:q},settings));
      assert.equal(checkoutQuantity({...input,quantity:undefined}),1);
      await assert.rejects(allocateCheckout({...input,customerId:customers[1]!},settings),/Insufficient/);
      await assert.rejects(allocateCheckout({...input,quantity:6},settings),/Only 5/);
      await assert.rejects(allocateCheckout({...input,expectedAmountCents:126},settings),/price changed/);
      assert.equal(await available(),5);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM wallet_entries WHERE customer_id=ANY($1::text[])",[customers])).rows[0].n,0);
    });
    let firstId = "";
    await t.test("repeated confirmations allocate all units and charge the total exactly once",async()=>{
      const replies = await Promise.all(Array.from({length:5},()=>allocateCheckout(input,settings)));
      firstId = replies[0]!.payment.id;
      assert.ok(replies.every(r=>r.payment.id===firstId));
      const p = await getPayment(firstId);
      assert.equal(p!.quantity,2); assert.equal(p!.amountCents,250);
      assert.equal(assignedInventoryIds(p!).length,2);
      assert.equal(await available(),3);
      assert.equal((await pool.query("SELECT balance_cents AS n FROM bot_customers WHERE id=$1",[customers[0]])).rows[0].n,750);
      assert.deepEqual((await pool.query("SELECT amount_cents AS n FROM wallet_entries WHERE payment_id=$1",[firstId])).rows,[{n:-250}]);
    });
    await t.test("competing buyers cannot oversell or pay for only part of a quantity",async()=>{
      const attempts = await Promise.allSettled([
        allocateCheckout({...input,token:randomUUID()},settings),
        allocateCheckout({...input,token:randomUUID(),customerId:customers[2]!},settings),
      ]);
      assert.equal(attempts.filter(a=>a.status==="fulfilled").length,1);
      assert.equal(attempts.filter(a=>a.status==="rejected").length,1);
      assert.equal(await available(),1);
      const totals = await pool.query("SELECT sum(balance_cents)::integer AS n FROM bot_customers WHERE id=ANY($1::text[])",[[customers[0],customers[2]]]);
      assert.equal(totals.rows[0].n,1500);
      const p = await pool.query("SELECT inventory_ids FROM shop_payments WHERE owner_id=$1",[owner]);
      assert.equal(new Set(p.rows.flatMap(row=>row.inventory_ids)).size,4);
    });
    await t.test("failed delivery retries the same complete bundle without taking more stock or money",async()=>{
      const before = assignedInventoryIds((await getPayment(firstId))!);
      failDelivery = true;
      await assert.rejects(deliverPayment(firstId));
      assert.equal((await getPayment(firstId))!.fulfillment,"allocated");
      failDelivery = false;
      await deliverPayment(firstId);
      await deliverPayment(firstId);
      assert.equal(sent.length,1);
      const message = sent[0]!.body as Record<string,unknown>;
      assert.equal(message.protect_content,true);assert.equal(message.parse_mode,"HTML");
      assert.match(String(message.text),/Quantity: <b>2<\/b>/);
      assert.match(String(message.text),/Account 1[\s\S]*Account 2/);
      assert.match(String(message.text),/&lt;account/);
      const revealed = await customerDeliveredInventory(owner,customers[0]!,firstId);
      assert.match(revealed.credential,/TEST_ONLY:<account/);
      await assert.rejects(customerDeliveredInventory(owner,customers[1]!,firstId));
      assert.deepEqual(assignedInventoryIds((await getPayment(firstId))!),before);
      assert.equal(await available(),1);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM wallet_entries WHERE payment_id=$1",[firstId])).rows[0].n,1);
    });
    await t.test("long account bundles are delivered completely as one protected text file",async()=>{
      const large = (await pool.query(`INSERT INTO shop_products(owner_id,name,category,price_cents,delivery_format,status)
        VALUES($1,'TEST_ONLY long','test',1,'user:pass','active') RETURNING id`,[owner])).rows[0].id as number;
      const value = `TEST_ONLY_LONG:${"x".repeat(5000)}`;
      await seedStock(large,value);
      const order = await allocateCheckout({...input,productId:large,quantity:1,expectedAmountCents:1,token:randomUUID()},settings);
      await deliverPayment(order.payment.id);
      const doc = sent.at(-1)!;
      assert.equal(doc.method,"sendDocument");
      assert.ok(doc.body instanceof FormData);
      const file = (doc.body as FormData).get("document") as Blob;
      assert.equal(await file.text(),value);
      assert.equal((doc.body as FormData).get("protect_content"),"true");
    });
  } finally {
    globalThis.fetch=oldFetch;
    if(oldOwner===undefined) delete process.env.TELECART_OWNER_ID; else process.env.TELECART_OWNER_ID=oldOwner;
    await pool.query("DELETE FROM wallet_entries WHERE customer_id=ANY($1::text[])",[customers]);
    for(const table of ["shop_payments","shop_inventory","shop_products","bot_customers","bot_runtime_settings"]) await pool.query(`DELETE FROM "${table}" WHERE owner_id=$1`,[owner]);
    await pool.end();
  }
});
