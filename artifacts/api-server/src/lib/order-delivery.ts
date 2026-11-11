import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db, shopPayments } from "@workspace/db";
import { CommerceError } from "./commerce-providers";
import { recordActivity } from "./shop-store";
import { assignedOrderCredentials } from "./payment-inventory";

async function loadDeliveredInventory(ownerId: string | null, orderId: string, customerId?: string) {
  if (!ownerId) throw new CommerceError("Sign in to view delivered inventory.", 401);
  const [row] = await db.select().from(shopPayments).where(and(
    eq(shopPayments.id, orderId), eq(shopPayments.ownerId, ownerId),
    ...(customerId ? [eq(shopPayments.customerId, customerId)] : []),
    ne(shopPayments.kind, "deposit"), eq(shopPayments.fulfillment, "delivered"),
    isNotNull(shopPayments.deliveredAt),
  ));
  if (!row?.deliveredAt) throw new CommerceError("No delivered inventory is available for this order.", 404);
  const delivery = await assignedOrderCredentials(row).catch(error => {
    if (error instanceof CommerceError && error.status === 409) throw new CommerceError("No delivered inventory is available for this order.", 404);
    throw error;
  });
  return {
    orderId: row.id, inventoryId: delivery.ids[0]!, credential: delivery.credential,
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
