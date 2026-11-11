import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db, shopInventory, shopPayments } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { decryptCredential } from "./inventory-encryption";
import { recordActivity } from "./shop-store";

async function loadDeliveredInventory(ownerId: string | null, orderId: string, customerId?: string) {
  if (!ownerId) throw new CommerceError("Sign in to view delivered inventory.", 401);
  const [row] = await db.select({
    orderId: shopPayments.id, inventoryId: shopInventory.id,
    encrypted: shopInventory.encryptedCredential, productId: shopInventory.productId,
    deliveredAt: shopPayments.deliveredAt,
  }).from(shopPayments).innerJoin(shopInventory, and(
    eq(shopInventory.id, shopPayments.inventoryId),
    eq(shopInventory.ownerId, ownerId),
    eq(shopInventory.productId, shopPayments.productId),
    eq(shopInventory.status, "delivered"),
  )).where(and(
    eq(shopPayments.id, orderId), eq(shopPayments.ownerId, ownerId),
    ...(customerId ? [eq(shopPayments.customerId, customerId)] : []),
    ne(shopPayments.kind, "deposit"), eq(shopPayments.fulfillment, "delivered"),
    isNotNull(shopPayments.deliveredAt),
  ));
  if (!row?.deliveredAt) throw new CommerceError("No delivered inventory is available for this order.", 404);
  let credential: string;
  try {
    credential = decryptCredential(row.encrypted, ownerId, row.productId);
  } catch {
    throw new CommerceError("Delivered inventory could not be decrypted. Check the inventory encryption configuration.", 500);
  }
  return {
    orderId: row.orderId, inventoryId: row.inventoryId, credential,
    deliveredAt: row.deliveredAt.toISOString(),
  };
}

export async function revealDeliveredInventory(ownerId: string | null, orderId: string) {
  const delivery = await loadDeliveredInventory(ownerId, orderId);
  // Audit the access, never the plaintext credential.
  await recordActivity(ownerId!, "Delivered inventory viewed", `Order ${delivery.orderId} · Inventory #${delivery.inventoryId}`, "inventory_access");
  return delivery;
}

export async function customerDeliveredInventory(ownerId: string, customerId: string, orderId: string) {
  if (!customerId) throw new CommerceError("Order not found.", 404);
  return loadDeliveredInventory(ownerId, orderId, customerId);
}
