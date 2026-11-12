import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { CommerceError } from "./commerce-providers";
import { decryptCredential, encryptCredential, credentialFingerprint } from "./inventory-encryption";
import { decryptProviderSecret, encryptProviderSecret } from "./provider-credentials";
import { encodeShopArchive, decodeShopArchive, previewToken, verifyPreviewToken } from "./shop-transfer-archive";
import { validateShopRelationships } from "./shop-transfer-validation";
import { readShopTransferData, insertTransferRow, insertTransferRows, destinationTransferState } from "./shop-transfer-store";
import type { TransferData, TransferRow, TransferTable } from "./shop-transfer-tables";
import { assignedInventoryIds } from "./payment-inventory";

function requireOwner(owner: string | null): asserts owner is string {
  if (!owner) throw new CommerceError("Sign in to transfer your private shop data.", 401);
}
const warnings = [
  "This ZIP contains private customer and financial information. Store it securely.",
  "Use the original SESSION_SECRET on the destination; it is intentionally not included.",
  "Admin passwords, login sessions, database URLs, environment-only provider keys and application code are not included.",
  "Imports never merge or overwrite business data. Saved shop preferences/provider configuration will be replaced; destination login credentials remain unchanged.",
  "The destination bot and payment processing stay paused for review. Stop the source server before resuming; never run both copies.",
  "Public callback URLs and unfinished Telegram selections are cleared. Historical payments, balances, stock and delivery records are retained.",
];

export async function shopTransferStatus(ownerId: string | null) {
  requireOwner(ownerId);
  const client = await pool.connect();
  try {
    const state = await destinationTransferState(client, ownerId);
    return { empty: state.empty, counts: state.counts, blockers: state.blockers, reviewRequired: state.reviewRequired, warnings };
  } finally { client.release(); }
}

