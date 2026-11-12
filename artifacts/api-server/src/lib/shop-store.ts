import { canCancelDeposit } from "./deposit-cancellation-policy";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, shopProducts, shopInventory, shopSettings, shopRecords, shopActivity, shopPayments, botCustomers } from "@workspace/db";
import { GetSettingsResponse, ListProductsResponse } from "@workspace/api-zod";
import { defaultSettings, sampleProducts } from "./shop-defaults";
import { integrationStatus } from "./commerce-connection";

export async function productsForOwner(ownerId: string | null) {
  if (!ownerId) return sampleProducts;
  const rows = await db.select({
    id: shopProducts.id,
    name: shopProducts.name,
    description: shopProducts.description,
    imageUrl: shopProducts.imageUrl,
    groupId: shopProducts.groupId,
    groupName: shopProducts.groupName,
    groupDescription: shopProducts.groupDescription,
    optionName: shopProducts.optionName,
    category: shopProducts.category,
    priceCents: shopProducts.priceCents,
    status: shopProducts.status,
    deliveryFormat: shopProducts.deliveryFormat,
    buttonEmoji: shopProducts.buttonEmoji,
    buttonCustomEmojiId: shopProducts.buttonCustomEmojiId,
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
  const connection = await integrationStatus(ownerId);
  const [row] = ownerId
    ? await db.select().from(shopSettings).where(eq(shopSettings.ownerId, ownerId))
    : [];
  return GetSettingsResponse.parse({
    ...defaultSettings,
    ...(row?.preferences ?? {}),
    isDemo: !ownerId,
    botConnected: connection.connected,
    paymentsConnected: connection.connected && connection.apiKeyPresent && connection.ipnSecretPresent,
    paymentProvider: "NOWPayments",
  });
}

export async function recordsForOwner(ownerId: string | null, kind: "order" | "customer" | "deposit") {
  if (!ownerId) return [];
  const rows = await db.select({ payload: shopRecords.payload }).from(shopRecords)
    .where(and(eq(shopRecords.ownerId, ownerId), eq(shopRecords.kind, kind)))
    .orderBy(desc(shopRecords.createdAt));
  const payments = await db.select().from(shopPayments).where(eq(shopPayments.ownerId, ownerId)).orderBy(desc(shopPayments.createdAt));
  const customers = await db.select().from(botCustomers).where(eq(botCustomers.ownerId, ownerId));
  const username = (id: string) => customers.find(c => c.id === id)?.username ?? "Telegram customer";
  let live: Record<string, unknown>[];
  if (kind === "customer") live = customers.map(c => {
    const bought = payments.filter(p => p.customerId === c.id && p.kind !== "deposit" && ["allocated", "delivered"].includes(p.fulfillment));
    return { id: c.id, username: c.username, telegramId: c.telegramId, orderCount: bought.length, spent: bought.reduce((sum, p) => sum + p.amountCents, 0) / 100, walletBalance: c.balanceCents / 100, joinedAt: c.createdAt.toISOString() };
  });
  else if (kind === "order") live = payments.filter(p => p.kind !== "deposit").map(p => ({
    id: p.id, customer: username(p.customerId), productName: p.productName, amount: p.amountCents / 100,
    status: p.fulfillment === "delivered" ? "delivered" : p.status === "finished" ? "paid" : p.status === "refunded" ? "refunded" : ["failed", "expired"].includes(p.status) ? "cancelled" : "pending",
    paymentMethod: p.kind === "wallet" ? "Wallet" : "NOWPayments", createdAt: p.createdAt.toISOString(),
  }));
  else live = payments.filter(p => p.kind === "deposit").map(p => ({
    id: p.id, customer: username(p.customerId), amount: p.amountCents / 100, currency: "USD",
    status: p.fulfillment === "credited" ? "finished" : p.cancelledAt && ["creating", "waiting", "expired", "failed", "rejected"].includes(p.status) ? "cancelled" : ["failed", "expired", "refunded"].includes(p.status) ? (p.status === "expired" ? "expired" : "failed") :
      ["confirming", "confirmed", "sending"].includes(p.status) ? "confirming" : "waiting",
    createdAt: p.createdAt.toISOString(),
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    canCancel: canCancelDeposit(p),
  }));
  return [...live, ...rows.map((row) => row.payload)];
}

export async function recordActivity(ownerId: string, title: string, description: string, type: string) {
  await db.insert(shopActivity).values({ ownerId, title, description, type });
}

export async function ownedProduct(ownerId: string, id: number) {
  const [row] = await db.select().from(shopProducts).where(and(eq(shopProducts.id, id), eq(shopProducts.ownerId, ownerId)));
  return row;
}
