import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import type { CustomerWalletCreditInput } from "@workspace/api-zod";
import { CommerceError } from "./commerce-providers";

const MAX_BALANCE = 2_000_000_000;
function creditRecord(row: Record<string, any>) {
  return {
    id: row.id, customerId: row.customer_id, actorId: row.actor_id, amountCents: row.amount_cents,
    balanceBeforeCents: row.balance_before_cents, balanceAfterCents: row.balance_after_cents,
    reason: row.reason, createdAt: new Date(row.created_at).toISOString(),
  };
}
async function ownedCustomer(client: PoolClient, owner: string, customer: string) {
  const result = await client.query("SELECT id,balance_cents FROM bot_customers WHERE owner_id=$1 AND id=$2", [owner, customer]);
  if (!result.rowCount) throw new CommerceError("Customer not found in your shop.", 404);
  if (!Number.isSafeInteger(result.rows[0].balance_cents) || result.rows[0].balance_cents < 0 || result.rows[0].balance_cents > MAX_BALANCE)
    throw new CommerceError("This wallet balance needs review before adding credit.", 409);
  return result.rows[0];
}
export async function addManualWalletCredit(owner: string, customerId: string, input: CustomerWalletCreditInput) {
  const reason = input.reason.trim();
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > MAX_BALANCE ||
    !reason || reason.length > 500 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestKey))
    throw new CommerceError("Enter a positive amount with at most two decimal places and a reason up to 500 characters.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customer = await ownedCustomer(client, owner, customerId);
    const previous = (await client.query("SELECT * FROM manual_wallet_credits WHERE owner_id=$1 AND request_key=$2", [owner, input.requestKey])).rows[0];
    if (previous) {
      if (previous.customer_id !== customerId || previous.amount_cents !== input.amountCents || previous.reason !== reason)
        throw new CommerceError("This credit reference was already used for different details. No additional credit was added.", 409);
      await client.query("COMMIT");
      return { credit: creditRecord(previous), balanceCents: customer.balance_cents, currency: "USD" as const, replayed: true };
    }
    // Check inside the same writer transaction as the credit, not before acquiring it.
    const runtime = (await client.query("SELECT transfer_review_required FROM bot_runtime_settings WHERE owner_id=$1", [owner])).rows[0];
    if (runtime?.transfer_review_required)
      throw new CommerceError("Review the imported shop in Database transfer before adding customer credit.", 503);
    const after = customer.balance_cents + input.amountCents;
    if (!Number.isSafeInteger(after) || after > MAX_BALANCE)
      throw new CommerceError("This credit would exceed the wallet balance limit of $20,000,000.00.", 409);
    const credit = (await client.query(`INSERT INTO manual_wallet_credits
      (id,owner_id,customer_id,request_key,actor_id,amount_cents,balance_before_cents,balance_after_cents,reason)
      VALUES($1,$2,$3,$4,$2,$5,$6,$7,$8) RETURNING *`,
      [randomUUID(), owner, customerId, input.requestKey, input.amountCents, customer.balance_cents, after, reason])).rows[0];
    await client.query("UPDATE bot_customers SET balance_cents=balance_cents+$3 WHERE owner_id=$1 AND id=$2", [owner, customerId, input.amountCents]);
    await client.query(`INSERT INTO shop_activity(owner_id,title,description,type)
      VALUES($1,'Manual wallet credit added',$2,'wallet')`, [owner, `Customer ${customerId}: $${(input.amountCents / 100).toFixed(2)}. Credit ${credit.id}.`]);
    await client.query("COMMIT");
    return { credit: creditRecord(credit), balanceCents: after, currency: "USD" as const, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function manualWalletCreditHistory(owner: string, customerId: string, cursor?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customer = await ownedCustomer(client, owner, customerId);
    let before: string | undefined;
    if (cursor) {
      const anchor = (await client.query(`SELECT created_at AS cursorAt FROM manual_wallet_credits
        WHERE owner_id=$1 AND customer_id=$2 AND id=$3`, [owner, customerId, cursor])).rows[0];
      if (!anchor) throw new CommerceError("Credit history changed. Reload the latest credits.", 409);
      before = anchor.cursorAt;
    }
    const rows = (await client.query(`SELECT * FROM manual_wallet_credits WHERE owner_id=$1 AND customer_id=$2
      ${cursor ? "AND (created_at<$3 OR (created_at=$3 AND id<$4))" : ""}
      ORDER BY created_at DESC,id DESC LIMIT 51`, cursor ? [owner, customerId, before, cursor] : [owner, customerId])).rows;
    const page = rows.slice(0, 50);
    await client.query("COMMIT");
    return { entries: page.map(creditRecord), nextCursor: rows.length > 50 ? page.at(-1)!.id as string : null,
      balanceCents: customer.balance_cents, currency: "USD" as const };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