export async function exportShopTransfer(ownerId: string | null) {
  requireOwner(ownerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const data = await readShopTransferData(client, ownerId);
    const archive = encodeShopArchive(ownerId, data);
    validateShopRelationships(data, ownerId);
    await client.query("COMMIT");
    return archive;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function previewShopTransfer(ownerId: string | null, zip: Buffer) {
  requireOwner(ownerId);
  const archive = decodeShopArchive(zip);
  validateShopRelationships(archive.data, archive.manifest.sourceOwnerId);
  const client = await pool.connect();
  try {
    const state = await destinationTransferState(client, ownerId);
    if (archive.data.connection.length && state.connectionOwner && state.connectionOwner !== ownerId) state.blockers.push("The destination bot is bound to another shop. An operator must resolve that binding first.");
    return {
      createdAt: archive.manifest.createdAt, counts: archive.manifest.counts,
      archiveHash: archive.archiveHash, confirmationToken: previewToken(ownerId, archive.archiveHash),
      canImport: state.blockers.length === 0, blockers: state.blockers, warnings,
    };
  } finally { client.release(); }
}

async function importRows(client: PoolClient, data: TransferData, source: string, owner: string) {
  const deadline = Date.now() + 20000;
  const write = (key: TransferTable, rows: TransferRow[], omitId = false) => insertTransferRows(client, key, rows, omitId, deadline);
  const allocate = async (table: "shop_products" | "shop_inventory", count: number): Promise<number[]> => {
    if (!count) return [];
    const result = await client.query(`SELECT n, nextval(pg_get_serial_sequence($1,'id'))::integer AS id
      FROM generate_series(1,$2::integer) AS n ORDER BY n`, [table, count]);
    return result.rows.map(row => row.id);
  };
  const products = new Map<number, number>();
  const inventory = new Map<number, number>();
  const productIds = await allocate("shop_products", data.products.length);
  const inventoryIds = await allocate("shop_inventory", data.inventory.length);
  data.products.forEach((p, index) => products.set(Number(p.id), productIds[index]!));
  data.inventory.forEach((p, index) => inventory.set(Number(p.id), inventoryIds[index]!));
  await write("customEmojis", data.customEmojis.map(emoji => ({ ...emoji, ownerId: owner })));
  await write("products", data.products.map(p => ({ ...p, id: products.get(Number(p.id)), ownerId: owner })));
  const stockRows: TransferRow[] = [];
  for (const stock of data.inventory) {
    const productId = products.get(Number(stock.productId))!;
    const plain = decryptCredential(String(stock.encryptedCredential), source, Number(stock.productId));
    stockRows.push({
      ...stock, id: inventory.get(Number(stock.id)), ownerId: owner, productId, encryptedCredential: encryptCredential(plain, owner, productId),
      fingerprint: credentialFingerprint(plain, owner, productId),
    });
  }
  await write("inventory", stockRows);
  await write("customers", data.customers.map(c => ({ ...c, ownerId: owner, state: {} })));
  await write("payments", data.payments.map(p => ({
    ...p, ownerId: owner, productId: p.productId === null ? null : products.get(Number(p.productId)),
    inventoryId: p.inventoryId === null ? null : inventory.get(Number(p.inventoryId)),
    inventoryIds: p.inventoryIds === null ? null : JSON.stringify(assignedInventoryIds(p).map(id => inventory.get(id)!)),
  })));
  await write("walletEntries", data.walletEntries);
  for (const key of ["records", "activity"] as const) {
    await write(key, data[key].map(row => ({ ...row, ownerId: owner })), true);
  }
  // Only empty-shop configuration can be replaced; business rows are never deleted.
  for (const table of ["shop_settings", "provider_credentials", "bot_runtime_settings"]) {
    await client.query(`DELETE FROM "${table}" WHERE owner_id=$1`, [owner]);
  }
  for (const row of data.settings) await insertTransferRow(client, "settings", { ...row, ownerId: owner });
  for (const row of data.providerCredentials) {
    const remapped: TransferRow = { ...row, ownerId: owner };
    for (const [field, purpose] of [
      ["telegramTokenEncrypted", "telegram"], ["nowpaymentsApiKeyEncrypted", "nowpayments-api-key"],
      ["nowpaymentsIpnSecretEncrypted", "nowpayments-ipn-secret"],
    ] as const) {
      if (row[field] !== null) remapped[field] = encryptProviderSecret(decryptProviderSecret(String(row[field]), source, purpose), owner, purpose);
    }
    await insertTransferRow(client, "providerCredentials", remapped);
  }
  await insertTransferRow(client, "runtime", {
    ...(data.runtime[0] ?? { updatedAt: new Date() }), ownerId: owner, enabled: false,
    transferReviewRequired: true, transport: "polling", publicUrl: "",
  });
  if (data.connection[0]) {
    await client.query("DELETE FROM bot_connections WHERE id='primary' AND owner_id=$1", [owner]);
    await insertTransferRow(client, "connection", { ...data.connection[0], ownerId: owner, active: "no", publicUrl: "" });
  } else {
    await client.query("DELETE FROM bot_connections WHERE owner_id=$1", [owner]);
  }
  await write("updates", data.updates);
}

export async function importShopTransfer(ownerId: string | null, zip: Buffer, token: string) {
  requireOwner(ownerId);
  const archive = decodeShopArchive(zip);
  verifyPreviewToken(token, ownerId, archive.archiveHash);
  validateShopRelationships(archive.data, archive.manifest.sourceOwnerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('telecart-runtime-control', 5))");
    // Serialize concurrent import/setup/checkout writes for the empty destination.
    // Normal SELECT readers continue; writers wait briefly or this transaction fails.
    await client.query(`LOCK TABLE shop_products, shop_inventory, bot_customers, shop_payments,
      wallet_entries, shop_records, shop_settings, shop_activity, provider_credentials,
      bot_runtime_settings, bot_connections, bot_updates, shop_custom_emojis, emoji_import_sessions IN SHARE ROW EXCLUSIVE MODE`);
    const state = await destinationTransferState(client, ownerId);
    if (state.blockers.length) throw new CommerceError(state.blockers.join(" "), 409);
    if (archive.data.connection.length && state.connectionOwner && state.connectionOwner !== ownerId) throw new CommerceError("The bot is bound to another shop. Nothing was imported.", 409);
    await importRows(client, archive.data, archive.manifest.sourceOwnerId, ownerId);
    await client.query("DELETE FROM emoji_import_sessions WHERE owner_id=$1", [ownerId]);
    await client.query(`INSERT INTO shop_activity(owner_id,title,description,type)
      VALUES($1,'Shop data imported',$2,'data_transfer')`,
    [ownerId, `Verified portable import ${archive.archiveHash.slice(0, 12)}. Bot and payment processing paused for review.`]);
    await client.query("COMMIT");
    return { counts: archive.manifest.counts, reviewRequired: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof CommerceError) throw error;
    throw new CommerceError("Import could not complete. All changes were rolled back; check for conflicting IDs or incompatible data.", 409);
  } finally { client.release(); }
}

export async function reviewShopTransfer(ownerId: string | null) {
  requireOwner(ownerId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`UPDATE bot_runtime_settings SET transfer_review_required=false, updated_at=now()
      WHERE owner_id=$1 AND transfer_review_required=true RETURNING owner_id`, [ownerId]);
    if (result.rowCount) await client.query(`INSERT INTO shop_activity(owner_id,title,description,type)
      VALUES($1,'Imported shop reviewed','Source stopped and records reviewed. Payment checks may resume; Telegram remains disabled.','data_transfer')`, [ownerId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
  return { reviewRequired: false };
}
