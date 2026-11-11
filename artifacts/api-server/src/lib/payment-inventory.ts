import { CommerceError } from "./commerce-providers";
import { and, eq, inArray } from "drizzle-orm";
import { db, shopInventory } from "@workspace/db";
import { decryptCredential } from "./inventory-encryption";

export function assignedInventoryIds(payment: { inventoryId?: unknown; inventoryIds?: unknown }): number[] {
  let ids = payment.inventoryIds;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { throw new CommerceError("Assigned inventory requires manual review.", 409); }
  }
  if (ids === null || ids === undefined) ids = payment.inventoryId == null ? [] : [payment.inventoryId];
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length || (payment.inventoryId != null && ids[0] !== payment.inventoryId)) {
    throw new CommerceError("Assigned inventory requires manual review.", 409);
  }
  return ids as number[];
}
export function inventoryBundle(credentials: string[]) {
  return credentials.length === 1 ? credentials[0]! : credentials.map((credential, index) => `Account ${index + 1}\n${credential}`).join("\n\n");
}

export async function assignedOrderCredentials(payment: {
  ownerId: string; productId: number | null; quantity?: number; inventoryId: number | null; inventoryIds?: unknown;
}) {
  const ids = assignedInventoryIds(payment);
  const quantity = payment.quantity ?? 1;
  if (payment.productId === null || !ids.length || ids.length !== quantity) throw new CommerceError("Assigned inventory requires manual review.", 409);
  const stock = await db.select().from(shopInventory).where(and(
    inArray(shopInventory.id, ids), eq(shopInventory.ownerId, payment.ownerId),
    eq(shopInventory.productId, payment.productId), eq(shopInventory.status, "delivered"),
  ));
  if (stock.length !== ids.length) throw new CommerceError("Assigned inventory requires manual review.", 409);
  const byId = new Map(stock.map(row => [row.id, row]));
  try {
    return { ids, credential: inventoryBundle(ids.map(id => decryptCredential(byId.get(id)!.encryptedCredential, payment.ownerId, payment.productId!))) };
  } catch { throw new CommerceError("Delivered inventory could not be decrypted. Check the inventory encryption configuration.", 500); }
}
