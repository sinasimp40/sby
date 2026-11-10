import { and, desc, eq, sql } from "drizzle-orm";
import { db, shopProducts, shopInventory, shopSettings, shopRecords, shopActivity } from "@workspace/db";
import { GetSettingsResponse, ListProductsResponse } from "@workspace/api-zod";
import { defaultSettings, sampleProducts } from "./shop-defaults";

export async function productsForOwner(ownerId: string | null) {
  if (!ownerId) return sampleProducts;
  const rows = await db.select({
    id: shopProducts.id,
    name: shopProducts.name,
    description: shopProducts.description,
    category: shopProducts.category,
    priceCents: shopProducts.priceCents,
    status: shopProducts.status,
    deliveryFormat: shopProducts.deliveryFormat,
    createdAt: shopProducts.createdAt,
    stock: sql<number>`count(${shopInventory.id}) filter (where ${shopInventory.status} = 'available')::integer`,
    sold: sql<number>`count(${shopInventory.id}) filter (where ${shopInventory.status} = 'delivered')::integer`,
  }).from(shopProducts)
    .leftJoin(shopInventory, eq(shopInventory.productId, shopProducts.id))
    .where(eq(shopProducts.ownerId, ownerId))
    .groupBy(shopProducts.id)
    .orderBy(desc(shopProducts.createdAt));
  return ListProductsResponse.parse(rows.map(({ priceCents, ...row }) => ({
    ...row, price: priceCents / 100, createdAt: row.createdAt.toISOString(),
  })));
}

export async function settingsForOwner(ownerId: string | null) {
  const [row] = ownerId
    ? await db.select().from(shopSettings).where(eq(shopSettings.ownerId, ownerId))
    : [];
  return GetSettingsResponse.parse({
    ...defaultSettings,
    ...(row?.preferences ?? {}),
    isDemo: !ownerId,
    botConnected: false,
    paymentsConnected: false,
    paymentProvider: "NOWPayments",
  });
}

export async function recordsForOwner(ownerId: string | null, kind: "order" | "customer" | "deposit") {
  if (!ownerId) return [];
  const rows = await db.select({ payload: shopRecords.payload }).from(shopRecords)
    .where(and(eq(shopRecords.ownerId, ownerId), eq(shopRecords.kind, kind)))
    .orderBy(desc(shopRecords.createdAt));
  return rows.map((row) => row.payload);
}

export async function recordActivity(ownerId: string, title: string, description: string, type: string) {
  await db.insert(shopActivity).values({ ownerId, title, description, type });
}

export async function ownedProduct(ownerId: string, id: number) {
  const [row] = await db.select().from(shopProducts).where(and(eq(shopProducts.id, id), eq(shopProducts.ownerId, ownerId)));
  return row;
}
